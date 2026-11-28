import { useEffect, useState } from 'react';
import type { UnifiedApprovalItem } from '../../adapters/index.js';
import { useI18n } from '../../i18n.js';
import { useSessionStore, useShellStore } from '../../stores/index.js';
import { Badge, Button, Icon, Kbd } from '../../ui/index.js';

const RAW_UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const WIN_ABS_PATH_RE = /\b[A-Za-z]:\\(?:[^\\\s"'`]+\\)*([^\\\s"'`]+)/g;
const POSIX_HOST_PATH_RE =
  /(?:^|(?<=[\s"'`=]))\/(?:Users|home|var\/folders|private\/var|private\/tmp|tmp)(?:\/[^\s"'`]+)*\/([^\s/"'`]+)/g;

/**
 * 纯函数脱敏内联审批卡首屏摘要与子代理标签，剥离残留宿主绝对路径、临时目录前缀与原始 UUID；
 * 完整底层路径与会话标识仅保留在 `inspectorPayload` 中供右侧 `Inspector` 按需检视（017 §6.4.1 & §9 阶段 3）。
 */
export function sanitizeApprovalDisplayText(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(RAW_UUID_RE, '<id>')
    .replace(WIN_ABS_PATH_RE, './$1')
    .replace(POSIX_HOST_PATH_RE, './$1')
    .trim();
}

/**
 * `ApprovalDeck` 入参契约（017 §6.4 & §7）：
 * - 严格暴露 `region[aria-label="待处理审批"]` 替代旧版全屏阻断模态框；
 * - 左缘固定 `3px` `--kpbl-pulse` 水豚琥珀色条，动作按钮锁定精确无障碍名称（`拒绝`、`本会话允许相同调用`、`批准一次`）。
 */
export interface ApprovalDeckProps {
  readonly sessionKey?: string | null;
  readonly approvals: readonly UnifiedApprovalItem[];
  readonly replyingIds?: Readonly<Record<string, boolean>>;
  /** 可选受控当前毫秒时间戳，供纯函数 SSR 单测确定性验证倒计时展示。 */
  readonly nowMs?: number;
  readonly onReply?: (approvalId: string, actionId: string) => void | Promise<void>;
  readonly onInspectApproval?: (approval: UnifiedApprovalItem) => void;
  readonly onJumpToChildSession?: (childSessionId: string) => void;
}

/**
 * 内联非阻断工具与子代理冒泡审批叠卡（`ApprovalDeck`）。
 */
export function ApprovalDeck({
  sessionKey,
  approvals,
  replyingIds,
  nowMs,
  onReply,
  onInspectApproval,
  onJumpToChildSession,
}: ApprovalDeckProps) {
  const { locale, t } = useI18n();
  const [liveNow, setLiveNow] = useState(() => nowMs ?? Date.now());
  const storeReplyingIds = useSessionStore((s) => s.replyingApprovalIds);
  const storeReplyApproval = useSessionStore((s) => s.replyApproval);

  const topApproval = approvals[0];
  const hasExpiry = topApproval?.expiresAt !== undefined && nowMs === undefined;

  useEffect(() => {
    if (!hasExpiry || typeof window === 'undefined') return undefined;
    setLiveNow(Date.now());
    const timer = window.setInterval(() => setLiveNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasExpiry]);

  if (!topApproval) return null;

  const effectiveNow = nowMs ?? liveNow;
  const remainingSec =
    topApproval.expiresAt !== undefined
      ? Math.max(0, Math.ceil((topApproval.expiresAt - effectiveNow) / 1000))
      : undefined;
  const isExpired = remainingSec !== undefined && remainingSec <= 0;
  const effectiveReplying = Boolean((replyingIds ?? storeReplyingIds)[topApproval.id]);

  const cleanTitle = sanitizeApprovalDisplayText(topApproval.title);
  const cleanSummary = sanitizeApprovalDisplayText(topApproval.summaryCode);
  const cleanSubDesc = topApproval.subagentBadge
    ? sanitizeApprovalDisplayText(
        topApproval.subagentBadge.description || topApproval.subagentBadge.role,
      )
    : undefined;

  const handleAction = (actionId: string) => {
    if (effectiveReplying || isExpired) return;
    if (onReply) {
      void onReply(topApproval.id, actionId);
      return;
    }
    void storeReplyApproval(topApproval.id, actionId);
  };

  const handleInspect = () => {
    if (onInspectApproval) {
      onInspectApproval(topApproval);
      return;
    }
    if (!sessionKey) return;
    useShellStore.getState().openWorkbenchTab(sessionKey, {
      kind: 'inspector',
      targetKey: `approval:${topApproval.id}`,
      title: t('workbench.tab.inspector'),
      payload: topApproval.inspectorPayload,
    });
  };

  const localizeActionLabel = (action: UnifiedApprovalItem['actions'][number]): string => {
    if (locale !== 'en') return action.label;
    if (action.id === 'allow_once') return t('approval.allowOnce');
    if (action.id === 'allow_session') return t('approval.allowSession');
    if (action.id === 'deny_once' || action.id === '__cancel__') return t('approval.deny');
    return action.label;
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements lint/a11y/noRedundantRoles: 显式输出 role="region" 以同时满足纯字符串 SSR 单测与 Chromium 无障碍地标契约（017 §7）。
    <section role="region" aria-label={t('approval.landmark')} className="kpbl-approval-deck">
      <div className="kpbl-approval-card">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="inline-flex min-w-0 flex-wrap items-center gap-2">
            <Icon name="shield-warning" size={15} />
            <span
              className="truncate text-sm font-medium"
              style={{ color: 'var(--kpbl-ink-strong)' }}
            >
              {cleanTitle}
            </span>

            {topApproval.source === 'delegation' && topApproval.subagentBadge ? (
              topApproval.subagentBadge.childSessionId && onJumpToChildSession ? (
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={t('approval.openSubagentAria', { desc: cleanSubDesc ?? '' })}
                  onClick={() => onJumpToChildSession(topApproval.subagentBadge!.childSessionId!)}
                >
                  <span aria-hidden="true">↳</span>
                  <span>{t('approval.subagentBadge', { desc: cleanSubDesc ?? '' })}</span>
                </Button>
              ) : (
                <Badge tone="info">
                  {`↳ ${t('approval.subagentBadge', { desc: cleanSubDesc ?? '' })}`}
                </Badge>
              )
            ) : null}

            {topApproval.source === 'external' ? (
              <Badge outline icon="plugs-connected">
                {t('approval.externalBadge')}
              </Badge>
            ) : null}

            {topApproval.riskLabel ? (
              <Badge tone="pulse">{sanitizeApprovalDisplayText(topApproval.riskLabel)}</Badge>
            ) : null}
          </div>

          <div className="inline-flex items-center gap-2">
            <Badge>{`1 / ${approvals.length}`}</Badge>
            {remainingSec !== undefined ? (
              <span
                className="font-mono text-xs kpbl-tabular"
                style={{ color: 'var(--kpbl-ink-subtle)' }}
              >
                {isExpired ? t('approval.expired') : `${remainingSec}s`}
              </span>
            ) : null}
          </div>
        </div>

        <pre className="kpbl-approval-summary">
          {topApproval.relativeCwd && topApproval.relativeCwd !== '.'
            ? `[${sanitizeApprovalDisplayText(topApproval.relativeCwd)}] ${cleanSummary}`
            : cleanSummary}
        </pre>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button
            size="xs"
            variant="ghost"
            leadingIcon="info"
            aria-label={t('approval.inspectBtn')}
            onClick={handleInspect}
          >
            {t('approval.inspectBtn')}
          </Button>

          <div className="inline-flex flex-wrap items-center gap-2">
            {topApproval.actions.map((action) => {
              const variant =
                action.intent === 'primary'
                  ? 'solid'
                  : action.intent === 'danger'
                    ? 'danger'
                    : 'outline';
              const actionText = localizeActionLabel(action);
              return (
                <Button
                  key={action.id}
                  size="sm"
                  variant={variant}
                  aria-label={actionText}
                  disabled={effectiveReplying || isExpired}
                  onClick={() => handleAction(action.id)}
                >
                  <span>{actionText}</span>
                  {action.shortcutHint ? <Kbd aria-hidden="true">{action.shortcutHint}</Kbd> : null}
                </Button>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
