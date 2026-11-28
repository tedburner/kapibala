import { useEffect, useMemo, useState } from 'react';
import type { Output, Workspace } from '../../../shared/contracts.js';
import { formatActivityTimestamp } from '../../../shared/i18n/index.js';
import { useI18n } from '../../i18n.js';
import {
  type WorkspaceSessionWorktree,
  useSettingsStore,
  useWorkspaceStore,
} from '../../stores/index.js';
import {
  Badge,
  Button,
  EmptyState,
  MiddleTruncate,
  SearchField,
  SettingRow,
  SettingSection,
} from '../../ui/index.js';
import { SessionDeleteDialog, type SessionTarget } from '../dialogs/index.js';
import { ArchivePreviewModal, type ArchivedPreviewTarget } from './ArchivePreviewModal.js';

/** 单个空间下的已归档会话分组。 */
export interface ArchivedWorkspaceGroup {
  readonly space: Workspace;
  readonly list: Output<'session.archived'>;
}

/** 受管 Git Worktree 概览条目。 */
export interface ManagedWorktreeSummary extends WorkspaceSessionWorktree {
  readonly workspaceName: string;
  readonly sessionTitle: string;
  readonly prunable?: boolean;
}

/** `ArchivesPage` 入参契约：跨工作区展示归档会话，支持检索、`查看内容` 只读预览、恢复并打开及清理 Worktree。 */
export interface ArchivesPageProps {
  readonly active?: boolean;
  readonly spaces?: readonly Workspace[];
  readonly archiveRevision?: number;
  readonly initialArchivedGroups?: readonly ArchivedWorkspaceGroup[];
  readonly initialPreview?: Output<'session.readArchived'>;
  readonly managedWorktrees?: readonly ManagedWorktreeSummary[];
  readonly onArchivedChanged?: () => void;
  readonly onOpenRestoredConversation?: (space: Workspace, conversationId: string) => void;
  readonly onReadArchived?: (
    workspaceId: string,
    conversationId: string,
  ) => Promise<Output<'session.readArchived'>>;
  readonly onRequestDelete?: (target: SessionTarget) => void;
  readonly onPruneWorktrees?: () => Promise<number>;
  readonly report?: (message: string) => void;
}

/** 壳内设置中心「会话归档」页面。 */
export function ArchivesPage({
  active = true,
  spaces: propSpaces,
  archiveRevision = 0,
  initialArchivedGroups,
  initialPreview,
  managedWorktrees: propWorktrees,
  onArchivedChanged,
  onOpenRestoredConversation,
  onReadArchived,
  onRequestDelete,
  onPruneWorktrees,
  report,
}: ArchivesPageProps) {
  const { locale, t } = useI18n();
  const timeFormat = useSettingsStore((s) => s.general.timeFormat);
  const confirmDeleteEnabled = useSettingsStore((s) => s.confirmations.deleteSession);
  const storeSpaces = useWorkspaceStore((s) => s.spaces);
  const storeHistories = useWorkspaceStore((s) => s.historiesByWorkspace);
  const resolvedSpaces: readonly Workspace[] = propSpaces ?? storeSpaces;

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [groups, setGroups] = useState<readonly ArchivedWorkspaceGroup[]>(
    initialArchivedGroups ?? [],
  );
  const [restoringId, setRestoringId] = useState<string>();
  const [reloadTick, setReloadTick] = useState(0);
  const [localDeleteTarget, setLocalDeleteTarget] = useState<SessionTarget>();
  const [deletingLocal, setDeletingLocal] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [notice, setNotice] = useState('');
  const [previewTarget, setPreviewTarget] = useState<ArchivedPreviewTarget>();
  const [previewData, setPreviewData] = useState<Output<'session.readArchived'> | undefined>(
    initialPreview,
  );
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState('');

  useEffect(() => {
    if (initialArchivedGroups) setGroups(initialArchivedGroups);
  }, [initialArchivedGroups]);

  useEffect(() => {
    if (!active || initialArchivedGroups || typeof window === 'undefined' || !window.kapibala) {
      return undefined;
    }
    void archiveRevision;
    void reloadTick;
    let cancelled = false;
    setLoading(true);
    setError('');
    void (async () => {
      try {
        const fetched: ArchivedWorkspaceGroup[] = [];
        for (const space of resolvedSpaces) {
          if (!space.trusted) continue;
          const list = await window.kapibala.session.archived(space.id);
          if (cancelled) return;
          fetched.push({ space, list });
        }
        if (!cancelled) {
          setGroups(fetched);
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '读取归档会话失败，请重试。');
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [active, archiveRevision, initialArchivedGroups, reloadTick, resolvedSpaces]);

  const derivedWorktrees = useMemo<readonly ManagedWorktreeSummary[]>(() => {
    if (propWorktrees) return propWorktrees;
    const list: ManagedWorktreeSummary[] = [];
    for (const space of resolvedSpaces) {
      for (const item of storeHistories[space.id]?.items ?? []) {
        if (item.worktree) {
          list.push({
            ...item.worktree,
            workspaceName: space.name,
            sessionTitle: item.title || '未命名对话',
            prunable: false,
          });
        }
      }
    }
    return list;
  }, [propWorktrees, resolvedSpaces, storeHistories]);

  function openPreview(space: Workspace, conversationId: string, title: string): void {
    setPreviewTarget({ space, conversationId, title });
    setPreviewError('');
    if (initialPreview && initialPreview.conversationId === conversationId) {
      setPreviewData(initialPreview);
      return;
    }
    const reader =
      onReadArchived ??
      (typeof window !== 'undefined' && window.kapibala
        ? (wsId: string, convId: string) =>
            window.kapibala.session.readArchived({ workspaceId: wsId, conversationId: convId })
        : undefined);
    if (!reader) return;
    setPreviewLoading(true);
    setPreviewData(undefined);
    void reader(space.id, conversationId)
      .then((res) => setPreviewData(res))
      .catch((err: unknown) =>
        setPreviewError(err instanceof Error ? err.message : '读取归档对话正文失败。'),
      )
      .finally(() => setPreviewLoading(false));
  }

  async function handleRestore(
    space: Workspace,
    conversationId: string,
    openAfter = false,
  ): Promise<void> {
    if (typeof window === 'undefined' || !window.kapibala) return;
    setRestoringId(conversationId);
    setNotice('');
    try {
      await window.kapibala.session.restore({ workspaceId: space.id, conversationId });
      setReloadTick((v) => v + 1);
      onArchivedChanged?.();
      if (previewTarget?.conversationId === conversationId) setPreviewTarget(undefined);
      if (openAfter && onOpenRestoredConversation) {
        onOpenRestoredConversation(space, conversationId);
      } else {
        setNotice(locale === 'en' ? 'Restored chat to sidebar.' : '已恢复对话至侧栏列表。');
      }
    } catch (err) {
      report?.(err instanceof Error ? err.message : '恢复归档对话失败。');
    } finally {
      setRestoringId(undefined);
    }
  }

  async function executeImmediateDelete(target: SessionTarget): Promise<void> {
    if (typeof window === 'undefined' || !window.kapibala) return;
    try {
      await window.kapibala.session.delete({
        workspaceId: target.workspaceId,
        conversationId: target.conversationId,
      });
      setReloadTick((v) => v + 1);
      onArchivedChanged?.();
      setNotice(locale === 'en' ? 'Archived chat permanently deleted.' : '已永久删除归档对话。');
    } catch (err) {
      report?.(err instanceof Error ? err.message : '永久删除失败。');
    }
  }

  async function handleConfirmLocalDelete(): Promise<void> {
    if (!localDeleteTarget) return;
    setDeletingLocal(true);
    try {
      await executeImmediateDelete(localDeleteTarget);
      setLocalDeleteTarget(undefined);
    } finally {
      setDeletingLocal(false);
    }
  }

  async function handlePruneWorktrees(): Promise<void> {
    if (!onPruneWorktrees || pruning) return;
    setPruning(true);
    setNotice('');
    try {
      const count = await onPruneWorktrees();
      setNotice(
        count > 0 ? `已清理 ${count} 个孤立 Worktree 副本。` : '当前没有可清理的孤立副本。',
      );
    } catch (err) {
      report?.(err instanceof Error ? err.message : '清理 Worktree 失败。');
    } finally {
      setPruning(false);
    }
  }

  const totalArchivedCount = groups.reduce((acc, g) => acc + g.list.total, 0);
  const keyword = query.trim().toLowerCase();
  const filteredGroups = groups
    .map(({ space, list }) => ({
      space,
      list,
      visibleItems: keyword
        ? list.items.filter(
            (item) =>
              (item.title || '未命名对话').toLowerCase().includes(keyword) ||
              space.name.toLowerCase().includes(keyword),
          )
        : list.items,
    }))
    .filter((g) => g.visibleItems.length > 0);
  const prunableCount = derivedWorktrees.filter((w) => w.prunable).length;

  return (
    <div className="kpbl-settings-stack">
      {notice ? (
        <output className="kpbl-settings-banner" data-tone="success">
          <span>{notice}</span>
        </output>
      ) : null}
      {error ? (
        <div role="alert" className="kpbl-settings-banner" data-tone="danger">
          <span>{error}</span>
        </div>
      ) : null}
      {totalArchivedCount > 0 ? (
        <SearchField
          aria-label={t('archives.searchAria')}
          placeholder={t('archives.searchPlaceholder')}
          value={query}
          onValueChange={setQuery}
        />
      ) : null}
      {loading ? <p className="kpbl-field-hint">正在按工作区读取已归档会话…</p> : null}

      {!loading && !error && totalArchivedCount === 0 ? (
        <EmptyState
          icon="archive"
          title={locale === 'en' ? 'No Archived Chats' : '没有已归档的对话'}
          description={
            locale === 'en'
              ? 'Archiving hides chats from the sidebar without deleting history; preview or restore them anytime.'
              : '归档仅将对话从左侧导航栏收起而不删除历史文件，随时可在此查看内容或恢复。'
          }
        />
      ) : !loading && !error && filteredGroups.length === 0 ? (
        <EmptyState
          icon="magnifying-glass"
          title={locale === 'en' ? 'No Matching Archives' : '没有匹配的归档对话'}
        />
      ) : (
        filteredGroups.map(({ space, list, visibleItems }) => (
          <SettingSection
            key={space.id}
            title={space.name}
            description={
              list.total > list.items.length
                ? `共 ${list.total} 条归档，当前展示最近 ${list.items.length} 条。`
                : `共 ${list.total} 条已归档对话`
            }
          >
            {visibleItems.map((item) => {
              const titleText = item.title || '未命名对话';
              return (
                <SettingRow
                  key={item.conversationId}
                  title={
                    <button
                      type="button"
                      className="kpbl-archive-title-btn"
                      onClick={() => openPreview(space, item.conversationId, titleText)}
                    >
                      {titleText}
                    </button>
                  }
                  description={
                    <span className="kpbl-tabular">
                      {item.messageCount} {locale === 'en' ? 'messages' : '条消息'} ·{' '}
                      {formatActivityTimestamp(item.lastActivityAt, timeFormat, locale)}
                    </span>
                  }
                  control={
                    <>
                      <Button
                        variant="ghost"
                        size="xs"
                        leadingIcon="eye"
                        aria-label={`${t('archives.viewBtn')} ${titleText}`}
                        onClick={() => openPreview(space, item.conversationId, titleText)}
                      >
                        {t('archives.viewBtn')}
                      </Button>
                      <Button
                        variant="outline"
                        size="xs"
                        loading={restoringId === item.conversationId}
                        onClick={() => void handleRestore(space, item.conversationId, false)}
                      >
                        {t('archives.restoreBtn')}
                      </Button>
                      <Button
                        variant="danger"
                        size="xs"
                        disabled={restoringId === item.conversationId}
                        onClick={() => {
                          const target: SessionTarget = {
                            workspaceId: space.id,
                            conversationId: item.conversationId,
                            title: titleText,
                          };
                          if (!confirmDeleteEnabled) void executeImmediateDelete(target);
                          else if (onRequestDelete) onRequestDelete(target);
                          else setLocalDeleteTarget(target);
                        }}
                      >
                        {t('archives.deleteBtn')}
                      </Button>
                    </>
                  }
                />
              );
            })}
          </SettingSection>
        ))
      )}

      <SettingSection
        title="受管 Git Worktree"
        description="并行隔离会话创建的独立分支工作树副本概览；已结束且无未合并改动的孤立副本可一键清理。"
        actions={
          <Button
            variant="outline"
            size="xs"
            leadingIcon="trash"
            loading={pruning}
            disabled={!onPruneWorktrees && prunableCount === 0}
            onClick={() => void handlePruneWorktrees()}
          >
            清理孤立 Worktree
          </Button>
        }
      >
        {derivedWorktrees.length === 0 ? (
          <SettingRow
            title="当前没有受管 Git Worktree 副本"
            description="在启动台开启 Git Worktree 并行隔离后，各会话绑定的工作树路径与分支将在此集中展示。"
          />
        ) : (
          derivedWorktrees.map((wt) => (
            <SettingRow
              key={wt.id}
              title={
                <span className="kpbl-row-title-line">
                  <Badge tone="info" icon="git-branch">
                    {wt.branch}
                  </Badge>
                  <span>
                    {wt.workspaceName} / {wt.sessionTitle}
                  </span>
                  <Badge tone={wt.prunable ? 'warning' : 'success'}>
                    {wt.prunable ? '可清理' : '关联中'}
                  </Badge>
                </span>
              }
              description={<MiddleTruncate mono maxChars={62} text={wt.worktreePath} />}
            />
          ))
        )}
      </SettingSection>

      <ArchivePreviewModal
        target={previewTarget}
        preview={previewData}
        loading={previewLoading}
        error={previewError || undefined}
        restoring={Boolean(previewTarget && restoringId === previewTarget.conversationId)}
        onClose={() => setPreviewTarget(undefined)}
        onRestoreOnly={(tTarget) =>
          void handleRestore(tTarget.space, tTarget.conversationId, false)
        }
        onRestoreAndOpen={
          onOpenRestoredConversation
            ? (tTarget) => void handleRestore(tTarget.space, tTarget.conversationId, true)
            : undefined
        }
        report={report}
      />
      <SessionDeleteDialog
        target={localDeleteTarget}
        busy={deletingLocal}
        onCancel={() => setLocalDeleteTarget(undefined)}
        onConfirm={() => void handleConfirmLocalDelete()}
      />
    </div>
  );
}
