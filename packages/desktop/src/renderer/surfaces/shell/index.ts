/**
 * Kapibala UI 2.0 应用壳与左栏导航组件族公共入口（显式命名重导出，禁用 `export *`）。
 */
export {
  AppShell,
  type AppShellProps,
  dispatchAppShellShortcut,
  resolveViewportTier,
  type ShellViewportTier,
  type ShortcutDispatchContext,
  type ShortcutKeyEventLike,
} from './AppShell.js';
export {
  CommandPalette,
  type CommandPaletteActionItem,
  type CommandPaletteProps,
} from './CommandPalette.js';
export {
  InboxSection,
  type InboxSectionProps,
} from './InboxSection.js';
export {
  NavigationRail,
  type NavigationRailProps,
} from './NavigationRail.js';
export {
  formatRelativeActivityTime,
  WorkspaceTree,
  type WorkspaceTreeProps,
} from './WorkspaceTree.js';
