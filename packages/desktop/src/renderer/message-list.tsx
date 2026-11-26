import { Button, Collapsible, InlineCopyText } from '@cloudflare/kumo';
import {
  type ViewArtifact,
  type ViewBlock,
  type ViewEvidence,
  type ViewMessage,
  type ViewOperation,
  type ViewTool,
  summarizeToolGroup,
} from '@kiturone/kapibala-host/view-model';
import {
  ArrowClockwiseIcon,
  ArrowDownIcon,
  BrainIcon,
  CaretRightIcon,
  CheckCircleIcon,
  ImageSquareIcon,
  MinusCircleIcon,
  PencilSimpleIcon,
  SparkleIcon,
  SpinnerGapIcon,
  WarningIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type RefObject, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { artifactFileName } from './artifact-model.js';
import { toolPreview } from './html-preview-model.js';
import { HtmlPreview, HtmlPreviewButton } from './html-preview.js';
import { MessageMarkdown } from './message-markdown.js';
import { aggregateTurnUsage } from './turn-usage.js';
import { useUI } from './ui-state.js';

type StatusIcon = typeof CheckCircleIcon;
type BlockGroup = { kind: 'block'; block: ViewBlock } | { kind: 'tools'; blocks: ViewBlock[] };

/**
 * 视图层回合（Turn）投影项：
 * - 用户消息逐条独立；
 * - 两次用户提问之间的连续助手消息聚合为单个 `assistant-turn`，把多步工具/思考/过渡语收进同一视觉单元，
 *   避免每一步中间调用都重复渲染消息卡片与「复制正文 | 消耗 token」底栏。
 */
type TurnEntry =
  | { readonly kind: 'user'; readonly id: string; readonly message: ViewMessage }
  | {
      readonly kind: 'assistant-turn';
      readonly id: string;
      readonly messages: readonly ViewMessage[];
    };

/** 工具状态只提供图标与无障碍文本，不依赖颜色独立表达结果。 */
const TOOL_STATES: Record<ViewTool['status'], { label: string; icon: StatusIcon; tone: string }> = {
  running: { label: '执行中', icon: SpinnerGapIcon, tone: 'text-(--kapibala-signal)' },
  succeeded: { label: '已完成', icon: CheckCircleIcon, tone: 'text-kumo-subtle' },
  failed: { label: '失败', icon: XCircleIcon, tone: 'text-kumo-danger' },
  interrupted: { label: '已中断', icon: MinusCircleIcon, tone: 'text-kumo-subtle' },
};

/** 将平铺的 ViewMessage 序列按用户消息边界聚合为视觉回合。 */
function buildTurnEntries(messages: readonly ViewMessage[]): TurnEntry[] {
  const entries: TurnEntry[] = [];
  for (const message of messages) {
    if (message.role === 'user') {
      entries.push({ kind: 'user', id: message.id, message });
      continue;
    }
    const prev = entries.at(-1);
    if (prev?.kind === 'assistant-turn') {
      (prev.messages as ViewMessage[]).push(message);
    } else {
      entries.push({ kind: 'assistant-turn', id: message.id, messages: [message] });
    }
  }
  return entries;
}

/** 相邻工具块合并为一组；文本与思考块保持原顺序，不重排历史。 */
function groupBlocks(blocks: readonly ViewBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  for (const block of blocks) {
    if (block.kind !== 'tool') {
      groups.push({ kind: 'block', block });
      continue;
    }
    const last = groups.at(-1);
    if (last?.kind === 'tools') last.blocks.push(block);
    else groups.push({ kind: 'tools', blocks: [block] });
  }
  return groups;
}

/** 执行组摘要按「运行中优先、其次失败、再次中断」归纳，完成才显示通过。 */
function summarizeStatus(tools: readonly ViewTool[]): {
  state: ViewTool['status'];
  label: string;
  icon: StatusIcon;
  tone: string;
} {
  const state: ViewTool['status'] = tools.some((tool) => tool.status === 'running')
    ? 'running'
    : tools.some((tool) => tool.status === 'failed')
      ? 'failed'
      : tools.some((tool) => tool.status === 'interrupted')
        ? 'interrupted'
        : 'succeeded';
  const summary = TOOL_STATES[state];
  return {
    state,
    label: summary.label,
    icon: summary.icon,
    tone: summary.tone,
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  // 长跑任务超过一分钟换 m/s 组合，避免「125.0 s」这种不便扫读的秒数。
  // 先取整总秒数再拆分，防止 119.6s 被拆成「1m 60s」。
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** 整轮运行实时秒表格式化（按整秒跳动，避免小数抖动）。 */
function formatLiveSeconds(ms: number): string {
  const totalSeconds = Math.max(1, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/**
 * 摘要行只展示非零分区；全空时不渲染，避免新会话出现一排 +0 −0。
 * 行数超限截断或旧记录缺失 facts 时没有可信数字，按设计 010 §2 显示「未记录」而不估算：
 * 这是会话唯一的分区事实时必须独立撑起 chip（其他分区全零），否则证据面板失去唯一入口。
 */
function evidenceSummary(evidence: ViewEvidence | undefined): string | null {
  if (!evidence) return null;
  const { summary } = evidence;
  const parts: string[] = [];
  if (summary.additions || summary.deletions)
    parts.push(`变更 +${summary.additions} −${summary.deletions}`);
  if (summary.references) parts.push(`引用 ${summary.references} 条`);
  if (summary.mcpCalls) parts.push(`MCP 调用 ${summary.mcpCalls} 次`);
  if (summary.runningDelegations) parts.push(`委派 ${summary.runningDelegations} 个运行中`);
  const unrecorded = summary.truncatedFiles + summary.missingFiles;
  if (unrecorded > 0) parts.push(`变更 未记录 ${unrecorded} 项`);
  return parts.length ? parts.join(' · ') : null;
}

function firstNonEmptyLine(text: string, maxLen = 140): string | undefined {
  return text
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, maxLen);
}

/**
 * 从结构化 JSON 或纯文本工具结果提取可读失败原因；
 * 彻底杜绝把格式化 JSON 首行的孤立 `{` 当成错误摘要渲染到消息流。
 */
function extractFailureReason(result: string | undefined): string | undefined {
  if (!result) return undefined;
  const trimmed = result.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.message === 'string') {
        const inner = parsed.message.trim();
        if (inner.startsWith('{')) {
          try {
            const innerObj = JSON.parse(inner) as Record<string, unknown>;
            const outLine =
              typeof innerObj.output === 'string'
                ? firstNonEmptyLine(innerObj.output, 140)
                : undefined;
            const codePrefix =
              typeof innerObj.exitCode === 'number' ? `退出码 ${innerObj.exitCode}` : undefined;
            if (codePrefix && outLine) return `${codePrefix}：${outLine}`;
            if (outLine) return outLine;
            if (codePrefix) return codePrefix;
          } catch {
            /* 内层非 JSON 时回退外层 message 首行。 */
          }
        }
        return firstNonEmptyLine(inner, 160);
      }
      if (typeof parsed.output === 'string') {
        const outLine = firstNonEmptyLine(parsed.output, 140);
        if (typeof parsed.exitCode === 'number' && outLine)
          return `退出码 ${parsed.exitCode}：${outLine}`;
        if (outLine) return outLine;
      }
      if (typeof parsed.error === 'string') return firstNonEmptyLine(parsed.error, 160);
      return undefined;
    } catch {
      /* 截断 JSON 退回首行过滤（跳过纯 `{`）。 */
    }
  }
  return result
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line !== '{' && line !== '}')
    ?.slice(0, 160);
}

/**
 * 提取无 `chip` 工具（如 `todo_write`、`list_agents`）的单行回执摘要；
 * 已有路径/命令 `chip` 的工具直接主行展示 `chip`，且绝不回显 JSON 首行 `{` 或英文样板回执。
 */
function extractInlineSummary(tool: ViewTool | undefined): string | undefined {
  if (!tool) return undefined;
  if (tool.chip) return undefined;
  if (tool.status === 'failed') return undefined;
  if (tool.status === 'running') return '执行中…';
  if (tool.name === 'write_file' || tool.name === 'edit_file') return undefined;
  if (!tool.result) return undefined;
  const trimmed = tool.result.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof parsed.message === 'string') return firstNonEmptyLine(parsed.message, 100);
      return undefined;
    } catch {
      return undefined;
    }
  }
  return firstNonEmptyLine(trimmed, 100);
}

/**
 * 自动开合状态：默认随 `autoOpen`（如运行中展开、完成后自动收起），
 * 一旦用户手动点击则以用户选择为准，避免流式或重渲染覆盖用户操作。
 */
function useAutoDisclosure(autoOpen: boolean): [boolean, (next: boolean) => void] {
  const [userChoice, setUserChoice] = useState<boolean | undefined>(undefined);
  const open = userChoice ?? autoOpen;
  return [open, setUserChoice];
}

/**
 * 运行中耗时每秒跳动一次；1 秒起显实时读数，终态固定取 `durationMs`。
 * 不再因 30 秒静默编译把图标置灰，避免长命令看起来像挂死。
 */
function useToolElapsed(tool: ViewTool | undefined): string | undefined {
  const [now, setNow] = useState(() => Date.now());
  const baseline = useRef({
    callId: tool?.callId,
    at: Date.now(),
    elapsed: tool?.elapsedMs ?? 0,
  });
  if (baseline.current.callId !== tool?.callId) {
    baseline.current = {
      callId: tool?.callId,
      at: Date.now(),
      elapsed: tool?.elapsedMs ?? 0,
    };
  } else if ((tool?.elapsedMs ?? 0) > baseline.current.elapsed) {
    baseline.current = {
      callId: tool?.callId,
      at: now,
      elapsed: tool?.elapsedMs ?? 0,
    };
  }
  const running = tool?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!tool) return undefined;
  if (!running) return tool.durationMs === undefined ? undefined : formatDuration(tool.durationMs);
  const elapsed = Math.max(
    tool.elapsedMs ?? 0,
    baseline.current.elapsed + now - baseline.current.at,
  );
  return elapsed >= 1000 ? formatLiveSeconds(elapsed) : undefined;
}

function ToolRow({
  tool,
  openPreviews,
  onTogglePreview,
  onTool,
  onArtifact,
}: {
  tool?: ViewTool;
  openPreviews: Readonly<Record<string, boolean>>;
  onTogglePreview(callId: string): void;
  onTool(callId: string, trigger: HTMLElement): void;
  onArtifact(callId: string, artifact: ViewArtifact, trigger: HTMLElement): void;
}) {
  // 只对已成功落盘的内置 write_file（html/htm/svg）给预览入口；运行中、拒绝或超限时该值为空。
  const toolName = tool?.name;
  const toolInput = tool?.input ?? '';
  const toolStatus = tool?.status;
  const artifacts = useMemo(
    () => [...new Map((tool?.artifacts ?? []).map((item) => [item.path, item])).values()],
    [tool?.artifacts],
  );
  const previewDoc = useMemo(
    () => (toolName ? toolPreview(toolName, toolInput, toolStatus) : undefined),
    [toolName, toolInput, toolStatus],
  );
  const showPreview = Boolean(tool?.callId && openPreviews[tool.callId]);
  const state = TOOL_STATES[tool?.status ?? 'running'];
  const elapsedText = useToolElapsed(tool);
  const lines = tool?.result?.slice(0, 1201).split('\n') ?? [];
  const preview = lines.slice(0, 8).join('\n').slice(0, 1200);
  const truncated = lines.length > 8 || (tool?.result?.length ?? 0) > preview.length;
  const diff = lines.some((line) => /^(diff --git |@@ |--- |\+\+\+ )/.test(line));
  const failureReason = tool?.status === 'failed' ? extractFailureReason(tool.result) : undefined;
  const inlineSummary = extractInlineSummary(tool);
  const isRunning = tool?.status === 'running';
  const primarySubject = tool?.chip ?? inlineSummary ?? tool?.invocation;

  return (
    <div className="min-w-0">
      <div className="kapibala-work-row flex min-w-0 items-center gap-2 px-1.5 py-0.5">
        <state.icon
          size={14}
          className={`shrink-0 ${state.tone} ${isRunning ? 'kapibala-spin' : ''}`}
          aria-hidden="true"
        />
        <span className="sr-only">{state.label}</span>
        <span
          className={`shrink-0 text-xs ${
            isRunning
              ? 'font-medium text-kumo-default'
              : tool?.status === 'failed'
                ? 'font-medium text-kumo-danger'
                : 'text-kumo-subtle'
          }`}
        >
          {tool?.verb ?? tool?.displayName ?? '工具'}
        </span>
        {primarySubject && (
          <span
            className={`min-w-0 flex-1 truncate text-xs ${
              tool?.chip && tool.mono ? 'font-mono text-kumo-subtle' : 'text-kumo-faint'
            }`}
            title={primarySubject}
          >
            {primarySubject}
          </span>
        )}
        {!primarySubject && <span className="flex-1" />}
        {artifacts.map((artifact) => (
          <Button
            key={artifact.path}
            className="kapibala-action shrink-0 text-kumo-brand"
            variant="ghost"
            size="sm"
            aria-label={`预览图片 ${artifactFileName(artifact.path)}`}
            title={artifact.path}
            onClick={(event) => tool && onArtifact(tool.callId, artifact, event.currentTarget)}
          >
            <ImageSquareIcon size={14} />
            <span className="max-w-32 truncate">{artifactFileName(artifact.path)}</span>
          </Button>
        ))}
        {elapsedText && (
          <span
            className="shrink-0 font-mono text-2xs text-kumo-faint tabular-nums"
            aria-label="耗时"
          >
            {elapsedText}
          </span>
        )}
        {previewDoc && tool && (
          <HtmlPreviewButton
            open={showPreview}
            onClick={() => onTogglePreview(tool.callId)}
            kind={previewDoc.label === 'SVG 文件预览' ? 'SVG' : 'HTML'}
          />
        )}
        <Button
          className="kapibala-action shrink-0 text-kumo-subtle"
          variant="ghost"
          size="sm"
          shape="square"
          aria-label="查看详情"
          disabled={!tool}
          onClick={(event) => tool && onTool(tool.callId, event.currentTarget)}
        >
          <CaretRightIcon size={13} />
        </Button>
      </div>
      {failureReason && (
        <div
          className="truncate px-2 pb-0.5 pl-[26px] text-2xs text-kumo-danger"
          title={failureReason}
        >
          {failureReason}
        </div>
      )}
      {diff && preview && (
        <Collapsible.Root className="px-1.5 pb-1 pl-[22px]">
          <Collapsible.Trigger
            render={
              <Button className="kapibala-action text-kumo-subtle" variant="ghost" size="sm" />
            }
          >
            <CaretRightIcon size={12} /> 查看差异预览
          </Collapsible.Trigger>
          <Collapsible.Panel>
            {/* 保留缩进并允许横向滚动：break-all 会把多级缩进后的 diff 揉成一段。 */}
            <pre className="mt-1 max-h-40 overflow-x-auto overflow-y-auto rounded-md border border-kumo-line bg-kumo-base px-3 py-2 font-mono text-xs leading-5 whitespace-pre">
              {preview.split('\n').map((line, index) => (
                <span
                  key={`${index}:${line}`}
                  className={
                    line.startsWith('+') && !line.startsWith('+++')
                      ? 'text-kumo-success'
                      : line.startsWith('-') && !line.startsWith('---')
                        ? 'text-kumo-danger'
                        : undefined
                  }
                >
                  {line}
                  {'\n'}
                </span>
              ))}
            </pre>
            {truncated && (
              <p className="px-2 py-1 text-xs text-kumo-subtle">预览已截断，完整结果见详情。</p>
            )}
          </Collapsible.Panel>
        </Collapsible.Root>
      )}
      {showPreview && previewDoc && (
        <div className="px-1.5 pt-1 pb-2 pl-[22px]">
          <HtmlPreview html={previewDoc.html} label={previewDoc.label} />
        </div>
      )}
    </div>
  );
}

function ToolGroup({
  blocks,
  openPreviews,
  onTogglePreview,
  onTool,
  onArtifact,
}: {
  blocks: readonly ViewBlock[];
  openPreviews: Readonly<Record<string, boolean>>;
  onTogglePreview(callId: string): void;
  onTool(callId: string, trigger: HTMLElement): void;
  onArtifact(callId: string, artifact: ViewArtifact, trigger: HTMLElement): void;
}) {
  const tools = blocks.flatMap((block) => (block.tool ? [block.tool] : []));
  const summary = summarizeStatus(tools);
  const group = summarizeToolGroup(tools);
  const totalMs = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  const autoOpen = summary.state === 'running' || summary.state === 'failed';
  const [open, setOpen] = useAutoDisclosure(autoOpen);

  // 单条工具不再外包「运行 1 次」组壳：直接渲染扁平单行，减少重复嵌套并让详情按钮一步可达。
  if (blocks.length === 1) {
    return (
      <div className="my-0.5">
        <ToolRow
          tool={blocks[0].tool}
          openPreviews={openPreviews}
          onTogglePreview={onTogglePreview}
          onTool={onTool}
          onArtifact={onArtifact}
        />
      </div>
    );
  }

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="kapibala-tool-group my-0.5">
      <Collapsible.Trigger
        render={
          <Button
            className="kapibala-action kapibala-work-row group h-auto w-full justify-start gap-2 px-1.5 py-1 font-normal"
            variant="ghost"
            size="sm"
          />
        }
      >
        <summary.icon
          size={14}
          className={`shrink-0 ${summary.tone} ${summary.state === 'running' ? 'kapibala-spin' : ''}`}
          aria-hidden="true"
        />
        <span className="min-w-0 truncate text-xs text-kumo-subtle">
          {group?.text ?? `执行 ${tools.length} 步`}
        </span>
        {totalMs > 0 && (
          <span className="shrink-0 font-mono text-2xs text-kumo-faint tabular-nums">
            {formatDuration(totalMs)}
          </span>
        )}
        <CaretRightIcon
          size={12}
          className=" shrink-0 text-kumo-faint transition-transform group-data-[panel-open]:rotate-90"
          aria-hidden="true"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <div className="kapibala-indent-rail my-0.5 flex flex-col gap-0.5">
          {blocks.map((block) => (
            <ToolRow
              key={block.id}
              tool={block.tool}
              openPreviews={openPreviews}
              onTogglePreview={onTogglePreview}
              onTool={onTool}
              onArtifact={onArtifact}
            />
          ))}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function ThinkingDisclosure({
  block,
  root,
  report,
}: {
  block: ViewBlock;
  root?: string;
  report(message: string): void;
}) {
  const streaming = block.state === 'streaming';
  const [open, setOpen] = useAutoDisclosure(streaming);
  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="my-0.5">
      <Collapsible.Trigger
        render={
          <Button
            aria-label="思考过程"
            className="kapibala-action kapibala-work-row group h-auto gap-1.5 px-1.5 py-0.5 font-normal text-kumo-subtle"
            variant="ghost"
            size="sm"
          />
        }
      >
        <BrainIcon size={14} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
        <span className={streaming ? 'kapibala-shimmer-text text-xs' : 'text-xs text-kumo-subtle'}>
          {streaming ? '思考中…' : '思考过程'}
        </span>
        <CaretRightIcon
          size={12}
          className="shrink-0 text-kumo-faint transition-transform group-data-[panel-open]:rotate-90"
          aria-hidden="true"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <div className="kapibala-indent-rail mt-1 mb-1.5">
          <MessageMarkdown
            text={block.text}
            root={root}
            streaming={streaming}
            variant="compact"
            report={report}
          />
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function MessageBlocks({
  blocks,
  isUser,
  processCommentary,
  root,
  openPreviews,
  onTogglePreview,
  onTool,
  onArtifact,
  report,
}: {
  blocks: readonly ViewBlock[];
  isUser: boolean;
  /** 是否处于最终回答前的中间推理/工具阶段；为 true 时过渡短句采用紧凑次级墨色。 */
  processCommentary?: boolean;
  root?: string;
  openPreviews: Readonly<Record<string, boolean>>;
  onTogglePreview(callId: string): void;
  onTool(callId: string, trigger: HTMLElement): void;
  onArtifact(callId: string, artifact: ViewArtifact, trigger: HTMLElement): void;
  report(message: string): void;
}) {
  return (
    <>
      {groupBlocks(blocks).map((group) =>
        group.kind === 'tools' ? (
          <ToolGroup
            key={group.blocks[0].id}
            blocks={group.blocks}
            openPreviews={openPreviews}
            onTogglePreview={onTogglePreview}
            onTool={onTool}
            onArtifact={onArtifact}
          />
        ) : group.block.kind === 'thinking' ? (
          <ThinkingDisclosure
            key={group.block.id}
            block={group.block}
            root={root}
            report={report}
          />
        ) : group.block.skillName ? (
          <span
            key={group.block.id}
            className="inline-flex items-center gap-1.5 rounded-lg bg-kumo-recessed px-3 py-1.5 text-xs"
          >
            <SparkleIcon size={14} className="text-kumo-brand" />
            <span className="font-medium text-kumo-brand">{group.block.skillName}</span>
          </span>
        ) : (
          <MessageMarkdown
            key={group.block.id}
            text={group.block.text}
            root={root}
            streaming={!isUser && group.block.state === 'streaming'}
            variant={processCommentary ? 'compact' : 'body'}
            report={report}
          />
        ),
      )}
    </>
  );
}

/**
 * 回合级过程折叠区（对标 PI-Desktop TurnProcess）：
 * - 将最终总结前的多步思考、过渡自言自语与工具调用归并为一个顶层折叠项；
 * - 活跃运行中、尚无最终回答或存在失败工具时自动展开；整轮最终回答落定后自动折叠为一行摘要，
 *   让主阅读流只保留「1 行过程摘要 + 完整最终回答」。
 */
function TurnProcessSection({
  messages,
  isActive,
  hasFinalAnswer,
  root,
  openPreviews,
  onTogglePreview,
  onTool,
  onArtifact,
  report,
}: {
  messages: readonly ViewMessage[];
  isActive: boolean;
  hasFinalAnswer: boolean;
  root?: string;
  openPreviews: Readonly<Record<string, boolean>>;
  onTogglePreview(callId: string): void;
  onTool(callId: string, trigger: HTMLElement): void;
  onArtifact(callId: string, artifact: ViewArtifact, trigger: HTMLElement): void;
  report(message: string): void;
}) {
  const tools = useMemo(
    () => messages.flatMap((msg) => msg.blocks.flatMap((b) => (b.tool ? [b.tool] : []))),
    [messages],
  );
  const status = summarizeStatus(tools);
  const groupSummary = summarizeToolGroup(tools);
  const totalMs = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  const autoOpen = isActive || !hasFinalAnswer || status.state === 'failed';
  const [open, setOpen] = useAutoDisclosure(autoOpen);
  const summaryText =
    groupSummary?.text ??
    (tools.length > 0 ? `执行 ${tools.length} 步` : `${messages.length} 步推理`);

  return (
    <Collapsible.Root open={open} onOpenChange={setOpen} className="mb-2">
      <Collapsible.Trigger
        render={
          <Button
            className="kapibala-action kapibala-work-row group h-auto w-full justify-start gap-1.5 px-1.5 py-1 font-normal"
            variant="ghost"
            size="sm"
          />
        }
      >
        {isActive ? (
          <SpinnerGapIcon
            size={14}
            className="kapibala-spin shrink-0 text-(--kapibala-signal)"
            aria-hidden="true"
          />
        ) : status.state === 'failed' ? (
          <XCircleIcon size={14} className="shrink-0 text-kumo-danger" aria-hidden="true" />
        ) : (
          <SparkleIcon size={14} className="shrink-0 text-kumo-subtle" aria-hidden="true" />
        )}
        <span
          className={
            isActive
              ? 'kapibala-shimmer-text shrink-0 text-xs font-medium'
              : 'shrink-0 text-xs font-medium text-kumo-subtle'
          }
        >
          {isActive ? '正在执行' : '执行过程'}
        </span>
        <span className="min-w-0 truncate text-xs text-kumo-faint">· {summaryText}</span>
        {totalMs > 0 && (
          <span className="shrink-0 font-mono text-2xs text-kumo-faint tabular-nums">
            · {formatDuration(totalMs)}
          </span>
        )}
        <CaretRightIcon
          size={12}
          className="shrink-0 text-kumo-faint transition-transform group-data-[panel-open]:rotate-90"
          aria-hidden="true"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel>
        <div className="kapibala-indent-rail mt-1 flex flex-col gap-1">
          {messages.map((msg) => (
            <MessageBlocks
              key={msg.id}
              blocks={msg.blocks}
              isUser={false}
              processCommentary
              root={root}
              openPreviews={openPreviews}
              onTogglePreview={onTogglePreview}
              onTool={onTool}
              onArtifact={onArtifact}
              report={report}
            />
          ))}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/**
 * 对话流尾部常驻状态行（对标 t3code WorkingTimelineRow / orca NativeChatTurnActivityLine）：
 * - 活跃运行中（包括两步工具之间长达数十秒的模型等待空窗期）始终展示动态阶段文案与整轮秒表；
 * - 非正常结束（步数耗尽、审批暂停、模型异常或手动停止）时内联渲染终态说明与一键「继续执行」入口。
 */
function TurnStatusLine({
  operation,
  messages,
  hasPendingApproval,
  latestErrorNotice,
  onContinue,
}: {
  operation?: ViewOperation;
  messages: readonly ViewMessage[];
  hasPendingApproval?: boolean;
  latestErrorNotice?: string;
  onContinue?: () => void;
}) {
  const phase = operation?.phase ?? 'idle';
  const active = phase === 'running' || phase === 'cancelling' || phase === 'settling';
  const [now, setNow] = useState(() => Date.now());
  const startedRef = useRef<{ id?: string; at: number }>({ id: undefined, at: Date.now() });

  if (active && startedRef.current.id !== operation?.id) {
    startedRef.current = { id: operation?.id, at: Date.now() };
  } else if (!active && startedRef.current.id !== undefined) {
    startedRef.current = { id: undefined, at: Date.now() };
  }

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  if (active) {
    const tail = messages.at(-1);
    const tailBlocks = tail?.role === 'assistant' ? tail.blocks : [];
    const runningTool = [...tailBlocks].reverse().find((b) => b.tool?.status === 'running')?.tool;
    const streamingBlock = [...tailBlocks].reverse().find((b) => b.state === 'streaming');

    const liveLabel =
      phase === 'cancelling'
        ? '正在停止本轮任务…'
        : phase === 'settling'
          ? '正在收尾并保存记录…'
          : hasPendingApproval
            ? `等待审批确认${runningTool?.chip ? ` ${runningTool.chip}` : runningTool ? ` ${runningTool.displayName}` : ''}…`
            : runningTool
              ? `正在${runningTool.verb ?? '执行'}${runningTool.chip ? ` ${runningTool.chip}` : ` ${runningTool.displayName}`}…`
              : streamingBlock?.kind === 'thinking'
                ? '正在深度思考…'
                : streamingBlock?.kind === 'text'
                  ? '正在生成回答…'
                  : '正在思考下一步…';

    const elapsedMs = Math.max(0, now - startedRef.current.at);
    return (
      <output
        aria-live="polite"
        className="flex min-h-7 w-full items-center gap-2 px-6 py-2 text-xs text-kumo-subtle"
      >
        <SpinnerGapIcon
          size={14}
          className="kapibala-spin shrink-0 text-(--kapibala-signal)"
          aria-hidden="true"
        />
        <span className="kapibala-shimmer-text min-w-0 truncate font-medium">{liveLabel}</span>
        {elapsedMs >= 1000 && (
          <span className="shrink-0 font-mono text-2xs text-kumo-faint tabular-nums">
            · {formatLiveSeconds(elapsedMs)}
          </span>
        )}
      </output>
    );
  }

  if (phase === 'idle' && operation?.result === 'failed' && messages.length > 0) {
    return (
      <output className="mx-6 my-2 flex flex-wrap items-center gap-2 rounded-lg border border-kumo-line bg-kumo-recessed px-3 py-2 text-xs text-kumo-warning">
        <WarningIcon size={14} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 text-kumo-default">
          {latestErrorNotice || '本轮执行未完成便已中断。'}
        </span>
        {onContinue && (
          <Button
            className="kapibala-action shrink-0"
            variant="secondary"
            size="sm"
            onClick={onContinue}
          >
            继续执行
          </Button>
        )}
      </output>
    );
  }

  if (phase === 'idle' && operation?.result === 'aborted' && messages.length > 0) {
    return (
      <output className="flex min-h-7 w-full items-center gap-2 px-6 py-1.5 text-xs text-kumo-subtle">
        <MinusCircleIcon size={14} className="shrink-0 text-kumo-faint" aria-hidden="true" />
        <span>已手动停止本轮执行</span>
        {onContinue && (
          <Button
            className="kapibala-action shrink-0 text-kumo-subtle"
            variant="ghost"
            size="sm"
            onClick={onContinue}
          >
            继续执行
          </Button>
        )}
      </output>
    );
  }

  return null;
}

/** 消息虚拟化由 TanStack 负责；滚动跟随只记录用户意图，切换会话保留内存草稿与阅读位置。 */
export function MessageList({
  messages,
  operation,
  hasPendingApproval,
  latestErrorNotice,
  onContinue,
  retryableMessageId,
  onRetry,
  memoryKey,
  root,
  scrollRef,
  evidence,
  evidenceUnavailable,
  onTool,
  onArtifact,
  onEvidence,
  onEdit,
  report,
}: {
  messages: readonly ViewMessage[];
  /** 当前会话运行阶段与终态结果；驱动对话流尾部实时状态行与中断续跑入口。 */
  operation?: ViewOperation;
  /** 当前会话是否存在待用户确认的审批请求；置位时状态行显示「等待审批确认」而非误导性的「正在运行」。 */
  hasPendingApproval?: boolean;
  /** 最近一条运行期错误说明（脱敏）；在失败收口条中内联提示原因。 */
  latestErrorNotice?: string;
  /** 在步数耗尽、审批暂停或手动停止后一键发送「继续」续跑剩余任务。 */
  onContinue?: () => void;
  /** 唯一可重试的消息（最新一轮）；缺失时历史回答不出现重试按钮。 */
  retryableMessageId?: string;
  /** 重试 = 宿主截断上一轮后重新生成；只在最新回答上调用。 */
  onRetry(): void;
  memoryKey: string;
  /** 当前工作区根路径；正文里相对路径的本地图片以它为基准解析。 */
  root?: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  /** 会话看板摘要；为空或全零时不渲染 chip，避免新会话出现无意义入口。 */
  evidence?: ViewEvidence;
  /** 证据拉取失败标记：与「尚未加载」区分，此时保留最小 chip 让证据面板入口不消失。 */
  evidenceUnavailable?: boolean;
  onTool(callId: string, trigger: HTMLElement): void;
  /** 打开产物预览；chip 是工具调用常驻的重开入口。 */
  onArtifact(callId: string, artifact: ViewArtifact, trigger: HTMLElement): void;
  /** 打开证据面板；trigger 用于关闭后把焦点还给摘要按钮。 */
  onEvidence(trigger: HTMLElement): void;
  /** 将用户消息原文回填到输入框供修改重发；只填草稿，不改写已落盘历史。 */
  onEdit(text: string): void;
  report(message: string): void;
}) {
  const summary = evidenceSummary(evidence);
  const entries = useMemo(() => buildTurnEntries(messages), [messages]);
  const isOperationActive =
    operation?.phase === 'running' ||
    operation?.phase === 'cancelling' ||
    operation?.phase === 'settling';
  const saved = useUI.getState().scrolls[memoryKey];
  const following = useRef(saved?.following ?? true);
  const userIntent = useRef(false);
  const frame = useRef<number | undefined>(undefined);
  const [atBottom, setAtBottom] = useState(following.current);
  // 工具 HTML/SVG 预览展开态按稳定的 callId 持有：临时消息落盘转正（provisionalId -> recordId）
  // 会更换虚拟行 key，放在 ToolRow 局部 state 会在提交边界丢失已展开的 iframe；切换会话时整体清空卸载。
  const [openPreviews, setOpenPreviews] = useState<Record<string, boolean>>({});
  const [previewScope, setPreviewScope] = useState(memoryKey);
  if (previewScope !== memoryKey) {
    setPreviewScope(memoryKey);
    setOpenPreviews({});
  }
  const togglePreview = (callId: string) => {
    setOpenPreviews((prev) => ({ ...prev, [callId]: !prev[callId] }));
  };
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 5,
    getItemKey: (index) => entries[index].id,
    initialOffset: saved?.offset ?? 0,
    onChange(instance, sync) {
      if (!sync && following.current && frame.current === undefined && entries.length)
        frame.current = requestAnimationFrame(() => {
          frame.current = undefined;
          if (following.current) {
            instance.scrollToIndex(entries.length - 1, { align: 'end' });
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }
        });
    },
  });
  const statusTailKey = `${isOperationActive}:${operation?.result ?? ''}`;
  useLayoutEffect(() => {
    if (!entries.length && !statusTailKey) return;
    if (following.current) {
      if (entries.length) virtualizer.scrollToIndex(entries.length - 1, { align: 'end' });
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [entries.length, statusTailKey, virtualizer, scrollRef]);
  // 证据 chip 挂载会把滚动容器压矮一行：跟随底部时立即补一次对齐，否则底部行被裁切。
  const hadChip = useRef(false);
  useLayoutEffect(() => {
    const mounted = Boolean(summary) || Boolean(evidenceUnavailable);
    if (mounted && !hadChip.current && following.current && entries.length)
      virtualizer.scrollToIndex(entries.length - 1, { align: 'end' });
    hadChip.current = mounted;
  }, [summary, evidenceUnavailable, entries.length, virtualizer]);
  useEffect(() => {
    const element = scrollRef.current;
    return () => {
      if (frame.current !== undefined) cancelAnimationFrame(frame.current);
      useUI.getState().scroll(memoryKey, element?.scrollTop ?? 0, following.current);
    };
  }, [memoryKey, scrollRef]);
  const bottom = () => {
    following.current = true;
    userIntent.current = false;
    setAtBottom(true);
    if (entries.length) virtualizer.scrollToIndex(entries.length - 1, { align: 'end' });
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {(summary || evidenceUnavailable) && (
        <div className="shrink-0 px-6 pt-3">
          <Button
            className="kapibala-action"
            variant="ghost"
            size="sm"
            // 可访问名保持稳定，作为证据面板唯一入口的 e2e 契约；失败态只换可见文案。
            aria-label="会话证据摘要"
            onClick={(event) => onEvidence(event.currentTarget)}
          >
            {summary ?? '证据不可用'}
          </Button>
        </div>
      )}
      <div
        ref={scrollRef}
        role="log"
        aria-label="对话内容"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动消息区接受键盘阅读，并作为虚拟行卸载后的稳定焦点返回目标。
        tabIndex={0}
        className="min-h-0 flex-1 overflow-y-auto outline-offset-2"
        onWheel={(event) => {
          userIntent.current = true;
          if (event.deltaY < 0) {
            following.current = false;
            setAtBottom(false);
          }
        }}
        onPointerDown={() => {
          userIntent.current = true;
        }}
        onKeyDown={(event) => {
          if (['PageUp', 'Home', 'ArrowUp', 'PageDown', 'End', 'ArrowDown'].includes(event.key))
            userIntent.current = true;
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
          if (nearBottom || userIntent.current) {
            following.current = nearBottom;
            setAtBottom(nearBottom);
          }
        }}
      >
        {entries.length === 0 && !isOperationActive && (
          <p className="py-12 text-center text-sm text-kumo-subtle">对话已就绪，输入你的问题。</p>
        )}
        <div className="kapibala-thread relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const entry = entries[row.index];
            const isLastEntry = row.index === entries.length - 1;

            if (entry.kind === 'user') {
              const message = entry.message;
              const copyText = message.blocks
                .filter((block) => block.kind === 'text' && !block.skillName)
                .map((block) => block.text)
                .join('\n');
              const retryable = message.id === retryableMessageId;
              return (
                <div
                  key={row.key}
                  data-index={row.index}
                  ref={virtualizer.measureElement}
                  className="absolute top-0 left-0 w-full px-6 pt-7 pb-2"
                  style={{ transform: `translateY(${row.start}px)` }}
                >
                  <article aria-label="你的消息" className="group ml-auto w-fit max-w-[85%]">
                    <div className="kapibala-user-bubble whitespace-pre-wrap break-words">
                      <MessageBlocks
                        blocks={message.blocks}
                        isUser
                        root={root}
                        openPreviews={openPreviews}
                        onTogglePreview={togglePreview}
                        onTool={onTool}
                        onArtifact={onArtifact}
                        report={report}
                      />
                    </div>
                    {(copyText || retryable) && (
                      <div className="mt-1 flex items-center justify-end gap-1 opacity-0 transition-opacity [@media(hover:none)]:opacity-100 group-hover:opacity-100 focus-within:opacity-100">
                        {copyText && (
                          <>
                            <InlineCopyText
                              className="kapibala-action text-kumo-subtle"
                              value={copyText}
                              labels={{ copyAction: '复制原文', copied: '已复制' }}
                            >
                              {''}
                            </InlineCopyText>
                            <Button
                              className="kapibala-action text-kumo-subtle"
                              variant="ghost"
                              size="sm"
                              shape="square"
                              aria-label="编辑该消息"
                              title="编辑该消息"
                              onClick={() => onEdit(copyText)}
                            >
                              <PencilSimpleIcon size={14} />
                            </Button>
                          </>
                        )}
                        {retryable && (
                          <Button
                            className="kapibala-action text-kumo-subtle"
                            variant="ghost"
                            size="sm"
                            shape="square"
                            aria-label="重新生成回答"
                            title="重新生成回答"
                            onClick={onRetry}
                          >
                            <ArrowClockwiseIcon size={14} />
                          </Button>
                        )}
                      </div>
                    )}
                  </article>
                </div>
              );
            }

            // 助手回合：将单次提问触发的多条消息收拢为「执行过程 + 最终回答 + 唯一底栏」。
            const turnMessages = entry.messages;
            const isTurnActive =
              (isLastEntry && isOperationActive) ||
              turnMessages.some(
                (msg) =>
                  msg.state === 'streaming' ||
                  msg.blocks.some((b) => b.state === 'streaming' || b.tool?.status === 'running'),
              );
            const lastMsg = turnMessages.at(-1)!;
            const lastHasTools = lastMsg.blocks.some((b) => b.kind === 'tool');
            const lastAnswerText = lastMsg.blocks
              .filter((b) => b.kind === 'text' && !b.skillName)
              .map((b) => b.text)
              .join('\n')
              .trim();
            const hasSplitAnswer =
              turnMessages.length >= 2 && !lastHasTools && lastAnswerText.length > 0;
            const processMessages =
              turnMessages.length >= 2
                ? hasSplitAnswer
                  ? turnMessages.slice(0, -1)
                  : turnMessages
                : [];
            const finalMessage =
              turnMessages.length === 1 ? lastMsg : hasSplitAnswer ? lastMsg : undefined;
            const processTools = processMessages.flatMap((m) =>
              m.blocks.flatMap((b) => (b.tool ? [b.tool] : [])),
            );
            // 单步单工具不套外层过程壳（如单次写入文件后总结），2 步及以上自动归入 TurnProcess。
            const foldProcess = processMessages.length >= 2 || processTools.length >= 2;

            const copyText =
              finalMessage && lastAnswerText
                ? lastAnswerText
                : turnMessages
                    .flatMap((m) => m.blocks)
                    .filter((b) => b.kind === 'text' && !b.skillName)
                    .map((b) => b.text)
                    .join('\n');

            const tailInterrupted = lastMsg.state === 'interrupted';
            const showHistoricalInterrupt =
              tailInterrupted &&
              !(
                isLastEntry &&
                operation?.phase === 'idle' &&
                (operation.result === 'failed' || operation.result === 'aborted')
              );
            const hasBody = turnMessages.some((m) =>
              m.blocks.some((b) => b.kind === 'text' || b.kind === 'tool'),
            );
            const retryable = Boolean(
              retryableMessageId && turnMessages.some((m) => m.id === retryableMessageId),
            );
            const latestUsage = aggregateTurnUsage(turnMessages);

            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className={`absolute top-0 left-0 w-full px-6 ${
                  row.index === 0 ? 'pt-5 pb-2' : 'pt-2 pb-2'
                }`}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <article aria-label="Kapibala 回复" className="group w-full">
                  <div className="w-full">
                    {foldProcess && (
                      <TurnProcessSection
                        messages={processMessages}
                        isActive={isTurnActive}
                        hasFinalAnswer={Boolean(finalMessage)}
                        root={root}
                        openPreviews={openPreviews}
                        onTogglePreview={togglePreview}
                        onTool={onTool}
                        onArtifact={onArtifact}
                        report={report}
                      />
                    )}
                    {!foldProcess &&
                      processMessages.map((msg) => (
                        <MessageBlocks
                          key={msg.id}
                          blocks={msg.blocks}
                          isUser={false}
                          processCommentary
                          root={root}
                          openPreviews={openPreviews}
                          onTogglePreview={togglePreview}
                          onTool={onTool}
                          onArtifact={onArtifact}
                          report={report}
                        />
                      ))}
                    {finalMessage && (
                      <MessageBlocks
                        blocks={finalMessage.blocks}
                        isUser={false}
                        root={root}
                        openPreviews={openPreviews}
                        onTogglePreview={togglePreview}
                        onTool={onTool}
                        onArtifact={onArtifact}
                        report={report}
                      />
                    )}
                  </div>
                  {showHistoricalInterrupt && (
                    <output className="mt-1 flex items-start gap-1.5 text-xs text-kumo-warning">
                      <WarningIcon size={14} className="mt-0.5 shrink-0" />
                      <span>
                        {hasBody
                          ? '本轮生成中断，输出可能不完整。'
                          : '本轮没有收到可展示的正文，常见原因是输出达到上限。可在「设置 → 高级设置」调大该模型的「最大输出 Token」后重试。'}
                      </span>
                    </output>
                  )}
                  {!isTurnActive && (copyText || latestUsage || retryable) && (
                    <div className="kapibala-action mt-2 flex flex-wrap items-center gap-2 text-xs text-kumo-subtle opacity-0 transition-opacity [@media(hover:none)]:opacity-100 group-hover:opacity-100 focus-within:opacity-100 focus-visible:opacity-100">
                      {copyText && (
                        <InlineCopyText
                          className="kapibala-action text-kumo-subtle"
                          value={copyText}
                          labels={{ copyAction: '复制正文', copied: '已复制正文' }}
                        >
                          <span>复制正文</span>
                        </InlineCopyText>
                      )}
                      {retryable && (
                        <Button
                          className="kapibala-action text-kumo-subtle"
                          variant="ghost"
                          size="sm"
                          shape="square"
                          aria-label="重新生成回答"
                          title="重新生成回答"
                          onClick={onRetry}
                        >
                          <ArrowClockwiseIcon size={14} />
                        </Button>
                      )}
                      {latestUsage && (
                        <span
                          className="text-2xs text-kumo-faint tabular-nums"
                          title={`输入 ${latestUsage.promptTokens.toLocaleString('zh-CN')} · 输出 ${latestUsage.completionTokens.toLocaleString('zh-CN')}`}
                        >
                          | 消耗 {latestUsage.totalTokens.toLocaleString('zh-CN')} token
                        </span>
                      )}
                    </div>
                  )}
                </article>
              </div>
            );
          })}
        </div>
        <div className="kapibala-thread">
          <TurnStatusLine
            operation={operation}
            messages={messages}
            hasPendingApproval={hasPendingApproval}
            latestErrorNotice={latestErrorNotice}
            onContinue={onContinue}
          />
        </div>
      </div>
      {!atBottom && (
        <div className="absolute right-5 bottom-4">
          <Button className="kapibala-action" variant="secondary" onClick={bottom}>
            <ArrowDownIcon size={16} />
            返回底部
          </Button>
        </div>
      )}
    </div>
  );
}
