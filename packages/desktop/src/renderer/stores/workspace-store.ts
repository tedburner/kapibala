import type {
  ViewExternalSession,
  ViewExternalTransport,
} from '@kiturone/kapibala-host/view-model';
import { create } from 'zustand';
import { buildExternalSessionKey, buildNativeSessionKey } from '../adapters/unified-thread.js';

/** 登记空间（默认空间或项目空间）视图契约。 */
export interface WorkspaceSpace {
  readonly id: string;
  readonly kind: 'default' | 'project';
  readonly name: string;
  readonly root: string;
  readonly trusted: boolean;
  readonly trustToken: string;
  readonly recentId?: string;
  readonly gitCapable?: boolean;
}

/** 本地 `/delegate` 委派子会话的父级归属摘要（D3.2）。 */
export interface WorkspaceSessionDelegation {
  readonly parentSessionId: string;
  readonly parentTitle?: string;
  readonly taskName: string;
}

/** 会话绑定的受管 Git Worktree 摘要。 */
export interface WorkspaceSessionWorktree {
  readonly id: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly baseRef?: string;
}

/** 空间历史分页内的单条本地会话条目。 */
export interface WorkspaceNativeSessionItem {
  readonly conversationId: string;
  readonly sessionId?: string;
  readonly title: string;
  readonly messageCount: number;
  readonly lastActivityAt: number;
  readonly pinned?: boolean;
  readonly unavailableReason?: string;
  readonly delegation?: WorkspaceSessionDelegation;
  readonly worktree?: WorkspaceSessionWorktree;
  readonly diffSummary?: { readonly additions: number; readonly deletions: number };
}

/** 单空间本地会话分页快照。 */
export interface WorkspaceHistoryPage {
  readonly items: readonly WorkspaceNativeSessionItem[];
  readonly page: number;
  readonly pages: number;
  readonly total: number;
}

/** 动态收件箱与侧栏胶囊的实时活跃类别（优先级：`waiting_approval > running > watch_triggered`）。 */
export type SessionLiveStatusKind = 'waiting_approval' | 'running' | 'watch_triggered';

/** 宿主运行句柄与后台监视触发器汇总后的活跃会话条目。 */
export interface SessionLiveStatusEntry {
  readonly sessionKey: string;
  readonly workspaceId: string;
  readonly workspaceName?: string;
  readonly conversationId?: string;
  readonly externalSessionId?: string;
  readonly title: string;
  readonly harnessLabel?: string;
  readonly status: SessionLiveStatusKind;
  readonly approvalCount?: number;
  readonly watchCount?: number;
  readonly isTemporary?: boolean;
  readonly updatedAt: number;
}

/** `InboxSection` 消费的单条动态收件箱项；全空间空闲时返回空数组使收件箱完全不占位（017 §6.1）。 */
export interface InboxItem {
  readonly sessionKey: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly title: string;
  readonly status: SessionLiveStatusKind;
  readonly badgeLabel: string;
  readonly harnessLabel?: string;
  readonly approvalCount: number;
  readonly updatedAt: number;
}

/** `WorkspaceTree` 渲染的层级会话树节点：委派子会话挂载于父会话 `children` 下（前缀 `↳`）。 */
export interface WorkspaceHierarchyNode {
  readonly sessionKey: string;
  readonly kind: 'native' | 'external';
  readonly workspaceId: string;
  readonly id: string;
  readonly title: string;
  readonly pinned: boolean;
  readonly lastActivityAt: number;
  readonly liveStatus?: SessionLiveStatusKind;
  readonly statusText?: string;
  readonly harnessLabel?: string;
  readonly transportLabel?: 'ACP' | 'CLI' | 'App-Server' | 'RPC';
  readonly worktree?: WorkspaceSessionWorktree;
  readonly diffSummary?: { readonly additions: number; readonly deletions: number };
  readonly delegationTaskName?: string;
  readonly canArchive: boolean;
  readonly canPin: boolean;
  readonly canRename: boolean;
  readonly children: readonly WorkspaceHierarchyNode[];
}

/** 单空间层级会话树投影：`showTemporaryGroup` 在无临时对话时恒为 `false`（禁渲染「暂无临时对话」）。 */
export interface WorkspaceHierarchyView {
  readonly workspaceId: string;
  readonly temporaryNodes: readonly WorkspaceHierarchyNode[];
  readonly showTemporaryGroup: boolean;
  readonly rootNodes: readonly WorkspaceHierarchyNode[];
}

/** 可注入的宿主工作区桥接接口，解耦 Electron Preload 以便在纯 Node 环境单测全部行为。 */
export interface WorkspaceStoreBridge {
  readonly listSpaces?: () => Promise<readonly WorkspaceSpace[]>;
  readonly loadHistoryPage?: (workspaceId: string, page: number) => Promise<WorkspaceHistoryPage>;
  readonly renameSession?: (wsId: string, convId: string, title: string) => Promise<void>;
  readonly pinSession?: (wsId: string, convId: string, pinned: boolean) => Promise<void>;
  readonly archiveSession?: (wsId: string, convId: string) => Promise<void>;
  readonly deleteSession?: (wsId: string, convId: string) => Promise<void>;
  readonly deleteExternalSession?: (wsId: string, sessionId: string) => Promise<void>;
}

/** `WorkspaceStore` 状态与动作契约。 */
export interface WorkspaceStoreState {
  readonly spaces: readonly WorkspaceSpace[];
  readonly activeWorkspaceId: string | null;
  readonly historiesByWorkspace: Readonly<Record<string, WorkspaceHistoryPage>>;
  readonly externalByWorkspace: Readonly<Record<string, readonly ViewExternalSession[]>>;
  readonly liveStatuses: Readonly<Record<string, SessionLiveStatusEntry>>;
  readonly expandedWorkspaces: Readonly<Record<string, boolean>>;
  setBridge: (bridge: WorkspaceStoreBridge) => void;
  setSpaces: (spaces: readonly WorkspaceSpace[]) => void;
  setActiveWorkspaceId: (workspaceId: string | null) => void;
  toggleWorkspaceExpanded: (workspaceId: string) => void;
  setWorkspaceHistory: (workspaceId: string, page: WorkspaceHistoryPage) => void;
  setExternalSessions: (workspaceId: string, items: readonly ViewExternalSession[]) => void;
  upsertLiveStatus: (entry: SessionLiveStatusEntry) => void;
  removeLiveStatus: (sessionKey: string) => void;
  clearLiveStatuses: () => void;
  refreshSpaces: () => Promise<void>;
  loadHistoryPage: (workspaceId: string, page?: number) => Promise<void>;
}

const EMPTY_INBOX: readonly InboxItem[] = Object.freeze([]);
const EMPTY_NODES: readonly WorkspaceHierarchyNode[] = Object.freeze([]);
const STATUS_PRIORITY: Readonly<Record<SessionLiveStatusKind, number>> = {
  waiting_approval: 0,
  running: 1,
  watch_triggered: 2,
};

function transportBadgeOf(t: ViewExternalTransport): 'ACP' | 'CLI' | 'App-Server' | 'RPC' {
  if (t === 'acp') return 'ACP';
  if (t === 'claude-cli') return 'CLI';
  if (t === 'codex-app-server') return 'App-Server';
  return 'RPC';
}

function inboxBadgeOf(status: SessionLiveStatusKind, approvalCount: number): string {
  if (status === 'waiting_approval')
    return approvalCount > 1 ? `待审批 ${approvalCount}` : '待审批';
  return status === 'running' ? '运行中' : '监视已触发';
}

/**
 * 聚合全空间动态运行收件箱条目（`waiting_approval -> running -> watch_triggered`）；
 * 空闲时返回冻结空数组以使 `InboxSection` 零高度隐藏（017 §6.1）。
 */
export function selectInboxItems(
  state: Pick<WorkspaceStoreState, 'spaces' | 'liveStatuses' | 'externalByWorkspace'>,
): readonly InboxItem[] {
  const spaceNames = new Map(state.spaces.map((s) => [s.id, s.name]));
  const merged = new Map<string, InboxItem>();

  for (const entry of Object.values(state.liveStatuses)) {
    const count = Math.max(entry.status === 'waiting_approval' ? 1 : 0, entry.approvalCount ?? 0);
    merged.set(entry.sessionKey, {
      sessionKey: entry.sessionKey,
      workspaceId: entry.workspaceId,
      workspaceName: entry.workspaceName ?? spaceNames.get(entry.workspaceId) ?? '工作区',
      title: entry.title.trim() || '未命名对话',
      status: entry.status,
      badgeLabel: inboxBadgeOf(entry.status, count),
      harnessLabel: entry.harnessLabel,
      approvalCount: count,
      updatedAt: entry.updatedAt,
    });
  }

  for (const [workspaceId, externals] of Object.entries(state.externalByWorkspace)) {
    for (const ext of externals) {
      const isWaiting = ext.pendingApprovalCount > 0 || ext.status === 'waiting_approval';
      const isRunning =
        ext.status === 'starting' || ext.status === 'running' || ext.status === 'cancelling';
      if (!isWaiting && !isRunning) continue;
      const sessionKey = buildExternalSessionKey(ext.id);
      if (merged.has(sessionKey)) continue;
      const status: SessionLiveStatusKind = isWaiting ? 'waiting_approval' : 'running';
      const count = isWaiting ? Math.max(1, ext.pendingApprovalCount) : 0;
      merged.set(sessionKey, {
        sessionKey,
        workspaceId,
        workspaceName: spaceNames.get(workspaceId) ?? '工作区',
        title: ext.title.trim() || `${ext.harnessName} 会话`,
        status,
        badgeLabel: inboxBadgeOf(status, count),
        harnessLabel: ext.harnessName,
        approvalCount: count,
        updatedAt: ext.updatedAt,
      });
    }
  }

  if (merged.size === 0) return EMPTY_INBOX;
  return [...merged.values()].sort((a, b) => {
    const diff = STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status];
    return diff !== 0 ? diff : b.updatedAt - a.updatedAt;
  });
}

/**
 * 构建指定空间的层级会话树：委派子会话缩进挂载于父会话 `children`（前缀 `↳`），空临时组自动隐藏。
 */
export function selectWorkspaceHierarchy(
  state: Pick<WorkspaceStoreState, 'historiesByWorkspace' | 'externalByWorkspace' | 'liveStatuses'>,
  workspaceId: string,
): WorkspaceHierarchyView {
  const historyItems = state.historiesByWorkspace[workspaceId]?.items ?? [];
  const externals = state.externalByWorkspace[workspaceId] ?? [];
  const persistedIds = new Set(historyItems.map((item) => item.conversationId));
  const parentLookup = new Map<string, WorkspaceNativeSessionItem>();
  for (const item of historyItems) {
    parentLookup.set(item.conversationId, item);
    if (item.sessionId) parentLookup.set(item.sessionId, item);
  }

  const childrenByParent = new Map<string, WorkspaceHierarchyNode[]>();
  const buildNativeNode = (
    item: WorkspaceNativeSessionItem,
    children: readonly WorkspaceHierarchyNode[] = EMPTY_NODES,
  ): WorkspaceHierarchyNode => {
    const sessionKey = buildNativeSessionKey(workspaceId, item.conversationId);
    const live = state.liveStatuses[sessionKey];
    const isRunning = live?.status === 'running' || live?.status === 'waiting_approval';
    return {
      sessionKey,
      kind: 'native',
      workspaceId,
      id: item.conversationId,
      title: item.title.trim() || '未命名对话',
      pinned: Boolean(item.pinned),
      lastActivityAt: item.lastActivityAt,
      liveStatus: live?.status,
      statusText: live
        ? inboxBadgeOf(live.status, live.approvalCount ?? 0)
        : item.delegation
          ? '✓ 完成'
          : undefined,
      worktree: item.worktree,
      diffSummary:
        item.diffSummary && (item.diffSummary.additions > 0 || item.diffSummary.deletions > 0)
          ? item.diffSummary
          : undefined,
      delegationTaskName: item.delegation?.taskName,
      canArchive: !isRunning,
      canPin: !item.delegation,
      canRename: true,
      children,
    };
  };

  const rootNativeItems: WorkspaceNativeSessionItem[] = [];
  for (const item of historyItems) {
    const parent = item.delegation ? parentLookup.get(item.delegation.parentSessionId) : undefined;
    if (parent && parent.conversationId !== item.conversationId) {
      const bucket = childrenByParent.get(parent.conversationId) ?? [];
      bucket.push(buildNativeNode(item));
      childrenByParent.set(parent.conversationId, bucket);
    } else {
      rootNativeItems.push(item);
    }
  }

  const nativeNodes = rootNativeItems.map((item) =>
    buildNativeNode(item, childrenByParent.get(item.conversationId) ?? EMPTY_NODES),
  );
  const externalNodes: WorkspaceHierarchyNode[] = externals.map((ext) => {
    const sessionKey = buildExternalSessionKey(ext.id);
    const isWaiting = ext.pendingApprovalCount > 0 || ext.status === 'waiting_approval';
    const isRunning =
      ext.status === 'starting' || ext.status === 'running' || ext.status === 'cancelling';
    const liveStatus: SessionLiveStatusKind | undefined = isWaiting
      ? 'waiting_approval'
      : isRunning
        ? 'running'
        : state.liveStatuses[sessionKey]?.status;
    return {
      sessionKey,
      kind: 'external',
      workspaceId,
      id: ext.id,
      title: ext.title.trim() || `${ext.harnessName} 会话`,
      pinned: false,
      lastActivityAt: ext.updatedAt,
      liveStatus,
      statusText: liveStatus
        ? inboxBadgeOf(liveStatus, Math.max(1, ext.pendingApprovalCount))
        : ext.status === 'failed'
          ? '失败'
          : undefined,
      harnessLabel: ext.harnessName,
      transportLabel: transportBadgeOf(ext.transport),
      canArchive: false,
      canPin: false,
      canRename: false,
      children: EMPTY_NODES,
    };
  });

  const rootNodes = [...nativeNodes, ...externalNodes].sort((a, b) =>
    a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : b.lastActivityAt - a.lastActivityAt,
  );
  const temporaryNodes: WorkspaceHierarchyNode[] = Object.values(state.liveStatuses)
    .filter(
      (entry) =>
        entry.workspaceId === workspaceId &&
        Boolean(entry.conversationId) &&
        (!persistedIds.has(entry.conversationId!) || entry.isTemporary),
    )
    .map((entry) => ({
      sessionKey: entry.sessionKey,
      kind: 'native',
      workspaceId,
      id: entry.conversationId!,
      title: entry.title.trim() || '未命名对话',
      pinned: false,
      lastActivityAt: entry.updatedAt,
      liveStatus: entry.status,
      statusText: inboxBadgeOf(entry.status, entry.approvalCount ?? 0),
      canArchive: false,
      canPin: false,
      canRename: false,
      children: EMPTY_NODES,
    }));

  return {
    workspaceId,
    temporaryNodes,
    showTemporaryGroup: temporaryNodes.length > 0,
    rootNodes,
  };
}

/** 创建隔离的 `WorkspaceStore` 实例。 */
export function createWorkspaceStore(initialBridge: WorkspaceStoreBridge = {}) {
  let bridge = initialBridge;
  return create<WorkspaceStoreState>((set, get) => ({
    spaces: [],
    activeWorkspaceId: null,
    historiesByWorkspace: {},
    externalByWorkspace: {},
    liveStatuses: {},
    expandedWorkspaces: {},
    setBridge: (nextBridge) => {
      bridge = nextBridge;
    },
    setSpaces: (spaces) =>
      set((state) => ({
        spaces,
        activeWorkspaceId:
          state.activeWorkspaceId && spaces.some((s) => s.id === state.activeWorkspaceId)
            ? state.activeWorkspaceId
            : (spaces[0]?.id ?? null),
      })),
    setActiveWorkspaceId: (workspaceId) =>
      set((state) => ({
        activeWorkspaceId: workspaceId,
        expandedWorkspaces: workspaceId
          ? { ...state.expandedWorkspaces, [workspaceId]: true }
          : state.expandedWorkspaces,
      })),
    toggleWorkspaceExpanded: (workspaceId) =>
      set((state) => ({
        expandedWorkspaces: {
          ...state.expandedWorkspaces,
          [workspaceId]: !(
            state.expandedWorkspaces[workspaceId] ?? workspaceId === state.activeWorkspaceId
          ),
        },
      })),
    setWorkspaceHistory: (workspaceId, page) =>
      set((state) => ({
        historiesByWorkspace: { ...state.historiesByWorkspace, [workspaceId]: page },
      })),
    setExternalSessions: (workspaceId, items) =>
      set((state) => ({
        externalByWorkspace: { ...state.externalByWorkspace, [workspaceId]: items },
      })),
    upsertLiveStatus: (entry) =>
      set((state) => ({ liveStatuses: { ...state.liveStatuses, [entry.sessionKey]: entry } })),
    removeLiveStatus: (sessionKey) =>
      set((state) => {
        if (!(sessionKey in state.liveStatuses)) return state;
        const next = { ...state.liveStatuses };
        delete next[sessionKey];
        return { liveStatuses: next };
      }),
    clearLiveStatuses: () => set({ liveStatuses: {} }),
    refreshSpaces: async () => {
      if (!bridge.listSpaces) return;
      get().setSpaces(await bridge.listSpaces());
    },
    loadHistoryPage: async (workspaceId, page = 1) => {
      if (!bridge.loadHistoryPage) return;
      get().setWorkspaceHistory(workspaceId, await bridge.loadHistoryPage(workspaceId, page));
    },
  }));
}

/** 渲染进程默认单例 `WorkspaceStore` Hook。 */
export const useWorkspaceStore = createWorkspaceStore();
