import { useState } from 'react';
import type { DesktopAPI } from '../../shared/contracts.js';
import {
  type WorkspaceHierarchyNode,
  useSessionStore,
  useSettingsStore,
  useShellStore,
} from '../stores/index.js';
import type { ExternalSessionDeleteTarget, SessionTarget } from '../surfaces/dialogs/index.js';
import { failureMessage } from './desktop-helpers.js';
import type { OpenedSession, useDesktopRuntime } from './useDesktopRuntime.js';

type RuntimeBag = ReturnType<typeof useDesktopRuntime>;

const scopeOf = (opened: OpenedSession) => ({
  workspaceId: opened.workspaceId,
  sessionId: opened.sessionId,
});

/**
 * 会话生命周期与确认弹窗状态子 Hook（改名、置顶、归档确认、永久删除确认、分叉摘要、取消运行、外部进程停止）。
 */
export function useSessionLifecycle(api: DesktopAPI, rt: RuntimeBag) {
  const [pendingRename, setPendingRename] = useState<SessionTarget>();
  const [pendingArchive, setPendingArchive] = useState<SessionTarget>();
  const [pendingDelete, setPendingDelete] = useState<SessionTarget>();
  const [pendingExternalDelete, setPendingExternalDelete] = useState<ExternalSessionDeleteTarget>();

  const refreshAllSpaces = async () => {
    for (const sp of rt.spaces) if (sp.trusted) await rt.refreshHistory(sp);
    rt.bumpArchiveRevision();
  };

  const executeArchive = (workspaceId: string, conversationId: string) =>
    void rt.act(async () => {
      await api.session.archive({ workspaceId, conversationId });
      if (rt.opened?.workspaceId === workspaceId && rt.opened.conversationId === conversationId) {
        rt.setOpened(undefined);
        await rt.client.clear();
        useSessionStore.getState().openLaunchpad();
      }
      await refreshAllSpaces();
    });

  const executeNativeDelete = (workspaceId: string, conversationId: string) =>
    void rt.act(async () => {
      await api.session.delete({ workspaceId, conversationId });
      if (rt.opened?.workspaceId === workspaceId && rt.opened.conversationId === conversationId) {
        rt.setOpened(undefined);
        await rt.client.clear();
        useSessionStore.getState().openLaunchpad();
      }
      await refreshAllSpaces();
    });

  const executeExternalDelete = (workspaceId: string, sessionId: string) =>
    void rt.act(async () => {
      await api.external.delete({ workspaceId, sessionId });
      if (rt.activeExternalRef.current?.sessionId === sessionId) {
        await rt.detachActiveExternal();
        useSessionStore.getState().openLaunchpad();
      }
      await rt.refreshExternalList(workspaceId);
    });

  return {
    pendingRename,
    setPendingRename,
    pendingArchive,
    setPendingArchive,
    pendingDelete,
    setPendingDelete,
    pendingExternalDelete,
    setPendingExternalDelete,
    refreshAllSpaces,
    closeCurrentSession: () =>
      rt.act(async () => {
        if (rt.activeExternal) {
          await rt.detachActiveExternal();
          useSessionStore.getState().openLaunchpad();
          return;
        }
        if (!rt.opened) return;
        await api.session.close(scopeOf(rt.opened));
        rt.setOpened(undefined);
        await rt.client.clear();
        useSessionStore.getState().openLaunchpad();
        await rt.refreshHistory();
      }),
    branchWithSummary: () =>
      rt.opened &&
      void rt.act(async () => {
        await api.session.branchWithSummary({
          workspaceId: rt.opened!.workspaceId,
          conversationId: rt.opened!.conversationId,
        });
        await rt.client.resync();
        await rt.refreshHistory();
      }),
    forkSession: () =>
      rt.opened &&
      void rt.act(async () => {
        await api.run.command({ ...scopeOf(rt.opened!), input: '/branch' });
        await rt.client.resync();
        await rt.refreshHistory();
      }),
    openTurnCheckpointDiff: (turnOrdinal: number) => {
      if (!rt.activeThread) return;
      useShellStore.getState().openWorkbenchTab(rt.activeThread.sessionKey, {
        kind: 'diff',
        targetKey: `cp:${turnOrdinal}`,
        payload: { turnOrdinal },
      });
    },
    cancelActiveRun: () => {
      if (rt.activeExternal) {
        void api.external
          .cancel({
            workspaceId: rt.activeExternal.workspaceId,
            sessionId: rt.activeExternal.sessionId,
          })
          .catch((e) => rt.setError(failureMessage(e)));
      } else if (rt.opened && rt.run) {
        void api.run
          .cancel({ ...scopeOf(rt.opened), runId: rt.run.runId })
          .catch((e) => rt.setError(failureMessage(e)));
      }
    },
    confirmRename: (title: string) => {
      if (!pendingRename) return;
      const target = pendingRename;
      setPendingRename(undefined);
      void rt.act(async () => {
        await api.session.rename({ ...target, title });
        const sp = rt.spaces.find((s) => s.id === target.workspaceId);
        if (sp) await rt.refreshHistory(sp);
      });
    },
    confirmArchive: () => {
      if (!pendingArchive) return;
      const target = pendingArchive;
      setPendingArchive(undefined);
      executeArchive(target.workspaceId, target.conversationId);
    },
    confirmDelete: () => {
      if (!pendingDelete) return;
      const target = pendingDelete;
      setPendingDelete(undefined);
      executeNativeDelete(target.workspaceId, target.conversationId);
    },
    confirmExternalDelete: () => {
      if (!pendingExternalDelete) return;
      const target = pendingExternalDelete;
      setPendingExternalDelete(undefined);
      executeExternalDelete(target.workspaceId, target.sessionId);
    },
    archiveNode: (workspaceId: string, conversationId: string, title = '未命名对话') => {
      if (useSettingsStore.getState().confirmations.archiveSession) {
        setPendingArchive({ workspaceId, conversationId, title });
        return;
      }
      executeArchive(workspaceId, conversationId);
    },
    requestDeleteNode: (node: WorkspaceHierarchyNode) => {
      const needConfirm = useSettingsStore.getState().confirmations.deleteSession;
      if (node.kind === 'external') {
        if (!needConfirm) {
          executeExternalDelete(node.workspaceId, node.id);
          return;
        }
        setPendingExternalDelete({
          workspaceId: node.workspaceId,
          sessionId: node.id,
          harnessName: node.harnessLabel ?? '外部代理',
          title: node.title,
        });
      } else {
        if (!needConfirm) {
          executeNativeDelete(node.workspaceId, node.id);
          return;
        }
        setPendingDelete({
          workspaceId: node.workspaceId,
          conversationId: node.id,
          title: node.title,
        });
      }
    },
    togglePinNode: (workspaceId: string, conversationId: string, currentlyPinned: boolean) =>
      void rt.act(async () => {
        await api.session.pin({ workspaceId, conversationId, pinned: !currentlyPinned });
        const sp = rt.spaces.find((s) => s.id === workspaceId);
        if (sp) await rt.refreshHistory(sp);
      }),
    closeActiveExternalProcess: () =>
      rt.activeExternal &&
      void rt.act(async () => {
        const cur = rt.activeExternal!;
        await api.external.close({ workspaceId: cur.workspaceId, sessionId: cur.sessionId });
        const snap = await api.external.snapshot({
          workspaceId: cur.workspaceId,
          sessionId: cur.sessionId,
        });
        rt.setActiveExternal((prev) =>
          prev && prev.sessionId === cur.sessionId ? { ...prev, snapshot: snap } : prev,
        );
        await rt.refreshExternalList(cur.workspaceId);
      }),
  };
}
