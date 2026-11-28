import type { ViewEvidence, ViewEvidenceDelegationState } from '@kiturone/kapibala-host/view-model';
import { useI18n } from '../../i18n.js';
import { Badge, type BadgeTone, Button, EmptyState, MiddleTruncate } from '../../ui/index.js';

const DELEGATION_STATE_META: Readonly<
  Record<ViewEvidenceDelegationState, { readonly label: string; readonly tone: BadgeTone }>
> = {
  running: { label: '运行中', tone: 'pulse' },
  ended: { label: '已结束（父会话收尾）', tone: 'warning' },
  finished: { label: '已完成', tone: 'success' },
  idle: { label: '可续聊', tone: 'info' },
  archived: { label: '已归档', tone: 'neutral' },
};

const REFERENCE_ROLE_LABELS: Readonly<Record<ViewEvidence['references'][number]['role'], string>> =
  {
    user: '用户提问',
    assistant: '助手回答',
    branch_summary: '分支摘要',
  };

/**
 * `EvidenceDashboard` 入参契约（017 §6.5 & 018 §6.1）：
 * 只读消费宿主聚合的四维会话证据（变更明细、跨会话引用来源、MCP 调用统计、派生委派任务），
 * 缺失行数事实严格显示「未记录」而非伪造 0，并提供一键跳转委派子会话入口。
 */
export interface EvidenceDashboardProps {
  readonly evidence?: ViewEvidence;
  readonly onReloadEvidence?: () => void;
  readonly onOpenDelegationSession?: (sessionId: string) => void;
  readonly onOpenDiffFile?: (filePath: string, callId?: string) => void;
}

/**
 * 右侧工作台「详情与证据」下半区四维证据看板组件。
 */
export function EvidenceDashboard({
  evidence,
  onReloadEvidence,
  onOpenDelegationSession,
  onOpenDiffFile,
}: EvidenceDashboardProps) {
  const { locale, t } = useI18n();
  const delStateLabel = (state: ViewEvidenceDelegationState): string => {
    if (locale !== 'en') return DELEGATION_STATE_META[state].label;
    if (state === 'running') return t('rail.statusRunning');
    if (state === 'finished') return t('process.completed');
    if (state === 'idle') return 'Resumable';
    if (state === 'archived') return 'Archived';
    return 'Ended';
  };
  const refRoleLabel = (role: ViewEvidence['references'][number]['role']): string => {
    if (locale !== 'en') return REFERENCE_ROLE_LABELS[role];
    if (role === 'user') return 'User';
    if (role === 'assistant') return 'Assistant';
    return 'Branch summary';
  };

  return (
    <section aria-label={t('evidence.sectionAria')} className="kpbl-inspector-card">
      <div className="kpbl-wb-toolbar-group justify-between">
        <strong className="kpbl-setting-row-title">{t('evidence.title')}</strong>
        {onReloadEvidence ? (
          <Button
            variant="ghost"
            size="xs"
            leadingIcon="arrow-clockwise"
            onClick={onReloadEvidence}
          >
            {t('evidence.reloadBtn')}
          </Button>
        ) : null}
      </div>

      {!evidence ? (
        <EmptyState
          icon="list-checks"
          title={t('evidence.emptyTitle')}
          description={t('evidence.emptyDesc')}
        />
      ) : (
        <>
          <div className="kpbl-evidence-grid">
            <div className="kpbl-evidence-stat">
              <span className="kpbl-wb-meta">{t('evidence.statChanges')}</span>
              <strong className="kpbl-tabular">
                +{evidence.summary.additions} −{evidence.summary.deletions}
              </strong>
            </div>
            <div className="kpbl-evidence-stat">
              <span className="kpbl-wb-meta">{t('evidence.statRefs')}</span>
              <strong className="kpbl-tabular">
                {t('evidence.statRefsValue', { count: evidence.summary.references })}
              </strong>
            </div>
            <div className="kpbl-evidence-stat">
              <span className="kpbl-wb-meta">{t('evidence.statMcp')}</span>
              <strong className="kpbl-tabular">
                {t('evidence.statMcpValue', { calls: evidence.summary.mcpCalls })}
                {evidence.summary.mcpFailures > 0
                  ? t('evidence.statMcpFailed', { failed: evidence.summary.mcpFailures })
                  : ''}
              </strong>
            </div>
            <div className="kpbl-evidence-stat">
              <span className="kpbl-wb-meta">{t('evidence.statDelegations')}</span>
              <strong className="kpbl-tabular">
                {t('evidence.statDelegationsValue', {
                  running: evidence.summary.runningDelegations,
                  total: evidence.delegations.length,
                })}
              </strong>
            </div>
          </div>

          <div>
            <h4 className="kpbl-setting-section-title mb-2">{t('evidence.changesHeading')}</h4>
            {evidence.changes.length === 0 ? (
              <p className="kpbl-field-hint">{t('evidence.noChanges')}</p>
            ) : (
              <ul className="kpbl-evidence-list">
                {evidence.changes.map((item) => (
                  <li key={`${item.callId}:${item.path}`} className="kpbl-evidence-row">
                    {onOpenDiffFile ? (
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => onOpenDiffFile(item.path, item.callId)}
                      >
                        <MiddleTruncate text={item.path} mono maxChars={40} />
                      </Button>
                    ) : (
                      <MiddleTruncate text={item.path} mono maxChars={44} />
                    )}
                    <span className="kpbl-wb-meta">
                      {item.status === 'recorded'
                        ? `+${item.additions ?? 0} −${item.deletions ?? 0}`
                        : item.status === 'truncated'
                          ? t('evidence.unrecordedLarge')
                          : t('evidence.unrecorded')}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="kpbl-setting-section-title mb-2">{t('evidence.refsHeading')}</h4>
            {evidence.references.length === 0 ? (
              <p className="kpbl-field-hint">{t('evidence.noRefs')}</p>
            ) : (
              <ul className="kpbl-evidence-list">
                {evidence.references.map((refItem) => (
                  <li
                    key={`${refItem.sessionId}:${refItem.recordId}`}
                    className="kpbl-evidence-row"
                  >
                    <MiddleTruncate text={refItem.title ?? refItem.sessionId} maxChars={38} />
                    <div className="kpbl-wb-toolbar-group">
                      <Badge tone="info">{refRoleLabel(refItem.role)}</Badge>
                      <span className="kpbl-wb-meta font-mono">{refItem.recordId}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="kpbl-setting-section-title mb-2">{t('evidence.mcpHeading')}</h4>
            {evidence.mcp.length === 0 ? (
              <p className="kpbl-field-hint">{t('evidence.noMcp')}</p>
            ) : (
              <ul className="kpbl-evidence-list">
                {evidence.mcp.map((server) => (
                  <li key={server.server} className="kpbl-evidence-row">
                    <span className="font-mono">{server.server}</span>
                    <div className="kpbl-wb-toolbar-group">
                      <span className="kpbl-wb-meta">
                        {t('evidence.statMcpValue', { calls: server.calls })}
                      </span>
                      {server.failed > 0 ? (
                        <Badge tone="danger">
                          {t('evidence.mcpFailedBadge', { failed: server.failed })}
                        </Badge>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="kpbl-setting-section-title mb-2">{t('evidence.delegationsHeading')}</h4>
            {evidence.delegations.length === 0 ? (
              <p className="kpbl-field-hint">{t('evidence.noDelegations')}</p>
            ) : (
              <ul className="kpbl-evidence-list">
                {evidence.delegations.map((del) => {
                  const meta = DELEGATION_STATE_META[del.state];
                  return (
                    <li key={del.sessionId} className="kpbl-evidence-row">
                      <div className="flex min-w-0 flex-1 flex-col gap-1">
                        <div className="kpbl-wb-toolbar-group">
                          <strong>{del.taskName || del.title}</strong>
                          <Badge tone={meta.tone}>{delStateLabel(del.state)}</Badge>
                        </div>
                        {del.summary ? <p className="kpbl-field-hint">{del.summary}</p> : null}
                      </div>
                      <Button
                        variant="outline"
                        size="xs"
                        leadingIcon="arrow-square-out"
                        disabled={!onOpenDelegationSession}
                        onClick={() => onOpenDelegationSession?.(del.sessionId)}
                      >
                        {t('evidence.openDelegationBtn')}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
