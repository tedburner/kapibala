import type {
  ViewCheckpointItem,
  ViewFileDiff,
  ViewTool,
} from '@kiturone/kapibala-host/view-model';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { DesktopAPI } from '../../shared/contracts.js';
import {
  buildDraftScopeKey,
  selectSessionWorkbench,
  useSessionStore,
  useShellStore,
} from '../stores/index.js';
import type { DiffScopeMode, WorkbenchStageProps } from '../surfaces/workbench/index.js';
import { failureMessage } from './desktop-helpers.js';
import type { useDesktopRuntime } from './useDesktopRuntime.js';

type RuntimeBag = ReturnType<typeof useDesktopRuntime>;

/**
 * 右侧五标签工程工作台（`变更` / `预览` / `文件` / `终端` / `详情与证据`）实时数据与动作控制器。
 */
export function useWorkbenchController(
  api: DesktopAPI,
  rt: RuntimeBag,
  onOpenDelegationConversation: (childSessionId: string, workspaceId: string) => void,
): WorkbenchStageProps | undefined {
  const sessionKey = rt.activeThread?.sessionKey ?? null;
  const workbenchBySession = useShellStore((s) => s.workbenchBySession);
  const wbState = selectSessionWorkbench({ workbenchBySession }, sessionKey);

  const [diffScope, setDiffScope] = useState<DiffScopeMode>('session');
  const [selectedCpOrdinal, setSelectedCpOrdinal] = useState<number | undefined>(undefined);
  const [checkpoints, setCheckpoints] = useState<readonly ViewCheckpointItem[]>([]);
  const [diffFiles, setDiffFiles] = useState<readonly ViewFileDiff[]>([]);
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffError, setDiffError] = useState('');
  const [diffRefreshTick, setDiffRefreshTick] = useState(0);
  const [selectedShellBySession, setSelectedShellBySession] = useState<Record<string, string>>({});
  const [terminalRestartGen, setTerminalRestartGen] = useState<Record<string, number>>({});

  const workspaceId = rt.activeExternal?.workspaceId ?? rt.opened?.workspaceId ?? rt.workspace?.id;
  const activeWorktree = rt.activeThread?.worktree;
  const executionRoot = activeWorktree?.worktreePath ?? rt.workspace?.root;

  const activeTab = useMemo(
    () => wbState.tabs.find((t) => t.id === wbState.activeTabId) ?? wbState.tabs[0],
    [wbState.activeTabId, wbState.tabs],
  );
  const activeKind = activeTab?.kind ?? 'inspector';
  const hasTerminalTab =
    wbState.open && (activeKind === 'terminal' || wbState.tabs.some((t) => t.kind === 'terminal'));

  // 切换会话时重置 Diff 局部范围游标。
  const [scopeOwner, setScopeOwner] = useState(sessionKey);
  if (scopeOwner !== sessionKey) {
    setScopeOwner(sessionKey);
    setDiffScope('session');
    setSelectedCpOrdinal(undefined);
    setCheckpoints([]);
    setDiffFiles([]);
    setDiffError('');
  }

  // 当工作台打开在「变更」标签（或会话累计 diffSummary 变化）时拉取真实检查点与 Diff 补丁。
  const diffTabPayloadOrdinal =
    typeof activeTab?.payload?.turnOrdinal === 'number' ? activeTab.payload.turnOrdinal : undefined;
  const diffTabWorktreeMerge = activeTab?.payload?.mode === 'worktree-merge';

  useEffect(() => {
    if (diffTabPayloadOrdinal !== undefined) {
      setDiffScope('checkpoint');
      setSelectedCpOrdinal(diffTabPayloadOrdinal);
    } else if (diffTabWorktreeMerge && activeWorktree) {
      setDiffScope('worktree_base');
    }
  }, [activeWorktree, diffTabPayloadOrdinal, diffTabWorktreeMerge]);

  const diffSummaryKey = [
    rt.run?.phase ?? 'idle',
    rt.facts.state?.operation?.phase ?? 'idle',
    rt.facts.state?.diffSummary?.additions ?? 'x',
    rt.facts.state?.diffSummary?.deletions ?? 'x',
    rt.activeThread?.diffSummary?.additions ?? 0,
    rt.activeThread?.diffSummary?.deletions ?? 0,
    rt.activeExternal?.snapshot.session.status ?? '',
    diffRefreshTick,
  ].join(':');
  // biome-ignore lint/correctness/useExhaustiveDependencies: diffSummaryKey 在检查点更新或还原后驱动重拉。
  useEffect(() => {
    if (!wbState.open || activeKind !== 'diff' || !workspaceId || !sessionKey) return;
    let cancelled = false;
    setDiffLoading(true);
    setDiffError('');

    const cpTarget = rt.activeExternal
      ? { workspaceId, externalSessionId: rt.activeExternal.sessionId }
      : rt.opened
        ? {
            workspaceId,
            sessionId: rt.opened.sessionId,
            conversationId: rt.opened.conversationId,
          }
        : undefined;

    const load = async () => {
      if (cpTarget) {
        const cpRes = await api.checkpoint.list(cpTarget).catch(() => ({ items: [] }));
        if (!cancelled) setCheckpoints(cpRes.items);
      }
      if (diffScope === 'worktree_base' && activeWorktree) {
        const wtDiff = await api.worktree.diff({ workspaceId, id: activeWorktree.id });
        if (!cancelled) setDiffFiles(wtDiff.files);
        return;
      }
      if (!cpTarget) {
        if (!cancelled) setDiffFiles([]);
        return;
      }
      const res = await api.checkpoint.diff({
        ...cpTarget,
        ...(diffScope === 'checkpoint' && selectedCpOrdinal !== undefined
          ? { ordinal: selectedCpOrdinal }
          : { includeLiveWorktree: true }),
      });
      if (!cancelled) setDiffFiles(res.files);
    };

    void load()
      .catch((err) => {
        if (!cancelled) setDiffError(failureMessage(err));
      })
      .finally(() => {
        if (!cancelled) setDiffLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeKind,
    activeWorktree,
    api,
    diffScope,
    diffSummaryKey,
    rt.activeExternal,
    rt.opened,
    selectedCpOrdinal,
    sessionKey,
    wbState.open,
    workspaceId,
  ]);

  // 当首次激活「终端」标签时懒拉起会话级保活 PTY 终端（仅订阅稳定 setter 与 shell 字符串，杜绝流式增量取消在途 ensure）。
  const currentTermSnap = sessionKey ? rt.terminalBySession[sessionKey] : undefined;
  const { preferredShell, setTerminalBySession } = rt;
  useEffect(() => {
    if (!hasTerminalTab || !workspaceId || !sessionKey || currentTermSnap) return;
    let cancelled = false;
    const shellPref = preferredShell !== 'auto' ? preferredShell : undefined;
    void api.terminal
      .ensure({
        workspaceId,
        sessionKey,
        ...(shellPref ? { shellId: shellPref } : {}),
      })
      .then((snap) => {
        if (cancelled) return;
        setTerminalBySession((prev) => ({ ...prev, [sessionKey]: snap }));
      })
      .catch((err) => {
        if (cancelled) return;
        setTerminalBySession((prev) => ({
          ...prev,
          [sessionKey]: {
            terminals: [],
            shells: [],
            unavailableReason: failureMessage(err),
          },
        }));
      });
    return () => {
      cancelled = true;
    };
  }, [
    api,
    currentTermSnap,
    hasTerminalTab,
    preferredShell,
    sessionKey,
    setTerminalBySession,
    workspaceId,
  ]);

  const allTools = useMemo<readonly ViewTool[]>(() => {
    const msgs = rt.activeExternal ? rt.activeExternal.snapshot.messages : rt.messages;
    return msgs.flatMap((m) => m.blocks.flatMap((b) => (b.tool ? [b.tool] : [])));
  }, [rt.activeExternal, rt.messages]);

  const insertFileMention = useCallback(
    (_path: string, formattedMention: string) => {
      const key = buildDraftScopeKey(sessionKey, workspaceId);
      const store = useSessionStore.getState();
      const prev = store.draftsByKey[key] ?? '';
      const prefix = prev && !/\s$/.test(prev) ? `${prev} ` : prev;
      store.setDraft(key, `${prefix}${formattedMention}`);
    },
    [sessionKey, workspaceId],
  );

  if (!sessionKey || !workspaceId) return undefined;

  const cpBaseParams = rt.activeExternal
    ? { workspaceId, externalSessionId: rt.activeExternal.sessionId }
    : rt.opened
      ? {
          workspaceId,
          sessionId: rt.opened.sessionId,
          conversationId: rt.opened.conversationId,
        }
      : { workspaceId };

  const selectedShell =
    selectedShellBySession[sessionKey] ??
    (rt.preferredShell !== 'auto' ? rt.preferredShell : currentTermSnap?.shells[0]?.id);

  return {
    sessionKey,
    diffProps: {
      files: diffFiles,
      checkpoints,
      worktree: activeWorktree,
      isExternalSession: Boolean(rt.activeExternal),
      selectedScope: diffScope,
      selectedCheckpointOrdinal: selectedCpOrdinal,
      loading: diffLoading,
      error: diffError || undefined,
      onScopeChange: (nextScope, ord) => {
        setDiffScope(nextScope);
        if (ord !== undefined) setSelectedCpOrdinal(ord);
      },
      onSelectCheckpoint: (ord) => {
        setDiffScope('checkpoint');
        setSelectedCpOrdinal(ord);
      },
      onRestoreCheckpoint: async (targetOrdinal, force) => {
        const res = await api.checkpoint.restore({
          ...cpBaseParams,
          targetOrdinal,
          ...(force ? { force: true } : {}),
        });
        setDiffRefreshTick((v) => v + 1);
        rt.reloadEvidence();
        rt.reloadCheckpoints();
        if (res.status === 'conflict') {
          return { status: 'conflict' as const, conflicts: res.conflicts };
        }
        if (res.status === 'noop') {
          return { status: 'error' as const, message: '当前检查点无需还原（无后续改动）' };
        }
        return {
          status: 'restored' as const,
          restoredCount: res.restoredFiles.length + res.deletedFiles.length,
        };
      },
      onPreviewMerge: (worktreeId) => api.worktree.previewMerge({ workspaceId, id: worktreeId }),
      onApplyMerge: async (params) => {
        const res = await api.worktree.applyMerge({
          workspaceId,
          id: params.worktreeId,
          previewToken: params.previewToken,
          ...(params.commitMessage ? { commitMessage: params.commitMessage } : {}),
        });
        setDiffRefreshTick((v) => v + 1);
        return res;
      },
      onResolveConflictWithAgent: (prompt) => {
        const key = buildDraftScopeKey(sessionKey, workspaceId);
        useSessionStore.getState().setDraft(key, prompt);
      },
    },
    previewProps: {
      workspaceRoot: executionRoot,
      onCreatePreviewUrl: (doc) => api.preview.url(doc),
      onLoadPreviewFile: (p) => api.preview.file(p),
      onOpenExternal: (url) => api.app.openExternal(url),
    },
    filesProps: {
      files: rt.fileList?.files ?? [],
      filesTruncated: rt.fileList?.truncated ?? false,
      onSearchFiles: (query) =>
        api.workspace.listFiles({
          workspaceId,
          query,
          ...(activeWorktree ? { worktreeId: activeWorktree.id } : {}),
        }),
      onReadFile: (filePath) =>
        api.workspace.readFile({
          workspaceId,
          path: filePath,
          ...(activeWorktree ? { worktreeId: activeWorktree.id } : {}),
        }),
      onInsertFileReference: insertFileMention,
    },
    terminalProps: {
      repoLabel: activeWorktree
        ? `${rt.workspace?.name ?? ''} (${activeWorktree.branch})`
        : rt.workspace?.name,
      terminals: (currentTermSnap?.terminals ?? []).map((t) => ({
        ...t,
        generation: terminalRestartGen[`${sessionKey}:${t.id}`] ?? 0,
      })),
      activeTerminalId: currentTermSnap?.activeTerminalId,
      shells: currentTermSnap?.shells ?? [],
      selectedShell,
      unavailableReason: currentTermSnap?.unavailableReason,
      onSelectShell: (shellId) =>
        setSelectedShellBySession((prev) => ({ ...prev, [sessionKey]: shellId })),
      onSelectTerminal: (terminalId) =>
        rt.setTerminalBySession((prev) => {
          const cur = prev[sessionKey];
          return cur ? { ...prev, [sessionKey]: { ...cur, activeTerminalId: terminalId } } : prev;
        }),
      onCreateTerminal: (shellId) => {
        void api.terminal
          .create({ workspaceId, sessionKey, ...(shellId ? { shellId } : {}) })
          .then((snap) => rt.setTerminalBySession((prev) => ({ ...prev, [sessionKey]: snap })))
          .catch((e) => rt.setError(failureMessage(e)));
      },
      onRestartTerminal: (terminalId) => {
        void api.terminal
          .create({
            workspaceId,
            sessionKey,
            replaceTerminalId: terminalId,
            ...(selectedShell ? { shellId: selectedShell } : {}),
          })
          .then((snap) => {
            const genKey = `${sessionKey}:${terminalId}`;
            setTerminalRestartGen((prev) => ({ ...prev, [genKey]: (prev[genKey] ?? 0) + 1 }));
            rt.setTerminalBySession((prev) => ({ ...prev, [sessionKey]: snap }));
          })
          .catch((e) => rt.setError(failureMessage(e)));
      },
      onWriteTerminal: (terminalId, data) => {
        void api.terminal.write({ workspaceId, sessionKey, terminalId, data }).catch(() => {});
      },
      onResizeTerminal: (terminalId, cols, rows) => {
        void api.terminal
          .resize({ workspaceId, sessionKey, terminalId, cols, rows })
          .catch(() => {});
      },
      onClearTerminal: (terminalId) => {
        void api.terminal
          .clear({ workspaceId, sessionKey, terminalId })
          .then(() =>
            rt.setTerminalBySession((prev) => {
              const cur = prev[sessionKey];
              if (!cur) return prev;
              return {
                ...prev,
                [sessionKey]: {
                  ...cur,
                  terminals: cur.terminals.map((t) =>
                    t.id === terminalId ? { ...t, replayBuffer: '' } : t,
                  ),
                },
              };
            }),
          )
          .catch(() => {});
      },
      onCloseTerminal: (terminalId) => {
        void api.terminal
          .close({ workspaceId, sessionKey, terminalId })
          .then((snap) => rt.setTerminalBySession((prev) => ({ ...prev, [sessionKey]: snap })))
          .catch((e) => rt.setError(failureMessage(e)));
      },
    },
    inspectorProps: {
      tools: allTools,
      workspaceRoot: rt.workspace?.root,
      executionRoot,
      conversationId: rt.opened?.conversationId ?? rt.activeExternal?.sessionId,
      evidence: rt.evidence,
      onReloadEvidence: rt.reloadEvidence,
      onOpenDelegationSession: (childSessionId) =>
        onOpenDelegationConversation(childSessionId, workspaceId),
      onOpenDiffFile: (filePath, callId) => {
        useShellStore.getState().openWorkbenchTab(sessionKey, {
          kind: 'diff',
          targetKey: filePath,
          payload: { filePath, callId },
        });
      },
    },
  };
}
