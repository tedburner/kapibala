import { type ReactNode, useState } from 'react';
import type {
  UnifiedProcessStep,
  UnifiedToolItem,
  UnifiedWorkbenchTarget,
} from '../../adapters/index.js';
import { useI18n } from '../../i18n.js';
import { Button, Icon, IconButton, MiddleTruncate, StatusDot } from '../../ui/index.js';

/** 格式化工具或批量过程耗时（毫秒 / 秒 / 分秒分段，保持等宽数字可读性）。 */
export function formatProcessDuration(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined || !Number.isFinite(durationMs) || durationMs < 0) {
    return undefined;
  }
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const totalSec = Math.round(durationMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
}

function ToolStatusGlyph({ status }: { readonly status: UnifiedToolItem['status'] }) {
  const { t } = useI18n();
  if (status === 'running') {
    return <StatusDot status="running" label={t('process.running')} />;
  }
  if (status === 'failed') {
    return (
      <>
        <Icon name="x-circle" size={14} className="kpbl-tone-danger" />
        <span className="kpbl-sr-only">{t('process.failed')}</span>
      </>
    );
  }
  if (status === 'interrupted') {
    return (
      <>
        <Icon name="minus-circle" size={14} className="kpbl-tone-warning" />
        <span className="kpbl-sr-only">{t('process.interrupted')}</span>
      </>
    );
  }
  return (
    <>
      <Icon name="check-circle" size={14} className="kpbl-tone-success" />
      <span className="kpbl-sr-only">{t('process.completed')}</span>
    </>
  );
}

function ToolExecutionRow({
  tool,
  onOpenTarget,
}: {
  readonly tool: UnifiedToolItem;
  readonly onOpenTarget?: (target: UnifiedWorkbenchTarget) => void;
}) {
  const { t } = useI18n();
  const durationLabel = formatProcessDuration(tool.durationMs);
  const diffAdd = tool.diffStat?.additions ?? null;
  const diffDel = tool.diffStat?.deletions ?? null;
  const hasDiff =
    (diffAdd !== null && diffAdd > 0) ||
    (diffDel !== null && diffDel > 0) ||
    (diffAdd === 0 && diffDel === 0 && tool.primaryTarget.kind === 'diff');

  const triggerPrimary = () => {
    onOpenTarget?.(tool.primaryTarget);
  };

  const triggerInspector = () => {
    onOpenTarget?.({ kind: 'inspector', callId: tool.callId });
  };

  return (
    <div className="min-w-0">
      <div className="kpbl-tool-row">
        <button
          type="button"
          className="kpbl-tool-main"
          onClick={triggerPrimary}
          title={`${tool.verb} ${tool.targetLabel}`}
        >
          <ToolStatusGlyph status={tool.status} />
          <span className="kpbl-tool-verb">{tool.verb}</span>
          <MiddleTruncate
            text={tool.targetLabel}
            mono={tool.mono}
            maxChars={54}
            className="kpbl-tool-target"
          />
        </button>

        {hasDiff ? (
          <span className="inline-flex items-center gap-1 font-mono text-xs kpbl-tabular">
            {diffAdd !== null ? <span className="kpbl-diff-add">+{diffAdd}</span> : null}
            {diffDel !== null ? <span className="kpbl-diff-del">−{diffDel}</span> : null}
          </span>
        ) : null}

        {durationLabel ? (
          <span
            aria-label={t('process.durationAria')}
            className="font-mono text-xs kpbl-tabular"
            style={{ color: 'var(--kpbl-ink-faint)' }}
          >
            {durationLabel}
          </span>
        ) : null}

        {tool.primaryTarget.kind === 'delegation' ? (
          <Button
            size="xs"
            variant="ghost"
            aria-label={
              tool.primaryTarget.taskName
                ? t('process.openSubsessionNamedAria', { name: tool.primaryTarget.taskName })
                : t('process.openSubsession')
            }
            onClick={triggerPrimary}
          >
            <span aria-hidden="true">↳</span>
            <span>{t('process.openSubsession')}</span>
          </Button>
        ) : null}

        {tool.primaryTarget.kind === 'preview' ? (
          <Button
            size="xs"
            variant="ghost"
            leadingIcon={tool.primaryTarget.previewKind === 'image' ? 'image' : 'eye'}
            aria-label={
              tool.primaryTarget.previewKind === 'svg'
                ? t('thread.previewSvgAria')
                : tool.primaryTarget.previewKind === 'html'
                  ? t('thread.previewHtmlAria')
                  : t('thread.previewImageAria', { label: tool.primaryTarget.label })
            }
            onClick={triggerPrimary}
          >
            {tool.primaryTarget.previewKind === 'svg'
              ? t('thread.previewSvgAria')
              : tool.primaryTarget.previewKind === 'html'
                ? t('thread.previewHtmlAria')
                : tool.primaryTarget.label}
          </Button>
        ) : null}

        <IconButton
          size="xs"
          variant="ghost"
          icon="arrow-square-out"
          aria-label={t('process.inspectAria')}
          onClick={triggerInspector}
        />
      </div>

      {tool.failureReason ? (
        <div className="kpbl-tool-error" title={tool.failureReason}>
          {tool.failureReason}
        </div>
      ) : null}
    </div>
  );
}

function ThinkingStepItem({
  step,
  renderThinkingBody,
  onExpandedChange,
}: {
  readonly step: Extract<UnifiedProcessStep, { readonly kind: 'thinking' }>;
  readonly renderThinkingBody?: (text: string, streaming: boolean) => ReactNode;
  readonly onExpandedChange?: (stepId: string, expanded: boolean) => void;
}) {
  const { t } = useI18n();
  const [userExpanded, setUserExpanded] = useState<boolean | undefined>(undefined);
  const isStreaming = step.state === 'streaming';
  const expanded = userExpanded ?? step.expanded;

  const toggle = () => {
    const next = !expanded;
    setUserExpanded(next);
    onExpandedChange?.(step.id, next);
  };

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-label={t('process.thinkingAria')}
        aria-expanded={expanded}
        className="kpbl-process-header"
        onClick={toggle}
      >
        {isStreaming ? (
          <StatusDot status="running" label={t('process.thinkingStreaming')} />
        ) : (
          <Icon name="brain" size={14} />
        )}
        <span className="truncate">
          {isStreaming ? t('process.thinkingStreaming') : t('process.thinkingAria')}
        </span>
        <Icon name={expanded ? 'caret-down' : 'caret-right'} size={12} />
      </button>

      {expanded ? (
        <div className="kpbl-process-rail">
          {renderThinkingBody ? (
            renderThinkingBody(step.text, isStreaming)
          ) : (
            <div className="kapibala-prose kapibala-prose-compact whitespace-pre-wrap">
              {step.text}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

function ToolGroupStepItem({
  step,
  defaultExpanded = true,
  onOpenTarget,
}: {
  readonly step: Extract<UnifiedProcessStep, { readonly kind: 'tool_group' }>;
  readonly defaultExpanded?: boolean;
  readonly onOpenTarget?: (target: UnifiedWorkbenchTarget) => void;
}) {
  const [userExpanded, setUserExpanded] = useState<boolean | undefined>(undefined);
  const expanded = userExpanded ?? defaultExpanded;
  const totalDuration = formatProcessDuration(step.totalDurationMs);

  /* 单条工具直接扁平渲染，避免嵌套一层多余的「已执行 1 步」折叠壳，让详情与预览按钮一步可达。 */
  if (step.tools.length === 1 && step.tools[0]) {
    return <ToolExecutionRow tool={step.tools[0]} onOpenTarget={onOpenTarget} />;
  }

  const summaryPrefix = step.status === 'succeeded' ? '✓ ' : step.status === 'failed' ? '✗ ' : '';

  return (
    <div className="min-w-0">
      <button
        type="button"
        aria-expanded={expanded}
        className="kpbl-process-header"
        onClick={() => setUserExpanded(!expanded)}
      >
        <ToolStatusGlyph status={step.status} />
        <span className="min-w-0 flex-1 truncate">
          {summaryPrefix}
          {step.summaryText}
        </span>
        {totalDuration ? (
          <span
            className="font-mono text-xs kpbl-tabular"
            style={{ color: 'var(--kpbl-ink-faint)' }}
          >
            {totalDuration}
          </span>
        ) : null}
        <Icon name={expanded ? 'caret-down' : 'caret-right'} size={12} />
      </button>

      {expanded ? (
        <div className="kpbl-process-rail">
          {step.tools.map((tool) => (
            <ToolExecutionRow key={tool.callId} tool={tool} onOpenTarget={onOpenTarget} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * `ProcessGroup` 入参契约（017 §6.3 & U1.7）：
 * - 支持传入单个 `step` 或批量 `steps`，按原始时序渲染可折叠推理过程与工具执行组；
 * - 工具行始终保留显式动作按钮（`查看详情`、`预览 HTML/SVG`、`↳ 打开子会话`），确保无悬停触控端与键盘巡航零盲区。
 */
export interface ProcessGroupProps {
  readonly step?: UnifiedProcessStep;
  readonly steps?: readonly UnifiedProcessStep[];
  readonly defaultToolGroupExpanded?: boolean;
  readonly renderThinkingBody?: (text: string, streaming: boolean) => ReactNode;
  readonly onExpandedChange?: (stepId: string, expanded: boolean) => void;
  readonly onOpenTarget?: (target: UnifiedWorkbenchTarget) => void;
}

/**
 * 助手推理与工具执行过程组（`ProcessGroup`）。
 */
export function ProcessGroup({
  step,
  steps,
  defaultToolGroupExpanded = true,
  renderThinkingBody,
  onExpandedChange,
  onOpenTarget,
}: ProcessGroupProps) {
  const resolvedSteps = steps ?? (step ? [step] : []);
  if (resolvedSteps.length === 0) return null;

  return (
    <div className="kpbl-process-stack">
      {resolvedSteps.map((item) =>
        item.kind === 'thinking' ? (
          <ThinkingStepItem
            key={item.id}
            step={item}
            renderThinkingBody={renderThinkingBody}
            onExpandedChange={onExpandedChange}
          />
        ) : (
          <ToolGroupStepItem
            key={item.id}
            step={item}
            defaultExpanded={defaultToolGroupExpanded}
            onOpenTarget={onOpenTarget}
          />
        ),
      )}
    </div>
  );
}
