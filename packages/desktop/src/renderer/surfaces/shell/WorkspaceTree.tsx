import { useState } from 'react';
import { formatActivityTimestamp } from '../../../shared/i18n/index.js';
import { useI18n } from '../../i18n.js';
import {
  type WorkspaceHierarchyNode,
  type WorkspaceHierarchyView,
  type WorkspaceHistoryPage,
  type WorkspaceSpace,
  useSettingsStore,
} from '../../stores/index.js';
import {
  ActionMenu,
  type ActionMenuEntry,
  Badge,
  Button,
  Icon,
  IconButton,
  StatusDot,
} from '../../ui/index.js';

/**
 * 格式化历史会话相对活动时间；非法或零时间戳返回空串，绝不伪造「刚刚」（017 §6.1）。
 */
export function formatRelativeActivityTime(timestamp: number, now = Date.now()): string {
  return formatActivityTimestamp(timestamp, 'relative', 'zh-CN', now);
}

/**
 * `WorkspaceTree` 入参契约（017 §6.1）：
 * - 空临时分组强制整组隐藏（严禁渲染「暂无临时对话」）；
 * - 会话行锁定 `16px minmax(0, 1fr) auto` 三列网格与单一尾槽（常态时间/状态，悬停或聚焦切换为 `···` 菜单）；
 * - 本地 `/delegate` 子会话以 `↳ <taskName>` 缩进挂载于父会话下方，独立 Worktree 会话附带 `⎇ <branch>` 次级行。
 */
export interface WorkspaceTreeProps {
  readonly spaces: readonly WorkspaceSpace[];
  readonly hierarchies: Readonly<Record<string, WorkspaceHierarchyView>>;
  readonly historiesByWorkspace?: Readonly<Record<string, WorkspaceHistoryPage>>;
  readonly activeWorkspaceId?: string | null;
  readonly activeSessionKey?: string | null;
  readonly expandedWorkspaces?: Readonly<Record<string, boolean>>;
  readonly onToggleWorkspace: (workspaceId: string) => void;
  readonly onSelectWorkspace: (space: WorkspaceSpace) => void;
  readonly onCreateProject?: () => void;
  readonly onNewInWorkspace?: (space: WorkspaceSpace) => void;
  readonly onSelectSession: (node: WorkspaceHierarchyNode) => void;
  readonly onRenameSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onTogglePinSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onArchiveSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onDeleteSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onPageChange?: (space: WorkspaceSpace, page: number) => void;
}

interface SessionRowItemProps {
  readonly node: WorkspaceHierarchyNode;
  readonly activeSessionKey?: string | null;
  readonly isChild?: boolean;
  readonly onSelectSession: (node: WorkspaceHierarchyNode) => void;
  readonly onRenameSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onTogglePinSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onArchiveSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onDeleteSession?: (node: WorkspaceHierarchyNode) => void;
}

function SessionNodeRow({
  node,
  activeSessionKey,
  isChild = false,
  onSelectSession,
  onRenameSession,
  onTogglePinSession,
  onArchiveSession,
  onDeleteSession,
}: SessionRowItemProps) {
  const { locale, t } = useI18n();
  const timeFormat = useSettingsStore((s) => s.general.timeFormat);
  const [menuOpen, setMenuOpen] = useState(false);
  const active = node.sessionKey === activeSessionKey;
  const displayTitle =
    isChild && node.delegationTaskName ? `↳ ${node.delegationTaskName}` : node.title;
  const localizedStatus = (() => {
    if (!node.statusText || locale !== 'en') return node.statusText;
    const m = /^待审批\s+(\d+)$/.exec(node.statusText);
    if (m) return t('rail.statusApprovalCount', { count: Number(m[1]) });
    if (node.statusText === '待审批') return t('rail.waitingApproval');
    if (node.statusText === '运行中') return t('rail.statusRunning');
    if (node.statusText === '✓ 完成') return t('rail.statusDone');
    if (node.statusText === '失败') return t('rail.statusFailed');
    return node.statusText;
  })();
  const tailText =
    localizedStatus ?? formatActivityTimestamp(node.lastActivityAt, timeFormat, locale);

  const menuEntries: ActionMenuEntry[] = [];
  if (node.canRename && onRenameSession) {
    menuEntries.push({
      id: 'rename',
      label: t('rail.rename'),
      icon: 'pencil',
      onSelect: () => onRenameSession(node),
    });
  }
  if (node.canPin && onTogglePinSession) {
    menuEntries.push({
      id: 'pin',
      label: node.pinned ? t('rail.unpin') : t('rail.pin'),
      icon: node.pinned ? 'push-pin-slash' : 'push-pin',
      onSelect: () => onTogglePinSession(node),
    });
  }
  if (node.kind === 'native' && onArchiveSession) {
    menuEntries.push({
      id: 'archive',
      label: t('rail.archive'),
      icon: 'archive',
      disabled: !node.canArchive,
      onSelect: () => onArchiveSession(node),
    });
  }
  if (onDeleteSession) {
    if (menuEntries.length > 0) {
      menuEntries.push({ type: 'separator', id: 'sep-danger' });
    }
    menuEntries.push({
      id: 'delete',
      label: t('rail.delete'),
      icon: 'trash',
      danger: true,
      onSelect: () => onDeleteSession(node),
    });
  }

  const leadingGlyph = node.liveStatus ? (
    <StatusDot
      status={
        node.liveStatus === 'waiting_approval'
          ? 'waiting_approval'
          : node.liveStatus === 'running'
            ? 'running'
            : 'warning'
      }
    />
  ) : isChild ? (
    <Icon name="arrow-bend-down-left" size={13} />
  ) : node.pinned ? (
    <Icon name="push-pin" size={14} />
  ) : node.kind === 'external' ? (
    <Icon name="plugs-connected" size={14} />
  ) : (
    <Icon name="file-text" size={14} />
  );

  return (
    <div className="kpbl-tree-node">
      <div
        data-active={active ? 'true' : undefined}
        data-child={isChild ? 'true' : undefined}
        data-menu-open={menuOpen ? 'true' : undefined}
        className="kpbl-tree-row"
      >
        <span className="inline-flex items-center justify-center">{leadingGlyph}</span>
        <button
          type="button"
          title={node.harnessLabel ? `${node.title} (${node.harnessLabel})` : node.title}
          aria-current={active ? 'page' : undefined}
          className="kpbl-tree-select-btn"
          onClick={() => onSelectSession(node)}
        >
          {displayTitle}
        </button>
        <span className="kpbl-tree-tail">
          <span className="kpbl-tree-tail-meta">
            {node.liveStatus === 'waiting_approval' ? (
              <Badge tone="pulse">{tailText || t('rail.waitingApproval')}</Badge>
            ) : (
              tailText
            )}
          </span>
          {menuEntries.length > 0 ? (
            <span className="kpbl-tree-tail-menu">
              <ActionMenu
                label={t('rail.sessionActionsAria', { title: node.title })}
                open={menuOpen}
                onOpenChange={setMenuOpen}
                items={menuEntries}
                renderTrigger={(triggerProps) => (
                  <IconButton
                    size="xs"
                    icon="dots-three"
                    aria-label={t('rail.sessionActionsAria', { title: node.title })}
                    aria-haspopup={triggerProps['aria-haspopup']}
                    aria-expanded={triggerProps['aria-expanded']}
                    onClick={triggerProps.toggle}
                  />
                )}
              />
            </span>
          ) : null}
        </span>
      </div>

      {node.worktree ? (
        <div className="kpbl-tree-subrow">
          <span>{`⎇ ${node.worktree.branch}`}</span>
          {node.diffSummary ? (
            <span>{`+${node.diffSummary.additions} −${node.diffSummary.deletions}`}</span>
          ) : null}
        </div>
      ) : null}

      {node.children.length > 0
        ? node.children.map((child) => (
            <SessionNodeRow
              key={child.sessionKey}
              node={child}
              activeSessionKey={activeSessionKey}
              isChild={true}
              onSelectSession={onSelectSession}
              onRenameSession={onRenameSession}
              onTogglePinSession={onTogglePinSession}
              onArchiveSession={onArchiveSession}
              onDeleteSession={onDeleteSession}
            />
          ))
        : null}
    </div>
  );
}

/**
 * 工作区与层级会话树（`WorkspaceTree`）：承载多项目空间折叠、委派子代理层级缩进与 Worktree 分支副行。
 */
export function WorkspaceTree({
  spaces,
  hierarchies,
  historiesByWorkspace,
  activeWorkspaceId,
  activeSessionKey,
  expandedWorkspaces,
  onToggleWorkspace,
  onSelectWorkspace,
  onCreateProject,
  onNewInWorkspace,
  onSelectSession,
  onRenameSession,
  onTogglePinSession,
  onArchiveSession,
  onDeleteSession,
  onPageChange,
}: WorkspaceTreeProps) {
  const { t } = useI18n();
  const allTemporary = spaces.flatMap((space) => {
    const view = hierarchies[space.id];
    return view?.showTemporaryGroup ? view.temporaryNodes : [];
  });

  return (
    <div className="flex flex-col gap-3">
      {allTemporary.length > 0 ? (
        <div className="kpbl-workspace-group">
          <div className="kpbl-section-heading">
            <span>{t('rail.temporaryGroup')}</span>
            <span className="tabular-nums">{allTemporary.length}</span>
          </div>
          {allTemporary.map((node) => (
            <SessionNodeRow
              key={node.sessionKey}
              node={node}
              activeSessionKey={activeSessionKey}
              onSelectSession={onSelectSession}
            />
          ))}
        </div>
      ) : null}

      <div className="kpbl-workspace-group">
        <div className="kpbl-section-heading">
          <span>{t('rail.workspacesGroup')}</span>
          {onCreateProject ? (
            <IconButton
              size="xs"
              icon="folder-plus"
              aria-label={t('rail.addProjectAria')}
              onClick={onCreateProject}
            />
          ) : null}
        </div>

        {spaces.map((space) => {
          const isOpen = expandedWorkspaces?.[space.id] ?? space.id === activeWorkspaceId;
          const view = hierarchies[space.id];
          const rootNodes = view?.rootNodes ?? [];

          return (
            <div key={space.id} className="kpbl-workspace-group">
              <div className="kpbl-space-header">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  aria-label={space.name}
                  title={space.root}
                  className="kpbl-space-toggle"
                  onClick={() => {
                    if (space.id === activeWorkspaceId) {
                      onToggleWorkspace(space.id);
                    } else {
                      onSelectWorkspace(space);
                    }
                  }}
                >
                  <Icon name={isOpen ? 'caret-down' : 'caret-right'} size={13} />
                  <span className="min-w-0 truncate">{space.name}</span>
                </button>
                <span className="inline-flex items-center gap-1">
                  {!space.trusted ? <Badge tone="warning">{t('rail.untrusted')}</Badge> : null}
                  {space.trusted && onNewInWorkspace ? (
                    <IconButton
                      size="xs"
                      icon="plus"
                      aria-label={t('rail.newInWorkspaceAria', { name: space.name })}
                      onClick={() => onNewInWorkspace(space)}
                    />
                  ) : (
                    <span className="px-1 text-xs tabular-nums">{rootNodes.length}</span>
                  )}
                </span>
              </div>

              {isOpen && rootNodes.length > 0 ? (
                <div className="flex flex-col gap-0.5">
                  {rootNodes.map((node) => (
                    <SessionNodeRow
                      key={node.sessionKey}
                      node={node}
                      activeSessionKey={activeSessionKey}
                      onSelectSession={onSelectSession}
                      onRenameSession={onRenameSession}
                      onTogglePinSession={onTogglePinSession}
                      onArchiveSession={onArchiveSession}
                      onDeleteSession={onDeleteSession}
                    />
                  ))}
                  {(() => {
                    const pageInfo = historiesByWorkspace?.[space.id];
                    if (!pageInfo || pageInfo.pages <= 1 || !onPageChange) return null;
                    return (
                      <div className="mt-1 flex items-center justify-between gap-1 px-2 py-0.5 text-xs tabular-nums">
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={pageInfo.page <= 1}
                          onClick={() => onPageChange(space, pageInfo.page - 1)}
                        >
                          {t('rail.prevPage')}
                        </Button>
                        <span>
                          {pageInfo.page} / {pageInfo.pages}
                        </span>
                        <Button
                          size="xs"
                          variant="ghost"
                          disabled={pageInfo.page >= pageInfo.pages}
                          onClick={() => onPageChange(space, pageInfo.page + 1)}
                        >
                          {t('rail.nextPage')}
                        </Button>
                      </div>
                    );
                  })()}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
