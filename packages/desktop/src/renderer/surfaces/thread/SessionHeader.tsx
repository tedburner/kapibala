import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { UnifiedThreadViewModel } from '../../adapters/index.js';
import { useI18n } from '../../i18n.js';
import { useShellStore } from '../../stores/index.js';
import {
  ActionMenu,
  type ActionMenuEntry,
  Button,
  HarnessBadge,
  IconButton,
  Kbd,
} from '../../ui/index.js';

/**
 * `SessionHeader` 入参契约（017 §6.2）：
 * - 本地 Core、委派子会话与外部代理（ACP / CLI / App-Server / RPC）共用唯一 `42px` 单行页头；
 * - 外部代理必显 `HarnessBadge`（如 `Claude Code · CLI`），本地默认 `Kapibala` 会话省略身份胶囊以降低阅读噪音；
 * - 当 `diffSummary` 非零时展示 `+A −D` 统计胶囊，点击直接展开右侧工作台 `变更`（`diff`）标签。
 */
export interface SessionHeaderProps {
  readonly thread: UnifiedThreadViewModel;
  readonly showRailToggle?: boolean;
  readonly pinned?: boolean;
  readonly workbenchOpen?: boolean;
  readonly platform?: 'darwin' | 'win32' | 'linux';
  readonly canRename?: boolean;
  readonly onToggleRail?: () => void;
  readonly onRenameTitle?: (nextTitle: string) => void | Promise<void>;
  readonly onOpenDiffWorkbench?: () => void;
  readonly onOpenWorktreeMerge?: () => void;
  readonly onToggleWorkbench?: () => void;
  readonly onTogglePin?: () => void;
  readonly onForkSession?: () => void;
  readonly onBranchWithSummary?: () => void;
  readonly onArchiveSession?: () => void;
  readonly onCloseExternalProcess?: () => void;
  readonly onCloseSession?: () => void;
}

/**
 * 统一会话舞台单行页头（`SessionHeader` · `42px`）。
 *
 * 失败与交互边界：
 * - 点击会话标题进入原地输入框，`Enter` 或失焦仅在非空且与原标题不同时触发 `onRenameTitle`，`Escape` 无损还原；
 * - 会话处于运行或等待审批态时自动禁用「归档会话」，防止在途任务写锁冲突。
 */
export function SessionHeader({
  thread,
  showRailToggle = true,
  pinned = false,
  workbenchOpen,
  platform = 'win32',
  canRename = thread.harness.kind === 'native',
  onToggleRail,
  onRenameTitle,
  onOpenDiffWorkbench,
  onOpenWorktreeMerge,
  onToggleWorkbench,
  onTogglePin,
  onForkSession,
  onBranchWithSummary,
  onArchiveSession,
  onCloseExternalProcess,
  onCloseSession,
}: SessionHeaderProps) {
  const { t } = useI18n();
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(thread.title);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const storeWorkbenchOpen = useShellStore(
    (s) => s.workbenchBySession[thread.sessionKey]?.open ?? false,
  );
  const resolvedWorkbenchOpen = workbenchOpen ?? storeWorkbenchOpen;

  useEffect(() => {
    if (!editing) {
      setTitleDraft(thread.title);
    }
  }, [editing, thread.title]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const isBusyPhase =
    thread.phase === 'starting' ||
    thread.phase === 'running' ||
    thread.phase === 'waiting_approval' ||
    thread.phase === 'cancelling';

  const showHarnessBadge =
    thread.harness.kind === 'external' ||
    (thread.harness.label.trim() !== '' && thread.harness.label !== 'Kapibala');

  const hasDiffSummary = Boolean(
    thread.diffSummary && (thread.diffSummary.additions > 0 || thread.diffSummary.deletions > 0),
  );

  const startEditingTitle = () => {
    if (!canRename || !onRenameTitle) return;
    setTitleDraft(thread.title);
    setEditing(true);
  };

  const commitTitleEdit = () => {
    const trimmed = titleDraft.trim();
    setEditing(false);
    if (!trimmed || trimmed === thread.title) {
      setTitleDraft(thread.title);
      return;
    }
    void onRenameTitle?.(trimmed);
  };

  const handleTitleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      commitTitleEdit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setTitleDraft(thread.title);
      setEditing(false);
    }
  };

  const handleOpenDiff = () => {
    if (onOpenDiffWorkbench) {
      onOpenDiffWorkbench();
      return;
    }
    useShellStore.getState().openWorkbenchTab(thread.sessionKey, { kind: 'diff' });
  };

  const handleOpenWorktree = () => {
    if (onOpenWorktreeMerge) {
      onOpenWorktreeMerge();
      return;
    }
    if (!thread.worktree) return;
    useShellStore.getState().openWorkbenchTab(thread.sessionKey, {
      kind: 'diff',
      targetKey: `worktree:${thread.worktree.id}`,
      title: t('workbench.tab.diff'),
      payload: {
        mode: 'worktree-merge',
        worktreeId: thread.worktree.id,
        branch: thread.worktree.branch,
      },
    });
  };

  const handleToggleWorkbench = () => {
    if (onToggleWorkbench) {
      onToggleWorkbench();
      return;
    }
    useShellStore.getState().toggleWorkbench(thread.sessionKey);
  };

  const menuItems: ActionMenuEntry[] = [
    {
      id: 'rename',
      label: t('header.renameSession'),
      icon: 'pencil',
      disabled: !canRename || !onRenameTitle,
      onSelect: startEditingTitle,
    },
    {
      id: 'pin',
      label: pinned ? t('rail.unpin') : t('rail.pin'),
      icon: pinned ? 'push-pin-slash' : 'push-pin',
      disabled: !onTogglePin,
      onSelect: () => onTogglePin?.(),
    },
    {
      id: 'fork',
      label: t('header.forkSession'),
      icon: 'git-branch',
      disabled: !thread.capabilities.canForkOrCheckpoint || !onForkSession,
      onSelect: () => onForkSession?.(),
    },
    {
      id: 'branch-with-summary',
      label: t('header.branchWithSummary'),
      icon: 'sparkle',
      disabled: !thread.capabilities.canForkOrCheckpoint || !onBranchWithSummary,
      onSelect: () => onBranchWithSummary?.(),
    },
    {
      id: 'merge-worktree',
      label: t('header.mergeWorktree'),
      icon: 'git-diff',
      disabled: !thread.worktree,
      onSelect: handleOpenWorktree,
    },
    { type: 'separator', id: 'sep-archive' },
    ...(thread.harness.kind === 'external' && onCloseExternalProcess
      ? [
          {
            id: 'close-external-proc',
            label: t('header.closeProcess'),
            icon: 'stop' as const,
            disabled: !thread.capabilities.canContinue,
            onSelect: () => onCloseExternalProcess(),
          },
        ]
      : []),
    {
      id: 'archive',
      label: t('rail.archive'),
      icon: 'archive',
      disabled: isBusyPhase || !onArchiveSession,
      onSelect: () => onArchiveSession?.(),
    },
    {
      id: 'close',
      label: t('header.closeSession'),
      icon: 'x',
      disabled: !onCloseSession,
      onSelect: () => onCloseSession?.(),
    },
  ];

  const shortcutText = platform === 'darwin' ? '⌘J' : 'Ctrl+J';

  return (
    <header className="kpbl-session-header">
      <div className="kpbl-header-left">
        {showRailToggle ? (
          <IconButton
            icon="sidebar"
            size="sm"
            aria-label={t('rail.toggle')}
            onClick={() => onToggleRail?.()}
          />
        ) : null}

        <div className="kpbl-header-breadcrumb">
          <span className="kpbl-header-workspace" title={thread.workspaceName}>
            {thread.workspaceName}
          </span>
          <span aria-hidden="true" className="kpbl-header-slash">
            /
          </span>

          {editing ? (
            <input
              ref={inputRef}
              type="text"
              aria-label={t('header.titleInputAria')}
              value={titleDraft}
              className="kpbl-header-title-input"
              onChange={(e) => setTitleDraft(e.target.value)}
              onBlur={commitTitleEdit}
              onKeyDown={handleTitleKeyDown}
            />
          ) : canRename && onRenameTitle ? (
            <button
              type="button"
              className="kpbl-header-title-btn"
              aria-label={t('header.renameTitleAria', { title: thread.title })}
              title={t('header.renameTitleHint')}
              onClick={startEditingTitle}
            >
              {thread.title}
            </button>
          ) : (
            <h1 className="kpbl-header-title" title={thread.title}>
              {thread.title}
            </h1>
          )}
        </div>

        {showHarnessBadge ? (
          <HarnessBadge
            kind={thread.harness.kind}
            label={thread.harness.label}
            transportLabel={thread.harness.transportLabel}
          />
        ) : null}

        {thread.worktree ? (
          <button
            type="button"
            className="kpbl-worktree-pill"
            aria-label={t('header.worktreeAria', { branch: thread.worktree.branch })}
            title={t('header.worktreeHint', { branch: thread.worktree.branch })}
            onClick={handleOpenWorktree}
          >
            <span aria-hidden="true">⎇</span>
            <span>{thread.worktree.branch}</span>
          </button>
        ) : null}
      </div>

      <div className="kpbl-header-right">
        {hasDiffSummary && thread.diffSummary ? (
          <button
            type="button"
            className="kpbl-diff-pill"
            aria-label={t('header.diffAria', {
              add: thread.diffSummary.additions,
              del: thread.diffSummary.deletions,
            })}
            title={t('header.diffHint')}
            onClick={handleOpenDiff}
          >
            <span className="kpbl-diff-add">+{thread.diffSummary.additions}</span>
            <span className="kpbl-diff-del">−{thread.diffSummary.deletions}</span>
          </button>
        ) : null}

        <Button
          variant="ghost"
          size="sm"
          leadingIcon="split-horizontal"
          aria-label={t('header.toggleWorkbenchAria')}
          aria-pressed={resolvedWorkbenchOpen}
          title={`${t('header.toggleWorkbenchAria')}（${shortcutText}）`}
          onClick={handleToggleWorkbench}
        >
          <Kbd>{shortcutText}</Kbd>
        </Button>

        <ActionMenu
          label={t('header.sessionMenuAria')}
          items={menuItems}
          renderTrigger={(triggerProps) => (
            <IconButton
              icon="dots-three"
              size="sm"
              aria-label={t('header.sessionMenuAria')}
              active={triggerProps.open}
              aria-haspopup={triggerProps['aria-haspopup']}
              aria-expanded={triggerProps['aria-expanded']}
              onClick={triggerProps.toggle}
            />
          )}
        />
      </div>
    </header>
  );
}
