import { useState } from 'react';
import { formatActivityTimestamp } from '../../../shared/i18n/index.js';
import type {
  UnifiedPreviewableCodeBlock,
  UnifiedTurn,
  UnifiedWorkbenchTarget,
} from '../../adapters/index.js';
import { useI18n } from '../../i18n.js';
import { MessageMarkdown } from '../../message-markdown.js';
import { useSettingsStore } from '../../stores/index.js';
import { Badge, Button, Icon, IconButton } from '../../ui/index.js';
import { ProcessGroup } from './ProcessGroup.js';

/** 用户消息气泡解析出的结构化溯源元数据（防原始 XML 包络直接泄漏到屏幕）。 */
export interface ParsedUserProvenance {
  readonly cleanText: string;
  readonly handoffFromTitle?: string;
  readonly references: readonly {
    readonly id: string;
    readonly label: string;
    readonly role?: string;
  }[];
  readonly systemSummary?: string;
}

const SESSION_REF_BLOCK_RE = /<session-reference\s+([^>]*)>[\s\S]*?<\/session-reference>/gi;
const HANDOFF_BLOCK_RE = /<conversation_handoff>\s*([\s\S]*?)<\/conversation_handoff>/gi;
const ATTR_PAIR_RE = /([a-zA-Z_][a-zA-Z0-9_-]*)="([^"]*)"/g;

function parseXmlAttributes(attrSource: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_PAIR_RE.lastIndex = 0;
  let match = ATTR_PAIR_RE.exec(attrSource);
  while (match !== null) {
    const key = match[1];
    const val = match[2];
    if (key && val !== undefined) {
      attrs[key] = val;
    }
    match = ATTR_PAIR_RE.exec(attrSource);
  }
  return attrs;
}

/**
 * 纯函数剥离用户消息中的 `<session-reference>`、`<conversation_handoff>`、`<watch-event>` 与 `<subagent-notification>` 包络，
 * 转换为可读徽标与干净的用户输入文本。
 */
export function parseUserMessageProvenance(rawText: string): ParsedUserProvenance {
  const trimmed = rawText.trim();
  if (trimmed.startsWith('<watch-event ')) {
    const firstTagEnd = trimmed.indexOf('>');
    const attrs = firstTagEnd > 0 ? parseXmlAttributes(trimmed.slice(13, firstTagEnd)) : {};
    const target = attrs.target || attrs.kind || '文件或端口变化';
    return {
      cleanText: '',
      references: [],
      systemSummary: `监视事件已触发 · ${target}`,
    };
  }
  if (trimmed.startsWith('<subagent-notification ')) {
    const firstTagEnd = trimmed.indexOf('>');
    const attrs = firstTagEnd > 0 ? parseXmlAttributes(trimmed.slice(23, firstTagEnd)) : {};
    const taskLabel = attrs.description || attrs.role || attrs.agentId || '子代理任务';
    return {
      cleanText: '',
      references: [],
      systemSummary: `↳ 子代理通知 · ${taskLabel}`,
    };
  }

  const references: Array<{ id: string; label: string; role?: string }> = [];
  let handoffFromTitle: string | undefined;

  let working = rawText.replace(SESSION_REF_BLOCK_RE, (_full, attrStr: string) => {
    const attrs = parseXmlAttributes(attrStr);
    const sessionId = attrs.session ?? 'session';
    const recordId = attrs.record;
    const title = attrs.title?.trim() || `会话 ${sessionId.slice(0, 8)}`;
    const id = recordId ? `${sessionId}:${recordId}` : sessionId;
    if (!references.some((r) => r.id === id)) {
      references.push({
        id,
        label: title,
        role: attrs.role,
      });
    }
    return '';
  });

  working = working.replace(HANDOFF_BLOCK_RE, (_full, inner: string) => {
    const titleMatch = /原会话：([^）)\n]+)/.exec(inner);
    handoffFromTitle = titleMatch?.[1]?.trim() || '历史对话';
    return '';
  });

  return {
    cleanText: working.trim(),
    handoffFromTitle,
    references,
  };
}

function buildTurnMetaText(turn: UnifiedTurn): string | undefined {
  if (turn.turnMetaBadge) return turn.turnMetaBadge;
  if (!turn.turnMeta) return undefined;
  const parts = [
    turn.turnMeta.agentName?.trim(),
    turn.turnMeta.modelLabel?.trim(),
    turn.turnMeta.effortLabel?.trim(),
    turn.turnMeta.modeLabel?.trim(),
  ].filter((item): item is string => Boolean(item));
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

const NOOP_REPORT = () => {};

/**
 * `TurnItem` 入参契约（017 §6.3 & §7）：
 * - 严格保留 `<article aria-label="你的消息">` 与 `<article aria-label="Kapibala 回复">` 无障碍地标契约；
 * - 正文内 `html` / `svg` 代码片段提供一键打开右侧工作台 `预览`（`Preview`）标签的显式按钮；
 * - 轮次尾栏在完成态展示 `复制正文`、`重新生成回答`、`还原文件并重试`、`还原检查点` 与 `消耗 N token`。
 */
export interface TurnItemProps {
  readonly turn: UnifiedTurn;
  readonly harnessKind?: 'native' | 'external';
  readonly harnessLabel?: string;
  readonly workspaceRoot?: string;
  readonly handoffFromTitle?: string;
  readonly onOpenWorkbenchTarget?: (target: UnifiedWorkbenchTarget) => void;
  readonly onOpenCodePreview?: (block: UnifiedPreviewableCodeBlock) => void;
  readonly onRegenerate?: (turn: UnifiedTurn) => void;
  readonly onRestoreAndRetry?: (turn: UnifiedTurn) => void;
  readonly onRestoreCheckpoint?: (turn: UnifiedTurn) => void;
  readonly onEditUserMessage?: (text: string) => void;
  readonly onThinkingExpandedChange?: (stepId: string, expanded: boolean) => void;
  readonly onReport?: (message: string) => void;
}

/**
 * 单轮对话与执行流视图单元（`TurnItem`）。
 */
export function TurnItem({
  turn,
  harnessKind = 'native',
  harnessLabel,
  workspaceRoot,
  handoffFromTitle,
  onOpenWorkbenchTarget,
  onOpenCodePreview,
  onRegenerate,
  onRestoreAndRetry,
  onRestoreCheckpoint,
  onEditUserMessage,
  onThinkingExpandedChange,
  onReport = NOOP_REPORT,
}: TurnItemProps) {
  const { locale, t } = useI18n();
  const timeFormat = useSettingsStore((s) => s.general.timeFormat);
  const [copiedReply, setCopiedReply] = useState(false);
  const [copiedUser, setCopiedUser] = useState(false);

  const userParsed = turn.userMessage
    ? parseUserMessageProvenance(turn.userMessage.text)
    : undefined;
  const effectiveHandoff = handoffFromTitle ?? userParsed?.handoffFromTitle;

  const streamItems =
    turn.streamItems.length > 0
      ? turn.streamItems
      : [
          ...turn.processSteps.map((step) => ({ kind: 'process' as const, step })),
          ...turn.proseBlocks.map((block) => ({ kind: 'prose' as const, block })),
        ];

  const hasAssistantContent =
    streamItems.length > 0 ||
    turn.state === 'interrupted' ||
    Boolean(turn.usage) ||
    Boolean(turn.turnMeta || turn.turnMetaBadge);

  const assistantCopyText = turn.proseBlocks
    .map((b) => b.text)
    .join('\n\n')
    .trim();

  const replySpeaker =
    harnessKind === 'external' && harnessLabel && harnessLabel !== 'Kapibala'
      ? harnessLabel
      : 'Kapibala';
  const replyLandmarkLabel = t('thread.replyAria', { name: replySpeaker });
  const turnTimeText = turn.timestamp
    ? formatActivityTimestamp(turn.timestamp, timeFormat, locale)
    : '';
  const metaBase = buildTurnMetaText(turn);
  const metaText = [turnTimeText, metaBase].filter(Boolean).join(' · ') || undefined;

  const copyTextToClipboard = (text: string, markCopied: (val: boolean) => void) => {
    if (!text || typeof navigator === 'undefined' || !navigator.clipboard) return;
    void navigator.clipboard.writeText(text).then(() => {
      markCopied(true);
      if (typeof window !== 'undefined') {
        window.setTimeout(() => markCopied(false), 1600);
      }
    });
  };

  const handleCodePreview = (codeBlock: UnifiedPreviewableCodeBlock) => {
    if (onOpenCodePreview) {
      onOpenCodePreview(codeBlock);
      return;
    }
    onOpenWorkbenchTarget?.({
      kind: 'preview',
      callId: codeBlock.id,
      previewKind: codeBlock.language,
      label: codeBlock.label,
      html: codeBlock.rawCode,
    });
  };

  return (
    <div className="kpbl-turn-item">
      {turn.userMessage && userParsed ? (
        userParsed.systemSummary ? (
          <div className="flex justify-center">
            <output className="kpbl-system-event-pill">
              <Icon name="eye" size={13} />
              <span>{userParsed.systemSummary}</span>
            </output>
          </div>
        ) : (
          <article aria-label={t('archives.userRole')} className="kpbl-user-turn">
            <div className="kpbl-user-bubble">
              {turn.userMessage.skillNames.length > 0 ||
              effectiveHandoff ||
              userParsed.references.length > 0 ? (
                <div className="kpbl-user-badges">
                  {turn.userMessage.skillNames.map((skill) => (
                    <Badge key={skill} tone="pulse" icon="sparkle">
                      {skill}
                    </Badge>
                  ))}
                  {effectiveHandoff ? (
                    <Badge tone="info" icon="shuffle">
                      {t('thread.handoffBadge', { title: effectiveHandoff })}
                    </Badge>
                  ) : null}
                  {userParsed.references.map((ref) => (
                    <Badge key={ref.id} tone="info" icon="file-text">
                      @{ref.label}
                    </Badge>
                  ))}
                </div>
              ) : null}
              {userParsed.cleanText ? <div>{userParsed.cleanText}</div> : null}
            </div>

            {userParsed.cleanText ? (
              <div className="kpbl-turn-actions">
                <IconButton
                  size="xs"
                  variant="ghost"
                  icon={copiedUser ? 'check' : 'copy'}
                  aria-label={t('thread.copySourceAria')}
                  onClick={() => copyTextToClipboard(userParsed.cleanText, setCopiedUser)}
                />
                {onEditUserMessage ? (
                  <IconButton
                    size="xs"
                    variant="ghost"
                    icon="pencil"
                    aria-label={t('thread.editMessageAria')}
                    onClick={() => onEditUserMessage(userParsed.cleanText)}
                  />
                ) : null}
                {turn.canRegenerate && !hasAssistantContent && onRegenerate ? (
                  <IconButton
                    size="xs"
                    variant="ghost"
                    icon="arrow-clockwise"
                    aria-label={t('thread.regenerateAria')}
                    onClick={() => onRegenerate(turn)}
                  />
                ) : null}
              </div>
            ) : null}
          </article>
        )
      ) : null}

      {hasAssistantContent ? (
        <article aria-label={replyLandmarkLabel} className="kpbl-assistant-turn">
          {streamItems.map((item) =>
            item.kind === 'process' ? (
              <ProcessGroup
                key={item.step.id}
                step={item.step}
                onOpenTarget={onOpenWorkbenchTarget}
                onExpandedChange={onThinkingExpandedChange}
                renderThinkingBody={(text, streaming) => (
                  <MessageMarkdown
                    text={text}
                    root={workspaceRoot}
                    streaming={streaming}
                    variant="compact"
                    report={onReport}
                  />
                )}
              />
            ) : (
              <div key={item.block.id} className="kpbl-prose-item">
                <MessageMarkdown
                  text={item.block.text}
                  root={workspaceRoot}
                  streaming={item.block.state === 'streaming'}
                  variant="body"
                  report={onReport}
                />
                {item.block.previewableCodeBlocks.length > 0 ? (
                  <div className="kpbl-prose-preview-bar">
                    {item.block.previewableCodeBlocks.map((cb) => (
                      <Button
                        key={cb.id}
                        size="xs"
                        variant="outline"
                        leadingIcon="eye"
                        aria-label={
                          cb.language === 'svg'
                            ? t('thread.previewSvgAria')
                            : t('thread.previewHtmlAria')
                        }
                        onClick={() => handleCodePreview(cb)}
                      >
                        {cb.language === 'svg'
                          ? t('thread.previewSvgBtn')
                          : t('thread.previewHtmlBtn')}
                      </Button>
                    ))}
                  </div>
                ) : null}
              </div>
            ),
          )}

          {turn.state === 'interrupted' ? (
            <output className="inline-flex items-center gap-1.5 text-xs kpbl-tone-warning">
              <Icon name="warning" size={14} />
              <span>{t('thread.interrupted')}</span>
            </output>
          ) : null}

          {turn.state !== 'streaming' &&
          (assistantCopyText ||
            turn.canRegenerate ||
            turn.canRestoreCheckpoint ||
            metaText ||
            turn.usage) ? (
            <footer className="kpbl-turn-footer">
              <div className="kpbl-turn-actions">
                {assistantCopyText ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    leadingIcon={copiedReply ? 'check' : 'copy'}
                    aria-label={t('thread.copyReply')}
                    onClick={() => copyTextToClipboard(assistantCopyText, setCopiedReply)}
                  >
                    {copiedReply ? t('thread.copied') : t('thread.copyReply')}
                  </Button>
                ) : null}

                {turn.canRegenerate && onRegenerate ? (
                  <IconButton
                    size="xs"
                    variant="ghost"
                    icon="arrow-clockwise"
                    aria-label={t('thread.regenerateAria')}
                    onClick={() => onRegenerate(turn)}
                  />
                ) : null}

                {turn.canRestoreCheckpoint && onRestoreAndRetry ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    leadingIcon="arrows-clockwise"
                    aria-label={t('thread.restoreAndRetry')}
                    onClick={() => onRestoreAndRetry(turn)}
                  >
                    {t('thread.restoreAndRetry')}
                  </Button>
                ) : null}

                {turn.canRestoreCheckpoint && onRestoreCheckpoint ? (
                  <Button
                    size="xs"
                    variant="ghost"
                    leadingIcon="arrow-bend-down-left"
                    aria-label={t('thread.restoreCheckpoint')}
                    onClick={() => onRestoreCheckpoint(turn)}
                  >
                    {t('thread.restoreCheckpoint')}
                  </Button>
                ) : null}
              </div>

              {metaText || turn.usage ? (
                <div className="kpbl-turn-meta">
                  {metaText ? <span>{metaText}</span> : null}
                  {metaText && turn.usage ? <span aria-hidden="true">·</span> : null}
                  {turn.usage ? (
                    <span
                      title={t('thread.tokenUsageTitle', {
                        prompt: turn.usage.promptTokens,
                        completion: turn.usage.completionTokens,
                      })}
                    >
                      {t('thread.tokenUsage', { total: turn.usage.totalTokens })}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </footer>
          ) : null}
        </article>
      ) : null}
    </div>
  );
}
