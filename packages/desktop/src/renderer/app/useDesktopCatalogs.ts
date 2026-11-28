import { useCallback, useEffect, useRef, useState } from 'react';
import type { DesktopAPI, Output, Workspace } from '../../shared/contracts.js';
import { buildNativeSessionKey } from '../adapters/index.js';
import { collectViewArtifacts } from '../artifact-model.js';
import { type WorkspaceHierarchyNode, useShellStore } from '../stores/index.js';
import { failureMessage } from './desktop-helpers.js';
import type {
  ActiveExternalState,
  HarnessCatalogEntry,
  OpenedSession,
} from './useDesktopRuntime.js';

/** 证据防抖的 max-wait：流式事件持续重排 trailing 计时器时，看板至少每 3s 放行一次拉取。 */
const EVIDENCE_MAX_WAIT_MS = 3000;

/**
 * 桌面目录、证据防抖聚合、新图片产物自动预览与跨空间会话检索子 Hook：
 * 从 `useDesktopRuntime` 解耦只读目录与检索副作用，保持单模块职责收敛。
 */
export function useDesktopCatalogs(params: {
  readonly api: DesktopAPI;
  readonly workspace?: Workspace;
  readonly spaces: readonly Workspace[];
  readonly opened?: OpenedSession;
  readonly activeExternal?: ActiveExternalState;
  readonly messages: ReturnType<typeof import('@kiturone/kapibala-host/view-model').selectMessages>;
  readonly projection?: import('@kiturone/kapibala-host/view-model').PresentationState;
  readonly runPhase?: 'running' | 'cancelling' | 'settling' | 'idle';
  readonly archiveRevision: number;
  readonly setError: (msg: string) => void;
}) {
  const {
    api,
    workspace,
    spaces,
    opened,
    activeExternal,
    messages,
    projection,
    runPhase,
    archiveRevision,
    setError,
  } = params;

  const activeSurface = useShellStore((s) => s.activeSurface);
  const settingsTab = useShellStore((s) => s.settingsTab);
  const trustedWorkspaceId = workspace?.trusted ? workspace.id : undefined;

  const [harnessCatalog, setHarnessCatalog] = useState<{
    readonly workspaceId: string;
    readonly choices: readonly HarnessCatalogEntry[];
    readonly failed?: true;
  }>();
  const [refreshingHarnessId, setRefreshingHarnessId] = useState<string>();
  const [managedWorktrees, setManagedWorktrees] = useState<Output<'worktree.list'>['items']>([]);
  const [activeTerminalsCount, setActiveTerminalsCount] = useState(0);

  const [evidence, setEvidence] = useState<Output<'session.evidence'>>();
  const [evidenceReloadTick, setEvidenceReloadTick] = useState(0);
  const evidenceFlushedAt = useRef(0);

  const artifactBaseline = useRef(new Set<string>());
  const artifactScope = useRef('');

  const [commandList, setCommandList] = useState<Output<'run.commandList'>>();
  const [skillList, setSkillList] = useState<Output<'run.skillCatalog'>>();
  const [fileList, setFileList] = useState<Output<'workspace.listFiles'>>();
  const fileListGen = useRef(0);

  const reloadHarnessCatalog = useCallback(
    async (targetWorkspaceId: string | undefined) => {
      if (!targetWorkspaceId) return;
      try {
        const { harnesses } = await api.external.harnesses(targetWorkspaceId);
        setHarnessCatalog({
          workspaceId: targetWorkspaceId,
          choices: harnesses
            .filter((item) => item.enabled)
            .map(({ id, name, transport, cachedConfigOptions, cachedConfigUpdatedAt }) => ({
              id,
              name,
              transport,
              ...(cachedConfigOptions ? { cachedConfigOptions } : {}),
              ...(cachedConfigUpdatedAt !== undefined ? { cachedConfigUpdatedAt } : {}),
            })),
        });
      } catch {
        setHarnessCatalog({ workspaceId: targetWorkspaceId, choices: [], failed: true });
      }
    },
    [api],
  );

  useEffect(() => {
    if (!trustedWorkspaceId || activeSurface === 'settings') return;
    void reloadHarnessCatalog(trustedWorkspaceId);
  }, [trustedWorkspaceId, activeSurface, reloadHarnessCatalog]);

  const refreshHarnessModels = useCallback(
    async (harnessId: string, options?: { readonly silent?: boolean }) => {
      if (!trustedWorkspaceId) return;
      setRefreshingHarnessId(harnessId);
      if (!options?.silent) setError('');
      try {
        const probe = await api.external.testHarness({
          id: harnessId,
          workspaceId: trustedWorkspaceId,
        });
        await reloadHarnessCatalog(trustedWorkspaceId);
        if (!probe.available && !options?.silent) {
          setError(
            probe.reason ||
              (probe.loginHint
                ? `需要先登录：${probe.loginHint}`
                : '未能读取该外部代理的模型列表。'),
          );
        }
      } catch (reason) {
        if (!options?.silent) setError(failureMessage(reason));
      } finally {
        setRefreshingHarnessId((cur) => (cur === harnessId ? undefined : cur));
      }
    },
    [api, reloadHarnessCatalog, setError, trustedWorkspaceId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: archiveRevision 是工作树归档变动后的手动重拉触发信号。
  useEffect(() => {
    if (activeSurface !== 'settings') return;
    if (settingsTab === 'archives' && trustedWorkspaceId) {
      void api.worktree
        .list(trustedWorkspaceId)
        .then((res) => setManagedWorktrees(res.items))
        .catch(() => setManagedWorktrees([]));
    }
    if (settingsTab === 'diagnostics' && trustedWorkspaceId) {
      void api.terminal
        .listShells(trustedWorkspaceId)
        .then((res) => setActiveTerminalsCount(res.activeTerminalsCount))
        .catch(() => {});
    }
  }, [activeSurface, api, archiveRevision, settingsTab, trustedWorkspaceId]);

  const evidenceWorkspaceId = opened?.workspaceId;
  const evidenceSessionId = opened?.sessionId;
  // biome-ignore lint/correctness/useExhaustiveDependencies: evidenceReloadTick 是手动重拉触发信号。
  useEffect(() => {
    if (!evidenceWorkspaceId || !evidenceSessionId || !projection) {
      setEvidence(undefined);
      return;
    }
    let cancelled = false;
    const elapsed = evidenceFlushedAt.current ? Date.now() - evidenceFlushedAt.current : 0;
    const base = runPhase === 'running' ? 800 : 300;
    const delay =
      elapsed >= EVIDENCE_MAX_WAIT_MS ? 0 : Math.min(base, EVIDENCE_MAX_WAIT_MS - elapsed);
    const timer = setTimeout(() => {
      evidenceFlushedAt.current = Date.now();
      void api.session
        .evidence({ workspaceId: evidenceWorkspaceId, sessionId: evidenceSessionId })
        .then((val) => {
          if (!cancelled) setEvidence(val);
        })
        .catch(() => {
          if (!cancelled) setEvidence(undefined);
        });
    }, delay);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, evidenceWorkspaceId, evidenceSessionId, projection, runPhase, evidenceReloadTick]);

  // 基线之外的新图片产物自动展开右侧 Preview 标签一次。
  useEffect(() => {
    if (!opened) {
      artifactScope.current = '';
      artifactBaseline.current.clear();
      return;
    }
    const scope = `${opened.workspaceId}:${opened.conversationId}`;
    const found = collectViewArtifacts(messages, scope);
    if (artifactScope.current !== scope) {
      artifactScope.current = scope;
      artifactBaseline.current = new Set(found.map((item) => item.key));
      return;
    }
    const fresh = found.filter((item) => !artifactBaseline.current.has(item.key));
    for (const item of found) artifactBaseline.current.add(item.key);
    const first = fresh[0];
    if (!first) return;
    const sessionKey = buildNativeSessionKey(opened.workspaceId, opened.conversationId);
    useShellStore.getState().openWorkbenchTab(sessionKey, {
      kind: 'preview',
      targetKey: first.callId,
      payload: {
        callId: first.callId,
        previewKind: 'image',
        label: first.artifact.path,
        filePath: first.artifact.path,
        artifact: first.artifact,
      },
    });
  }, [messages, opened]);

  const activeWorktreeId =
    projection?.worktree?.id ?? opened?.worktree?.id ?? activeExternal?.snapshot.worktree?.id;
  useEffect(() => {
    void api.run
      .commandList()
      .then(setCommandList)
      .catch(() => {});
    const gen = ++fileListGen.current;
    const wsId = opened?.workspaceId ?? trustedWorkspaceId;
    if (!opened?.workspaceId || !opened.sessionId) {
      if (!wsId) setSkillList(undefined);
      else {
        void api.resources
          .readSkills(wsId)
          .then((snap) => {
            if (gen !== fileListGen.current) return;
            const usable = snap.enabled
              ? snap.skills.filter((s) => s.userInvocable && s.available && !s.disabled)
              : [];
            setSkillList({
              installed: snap.skills.length > 0,
              skills: usable.slice(0, 500).map((s) => ({
                name: s.name,
                description:
                  s.description.length > 256 ? `${s.description.slice(0, 256)}…` : s.description,
                scope: s.scope,
              })),
              truncated: usable.length > 500,
            });
          })
          .catch(() => {
            if (gen === fileListGen.current) setSkillList(undefined);
          });
      }
    } else {
      void api.run
        .skillCatalog({ workspaceId: opened.workspaceId, sessionId: opened.sessionId })
        .then((res) => {
          if (gen === fileListGen.current) setSkillList(res);
        })
        .catch(() => {
          if (gen === fileListGen.current) setSkillList(undefined);
        });
    }
    if (!wsId) {
      setFileList(undefined);
      return;
    }
    void api.workspace
      .listFiles({
        workspaceId: wsId,
        ...(activeWorktreeId ? { worktreeId: activeWorktreeId } : {}),
      })
      .then((res) => {
        if (gen === fileListGen.current) setFileList(res);
      })
      .catch(() => {
        if (gen === fileListGen.current) setFileList(undefined);
      });
  }, [api, activeWorktreeId, opened?.sessionId, opened?.workspaceId, trustedWorkspaceId]);

  const searchSessionsAcrossSpaces = useCallback(
    async (query: string): Promise<readonly WorkspaceHierarchyNode[]> => {
      let trustedSpaces = spaces.filter((s) => s.trusted);
      if (trustedSpaces.length === 0) {
        await api.ready();
        const def = await api.workspace.openDefault();
        if (def.trusted) trustedSpaces = [def];
      }
      const results = await Promise.all(
        trustedSpaces.map(async (sp) => {
          const list = await api.session.list(sp.id, 1, query);
          return list.items.map(
            (row): WorkspaceHierarchyNode => ({
              sessionKey: buildNativeSessionKey(sp.id, row.conversationId),
              kind: 'native',
              workspaceId: sp.id,
              id: row.conversationId,
              title: row.title || '新对话',
              pinned: Boolean(row.pinned),
              lastActivityAt: row.lastActivityAt,
              harnessLabel: sp.name,
              canArchive: true,
              canPin: true,
              canRename: true,
              children: [],
            }),
          );
        }),
      );
      return results.flat().sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    },
    [api, spaces],
  );

  return {
    harnessCatalog,
    reloadHarnessCatalog,
    refreshingHarnessId,
    refreshHarnessModels,
    managedWorktrees,
    setManagedWorktrees,
    activeTerminalsCount,
    setActiveTerminalsCount,
    evidence,
    reloadEvidence: () => setEvidenceReloadTick((v) => v + 1),
    commandList,
    skillList,
    fileList,
    searchSessionsAcrossSpaces,
  };
}
