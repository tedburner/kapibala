import { useMemo, useState } from 'react';
import type { DesktopAPI } from '../shared/contracts.js';
import { ConnectedSettingsStage, DesktopModalHost } from './app/DesktopDialogs.js';
import { HostRecoveryBanner, failureMessage } from './app/desktop-helpers.js';
import { useDesktopRuntime } from './app/useDesktopRuntime.js';
import { useSessionActions } from './app/useSessionActions.js';
import { useWorkbenchController } from './app/useWorkbenchController.js';
import { useI18n } from './i18n.js';
import { formatStagedTurnHint } from './mode-labels.js';
import {
  buildDraftScopeKey,
  selectInboxItems,
  selectWorkspaceHierarchy,
  useSessionStore,
  useShellStore,
  useWorkspaceStore,
} from './stores/index.js';
import { type ActiveWatchSummaryItem, ComposerDock } from './surfaces/composer/index.js';
import { LaunchpadView } from './surfaces/launchpad/index.js';
import { AppShell } from './surfaces/shell/index.js';
import { SessionStage } from './surfaces/thread/index.js';
import { WorkbenchStage } from './surfaces/workbench/index.js';
import type { ToastItem } from './ui/index.js';

const api: DesktopAPI = window.kapibala;

function detectPlatform(): 'darwin' | 'win32' | 'linux' {
  if (typeof document !== 'undefined') {
    const p = document.documentElement.dataset.platform;
    if (p === 'darwin' || p === 'win32' || p === 'linux') return p;
  }
  return 'win32';
}

/**
 * Kapibala UI 2.0 桌面应用根组件：
 * 组合 `AppShell`、`LaunchpadView`、`SessionStage`、`ComposerDock`、`WorkbenchStage`、`SettingsStage` 与受控模态框集合；
 * 运行与权限裁决唯一真源始终驻留 `agent-host`。
 */
export function App() {
  const { locale, t } = useI18n();
  const [platform] = useState(detectPlatform);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);

  const rt = useDesktopRuntime(api);
  const actions = useSessionActions(api, rt);
  const workbenchProps = useWorkbenchController(api, rt, (childId, wsId) => {
    const sp = rt.spaces.find((s) => s.id === wsId) ?? rt.workspace;
    if (sp) void rt.act(() => actions.openConversation(childId, sp));
  });

  const wsSpaces = useWorkspaceStore((s) => s.spaces);
  const wsHistories = useWorkspaceStore((s) => s.historiesByWorkspace);
  const wsExternal = useWorkspaceStore((s) => s.externalByWorkspace);
  const wsLive = useWorkspaceStore((s) => s.liveStatuses);
  const expandedWorkspaces = useWorkspaceStore((s) => s.expandedWorkspaces);

  const worktreeEnabled = useSessionStore((s) => s.worktreeEnabled);
  const worktreeBranchDraft = useSessionStore((s) => s.worktreeBranchDraft);
  const launchpadScope = buildDraftScopeKey(null, rt.workspace?.id ?? null);
  const launchpadDraft = useSessionStore((s) => s.draftsByKey[launchpadScope] ?? '');

  const inboxItems = useMemo(
    () =>
      selectInboxItems({
        spaces: wsSpaces,
        liveStatuses: wsLive,
        externalByWorkspace: wsExternal,
      }),
    [wsExternal, wsLive, wsSpaces],
  );
  const hierarchies = useMemo(() => {
    const record: Record<string, ReturnType<typeof selectWorkspaceHierarchy>> = {};
    for (const sp of wsSpaces) {
      record[sp.id] = selectWorkspaceHierarchy(
        {
          historiesByWorkspace: wsHistories,
          externalByWorkspace: wsExternal,
          liveStatuses: wsLive,
        },
        sp.id,
      );
    }
    return record;
  }, [wsExternal, wsHistories, wsLive, wsSpaces]);

  const trustedWorkspaceId = rt.workspace?.trusted ? rt.workspace.id : undefined;
  const availableHarnesses =
    rt.harnessCatalog && rt.harnessCatalog.workspaceId === trustedWorkspaceId
      ? rt.harnessCatalog.choices
      : [];

  const stagedHintText = useMemo(
    () =>
      formatStagedTurnHint({
        locale,
        activeExternalHarnessId: rt.activeExternal?.snapshot.session.harnessId,
        activeExtStaged: actions.activeExtStaged,
        hasOpenedNative: Boolean(rt.opened),
        currentNativeRole: rt.opened?.configuration.role,
        activeStagedToExtName: actions.activeStagedToExt?.name,
        activeStagedLocalRole: actions.activeStagedLocal
          ? (actions.activeStagedLocal.role ?? rt.opened?.configuration.role ?? 'default')
          : undefined,
        composerModelName: actions.composerModel?.name,
      }),
    [
      actions.activeExtStaged,
      actions.activeStagedLocal,
      actions.activeStagedToExt,
      actions.composerModel?.name,
      locale,
      rt.activeExternal,
      rt.opened,
    ],
  );

  const activeNotices = rt.activeExternal
    ? rt.activeExternal.snapshot.notices
    : (rt.facts.state?.notices ?? []);

  const toasts = useMemo<readonly ToastItem[]>(() => {
    const diagToasts: ToastItem[] = activeNotices
      .filter((n) => !rt.dismissedNotices[n.id])
      .map((n) => ({ id: `notice:${n.id}`, level: n.level, title: n.text, durationMs: 3000 }));
    const extToasts: ToastItem[] = rt.externalToasts
      .filter((t) => t.sessionId !== rt.activeExternal?.sessionId)
      .map((t) => ({
        id: `ext:${t.id}`,
        level: t.level,
        title: t.text,
        actionLabel: '查看',
        onAction: () => {
          rt.setExternalToasts((prev) => prev.filter((x) => x.id !== t.id));
          const sp = rt.spacesRef.current.find((s) => s.id === t.workspaceId);
          if (sp) void rt.act(() => actions.openExternalSession(sp, t.sessionId));
        },
      }));
    return [...extToasts, ...diagToasts];
  }, [activeNotices, actions, rt]);

  const isReadonlyExternalArchive = Boolean(
    rt.activeExternal && rt.activeThread && !rt.activeThread.capabilities.canContinue,
  );

  const composerDock = (
    <ComposerDock
      thread={rt.activeThread}
      approvalProps={{
        onInspectApproval: (approval) => {
          if (!rt.activeThread) return;
          useShellStore.getState().openWorkbenchTab(rt.activeThread.sessionKey, {
            kind: 'inspector',
            targetKey: `approval:${approval.id}`,
            payload: { approval },
          });
        },
        onJumpToChildSession: (childSessionId) => {
          if (rt.workspace) {
            void rt.act(() => actions.openConversation(childSessionId, rt.workspace));
          }
        },
      }}
      statusStripProps={{
        gitBranch: rt.facts.inspection?.status?.gitBranch,
        contextUsage: rt.facts.inspection?.status?.contextUsage,
        watches: (
          rt.facts.inspection as
            | { readonly watches?: readonly ActiveWatchSummaryItem[] }
            | undefined
        )?.watches,
        onStopRetry: () => void actions.cancelActiveRun(),
        onCancelWatch: rt.opened
          ? (watchId) => {
              void api.run
                .command({
                  workspaceId: rt.opened!.workspaceId,
                  sessionId: rt.opened!.sessionId,
                  input: `/watches cancel ${watchId}`,
                })
                .catch((e) => rt.setError(failureMessage(e)));
            }
          : undefined,
        onOpenPortPreview: (url) => {
          if (!rt.activeThread) return;
          useShellStore.getState().openWorkbenchTab(rt.activeThread.sessionKey, {
            kind: 'preview',
            targetKey: url,
            payload: { url },
          });
        },
      }}
      composerProps={{
        sessionKey: rt.activeThread?.sessionKey ?? null,
        workspaceId: rt.workspace?.id ?? null,
        spaces: wsSpaces,
        busy: rt.busy || isReadonlyExternalArchive,
        placeholder: isReadonlyExternalArchive
          ? t('composer.readonlyArchivePlaceholder')
          : undefined,
        readonlyArchiveActionLabel:
          isReadonlyExternalArchive && rt.activeExternal
            ? t('composer.newExternalSessionBtn', {
                name: rt.activeExternal.snapshot.session.harnessName,
              })
            : undefined,
        onReadonlyArchiveAction:
          isReadonlyExternalArchive && rt.activeExternal
            ? () => {
                const { harnessId, harnessName } = rt.activeExternal!.snapshot.session;
                void rt.act(() =>
                  actions.showNewConversation(rt.workspace, { id: harnessId, name: harnessName }),
                );
              }
            : undefined,
        models: actions.usableModels,
        providers: rt.catalog?.providers ?? [],
        harnesses: availableHarnesses,
        selectedModel: actions.composerModel,
        selectedHarness: actions.composerHarness,
        role: rt.opened ? actions.effectiveRole : undefined,
        refreshingHarnessId: rt.refreshingHarnessId,
        permissionMode: actions.composerMode,
        worktreeEnabled,
        worktreeBranchDraft,
        commandFeedbacks: actions.commandFeedbacks,
        stagedHintText,
        commands: rt.commandList?.commands ?? [],
        skills: rt.skillList?.skills ?? [],
        skillsInstalled: rt.skillList?.installed,
        files: rt.fileList?.files ?? [],
        filesTruncated: rt.fileList?.truncated,
        onLoadReferenceCandidates: async (wsId) =>
          (await api.reference.candidates({ workspaceId: wsId })).items,
        onSearchReferences: async (wsId, query) =>
          (await api.reference.search({ workspaceId: wsId, query })).hits,
        onSend: actions.handleSend,
        onCancel: actions.cancelActiveRun,
        onDismissFeedback: actions.dismissFeedback,
        onSelectModel: actions.chooseModel,
        onSelectRole: rt.opened ? actions.chooseRole : undefined,
        onSelectHarness: actions.chooseHarness,
        onRefreshHarnessModels: (id, opts) => void rt.refreshHarnessModels(id, opts),
        onOpenModelSettings: () => useShellStore.getState().openSettings('providers'),
        onOpenExternalSettings: () => useShellStore.getState().openSettings('external'),
        onSelectWorkspace: (sp) => {
          const target = rt.spaces.find((s) => s.id === sp.id);
          if (target) void rt.act(() => rt.selectSpace(target));
        },
        onCreateProject: () => setProjectDialogOpen(true),
        onSelectPermissionMode: actions.choosePermissionMode,
        onRequestTrustWorkspace: () => {
          if (rt.workspace && !rt.workspace.trusted) rt.setTrustTarget(rt.workspace);
        },
      }}
    />
  );

  const currentPinned = Boolean(
    rt.opened &&
      rt.workspace &&
      rt.histories[rt.workspace.id]?.items.find(
        (i) => i.conversationId === rt.opened?.conversationId,
      )?.pinned,
  );
  const errorBannerText = rt.error || rt.facts.error;

  return (
    <>
      <AppShell
        platform={platform}
        inboxItems={inboxItems}
        spaces={wsSpaces}
        hierarchies={hierarchies}
        historiesByWorkspace={wsHistories}
        activeWorkspaceId={rt.workspace?.id ?? null}
        expandedWorkspaces={expandedWorkspaces}
        newDisabled={rt.busy || !rt.workspace?.trusted}
        enabledHarnesses={availableHarnesses}
        topBanner={
          errorBannerText ? (
            <HostRecoveryBanner
              message={errorBannerText}
              hasOpenSession={Boolean(rt.opened)}
              onRefreshRun={() =>
                rt.opened &&
                void rt.act(() =>
                  rt.client.refreshRun({
                    workspaceId: rt.opened!.workspaceId,
                    sessionId: rt.opened!.sessionId,
                  }),
                )
              }
              onResync={() => void rt.act(() => rt.client.resync())}
              onOpenSettings={() => useShellStore.getState().openSettings('providers')}
              onReconnect={() =>
                void api.app.reconnect().catch((e) => rt.setError(failureMessage(e)))
              }
            />
          ) : null
        }
        toasts={toasts}
        onDismissToast={(id) => {
          if (id.startsWith('notice:')) rt.dismissNotice(id.slice('notice:'.length));
          else if (id.startsWith('ext:')) {
            const raw = id.slice('ext:'.length);
            rt.setExternalToasts((prev) => prev.filter((x) => x.id !== raw));
          }
        }}
        launchpadStage={
          <LaunchpadView
            spaces={wsSpaces}
            activeWorkspaceId={rt.workspace?.id ?? null}
            draft={launchpadDraft}
            composerSlot={composerDock}
            onSelectStarter={(starter) => {
              useSessionStore.getState().setDraft(launchpadScope, starter.prompt);
            }}
          />
        }
        sessionStage={
          rt.activeThread ? (
            <SessionStage
              thread={rt.activeThread}
              workspaceRoot={rt.activeThread.worktree?.worktreePath ?? rt.workspace?.root}
              platform={platform}
              pinned={currentPinned}
              composerSlot={composerDock}
              onToggleRail={() =>
                useShellStore
                  .getState()
                  .toggleRail(typeof window !== 'undefined' ? window.innerWidth : 1280)
              }
              onRenameTitle={
                rt.opened
                  ? (nextTitle) =>
                      rt.act(async () => {
                        await api.session.rename({
                          workspaceId: rt.opened!.workspaceId,
                          conversationId: rt.opened!.conversationId,
                          title: nextTitle,
                        });
                        await rt.refreshHistory();
                      })
                  : undefined
              }
              onTogglePin={
                rt.opened
                  ? () =>
                      actions.togglePinNode(
                        rt.opened!.workspaceId,
                        rt.opened!.conversationId,
                        currentPinned,
                      )
                  : undefined
              }
              onForkSession={rt.opened ? actions.forkSession : undefined}
              onBranchWithSummary={rt.opened ? actions.branchWithSummary : undefined}
              onArchiveSession={
                rt.opened
                  ? () =>
                      actions.archiveNode(
                        rt.opened!.workspaceId,
                        rt.opened!.conversationId,
                        rt.activeThread?.title,
                      )
                  : undefined
              }
              onCloseExternalProcess={
                rt.activeExternal ? actions.closeActiveExternalProcess : undefined
              }
              onCloseSession={() => void actions.closeCurrentSession()}
              onJumpToChildSession={(childId, wsId) => {
                const sp = rt.spaces.find((s) => s.id === wsId) ?? rt.workspace;
                if (sp) void rt.act(() => actions.openConversation(childId, sp));
              }}
              onRegenerate={(turn) => actions.regenerateLastTurn(false, turn)}
              onRestoreAndRetry={(turn) => actions.regenerateLastTurn(true, turn)}
              onRestoreCheckpoint={(turn) => {
                if (turn.checkpointOrdinal !== undefined) {
                  actions.openTurnCheckpointDiff(turn.checkpointOrdinal);
                }
              }}
              onEditUserMessage={(text) => {
                if (!rt.activeThread) return;
                useSessionStore.getState().setDraft(rt.activeThread.sessionKey, text);
              }}
              onContinue={
                rt.opened
                  ? () => void actions.handleSend({ text: '继续', references: [] })
                  : undefined
              }
              onReport={rt.setError}
            />
          ) : null
        }
        workbenchStage={workbenchProps ? <WorkbenchStage {...workbenchProps} /> : undefined}
        settingsStage={<ConnectedSettingsStage api={api} rt={rt} actions={actions} />}
        onNewConversation={() => void rt.act(() => actions.showNewConversation(rt.workspace))}
        onCreateProject={() => setProjectDialogOpen(true)}
        onToggleWorkspace={(wsId) => useWorkspaceStore.getState().toggleWorkspaceExpanded(wsId)}
        onSelectWorkspace={(sp) => {
          const target = rt.spaces.find((s) => s.id === sp.id);
          if (target) void rt.act(() => rt.selectSpace(target));
        }}
        onNewInWorkspace={(sp) => {
          const target = rt.spaces.find((s) => s.id === sp.id);
          if (target) void rt.act(() => actions.showNewConversation(target));
        }}
        onSelectInboxSession={actions.handleInboxSelect}
        onSelectTreeSession={actions.handleTreeNodeSelect}
        onSearchSessions={rt.searchSessionsAcrossSpaces}
        onLaunchExternalHarness={(harnessId) => {
          const found = availableHarnesses.find((h) => h.id === harnessId);
          if (found) {
            void rt.act(() =>
              actions.showNewConversation(rt.workspace, { id: found.id, name: found.name }),
            );
          }
        }}
        onRenameSession={(node) =>
          actions.setPendingRename({
            workspaceId: node.workspaceId,
            conversationId: node.id,
            title: node.title,
          })
        }
        onTogglePinSession={(node) => actions.togglePinNode(node.workspaceId, node.id, node.pinned)}
        onArchiveSession={(node) => actions.archiveNode(node.workspaceId, node.id, node.title)}
        onDeleteSession={actions.requestDeleteNode}
        onPageChange={(sp, page) => {
          const target = rt.spaces.find((s) => s.id === sp.id);
          if (target) void rt.act(() => rt.refreshHistory(target, page));
        }}
      />

      <DesktopModalHost
        api={api}
        rt={rt}
        actions={actions}
        projectDialogOpen={projectDialogOpen}
        onProjectDialogOpenChange={setProjectDialogOpen}
      />
    </>
  );
}
