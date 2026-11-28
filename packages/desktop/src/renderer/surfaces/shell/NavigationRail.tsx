import { useI18n } from '../../i18n.js';
import type {
  InboxItem,
  WorkspaceHierarchyNode,
  WorkspaceHierarchyView,
  WorkspaceHistoryPage,
  WorkspaceSpace,
} from '../../stores/index.js';
import { BrandMark, Icon, IconButton, Kbd, StatusDot } from '../../ui/index.js';
import { InboxSection } from './InboxSection.js';
import { WorkspaceTree } from './WorkspaceTree.js';

/**
 * `NavigationRail` 入参契约（017 §6.1 & §7）：
 * 默认中文态严格保留桌面 E2E 导航锚点名称，英文态经 `useI18n()` 实时对齐。
 */
export interface NavigationRailProps {
  readonly collapsed?: boolean;
  readonly drawerMode?: boolean;
  readonly platform?: 'darwin' | 'win32' | 'linux';
  readonly settingsActive?: boolean;
  readonly newDisabled?: boolean;
  readonly inboxItems: readonly InboxItem[];
  readonly spaces: readonly WorkspaceSpace[];
  readonly hierarchies: Readonly<Record<string, WorkspaceHierarchyView>>;
  readonly historiesByWorkspace?: Readonly<Record<string, WorkspaceHistoryPage>>;
  readonly activeWorkspaceId?: string | null;
  readonly activeSessionKey?: string | null;
  readonly expandedWorkspaces?: Readonly<Record<string, boolean>>;
  readonly onNewConversation: () => void;
  readonly onToggleRail: () => void;
  readonly onOpenCommandPalette: () => void;
  readonly onOpenSettings: () => void;
  readonly onCreateProject?: () => void;
  readonly onToggleWorkspace: (workspaceId: string) => void;
  readonly onSelectWorkspace: (space: WorkspaceSpace) => void;
  readonly onNewInWorkspace?: (space: WorkspaceSpace) => void;
  readonly onSelectInboxSession: (sessionKey: string, workspaceId: string) => void;
  readonly onSelectTreeSession: (node: WorkspaceHierarchyNode) => void;
  readonly onRenameSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onTogglePinSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onArchiveSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onDeleteSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onPageChange?: (space: WorkspaceSpace, page: number) => void;
}

/**
 * 左栏空间与会话导航轨（`NavigationRail`）。
 */
export function NavigationRail({
  collapsed = false,
  drawerMode = false,
  platform = 'win32',
  settingsActive = false,
  newDisabled = false,
  inboxItems,
  spaces,
  hierarchies,
  historiesByWorkspace,
  activeWorkspaceId,
  activeSessionKey,
  expandedWorkspaces,
  onNewConversation,
  onToggleRail,
  onOpenCommandPalette,
  onOpenSettings,
  onCreateProject,
  onToggleWorkspace,
  onSelectWorkspace,
  onNewInWorkspace,
  onSelectInboxSession,
  onSelectTreeSession,
  onRenameSession,
  onTogglePinSession,
  onArchiveSession,
  onDeleteSession,
  onPageChange,
}: NavigationRailProps) {
  const { t } = useI18n();
  const isCollapsed = collapsed && !drawerMode;
  const isMac = platform === 'darwin';
  const modSymbol = isMac ? '⌘' : 'Ctrl+';
  const hasWaitingApproval = inboxItems.some((item) => item.status === 'waiting_approval');
  const hasRunning = inboxItems.some((item) => item.status === 'running');

  if (isCollapsed) {
    return (
      <aside aria-label={t('rail.landmark')} data-collapsed="true" className="kpbl-nav-rail">
        <div className="kpbl-rail-topbar">
          <IconButton
            size="sm"
            icon="sidebar"
            aria-label={t('rail.toggle')}
            active={false}
            onClick={onToggleRail}
          />
        </div>
        <div className="kpbl-rail-collapsed-stack">
          <IconButton
            size="sm"
            icon="plus"
            aria-label={t('rail.newChat')}
            disabled={newDisabled}
            onClick={onNewConversation}
          />
          <IconButton
            size="sm"
            icon="magnifying-glass"
            aria-label={t('rail.searchAria')}
            onClick={onOpenCommandPalette}
          />
          {inboxItems.length > 0 ? (
            <button
              type="button"
              aria-label={t('rail.inboxAria', { count: inboxItems.length })}
              title={t('rail.inboxAria', { count: inboxItems.length })}
              className="kpbl-icon-btn"
              data-variant="ghost"
              data-size="sm"
              onClick={() => {
                const top = inboxItems[0];
                if (top) onSelectInboxSession(top.sessionKey, top.workspaceId);
              }}
            >
              <StatusDot
                status={
                  hasWaitingApproval ? 'waiting_approval' : hasRunning ? 'running' : 'warning'
                }
              />
            </button>
          ) : null}
        </div>
        <div className="kpbl-rail-footer">
          <IconButton
            size="sm"
            icon="gear"
            aria-label={t('rail.openSettingsAria')}
            active={settingsActive}
            onClick={onOpenSettings}
          />
        </div>
      </aside>
    );
  }

  return (
    <aside
      aria-label={t('rail.landmark')}
      data-drawer={drawerMode ? 'true' : undefined}
      className="kpbl-nav-rail"
    >
      <div
        data-macos-inset={isMac && !drawerMode ? 'true' : undefined}
        className="kpbl-rail-topbar"
      >
        <span className="kpbl-rail-brand">
          <BrandMark size={20} decorative={true} />
          <span className="kpbl-rail-wordmark">Kapibala</span>
        </span>
        <span className="kpbl-rail-actions">
          <IconButton
            size="sm"
            icon="plus"
            aria-label={t('rail.newChat')}
            disabled={newDisabled}
            onClick={onNewConversation}
          />
          <IconButton
            size="sm"
            icon="sidebar"
            aria-label={t('rail.toggle')}
            active={true}
            onClick={onToggleRail}
          />
        </span>
      </div>

      <div className="kpbl-rail-search-wrap">
        <button
          type="button"
          aria-label={t('rail.searchAria')}
          className="kpbl-rail-cmd-trigger"
          onClick={onOpenCommandPalette}
        >
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <Icon name="magnifying-glass" size={14} />
            <span className="truncate">{t('rail.searchPlaceholder')}</span>
          </span>
          <Kbd>{`${modSymbol}K`}</Kbd>
        </button>
      </div>

      <div className="kpbl-rail-scroll">
        <InboxSection
          items={inboxItems}
          activeSessionKey={activeSessionKey}
          onSelectSession={onSelectInboxSession}
        />
        <WorkspaceTree
          spaces={spaces}
          hierarchies={hierarchies}
          historiesByWorkspace={historiesByWorkspace}
          activeWorkspaceId={activeWorkspaceId}
          activeSessionKey={activeSessionKey}
          expandedWorkspaces={expandedWorkspaces}
          onToggleWorkspace={onToggleWorkspace}
          onSelectWorkspace={onSelectWorkspace}
          onCreateProject={onCreateProject}
          onNewInWorkspace={onNewInWorkspace}
          onSelectSession={onSelectTreeSession}
          onRenameSession={onRenameSession}
          onTogglePinSession={onTogglePinSession}
          onArchiveSession={onArchiveSession}
          onDeleteSession={onDeleteSession}
          onPageChange={onPageChange}
        />
      </div>

      <div className="kpbl-rail-footer">
        <button
          type="button"
          aria-label={t('rail.openSettingsAria')}
          data-active={settingsActive ? 'true' : undefined}
          className="kpbl-rail-footer-btn"
          onClick={onOpenSettings}
        >
          <span className="inline-flex min-w-0 items-center gap-2">
            <Icon name="gear" size={16} />
            <span className="truncate">{t('rail.settingsLabel')}</span>
          </span>
          <Kbd>{`${modSymbol},`}</Kbd>
        </button>
      </div>
    </aside>
  );
}
