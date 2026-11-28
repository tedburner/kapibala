import type { ViewMergePreview } from '@kiturone/kapibala-host/view-model';
import { useRef, useState } from 'react';
import type { ThreadWorktreeBinding } from '../../adapters/index.js';
import { useI18n } from '../../i18n.js';
import { Badge, Button, MiddleTruncate, ModalDialog } from '../../ui/index.js';

/** `onRestoreCheckpoint` 返回契约：若目标文件在轮次后被手动修改则返回 `conflict` 清单供二次确认。 */
export type RestoreCheckpointResult =
  | { readonly status: 'restored'; readonly restoredCount?: number }
  | { readonly status: 'conflict'; readonly conflicts: readonly string[] }
  | { readonly status: 'error'; readonly message: string };

/** `onApplyMerge` 返回契约：冲突隔离在工作树内部返回 `conflict`，绝不污染主工作区（018 §3.3）。 */
export type ApplyWorktreeMergeResult =
  | { readonly status: 'merged'; readonly commit?: string }
  | { readonly status: 'conflict'; readonly conflictedFiles: readonly string[] }
  | { readonly status: 'error'; readonly message: string };

/** 生成让当前工作树会话 Agent 解决合并冲突的结构化提示词。 */
export function buildWorktreeConflictResolutionPrompt(
  branch: string,
  baseRef: string,
  conflictedFiles: readonly string[],
): string {
  const fileLines = conflictedFiles.map((file) => `- ${file}`).join('\n');
  return [
    `当前工作树分支 \`${branch}\` 在预合并目标基线分支 \`${baseRef}\` 时发生代码冲突，请直接在当前工作树内解决以下冲突文件并保留双端有效改动：`,
    fileLines,
    '解决全部冲突标记后请运行必要的类型或单测校验，以便重新合并回主工作区。',
  ].join('\n');
}

/**
 * `CheckpointConflictDialog` 入参契约：
 * 当 `restoreCheckpoint` 检测到用户事后手动编辑过归因文件时弹出破坏性确认框，
 * 严格遵循 `017` §4 将初始焦点锁定在「取消」安全按钮，防误触回车丢失手动编辑。
 */
export interface CheckpointConflictDialogProps {
  readonly open: boolean;
  readonly ordinal: number | null;
  readonly conflicts: readonly string[];
  readonly busy?: boolean;
  readonly onCancel: () => void;
  readonly onConfirmForceRestore: () => void;
}

/** 检查点回滚手动修改冲突确认模态框。 */
export function CheckpointConflictDialog({
  open,
  ordinal,
  conflicts,
  busy = false,
  onCancel,
  onConfirmForceRestore,
}: CheckpointConflictDialogProps) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  return (
    <ModalDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) onCancel();
      }}
      title={t('diff.conflictTitle')}
      description={t('diff.conflictDesc', { ordinal: ordinal ?? 0 })}
      initialFocusRef={cancelRef}
      footer={
        <>
          <Button ref={cancelRef} variant="outline" size="sm" disabled={busy} onClick={onCancel}>
            {t('general.cancel')}
          </Button>
          <Button
            variant="danger"
            size="sm"
            loading={busy}
            leadingIcon="warning"
            onClick={onConfirmForceRestore}
          >
            {t('diff.forceRestoreBtn')}
          </Button>
        </>
      }
    >
      <ul className="kpbl-evidence-list">
        {conflicts.map((filePath) => (
          <li key={filePath} className="kpbl-evidence-row">
            <MiddleTruncate text={filePath} mono maxChars={56} />
          </li>
        ))}
      </ul>
    </ModalDialog>
  );
}

/**
 * `DiffWorktreePanel` 入参契约（018 §3.3）：
 * 承载受管 Git Worktree 的「预览合并到主分支 → 确认合并回主工作区」两阶段冲突隔离审阅流。
 */
export interface DiffWorktreePanelProps {
  readonly worktree: ThreadWorktreeBinding;
  readonly mergePreview?: ViewMergePreview | null;
  readonly initialConflictFiles?: readonly string[];
  readonly onPreviewMerge?: (
    worktreeId: string,
  ) => Promise<ViewMergePreview | null> | ViewMergePreview | null;
  readonly onApplyMerge?: (params: {
    readonly worktreeId: string;
    readonly previewToken: string;
    readonly commitMessage?: string;
  }) => Promise<ApplyWorktreeMergeResult> | ApplyWorktreeMergeResult;
  readonly onResolveConflictWithAgent?: (prompt: string) => void;
}

/** 受管工作树合并预检与冲突隔离操作面板。 */
export function DiffWorktreePanel({
  worktree,
  mergePreview: externalPreview,
  initialConflictFiles = [],
  onPreviewMerge,
  onApplyMerge,
  onResolveConflictWithAgent,
}: DiffWorktreePanelProps) {
  const { t } = useI18n();
  const [localPreview, setLocalPreview] = useState<ViewMergePreview | null>(null);
  const [conflictFiles, setConflictFiles] = useState<readonly string[]>(initialConflictFiles);
  const [statusNotice, setStatusNotice] = useState<{
    readonly tone: 'success' | 'danger';
    readonly text: string;
  } | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [applying, setApplying] = useState(false);

  const preview = externalPreview ?? localPreview;
  const baseRef = preview?.baseRef ?? worktree.baseRef ?? 'main';

  const handlePreview = async () => {
    if (!onPreviewMerge) return;
    setPreviewing(true);
    setStatusNotice(null);
    try {
      const next = await onPreviewMerge(worktree.id);
      if (next) setLocalPreview(next);
    } catch (err) {
      setStatusNotice({
        tone: 'danger',
        text: err instanceof Error ? err.message : '预览合并状态失败',
      });
    } finally {
      setPreviewing(false);
    }
  };

  const handleApply = async () => {
    if (!onApplyMerge || !preview) return;
    setApplying(true);
    setStatusNotice(null);
    try {
      const outcome = await onApplyMerge({
        worktreeId: worktree.id,
        previewToken: preview.previewToken,
      });
      if (outcome.status === 'conflict') {
        setConflictFiles(outcome.conflictedFiles);
      } else if (outcome.status === 'merged') {
        setConflictFiles([]);
        setStatusNotice({
          tone: 'success',
          text: `已无冲突快进合并回 ${baseRef}${outcome.commit ? ` (${outcome.commit.slice(0, 7)})` : ''}`,
        });
      } else {
        setStatusNotice({ tone: 'danger', text: outcome.message });
      }
    } catch (err) {
      setStatusNotice({
        tone: 'danger',
        text: err instanceof Error ? err.message : '执行工作树合并失败',
      });
    } finally {
      setApplying(false);
    }
  };

  return (
    <div className="kpbl-diff-worktree-bar">
      <div className="kpbl-wb-toolbar-group justify-between">
        <div className="kpbl-wb-toolbar-group">
          <Badge tone="info" icon="git-branch">
            {worktree.branch}
          </Badge>
          <span className="kpbl-wb-meta">{t('diff.wtBaseRef', { base: baseRef })}</span>
          {preview ? (
            <span className="kpbl-wb-meta">
              {t('diff.wtAheadBehind', { ahead: preview.aheadCount, behind: preview.behindCount })}
            </span>
          ) : null}
        </div>
        <div className="kpbl-wb-toolbar-group">
          <Button
            variant="outline"
            size="xs"
            leadingIcon="git-diff"
            loading={previewing}
            disabled={!onPreviewMerge || applying}
            onClick={() => void handlePreview()}
          >
            {t('diff.wtPreviewMergeBtn')}
          </Button>
          {preview ? (
            <Button
              variant="solid"
              size="xs"
              leadingIcon="check"
              loading={applying}
              disabled={!onApplyMerge || preview.mainDirty || preview.aheadCount === 0}
              onClick={() => void handleApply()}
            >
              {t('diff.wtApplyMergeBtn')}
            </Button>
          ) : null}
        </div>
      </div>

      {preview?.mainDirty ? (
        <div role="alert" data-tone="warning" className="kpbl-wb-banner">
          <span>{t('diff.wtMainDirty')}</span>
        </div>
      ) : null}

      {preview && !preview.mainDirty && preview.worktreeDirty ? (
        <div data-tone="info" className="kpbl-wb-banner">
          <span>{t('diff.wtDirtyInfo')}</span>
        </div>
      ) : null}

      {statusNotice ? (
        <div
          role={statusNotice.tone === 'danger' ? 'alert' : 'status'}
          data-tone={statusNotice.tone}
          className="kpbl-wb-banner"
        >
          <span>{statusNotice.text}</span>
        </div>
      ) : null}

      {conflictFiles.length > 0 ? (
        <div role="alert" className="kpbl-diff-conflict-box">
          <div className="kpbl-wb-toolbar-group justify-between">
            <strong>{t('diff.wtConflictHeading')}</strong>
            {onResolveConflictWithAgent ? (
              <Button
                variant="solid"
                size="xs"
                leadingIcon="sparkle"
                onClick={() =>
                  onResolveConflictWithAgent(
                    buildWorktreeConflictResolutionPrompt(worktree.branch, baseRef, conflictFiles),
                  )
                }
              >
                {t('diff.wtResolveWithAgentBtn')}
              </Button>
            ) : null}
          </div>
          <ul className="kpbl-evidence-list">
            {conflictFiles.map((filePath) => (
              <li key={filePath} className="kpbl-evidence-row">
                <MiddleTruncate text={filePath} mono maxChars={56} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
