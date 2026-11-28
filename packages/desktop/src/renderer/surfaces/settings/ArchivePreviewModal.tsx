import type { Output, Workspace } from '../../../shared/contracts.js';
import { formatActivityTimestamp } from '../../../shared/i18n/index.js';
import { useI18n } from '../../i18n.js';
import { MessageMarkdown } from '../../message-markdown.js';
import { useSettingsStore } from '../../stores/index.js';
import { Badge, Button, EmptyState, ModalDialog } from '../../ui/index.js';
import { parseUserMessageProvenance } from '../thread/TurnItem.js';

/** 归档会话内容预览目标身份。 */
export interface ArchivedPreviewTarget {
  readonly space: Workspace;
  readonly conversationId: string;
  readonly title: string;
}

/**
 * `ArchivePreviewModal` 入参契约：
 * 在不解除归档状态的前提下，以原生 `<dialog>` 只读渲染归档对话的完整问答正文、Markdown 代码块与工具调用摘要；
 * 底栏提供「恢复」与「恢复并打开对话」一键直达主舞台续聊。
 */
export interface ArchivePreviewModalProps {
  readonly target?: ArchivedPreviewTarget;
  readonly preview?: Output<'session.readArchived'>;
  readonly loading?: boolean;
  readonly error?: string;
  readonly restoring?: boolean;
  readonly onClose: () => void;
  readonly onRestoreOnly: (target: ArchivedPreviewTarget) => void;
  readonly onRestoreAndOpen?: (target: ArchivedPreviewTarget) => void;
  readonly report?: (message: string) => void;
}

const NOOP_REPORT = () => {};

/**
 * 「会话归档」只读对话内容预览模态框。
 */
export function ArchivePreviewModal({
  target,
  preview,
  loading = false,
  error,
  restoring = false,
  onClose,
  onRestoreOnly,
  onRestoreAndOpen,
  report = NOOP_REPORT,
}: ArchivePreviewModalProps) {
  const { locale, t } = useI18n();
  const timeFormat = useSettingsStore((s) => s.general.timeFormat);
  const displayTitle = preview?.title || target?.title || '未命名对话';

  return (
    <ModalDialog
      open={Boolean(target)}
      onOpenChange={(open) => {
        if (!open && !restoring) onClose();
      }}
      title={t('archives.previewModalTitle', { title: displayTitle })}
      description={
        target
          ? `${target.space.name}${preview?.gitBranch ? ` · ⎇ ${preview.gitBranch}` : ''}`
          : undefined
      }
      width="lg"
      closedBy={restoring ? 'none' : 'any'}
      closeLabel={t('general.cancel')}
      footer={
        target ? (
          <>
            <Button variant="outline" disabled={restoring} onClick={onClose}>
              {t('general.cancel')}
            </Button>
            <Button variant="outline" loading={restoring} onClick={() => onRestoreOnly(target)}>
              {t('archives.restoreBtn')}
            </Button>
            {onRestoreAndOpen ? (
              <Button
                variant="solid"
                leadingIcon="folder-open"
                loading={restoring}
                onClick={() => onRestoreAndOpen(target)}
              >
                {t('archives.restoreAndOpenBtn')}
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      {loading ? (
        <p className="kpbl-field-hint">{t('archives.previewLoading')}</p>
      ) : error ? (
        <div role="alert" className="kpbl-settings-banner" data-tone="danger">
          <span>{error}</span>
        </div>
      ) : !preview || preview.items.length === 0 ? (
        <EmptyState icon="file-text" title={t('archives.previewEmpty')} />
      ) : (
        <div className="kpbl-dialog-stack">
          {preview.truncated ? (
            <output className="kpbl-settings-banner">
              <span>{t('archives.previewTruncated')}</span>
            </output>
          ) : null}

          <div aria-label="归档消息列表" className="kpbl-archive-preview-scroll">
            {preview.items.map((turn) => {
              const isUser = turn.role === 'user';
              const parsedUser = isUser ? parseUserMessageProvenance(turn.text) : undefined;
              const visibleUserText =
                parsedUser?.systemSummary || parsedUser?.cleanText || turn.text;

              return (
                <article
                  key={turn.id}
                  data-role={turn.role}
                  aria-label={isUser ? t('archives.userRole') : t('archives.assistantRole')}
                  className="kpbl-archive-turn"
                >
                  <div className="kpbl-archive-turn-head">
                    <span className="font-medium">
                      {isUser ? t('archives.userRole') : t('archives.assistantRole')}
                    </span>
                    <span className="kpbl-tabular">
                      {formatActivityTimestamp(turn.timestamp, timeFormat, locale)}
                    </span>
                  </div>

                  {turn.toolSummaries.length > 0 ? (
                    <div className="kpbl-row-title-line">
                      {turn.toolSummaries.map((tool, idx) => (
                        <Badge
                          key={`${turn.id}-tool-${idx}`}
                          tone={tool.isError ? 'danger' : undefined}
                          icon={tool.isError ? 'warning-circle' : 'code'}
                        >
                          {tool.summary ? `${tool.name} · ${tool.summary}` : tool.name}
                        </Badge>
                      ))}
                    </div>
                  ) : null}

                  {isUser ? (
                    <div className="whitespace-pre-wrap">{visibleUserText}</div>
                  ) : turn.text ? (
                    <MessageMarkdown
                      text={turn.text}
                      root={target?.space.root}
                      streaming={false}
                      variant="body"
                      report={report}
                    />
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </ModalDialog>
  );
}
