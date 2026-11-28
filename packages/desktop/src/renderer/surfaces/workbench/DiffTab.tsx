import type {
  ViewCheckpointItem,
  ViewFileDiff,
  ViewMergePreview,
} from '@kiturone/kapibala-host/view-model';
import { useEffect, useMemo, useState } from 'react';
import type { ThreadWorktreeBinding } from '../../adapters/index.js';
import { useI18n } from '../../i18n.js';
import {
  Badge,
  Button,
  EmptyState,
  MiddleTruncate,
  Segmented,
  type SegmentedOption,
  Select,
  type SelectOption,
} from '../../ui/index.js';
import {
  type ApplyWorktreeMergeResult,
  CheckpointConflictDialog,
  type DiffRestoreTarget,
  DiffWorktreePanel,
  type RestoreCheckpointResult,
  SessionRevertConfirmDialog,
  formatRestoreSuccessMessage,
} from './DiffWorktreePanel.js';
import {
  buildSplitDiffRows,
  parseUnifiedDiffPatch,
  resolveDiffStatusBadge,
} from './diff-parser.js';

/** `DiffTab` 三档对比范围：会话累计、指定轮次检查点、或相对受管工作树基线分支（018 §4.3 & §6.1）。 */
export type DiffScopeMode = 'session' | 'checkpoint' | 'worktree_base';

/** `DiffTab` 行对比布局模式：统一单列（Unified）与左右并排（Split）。 */
export type DiffViewMode = 'unified' | 'split';

/**
 * `DiffTab` 入参契约（`tab[name="变更"]`）：
 * 统一承载 Shadow Git 检查点真实磁盘 Diff、归因路径冲突预检回滚以及 Git Worktree 本地合并审阅。
 */
export interface DiffTabProps {
  readonly files?: readonly ViewFileDiff[];
  readonly checkpoints?: readonly ViewCheckpointItem[];
  readonly worktree?: ThreadWorktreeBinding;
  readonly isExternalSession?: boolean;
  readonly defaultScope?: DiffScopeMode;
  readonly selectedScope?: DiffScopeMode;
  readonly selectedCheckpointOrdinal?: number;
  readonly selectedFilePath?: string;
  readonly defaultViewMode?: DiffViewMode;
  readonly loading?: boolean;
  readonly error?: string;
  readonly initialRestoreConflicts?: readonly string[];
  readonly initialMergeConflicts?: readonly string[];
  readonly mergePreview?: ViewMergePreview | null;
  readonly onScopeChange?: (scope: DiffScopeMode, checkpointOrdinal?: number) => void;
  readonly onSelectCheckpoint?: (ordinal: number) => void;
  readonly onSelectFile?: (path: string) => void;
  readonly onRestoreCheckpoint?: (
    targetOrdinal: number,
    force?: boolean,
  ) => Promise<RestoreCheckpointResult> | RestoreCheckpointResult;
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

/**
 * 右侧工作台「变更」标签页：
 * 支持三档范围切换、Unified/Split 视图切换、手动修改冲突确认还原与受管工作树冲突隔离合并。
 */
export function DiffTab({
  files = [],
  checkpoints = [],
  worktree,
  isExternalSession = false,
  defaultScope = 'session',
  selectedScope,
  selectedCheckpointOrdinal,
  selectedFilePath,
  defaultViewMode = 'unified',
  loading = false,
  error,
  initialRestoreConflicts = [],
  initialMergeConflicts = [],
  mergePreview,
  onScopeChange,
  onSelectCheckpoint,
  onSelectFile,
  onRestoreCheckpoint,
  onPreviewMerge,
  onApplyMerge,
  onResolveConflictWithAgent,
}: DiffTabProps) {
  const { t } = useI18n();
  const [internalScope, setInternalScope] = useState<DiffScopeMode>(defaultScope);
  const [viewMode, setViewMode] = useState<DiffViewMode>(defaultViewMode);
  const [internalOrdinal, setInternalOrdinal] = useState<number | undefined>(
    () => selectedCheckpointOrdinal ?? checkpoints.at(-1)?.ordinal,
  );
  const [internalPath, setInternalPath] = useState<string | undefined>(() => selectedFilePath);
  const [restoring, setRestoring] = useState(false);
  const [restoreFeedback, setRestoreFeedback] = useState<{
    readonly tone: 'success' | 'danger';
    readonly text: string;
  } | null>(null);
  const [conflictPaths, setConflictPaths] = useState<readonly string[]>(initialRestoreConflicts);
  const [confirmSessionRevert, setConfirmSessionRevert] = useState(false);
  const [conflictTarget, setConflictTarget] = useState<DiffRestoreTarget | null>(null);

  useEffect(() => {
    if (selectedFilePath) setInternalPath(selectedFilePath);
  }, [selectedFilePath]);

  useEffect(() => {
    if (selectedCheckpointOrdinal !== undefined) {
      setInternalOrdinal(selectedCheckpointOrdinal);
    }
  }, [selectedCheckpointOrdinal]);

  const activeScope = selectedScope ?? internalScope;
  const preferredOrdinal = selectedCheckpointOrdinal ?? internalOrdinal;
  const activeOrdinal =
    preferredOrdinal !== undefined && checkpoints.some((cp) => cp.ordinal === preferredOrdinal)
      ? preferredOrdinal
      : checkpoints.at(-1)?.ordinal;

  const scopeOptions = useMemo<readonly SegmentedOption<DiffScopeMode>[]>(() => {
    const base: SegmentedOption<DiffScopeMode>[] = [
      { value: 'session', label: t('diff.scopeSession') },
      { value: 'checkpoint', label: t('diff.scopeCheckpoint'), disabled: checkpoints.length === 0 },
    ];
    if (worktree) base.push({ value: 'worktree_base', label: t('diff.scopeWorktreeBase') });
    return base;
  }, [checkpoints.length, t, worktree]);

  const viewModeOptions = useMemo<readonly SegmentedOption<DiffViewMode>[]>(
    () => [
      { value: 'unified', label: t('diff.viewUnified') },
      { value: 'split', label: t('diff.viewSplit'), icon: 'split-horizontal' },
    ],
    [t],
  );

  const checkpointOptions = useMemo<readonly SelectOption<string>[]>(
    () =>
      checkpoints.map((cp) => {
        const ordLabel = t('diff.checkpointOption', { ordinal: cp.ordinal });
        return {
          value: String(cp.ordinal),
          label: cp.label ? `${ordLabel} · ${cp.label}` : ordLabel,
          badge: `+${cp.additions} −${cp.deletions}`,
        };
      }),
    [checkpoints, t],
  );

  const activeFile = useMemo(() => {
    if (files.length === 0) return undefined;
    const target = selectedFilePath ?? internalPath;
    return files.find((f) => f.path === target) ?? files[0];
  }, [files, internalPath, selectedFilePath]);

  const parsedHunks = useMemo(
    () => (activeFile && !activeFile.binary ? parseUnifiedDiffPatch(activeFile.patch) : []),
    [activeFile],
  );

  const executeRestore = async (target: DiffRestoreTarget, force: boolean) => {
    if (!onRestoreCheckpoint) return;
    setRestoring(true);
    setRestoreFeedback(null);
    setConfirmSessionRevert(false);
    try {
      const outcome = await onRestoreCheckpoint(target.targetOrdinal, force);
      if (outcome.status === 'conflict') {
        setConflictTarget(target);
        setConflictPaths(outcome.conflicts);
      } else if (outcome.status === 'restored') {
        setConflictPaths([]);
        setConflictTarget(null);
        setRestoreFeedback({
          tone: 'success',
          text: formatRestoreSuccessMessage(target, isExternalSession),
        });
      } else {
        setRestoreFeedback({ tone: 'danger', text: outcome.message });
      }
    } catch (err) {
      setRestoreFeedback({
        tone: 'danger',
        text: err instanceof Error ? err.message : '还原检查点失败',
      });
    } finally {
      setRestoring(false);
    }
  };

  const activeCheckpointTarget: DiffRestoreTarget | null =
    activeOrdinal !== undefined
      ? {
          scope: 'checkpoint',
          displayOrdinal: activeOrdinal,
          targetOrdinal: Math.max(-1, activeOrdinal - 1),
        }
      : null;

  return (
    <div className="kpbl-workbench-panel">
      <div className="kpbl-wb-toolbar">
        <div className="kpbl-wb-toolbar-group">
          <Segmented
            aria-label={t('diff.scopeAria')}
            value={activeScope}
            options={scopeOptions}
            onValueChange={(nextScope) => {
              setInternalScope(nextScope);
              onScopeChange?.(nextScope, activeOrdinal);
            }}
          />
          {activeScope === 'checkpoint' && checkpointOptions.length > 0 ? (
            <Select
              aria-label={t('diff.checkpointSelectAria')}
              size="xs"
              value={activeOrdinal !== undefined ? String(activeOrdinal) : undefined}
              options={checkpointOptions}
              onValueChange={(val) => {
                const nextOrd = Number(val);
                setInternalOrdinal(nextOrd);
                onSelectCheckpoint?.(nextOrd);
                onScopeChange?.('checkpoint', nextOrd);
              }}
            />
          ) : null}
        </div>

        <div className="kpbl-wb-toolbar-group">
          <Segmented
            aria-label={t('diff.viewModeAria')}
            value={viewMode}
            options={viewModeOptions}
            onValueChange={setViewMode}
          />
          {onRestoreCheckpoint && activeScope === 'checkpoint' && activeCheckpointTarget ? (
            <Button
              variant="outline"
              size="xs"
              leadingIcon="arrow-bend-down-left"
              loading={restoring}
              onClick={() => void executeRestore(activeCheckpointTarget, false)}
            >
              {t('diff.restoreBtn')}
            </Button>
          ) : null}
          {onRestoreCheckpoint && activeScope === 'session' && checkpoints.length > 0 ? (
            <Button
              variant="outline"
              size="xs"
              leadingIcon="arrow-bend-down-left"
              loading={restoring}
              onClick={() => setConfirmSessionRevert(true)}
            >
              {t('diff.revertSessionBtn')}
            </Button>
          ) : null}
        </div>
      </div>

      {isExternalSession && onRestoreCheckpoint ? (
        <div className="kpbl-wb-banner">
          <span>{t('diff.externalBanner')}</span>
        </div>
      ) : null}

      {restoreFeedback ? (
        <div
          role={restoreFeedback.tone === 'danger' ? 'alert' : 'status'}
          data-tone={restoreFeedback.tone}
          className="kpbl-wb-banner"
        >
          <span>{restoreFeedback.text}</span>
        </div>
      ) : null}

      {worktree ? (
        <DiffWorktreePanel
          worktree={worktree}
          mergePreview={mergePreview}
          initialConflictFiles={initialMergeConflicts}
          onPreviewMerge={onPreviewMerge}
          onApplyMerge={onApplyMerge}
          onResolveConflictWithAgent={onResolveConflictWithAgent}
        />
      ) : null}

      {error ? (
        <div role="alert" data-tone="danger" className="kpbl-wb-banner">
          <span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <div className="p-4">
          <EmptyState icon="spinner" title={t('diff.loading')} />
        </div>
      ) : files.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon="git-diff"
            title={t('diff.emptyTitle')}
            description={t('diff.emptyDesc')}
          />
        </div>
      ) : (
        <>
          <section aria-label={t('diff.fileListAria')} className="kpbl-diff-filelist">
            {files.map((file) => {
              const badge = resolveDiffStatusBadge(file);
              const selected = activeFile?.path === file.path;
              return (
                <button
                  key={file.path}
                  type="button"
                  data-active={selected ? 'true' : undefined}
                  aria-pressed={selected}
                  className="kpbl-diff-file-item"
                  onClick={() => {
                    setInternalPath(file.path);
                    onSelectFile?.(file.path);
                  }}
                >
                  <MiddleTruncate text={file.path} mono maxChars={48} />
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                  <span className="kpbl-diff-counts">
                    <span className="kpbl-diff-stat-add">+{file.additions}</span>
                    <span className="kpbl-diff-stat-del">−{file.deletions}</span>
                  </span>
                </button>
              );
            })}
          </section>

          {activeFile ? (
            <div className="kpbl-diff-viewport">
              {activeFile.truncated ? (
                <div data-tone="warning" className="kpbl-wb-banner">
                  <span>{t('diff.patchTruncated')}</span>
                </div>
              ) : null}

              {activeFile.binary ? (
                <div className="p-4">
                  <EmptyState
                    icon="file"
                    title={t('diff.binaryTitle')}
                    description={t('diff.binaryDesc')}
                  />
                </div>
              ) : parsedHunks.length === 0 ? (
                <div className="p-4">
                  <EmptyState icon="info" title={t('diff.noTextDiff')} />
                </div>
              ) : (
                parsedHunks.map((hunk) => (
                  <section key={hunk.id} className="kpbl-diff-hunk">
                    <div className="kpbl-diff-hunk-header">{hunk.header}</div>
                    {viewMode === 'unified'
                      ? hunk.rows.map((row) => (
                          <div key={row.id} data-kind={row.kind} className="kpbl-diff-row">
                            <span className="kpbl-diff-lineno">{row.oldLine ?? ''}</span>
                            <span className="kpbl-diff-lineno">{row.newLine ?? ''}</span>
                            <span className="kpbl-diff-sign">{row.sign}</span>
                            <code className="kpbl-diff-code">{row.content}</code>
                          </div>
                        ))
                      : buildSplitDiffRows(hunk).map((pair) => (
                          <div key={pair.id} className="kpbl-diff-split-row">
                            <div
                              data-kind={pair.left?.kind}
                              data-empty={pair.left ? undefined : 'true'}
                              className="kpbl-diff-cell"
                            >
                              <span className="kpbl-diff-lineno">{pair.left?.oldLine ?? ''}</span>
                              <span className="kpbl-diff-sign">{pair.left?.sign ?? ''}</span>
                              <code className="kpbl-diff-code">{pair.left?.content ?? ''}</code>
                            </div>
                            <div
                              data-kind={pair.right?.kind}
                              data-empty={pair.right ? undefined : 'true'}
                              className="kpbl-diff-cell"
                            >
                              <span className="kpbl-diff-lineno">{pair.right?.newLine ?? ''}</span>
                              <span className="kpbl-diff-sign">{pair.right?.sign ?? ''}</span>
                              <code className="kpbl-diff-code">{pair.right?.content ?? ''}</code>
                            </div>
                          </div>
                        ))}
                  </section>
                ))
              )}
            </div>
          ) : null}
        </>
      )}

      <SessionRevertConfirmDialog
        open={confirmSessionRevert}
        checkpointCount={checkpoints.length}
        busy={restoring}
        onCancel={() => setConfirmSessionRevert(false)}
        onConfirm={() => void executeRestore({ scope: 'session', targetOrdinal: -1 }, false)}
      />

      <CheckpointConflictDialog
        open={conflictPaths.length > 0}
        scope={conflictTarget?.scope ?? (activeScope === 'session' ? 'session' : 'checkpoint')}
        ordinal={conflictTarget?.displayOrdinal ?? activeOrdinal ?? null}
        conflicts={conflictPaths}
        busy={restoring}
        onCancel={() => {
          setConflictPaths([]);
          setConflictTarget(null);
        }}
        onConfirmForceRestore={() => {
          const fallback: DiffRestoreTarget | null =
            activeScope === 'session'
              ? { scope: 'session', targetOrdinal: -1 }
              : activeCheckpointTarget;
          const resolved = conflictTarget ?? fallback;
          if (resolved) void executeRestore(resolved, true);
        }}
      />
    </div>
  );
}
