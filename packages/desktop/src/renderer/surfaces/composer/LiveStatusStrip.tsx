import type {
  ViewRetryStatus,
  ViewTodoItem,
  ViewTodoState,
  ViewTodoStatus,
} from '@kiturone/kapibala-host/view-model';
import { useEffect, useState } from 'react';
import { useI18n } from '../../i18n.js';
import { useShellStore } from '../../stores/index.js';
import { AnchoredPopover, Badge, Button, Icon, IconButton } from '../../ui/index.js';

/** 活动监视条目摘要：供状态条弹层展示取消入口与本地开发端口预览快捷跳转（018 §6.1）。 */
export interface ActiveWatchSummaryItem {
  readonly id: string;
  readonly kind: 'file_change' | 'port_ready' | string;
  readonly target: string;
  readonly status?: 'watching' | 'triggered';
  readonly localPreviewUrl?: string;
}

/** 上下文窗口占用摘要。 */
export interface ContextUsageSummary {
  readonly usedTokens?: number;
  readonly limitTokens: number;
  readonly percent?: number;
}

const TODO_STATUS_LABELS: Readonly<Record<ViewTodoStatus, string>> = {
  completed: '已完成',
  in_progress: '进行中',
  pending: '待办',
  cancelled: '已取消',
};

function TodoStatusGlyph({ status }: { readonly status: ViewTodoStatus }) {
  if (status === 'completed') {
    return <Icon name="check-circle" size={14} className="kpbl-tone-success" />;
  }
  if (status === 'in_progress') {
    return <Icon name="circle-notch" size={14} />;
  }
  if (status === 'cancelled') {
    return <Icon name="x-circle" size={14} className="kpbl-tone-warning" />;
  }
  return <Icon name="circle" size={14} />;
}

function formatCompactTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
  return String(tokens);
}

/** 校验候选 URL 是否为安全回环开发地址（`http://localhost` / `127.0.0.1` / `[::1]`）。 */
export function extractLocalhostPreviewUrl(targetOrUrl: string | undefined): string | undefined {
  if (!targetOrUrl) return undefined;
  const trimmed = targetOrUrl.trim();
  if (/^\d{2,5}$/.test(trimmed)) {
    const port = Number(trimmed);
    return port >= 1 && port <= 65535 ? `http://localhost:${port}` : undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:') return undefined;
    const host = parsed.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]') {
      return parsed.href;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * `LiveStatusStrip` 入参契约（017 §6.4.2 & §7）：
 * - 当任务清单、活跃监视、退避重试、上下文占用与分支全部为空时必须返回 `null` 零占位；
 * - 任务进度触发按钮固定使用 `aria-label="任务清单"` 以守护桌面端 E2E 选择器契约。
 */
export interface LiveStatusStripProps {
  readonly sessionKey?: string | null;
  readonly todos?: ViewTodoState;
  readonly activeWatchesCount?: number;
  readonly watches?: readonly ActiveWatchSummaryItem[];
  readonly readyLocalPortUrl?: string;
  readonly retryStatus?: ViewRetryStatus;
  readonly contextUsage?: ContextUsageSummary;
  readonly gitBranch?: string;
  readonly worktreeBranch?: string;
  readonly nowMs?: number;
  readonly onCancelWatch?: (watchId: string) => void;
  readonly onOpenPortPreview?: (url: string) => void;
  readonly onStopRetry?: () => void;
}

/**
 * 输入坞上方单行动态状态聚合条（`LiveStatusStrip`）。
 */
export function LiveStatusStrip({
  sessionKey,
  todos,
  activeWatchesCount = 0,
  watches = [],
  readyLocalPortUrl,
  retryStatus,
  contextUsage,
  gitBranch,
  worktreeBranch,
  nowMs,
  onCancelWatch,
  onOpenPortPreview,
  onStopRetry,
}: LiveStatusStripProps) {
  const { t } = useI18n();
  const [todoOpen, setTodoOpen] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const [liveNow, setLiveNow] = useState(() => nowMs ?? Date.now());

  const hasRetryTimer = Boolean(retryStatus && nowMs === undefined);
  useEffect(() => {
    if (!hasRetryTimer || typeof window === 'undefined') return undefined;
    setLiveNow(Date.now());
    const timer = window.setInterval(() => setLiveNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasRetryTimer]);

  const hasTodos = Boolean(todos && todos.items.length > 0);
  const effectiveWatchCount = Math.max(activeWatchesCount, watches.length);

  const detectedPortUrl =
    extractLocalhostPreviewUrl(readyLocalPortUrl) ??
    watches
      .filter((w) => w.kind === 'port_ready')
      .map((w) => extractLocalhostPreviewUrl(w.localPreviewUrl ?? w.target))
      .find((url): url is string => Boolean(url));

  const contextPercent =
    contextUsage?.percent !== undefined
      ? contextUsage.percent
      : contextUsage?.usedTokens !== undefined && contextUsage.limitTokens > 0
        ? (contextUsage.usedTokens / contextUsage.limitTokens) * 100
        : undefined;

  const branchLabel = worktreeBranch?.trim() || gitBranch?.trim() || undefined;

  if (
    !hasTodos &&
    effectiveWatchCount === 0 &&
    !detectedPortUrl &&
    !retryStatus &&
    contextPercent === undefined &&
    !branchLabel
  ) {
    return null;
  }

  const effectiveNow = nowMs ?? liveNow;
  const retryRemainingSec = retryStatus
    ? Math.max(0, Math.ceil((retryStatus.nextRetryAt - effectiveNow) / 1000))
    : 0;

  const todoTotal = todos?.items.length ?? 0;
  const todoCompleted = todos?.items.filter((i) => i.status === 'completed').length ?? 0;
  const inProgressItems = todos?.items.filter((i) => i.status === 'in_progress') ?? [];
  const firstActiveTodo = inProgressItems[0];
  const todoSuffix =
    todoCompleted === todoTotal
      ? t('status.todoDoneSuffix')
      : firstActiveTodo
        ? ` · ${firstActiveTodo.title}`
        : '';
  const todoExtra = inProgressItems.length > 1 ? ` +${inProgressItems.length - 1}` : '';

  const handleOpenPortPreview = (url: string) => {
    if (onOpenPortPreview) return void onOpenPortPreview(url);
    if (!sessionKey) return;
    useShellStore.getState().openWorkbenchTab(sessionKey, {
      kind: 'preview',
      targetKey: `port:${url}`,
      title: t('workbench.tab.preview'),
      payload: { previewKind: 'localhost', url },
    });
  };

  const todoStatusLabel = (status: ViewTodoStatus) =>
    t(`status.todo.${status}` as keyof typeof TODO_STATUS_LABELS & `status.todo.${ViewTodoStatus}`);

  return (
    <div className="kpbl-live-strip">
      <div className="inline-flex min-w-0 flex-wrap items-center gap-2">
        {hasTodos && todos ? (
          <AnchoredPopover
            open={todoOpen}
            onOpenChange={setTodoOpen}
            placement="top-start"
            trigger={
              <Button
                size="xs"
                variant="outline"
                leadingIcon="list-checks"
                aria-label={t('status.todoAria')}
                aria-expanded={todoOpen}
                onClick={() => setTodoOpen((prev) => !prev)}
              >
                <span className="kpbl-tabular">
                  {t('status.todoCount', { done: todoCompleted, total: todoTotal })}
                </span>
                {todoSuffix ? <span className="max-w-44 truncate">{todoSuffix}</span> : null}
                {todoExtra ? <span>{todoExtra}</span> : null}
              </Button>
            }
          >
            <section aria-label={t('status.todoDetailsAria')} className="min-w-60 p-1">
              <ul className="m-0 flex list-none flex-col gap-1 p-0">
                {todos.items.map((item: ViewTodoItem) => (
                  <li
                    key={item.id}
                    aria-label={`${todoStatusLabel(item.status)}：${item.title}`}
                    className="flex items-center gap-2 rounded px-2 py-1 text-xs"
                  >
                    <TodoStatusGlyph status={item.status} />
                    <span
                      className={
                        item.status === 'cancelled'
                          ? 'min-w-0 flex-1 truncate line-through opacity-65'
                          : 'min-w-0 flex-1 truncate'
                      }
                    >
                      {item.title}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          </AnchoredPopover>
        ) : null}

        {effectiveWatchCount > 0 ? (
          <AnchoredPopover
            open={watchOpen}
            onOpenChange={setWatchOpen}
            placement="top-start"
            trigger={
              <Button
                size="xs"
                variant="outline"
                leadingIcon="eye"
                aria-label={t('status.activeWatchesAria')}
                aria-expanded={watchOpen}
                onClick={() => setWatchOpen((prev) => !prev)}
              >
                <span className="kpbl-tabular">
                  {t('status.watchCount', { count: effectiveWatchCount })}
                </span>
              </Button>
            }
          >
            <div className="flex min-w-56 flex-col gap-1.5 p-1.5">
              {watches.length === 0 ? (
                <p className="m-0 px-2 py-1 text-xs">
                  {t('status.watchEmptyHint', { count: effectiveWatchCount })}
                </p>
              ) : (
                watches.map((watch) => (
                  <div
                    key={watch.id}
                    className="flex items-center justify-between gap-2 rounded px-2 py-1 text-xs"
                  >
                    <span className="min-w-0 flex-1 truncate font-mono">{watch.target}</span>
                    {onCancelWatch ? (
                      <IconButton
                        size="xs"
                        icon="x"
                        aria-label={t('status.cancelWatchAria', { target: watch.target })}
                        onClick={() => onCancelWatch(watch.id)}
                      />
                    ) : null}
                  </div>
                ))
              )}
              {detectedPortUrl ? (
                <Button
                  size="xs"
                  variant="outline"
                  leadingIcon="globe"
                  onClick={() => {
                    setWatchOpen(false);
                    handleOpenPortPreview(detectedPortUrl);
                  }}
                >
                  {t('status.openPortPreview')}
                </Button>
              ) : null}
            </div>
          </AnchoredPopover>
        ) : null}

        {detectedPortUrl ? (
          <Button
            size="xs"
            variant="ghost"
            leadingIcon="globe"
            aria-label={t('status.openPortPreview')}
            onClick={() => handleOpenPortPreview(detectedPortUrl)}
          >
            {t('status.openPortPreview')}
          </Button>
        ) : null}

        {retryStatus ? (
          <output className="kpbl-retry-pill">
            <Icon name="arrows-clockwise" size={13} />
            <span className="truncate">
              {t('status.retryIn', {
                msg: retryStatus.message,
                sec: retryRemainingSec,
                attempt: retryStatus.attempt,
                max: retryStatus.maxRetries,
              })}
            </span>
            {onStopRetry ? (
              <Button
                size="xs"
                variant="ghost"
                aria-label={t('composer.stopBtn')}
                onClick={onStopRetry}
              >
                {t('composer.stopBtn')}
              </Button>
            ) : null}
          </output>
        ) : null}
      </div>

      <div className="inline-flex items-center gap-2 kpbl-tabular">
        {contextPercent !== undefined ? (
          <span
            title={
              contextUsage?.usedTokens !== undefined
                ? t('status.contextUsedTitle', {
                    used: contextUsage.usedTokens,
                    limit: contextUsage.limitTokens,
                  })
                : t('status.contextPercentTitle', { percent: Math.round(contextPercent) })
            }
          >
            {contextUsage?.usedTokens !== undefined
              ? `${formatCompactTokens(contextUsage.usedTokens)} (${Math.round(contextPercent)}%)`
              : `${Math.round(contextPercent)}%`}
          </span>
        ) : null}

        {branchLabel ? (
          <Badge tone={worktreeBranch ? 'info' : 'neutral'}>
            <span aria-hidden="true">⎇</span>
            <span className="font-mono">{branchLabel}</span>
          </Badge>
        ) : null}
      </div>
    </div>
  );
}
