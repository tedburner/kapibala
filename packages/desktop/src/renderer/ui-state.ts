import { create } from 'zustand';

/** 仅易失 UI 偏好和草稿；运行、消息、审批与持久主题始终从 Host/Main 事实读取。 */
export const useUI = create<{
  sidebarOpen: boolean;
  settingsOpen: boolean;
  approvalsOpen: boolean;
  drafts: Record<string, string>;
  scrolls: Record<string, { offset: number; following: boolean }>;
  selected: Record<string, string>;
  /** 已被用户关闭的提示 id；仅本次桌面进程有效，重新加载会话不复活已关掉的浮层。 */
  dismissedNotices: Record<string, true>;
  scroll(sessionId: string, offset: number, following: boolean): void;
  select(workspaceId: string, sessionId: string): void;
  sidebar(open: boolean): void;
  settings(open: boolean): void;
  approvals(open: boolean): void;
  draft(sessionId: string, text: string): void;
  dismissNotice(id: string): void;
}>((set) => ({
  sidebarOpen: innerWidth >= 960,
  settingsOpen: false,
  approvalsOpen: false,
  drafts: {},
  scrolls: {},
  selected: {},
  dismissedNotices: {},
  scroll: (id, offset, following) =>
    set((state) => ({ scrolls: { ...state.scrolls, [id]: { offset, following } } })),
  select: (workspaceId, sessionId) =>
    set((state) => ({ selected: { ...state.selected, [workspaceId]: sessionId } })),
  sidebar: (sidebarOpen) => set({ sidebarOpen }),
  settings: (settingsOpen) => set({ settingsOpen }),
  approvals: (approvalsOpen) => set({ approvalsOpen }),
  draft: (id, text) => set((state) => ({ drafts: { ...state.drafts, [id]: text } })),
  dismissNotice: (id) =>
    set((state) => ({ dismissedNotices: { ...state.dismissedNotices, [id]: true } })),
}));
