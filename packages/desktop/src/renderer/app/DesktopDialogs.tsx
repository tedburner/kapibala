import type { DesktopAPI } from '../../shared/contracts.js';
import { useShellStore } from '../stores/index.js';
import {
  ExternalSessionDeleteDialog,
  FullAccessConfirmDialog,
  ProjectDialog,
  SessionArchiveDialog,
  SessionDeleteDialog,
  SessionRenameDialog,
  WorkspaceTrustDialog,
} from '../surfaces/dialogs/index.js';
import { SettingsStage } from '../surfaces/settings/index.js';
import { InteractionPromptDialog, failureMessage } from './desktop-helpers.js';
import type { useDesktopRuntime } from './useDesktopRuntime.js';
import type { useSessionActions } from './useSessionActions.js';

type RuntimeBag = ReturnType<typeof useDesktopRuntime>;
type ActionsBag = ReturnType<typeof useSessionActions>;

/**
 * 壳内设置主舞台装配容器：将 `useDesktopRuntime` 与 `useSessionActions` 桥接至 `SettingsStage`。
 */
export function ConnectedSettingsStage({
  api,
  rt,
  actions,
}: {
  readonly api: DesktopAPI;
  readonly rt: RuntimeBag;
  readonly actions: ActionsBag;
}) {
  return (
    <SettingsStage
      catalog={rt.catalog}
      reloadCatalog={rt.reloadCatalog}
      report={rt.setError}
      spaces={rt.spaces}
      workspaceId={
        rt.activeExternal?.workspaceId ??
        rt.opened?.workspaceId ??
        (rt.workspace?.trusted ? rt.workspace.id : undefined) ??
        rt.spaces.find((s) => s.trusted)?.id
      }
      activeSessionScope={
        rt.opened
          ? { workspaceId: rt.opened.workspaceId, sessionId: rt.opened.sessionId }
          : undefined
      }
      currentSessionMode={actions.composerMode}
      onEnableFullAccess={() => actions.confirmFullAccess()}
      onSpacesChanged={async (updated) => {
        if (updated) await rt.syncUpdatedSpace(updated);
        await actions.refreshAllSpaces();
      }}
      archiveRevision={rt.archiveRevision}
      managedWorktrees={rt.managedWorktrees.map((wt) => ({
        ...wt,
        prunable: wt.prunable === true,
        workspaceName: rt.workspace?.name ?? '项目空间',
        sessionTitle: wt.branch,
      }))}
      onArchivedChanged={() => void actions.refreshAllSpaces()}
      onOpenRestoredConversation={(space, convId) => {
        useShellStore.getState().returnToWorkspace();
        void rt.act(() => actions.openConversation(convId, space));
      }}
      onRequestDelete={actions.setPendingDelete}
      onPruneWorktrees={async () => {
        const wsId = rt.workspace?.trusted ? rt.workspace.id : undefined;
        if (!wsId) return 0;
        const prunableItems = rt.managedWorktrees.filter((wt) => wt.prunable === true);
        let removedCount = 0;
        for (const wt of prunableItems) {
          const res = await api.worktree.remove({ workspaceId: wsId, id: wt.id });
          if (res.removed) removedCount += 1;
        }
        const refreshed = await api.worktree.list(wsId);
        rt.setManagedWorktrees(refreshed.items);
        return removedCount;
      }}
      hostDown={rt.facts.error !== undefined || rt.facts.runtimeValid === false}
      runtime={rt.facts.runtime}
      inspection={rt.facts.inspection}
      activeTerminalsCount={rt.activeTerminalsCount}
      appInfo={rt.appInfo}
      preferredShell={rt.preferredShell}
      onPreferredShellChange={rt.setPreferredShell}
    />
  );
}

/**
 * 顶层受控原生 `<dialog>` 模态框集合（项目登记、目录信任、完全访问、重命名、永久删除、命令交互）。
 */
export function DesktopModalHost({
  api,
  rt,
  actions,
  projectDialogOpen,
  onProjectDialogOpenChange,
}: {
  readonly api: DesktopAPI;
  readonly rt: RuntimeBag;
  readonly actions: ActionsBag;
  readonly projectDialogOpen: boolean;
  readonly onProjectDialogOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      <ProjectDialog
        open={projectDialogOpen}
        onOpenChange={onProjectDialogOpenChange}
        onCreated={(ws) => rt.act(() => rt.selectSpace(ws))}
      />
      <WorkspaceTrustDialog
        open={Boolean(rt.trustTarget)}
        onOpenChange={(open) => {
          if (!open) rt.setTrustTarget(undefined);
        }}
        rootPath={rt.trustTarget?.root}
        busy={rt.busy}
        confirmLabel="信任并打开"
        cancelLabel="暂不信任"
        closeLabel="取消信任"
        onCancel={() => {
          const target = rt.trustTarget;
          rt.setTrustTarget(undefined);
          if (target) {
            void api.workspace
              .confirmTrust({
                workspaceId: target.id,
                trustToken: target.trustToken,
                accept: false,
              })
              .catch(() => {});
          }
        }}
        onConfirm={() => {
          const target = rt.trustTarget;
          if (!target) return;
          void rt.act(async () => {
            const space = await api.workspace.confirmTrust({
              workspaceId: target.id,
              trustToken: target.trustToken,
              accept: true,
            });
            rt.setTrustTarget(undefined);
            await rt.selectSpace(space);
          });
        }}
      />
      <FullAccessConfirmDialog
        open={actions.fullAccessOpen}
        onOpenChange={actions.setFullAccessOpen}
        busy={rt.busy}
        onConfirm={() => void actions.confirmFullAccess()}
      />
      <SessionRenameDialog
        target={actions.pendingRename}
        busy={rt.busy}
        onCancel={() => actions.setPendingRename(undefined)}
        onConfirm={actions.confirmRename}
      />
      <SessionArchiveDialog
        target={actions.pendingArchive}
        busy={rt.busy}
        onCancel={() => actions.setPendingArchive(undefined)}
        onConfirm={actions.confirmArchive}
      />
      <SessionDeleteDialog
        target={actions.pendingDelete}
        busy={rt.busy}
        onCancel={() => actions.setPendingDelete(undefined)}
        onConfirm={actions.confirmDelete}
      />
      <ExternalSessionDeleteDialog
        target={actions.pendingExternalDelete}
        busy={rt.busy}
        onCancel={() => actions.setPendingExternalDelete(undefined)}
        onConfirm={actions.confirmExternalDelete}
      />
      <InteractionPromptDialog
        request={rt.facts.interactions[0]}
        onReply={(value) => {
          const req = rt.facts.interactions[0];
          if (!req) return;
          void api.interaction
            .reply({
              workspaceId: req.workspaceId,
              sessionId: req.sessionId,
              requestId: req.requestId,
              ...(value !== undefined ? { value } : {}),
            })
            .catch((e) => rt.setError(failureMessage(e)));
        }}
      />
    </>
  );
}
