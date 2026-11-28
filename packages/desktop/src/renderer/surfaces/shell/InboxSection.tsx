import { useI18n } from '../../i18n.js';
import type { InboxItem } from '../../stores/index.js';
import { Badge, StatusDot, type StatusDotState } from '../../ui/index.js';

/**
 * `InboxSection` 入参契约（017 §6.1）：
 * 仅在存在待审批、运行中或后台监视已触发的会话时挂载，空闲时严格返回 `null` 释放左栏纵向空间。
 */
export interface InboxSectionProps {
  readonly items: readonly InboxItem[];
  readonly activeSessionKey?: string | null;
  readonly onSelectSession: (sessionKey: string, workspaceId: string) => void;
}

function mapStatusDot(status: InboxItem['status']): StatusDotState {
  if (status === 'waiting_approval') return 'waiting_approval';
  if (status === 'running') return 'running';
  return 'warning';
}

function mapBadgeTone(status: InboxItem['status']): 'pulse' | 'neutral' | 'warning' {
  if (status === 'waiting_approval') return 'pulse';
  if (status === 'running') return 'neutral';
  return 'warning';
}

/**
 * 左栏动态运行收件箱（`InboxSection`）：
 * 按「待审批（水豚琥珀脉搏胶囊）→ 运行中 → 监视已触发」优先级排列全空间活跃任务，支持单击跨空间直达。
 */
export function InboxSection({ items, activeSessionKey, onSelectSession }: InboxSectionProps) {
  const { locale, t } = useI18n();
  if (items.length === 0) return null;

  const formatBadge = (raw: string): string => {
    if (locale !== 'en') return raw;
    const m = /^待审批\s+(\d+)$/.exec(raw);
    if (m) return t('rail.statusApprovalCount', { count: Number(m[1]) });
    if (raw === '待审批') return t('rail.waitingApproval');
    if (raw === '运行中') return t('rail.statusRunning');
    if (raw === '监视已触发') return t('rail.statusWatchTriggered');
    return raw;
  };

  return (
    <section aria-label={t('rail.inboxSectionAria')} className="kpbl-inbox-section">
      <div className="kpbl-section-heading">
        <span>{t('rail.inboxSectionAria')}</span>
        <span className="tabular-nums">{items.length}</span>
      </div>
      {items.map((item) => {
        const active = item.sessionKey === activeSessionKey;
        const rightLabel =
          item.status === 'running' && item.harnessLabel
            ? item.harnessLabel
            : formatBadge(item.badgeLabel);
        return (
          <button
            key={item.sessionKey}
            type="button"
            data-active={active ? 'true' : undefined}
            aria-current={active ? 'page' : undefined}
            title={`${item.title} · ${item.workspaceName}`}
            className="kpbl-inbox-item"
            onClick={() => onSelectSession(item.sessionKey, item.workspaceId)}
          >
            <StatusDot status={mapStatusDot(item.status)} />
            <span className="min-w-0 truncate">{item.title}</span>
            <Badge tone={mapBadgeTone(item.status)}>{rightLabel}</Badge>
          </button>
        );
      })}
    </section>
  );
}
