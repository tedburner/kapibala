import { useCallback, useEffect, useState } from 'react';
import type { DesktopAPI, Workspace } from '../../shared/contracts.js';
import { type UnifiedTurn, parseSessionKey } from '../adapters/index.js';
import { type WorkspaceHierarchyNode, useSessionStore } from '../stores/index.js';
import type {
  CommandFeedbackItem,
  ComposerPermissionMode,
  ComposerSendPayload,
  NativeSessionRole,
  SelectedExternalHarness,
} from '../surfaces/composer/index.js';
import { failureMessage, findLastUserPrompt } from './desktop-helpers.js';
import { executeComposerSend, prependCommandFeedback } from './useComposerSend.js';
import type { OpenedSession, useDesktopRuntime } from './useDesktopRuntime.js';
import type { StagedExternalNext } from './useExternalHandoffs.js';
import { useSessionLifecycle } from './useSessionLifecycle.js';

type RuntimeBag = ReturnType<typeof useDesktopRuntime>;

const scopeOf = (opened: OpenedSession) => ({
  workspaceId: opened.workspaceId,
  sessionId: opened.sessionId,
});

/**
 * 会话发送、模型/角色/外部代理下一轮暂存与内联审批回传协调 Hook。
 */
export function useSessionActions(api: DesktopAPI, rt: RuntimeBag) {
  const [pendingProfile, setPendingProfile] = useState<string>();
  const [pendingMode, setPendingMode] = useState<ComposerPermissionMode>();
  const [pendingHarness, setPendingHarness] = useState<SelectedExternalHarness>();
  const [stagedLocalConfig, setStagedLocalConfig] = useState<{
    readonly conversationId: string;
    readonly profileId?: string;
    readonly role?: NativeSessionRole;
  }>();
  const [stagedLocalToExternal, setStagedLocalToExternal] = useState<{
    readonly conversationId: string;
    readonly harness: SelectedExternalHarness;
  }>();
  const [stagedExternalNext, setStagedExternalNext] = useState<StagedExternalNext>();
  const [fullAccessOpen, setFullAccessOpen] = useState(false);
  const [commandFeedbacks, setCommandFeedbacks] = useState<readonly CommandFeedbackItem[]>([]);

  const lifecycle = useSessionLifecycle(api, rt);

  const usableModels = (rt.catalog?.profiles ?? []).filter(
    (model) => model.credential.configured && !model.disabled,
  );
  const defaultModel =
    usableModels.find((m) => m.id === rt.catalog?.defaultModel) ?? usableModels[0];

  const activeStagedLocal =
    rt.opened && stagedLocalConfig?.conversationId === rt.opened.conversationId
      ? stagedLocalConfig
      : undefined;
  const activeStagedToExt =
    rt.opened && stagedLocalToExternal?.conversationId === rt.opened.conversationId
      ? stagedLocalToExternal.harness
      : undefined;
  const activeExtStaged =
    rt.activeExternal && stagedExternalNext?.sessionId === rt.activeExternal.sessionId
      ? stagedExternalNext
      : undefined;

  const effectiveProfileId = activeStagedLocal?.profileId ?? rt.opened?.configuration.profileId;
  const effectiveRole = activeStagedLocal?.role ?? rt.opened?.configuration.role;

  const composerModel = rt.activeExternal
    ? activeExtStaged?.kind === 'local'
      ? (usableModels.find((m) => m.id === activeExtStaged.profileId) ?? defaultModel)
      : undefined
    : rt.opened
      ? (usableModels.find((m) => m.id === effectiveProfileId) ??
        rt.catalog?.profiles.find((m) => m.id === effectiveProfileId))
      : (usableModels.find((m) => m.id === pendingProfile) ?? defaultModel);

  const composerHarness: SelectedExternalHarness | undefined = rt.activeExternal
    ? activeExtStaged?.kind === 'local'
      ? undefined
      : activeExtStaged?.kind === 'external'
        ? activeExtStaged.harness
        : (() => {
            const opts = rt.activeExternal.snapshot.configOptions ?? [];
            const cur = (cat: 'model' | 'thought_level' | 'mode') => {
              const o = opts.find((x) => x.category === cat);
              const val = o?.currentValue;
              if (!val) return undefined;
              const label = o?.options.find((c) => c.value === val)?.name ?? val;
              return { val, label, isDefault: o?.options[0]?.value === val };
            };
            const m = cur('model');
            const t = cur('thought_level');
            const md = cur('mode');
            const mdName = md && !md.isDefault ? md.label.replace(/\s*[（(].*$/, '').trim() : '';
            return {
              id: rt.activeExternal.snapshot.session.harnessId,
              name: rt.activeExternal.snapshot.session.harnessName,
              ...(m ? { modelId: m.val, modelName: m.label } : {}),
              ...(t ? { thoughtLevel: t.val, thoughtLevelName: t.label } : {}),
              ...(md ? { modeId: md.val, ...(mdName ? { modeName: mdName } : {}) } : {}),
            };
          })()
    : rt.opened
      ? activeStagedToExt
      : pendingHarness;

  const composerMode: ComposerPermissionMode =
    rt.opened?.configuration.mode ?? pendingMode ?? rt.catalog?.permissionMode ?? 'Approval';

  const currentWorktreeOption = () => {
    const store = useSessionStore.getState();
    if (!store.worktreeEnabled || rt.workspace?.kind !== 'project') return undefined;
    const branch = store.worktreeBranchDraft.trim();
    return { enabled: true as const, ...(branch ? { branch } : {}) };
  };

  const resetWorktreeDraft = () => {
    const store = useSessionStore.getState();
    store.setWorktreeEnabled(false);
    store.setWorktreeBranchDraft('');
  };

  const showNewConversation = useCallback(
    async (space: Workspace | undefined = rt.workspace, harness?: SelectedExternalHarness) => {
      if (!space) return;
      if (!space.trusted) return void rt.setTrustTarget(space);
      if (space.id !== rt.currentSpaceRef.current?.id) await rt.selectSpace(space);
      else {
        rt.setOpened(undefined);
        await rt.client.clear();
        await rt.detachActiveExternal();
        useSessionStore.getState().openLaunchpad();
      }
      setPendingHarness(harness);
      setPendingMode(undefined);
      setStagedLocalConfig(undefined);
      setStagedLocalToExternal(undefined);
      setCommandFeedbacks([]);
      if (typeof document !== 'undefined') {
        requestAnimationFrame(() =>
          document.querySelector<HTMLTextAreaElement>('textarea.kpbl-omni-textarea')?.focus(),
        );
      }
    },
    [rt],
  );

  const openConversation = useCallback(
    async (conversationId: string, space: Workspace | undefined = rt.workspace) => {
      if (!space) return;
      if (!space.trusted) return void rt.setTrustTarget(space);
      if (space.id !== rt.currentSpaceRef.current?.id) await rt.selectSpace(space);
      else await rt.detachActiveExternal();
      const navToken = ++rt.externalNavGen.current;
      const result = await api.session.open({ workspaceId: space.id, conversationId });
      if (navToken !== rt.externalNavGen.current) {
        await api.session.close(scopeOf(result)).catch(() => {});
        return;
      }
      rt.activeExternalRef.current = undefined;
      rt.setActiveExternal(undefined);
      setStagedLocalConfig(undefined);
      setStagedLocalToExternal(undefined);
      setCommandFeedbacks([]);
      rt.setOpened(result);
      await rt.client.select(scopeOf(result));
      await rt.refreshHistory(space);
    },
    [api, rt],
  );

  const openExternalSession = useCallback(
    async (space: Workspace, sessionId: string) => {
      if (!space.trusted) return void rt.setTrustTarget(space);
      if (space.id !== rt.currentSpaceRef.current?.id) await rt.selectSpace(space);
      else {
        rt.setOpened(undefined);
        await rt.client.clear();
        await rt.detachActiveExternal();
      }
      const navToken = ++rt.externalNavGen.current;
      const subscriptionId = crypto.randomUUID();
      const snapshot = await api.external.subscribe({
        workspaceId: space.id,
        sessionId,
        subscriptionId,
      });
      if (navToken !== rt.externalNavGen.current) {
        await api.external.unsubscribe(subscriptionId).catch(() => {});
        return;
      }
      const next = { workspaceId: space.id, sessionId, subscriptionId, snapshot };
      rt.activeExternalRef.current = next;
      rt.setActiveExternal(next);
      setStagedExternalNext(undefined);
      setCommandFeedbacks([]);
      rt.setExternalToasts((prev) => prev.filter((item) => item.sessionId !== sessionId));
      await rt.refreshExternalList(space.id);
    },
    [api, rt],
  );

  const createNativeSession = async (space: Workspace, explicitProfileId?: string) => {
    const profileId = explicitProfileId ?? composerModel?.id;
    const wt = currentWorktreeOption();
    const result = await api.session.create({
      workspaceId: space.id,
      ...(profileId ? { profileId } : {}),
      ...(wt ? { worktree: wt } : {}),
    });
    const reqProfile =
      profileId && profileId !== result.configuration.profileId ? profileId : undefined;
    const reqMode =
      pendingMode && pendingMode !== result.configuration.mode ? pendingMode : undefined;
    const configuration =
      reqProfile || reqMode
        ? await api.session.configure({
            ...scopeOf(result),
            ...(reqProfile ? { profileId: reqProfile } : {}),
            ...(reqMode ? { mode: reqMode } : {}),
            ...(reqMode === 'FullAccess' ? { confirmFullAccess: true } : {}),
          })
        : result.configuration;
    setPendingProfile(undefined);
    setPendingMode(undefined);
    resetWorktreeDraft();
    rt.setOpened({ ...result, configuration });
    await rt.client.select(scopeOf(result));
    await rt.client.whenReady();
    return { ...result, configuration };
  };

  const flushStagedOpenedConfig = async (target: OpenedSession) => {
    if (stagedLocalConfig?.conversationId !== target.conversationId) return;
    const nextProfile =
      stagedLocalConfig.profileId && stagedLocalConfig.profileId !== target.configuration.profileId
        ? stagedLocalConfig.profileId
        : undefined;
    const nextRole =
      stagedLocalConfig.role && stagedLocalConfig.role !== target.configuration.role
        ? stagedLocalConfig.role
        : undefined;
    setStagedLocalConfig(undefined);
    if (!nextProfile && !nextRole) return;
    const configuration = await api.session.configure({
      ...scopeOf(target),
      ...(nextProfile ? { profileId: nextProfile } : {}),
      ...(nextRole ? { role: nextRole } : {}),
    });
    rt.setOpened((prev) =>
      prev && prev.sessionId === target.sessionId ? { ...prev, configuration } : prev,
    );
  };

  const replyApproval = useCallback(
    async (params: {
      readonly sessionKey: string;
      readonly approvalId: string;
      readonly actionId: string;
      readonly source: 'native' | 'delegation' | 'external';
    }) => {
      if (params.source === 'external') {
        const cur = rt.activeExternalRef.current;
        if (!cur) return;
        const isCancel = params.actionId === '__cancel__';
        await api.external.approve({
          workspaceId: cur.workspaceId,
          sessionId: cur.sessionId,
          approvalId: params.approvalId,
          ...(isCancel ? { cancel: true } : { optionId: params.actionId }),
        });
        return;
      }
      const approval = rt.facts.approvals.find((a) => a.approvalId === params.approvalId);
      if (!approval) return;
      try {
        await api.approval.reply({
          workspaceId: approval.workspaceId,
          sessionId: approval.sessionId,
          runId: approval.runId,
          approvalId: approval.approvalId,
          choice: params.actionId as 'allow_once' | 'allow_session' | 'deny_once',
        });
        rt.client.dismissApproval(approval.approvalId);
      } catch (reason) {
        const code = (reason as { code?: string } | undefined)?.code;
        const msg = failureMessage(reason);
        if (
          code === 'APPROVAL_EXPIRED' ||
          code === 'SESSION_NOT_FOUND' ||
          code === 'SESSION_CLOSED' ||
          code === 'HOST_UNAVAILABLE' ||
          msg.includes('CONTROL_CLOSED') ||
          msg.includes('PEER_CLOSED')
        ) {
          rt.client.dismissApproval(approval.approvalId);
        }
        rt.setError(msg);
      }
    },
    [api, rt],
  );

  useEffect(() => {
    useSessionStore.getState().setBridge({ replyApproval });
  }, [replyApproval]);

  return {
    ...lifecycle,
    usableModels,
    composerModel,
    composerHarness,
    composerMode,
    effectiveRole,
    activeStagedLocal,
    activeStagedToExt,
    activeExtStaged,
    fullAccessOpen,
    setFullAccessOpen,
    confirmFullAccess: () =>
      rt.act(async () => {
        if (rt.opened) {
          const configuration = await api.session.configure({
            ...scopeOf(rt.opened),
            mode: 'FullAccess',
            confirmFullAccess: true,
          });
          rt.setOpened((prev) => (prev ? { ...prev, configuration } : prev));
        } else setPendingMode('FullAccess');
        setFullAccessOpen(false);
      }),
    commandFeedbacks,
    dismissFeedback: (id: string) => setCommandFeedbacks((p) => p.filter((x) => x.id !== id)),
    showNewConversation,
    openConversation,
    openExternalSession,
    handleSend: (payload: ComposerSendPayload) =>
      executeComposerSend({
        api,
        rt,
        payload,
        composerModel,
        composerHarness,
        activeExtStaged,
        activeStagedToExt,
        currentWorktreeOption,
        resetWorktreeDraft,
        createNativeSession,
        openExternalSession,
        flushStagedOpenedConfig,
        pushCommandFeedback: (lines) =>
          setCommandFeedbacks((prev) => prependCommandFeedback(prev, lines)),
        clearStagedExternal: () => setStagedExternalNext(undefined),
        clearStagedLocalToExt: () => {
          setPendingHarness(undefined);
          setStagedLocalToExternal(undefined);
          setStagedLocalConfig(undefined);
        },
      }),
    chooseModel: (profileId: string) => {
      void api.settings
        .setDefault(profileId)
        .then(rt.reloadCatalog)
        .catch((e) => rt.setError(failureMessage(e)));
      if (rt.activeExternal) {
        return void setStagedExternalNext({
          sessionId: rt.activeExternal.sessionId,
          kind: 'local',
          profileId,
        });
      }
      if (!rt.opened) {
        setPendingProfile(profileId);
        return void setPendingHarness(undefined);
      }
      setStagedLocalToExternal(undefined);
      const role = effectiveRole ?? rt.opened.configuration.role;
      setStagedLocalConfig(
        profileId === rt.opened.configuration.profileId && role === rt.opened.configuration.role
          ? undefined
          : { conversationId: rt.opened.conversationId, profileId, role },
      );
    },
    chooseRole: (nextRole: NativeSessionRole) => {
      if (!rt.opened) return;
      setStagedLocalToExternal(undefined);
      const profileId = effectiveProfileId ?? rt.opened.configuration.profileId;
      setStagedLocalConfig(
        profileId === rt.opened.configuration.profileId && nextRole === rt.opened.configuration.role
          ? undefined
          : { conversationId: rt.opened.conversationId, profileId, role: nextRole },
      );
    },
    chooseHarness: (choice: SelectedExternalHarness) => {
      if (rt.activeExternal) {
        setStagedExternalNext({
          sessionId: rt.activeExternal.sessionId,
          kind: 'external',
          harness: choice,
        });
      } else if (rt.opened) {
        setStagedLocalToExternal({ conversationId: rt.opened.conversationId, harness: choice });
      } else setPendingHarness(choice);
    },
    choosePermissionMode: (mode: ComposerPermissionMode) => {
      if (mode === 'FullAccess') setFullAccessOpen(true);
      else if (rt.opened) {
        void rt.act(async () => {
          const configuration = await api.session.configure({ ...scopeOf(rt.opened!), mode });
          rt.setOpened((prev) => (prev ? { ...prev, configuration } : prev));
        });
      } else setPendingMode(mode);
    },
    handleTreeNodeSelect: (node: WorkspaceHierarchyNode) => {
      const space = rt.spaces.find((s) => s.id === node.workspaceId);
      if (!space) return;
      if (node.kind === 'external') void rt.act(() => openExternalSession(space, node.id));
      else void rt.act(() => openConversation(node.id, space));
    },
    handleInboxSelect: (sessionKey: string, workspaceId: string) => {
      const space = rt.spaces.find((s) => s.id === workspaceId);
      const parsed = parseSessionKey(sessionKey);
      if (!space || !parsed) return;
      if (parsed.kind === 'external')
        void rt.act(() => openExternalSession(space, parsed.sessionId));
      else void rt.act(() => openConversation(parsed.conversationId, space));
    },
    regenerateLastTurn: (restoreFiles = false, targetTurn?: UnifiedTurn) => {
      if (!rt.opened || rt.busy) return;
      const targetMessageId = targetTurn?.userMessage?.id;
      const prompt = targetTurn?.userMessage?.text?.trim() || findLastUserPrompt(rt.messages);
      if (!prompt) return;
      void rt.act(async () => {
        await flushStagedOpenedConfig(rt.opened!);
        if (restoreFiles || targetMessageId) {
          await api.run.regenerate({
            ...scopeOf(rt.opened!),
            operationId: crypto.randomUUID(),
            ...(restoreFiles ? { restoreFiles: true } : {}),
            ...(targetMessageId ? { targetMessageId } : {}),
          });
          rt.reloadCheckpoints();
        } else await rt.client.start(scopeOf(rt.opened!), prompt, { regenerate: true });
      });
    },
  };
}
