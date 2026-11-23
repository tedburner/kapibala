import { Button, Collapsible, InlineCopyText } from '@cloudflare/kumo';
import {
  type ViewArtifact,
  type ViewBlock,
  type ViewEvidence,
  type ViewMessage,
  type ViewTool,
  summarizeToolGroup,
} from '@kiturone/kapibala-host/view-model';
import {
  ArrowClockwiseIcon,
  ArrowDownIcon,
  BrainIcon,
  CaretDownIcon,
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
import { useUI } from './ui-state.js';

type StatusIcon = typeof CheckCircleIcon;
type BlockGroup = { kind: 'block'; block: ViewBlock } | { kind: 'tools'; blocks: ViewBlock[] };

/** 工具状态只提供图标与无障碍文本，不依赖颜色独立表达结果。 */
const TOOL_STATES: Record<ViewTool['status'], { label: string; icon: StatusIcon; tone: string }> = {
  running: { label: '执行中', icon: SpinnerGapIcon, tone: 'text-(--kapibala-signal)' },
  succeeded: { label: '已完成', icon: CheckCircleIcon, tone: 'text-kumo-success' },
  failed: { label: '失败', icon: XCircleIcon, tone: 'text-kumo-danger' },
  interrupted: { label: '已中断', icon: MinusCircleIcon, tone: 'text-kumo-subtle' },
};

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
function summarize(tools: readonly ViewTool[]): {
  label: string;
  icon: StatusIcon;
  tone: string;
} {
  const state = tools.some((tool) => tool.status === 'running')
    ? 'running'
    : tools.some((tool) => tool.status === 'failed')
      ? 'failed'
      : tools.some((tool) => tool.status === 'interrupted')
        ? 'interrupted'
        : 'succeeded';
  const summary = TOOL_STATES[state];
  return {
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

/** 失败原因只取首行非空文本；完整结果仍在详情抽屉，不把整段错误铺到消息流。 */
function firstReason(result: string | undefined): string | undefined {
  if (!result) return undefined;
  return result
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?.slice(0, 160);
}

/**
 * 运行中耗时每秒跳动一次；超过 3 秒才显示，避免短调用闪烁。
 * 宿主 `elapsedMs` 是进度事件快照，本地计时从该快照起算，终态固定取 `durationMs`；
 * 连续 30 秒没有新进度时标记 stale，由调用方降低视觉权重（「无活动」不等于中断）。
 */
function useToolElapsed(tool: ViewTool | undefined): { text?: string; stale: boolean } {
  const [now, setNow] = useState(() => Date.now());
  const baseline = useRef({
    callId: tool?.callId,
    at: Date.now(),
    elapsed: tool?.elapsedMs ?? 0,
    lastActive: Date.now(),
  });
  if (baseline.current.callId !== tool?.callId) {
    baseline.current = {
      callId: tool?.callId,
      at: Date.now(),
      elapsed: tool?.elapsedMs ?? 0,
      lastActive: Date.now(),
    };
  } else if ((tool?.elapsedMs ?? 0) > baseline.current.elapsed) {
    baseline.current = {
      callId: tool?.callId,
      at: now,
      elapsed: tool?.elapsedMs ?? 0,
      lastActive: now,
    };
  }
  const running = tool?.status === 'running';
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  if (!tool) return { stale: false };
  if (!running)
    return {
      text: tool.durationMs === undefined ? undefined : formatDuration(tool.durationMs),
      stale: false,
    };
  const elapsed = Math.max(
    tool.elapsedMs ?? 0,
    baseline.current.elapsed + now - baseline.current.at,
  );
  return {
    text: elapsed >= 3000 ? formatDuration(elapsed) : undefined,
    stale: now - baseline.current.lastActive >= 30_000,
  };
}

function ToolRow({
  tool,
  onTool,
  onArtifact,
}: {
  tool?: ViewTool;
  onTool(callId: string, trigger: HTMLElement): void;
  onArtifact(callId: string, artifact: ViewArtifact, trigger: HTMLElement): void;
}) {
  // 只对内置 write_file 的目标为 html/htm/svg 时给预览入口；解析失败或超限时该值为空。
  // 按 name/input 两段文本做记忆，避免流式事件换对象引用时重复解析整份入参。
  const toolName = tool?.name;
  const toolInput = tool?.input ?? '';
  // 产物按路径去重：同一次调用重复下发同一路径时不重复渲染 chip。
  const artifacts = useMemo(
    () => [...new Map((tool?.artifacts ?? []).map((item) => [item.path, item])).values()],
    [tool?.artifacts],
  );
  const previewDoc = useMemo(
    () => (toolName ? toolPreview(toolName, toolInput) : undefined),
    [toolName, toolInput],
  );
  const [showPreview, setShowPreview] = useState(false);
  const state = TOOL_STATES[tool?.status ?? 'running'];
  const elapsed = useToolElapsed(tool);
  // 限制单行预览长度与行数，完整的已脱敏内容仍由详情抽屉展示。
  const lines = tool?.result?.slice(0, 1201).split('\n') ?? [];
  const preview = lines.slice(0, 8).join('\n').slice(0, 1200);
  const truncated = lines.length > 8 || (tool?.result?.length ?? 0) > preview.length;
  const diff = lines.some((line) => /^(diff --git |@@ |--- |\+\+\+ )/.test(line));
  const failureReason = tool?.status === 'failed' ? firstReason(tool.result) : undefined;
  // 主行只放显示名与结果摘要；失败原因单独一行，避免和次要行重复。
  // write_file / edit_file 的成功结果是 core 的英文回执（如 “Successfully wrote 14 bytes to …”），
  // 与次行「动词 · 对象」完全冗余且造成中英混排：成功态不再回显原始结果，事实仍在预览与详情里。
  const boilerplateResult =
    tool?.status === 'succeeded' && (tool.name === 'write_file' || tool.name === 'edit_file');
  const resultSummary = boilerplateResult
    ? undefined
    : tool?.status === 'failed'
      ? undefined
      : tool?.result
        ? tool.result.split('\n')[0]?.slice(0, 120)
        : tool?.status === 'running'
          ? '执行中…'
          : undefined;
  return (
    <div className="min-w-0 rounded-md hover:bg-kumo-tint">
      <div className="flex min-w-0 items-center gap-2 px-2 pt-1">
        <state.icon
          size={14}
          className={`shrink-0 ${elapsed.stale ? 'text-kumo-faint' : state.tone}`}
          aria-hidden="true"
        />
        <span className="sr-only">{state.label}</span>
        <span className="shrink-0 text-xs font-medium text-kumo-default">
          {tool?.displayName ?? '工具'}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-kumo-subtle">
          {/* 已有「动词 · 对象」次行的工具不再回退 invocation，主行保持只放状态摘要。 */}
          {resultSummary ?? (tool?.verb || tool?.chip ? undefined : tool?.invocation)}
        </span>
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
        {elapsed.text && (
          <span className="shrink-0 font-mono text-2xs text-kumo-faint" aria-label="耗时">
            {elapsed.text}
          </span>
        )}
        {previewDoc && (
          <HtmlPreviewButton
            open={showPreview}
            onClick={() => setShowPreview(!showPreview)}
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
          <CaretRightIcon size={14} />
        </Button>
      </div>
      {(tool?.verb || tool?.chip) && (
        <div className="truncate px-2 pb-1 pl-[30px] text-2xs text-kumo-faint">
          {tool.verb}
          {tool.chip && (
            <>
              {tool.verb ? ' · ' : ''}
              <span className={tool.mono ? 'font-mono' : undefined}>{tool.chip}</span>
            </>
          )}
        </div>
      )}
      {!tool?.verb && !tool?.chip && tool?.invocation && (
        <div
          className="truncate px-2 pb-1 pl-[30px] font-mono text-2xs text-kumo-faint"
          title={tool.invocation}
        >
          {tool.invocation}
        </div>
      )}
      {failureReason && (
        <div
          className="truncate px-2 pb-1 pl-[30px] text-2xs text-kumo-danger"
          title={failureReason}
        >
          {failureReason}
        </div>
      )}
      {preview && (
        <Collapsible.Root className="px-2 pb-1">
          <Collapsible.Trigger
            render={
              <Button className="kapibala-action text-kumo-subtle" variant="ghost" size="sm" />
            }
          >
            <CaretRightIcon size={12} /> {diff ? '查看差异预览' : '查看结果预览'}
          </Collapsible.Trigger>
          <Collapsible.Panel>
            {/* 保留缩进并允许横向滚动：break-all 会把多级缩进后的 diff 揉成一段。 */}
            <pre className="max-h-40 overflow-x-auto overflow-y-auto rounded-md bg-kumo-base px-3 py-2 font-mono text-xs leading-5 whitespace-pre">
              {preview.split('\n').map((line, index) => (
                <span
                  key={`${index}:${line}`}
                  className={
                    diff && line.startsWith('+') && !line.startsWith('+++')
                      ? 'text-kumo-success'
                      : diff && line.startsWith('-') && !line.startsWith('---')
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
        <div className="px-2 pt-1 pb-2">
          <HtmlPreview html={previewDoc.html} label={previewDoc.label} />
        </div>
      )}
    </div>
  );
}

function ToolGroup({
  blocks,
  onTool,
  onArtifact,
}: {
  blocks: readonly ViewBlock[];
  onTool(callId: string, trigger: HTMLElement): void;
  onArtifact(callId: string, artifact: ViewArtifact, trigger: HTMLElement): void;
}) {
  const tools = blocks.flatMap((block) => (block.tool ? [block.tool] : []));
  const summary = summarize(tools);
  // U1.8：连续同类调用合并为「已读取 3 个文件」「运行 20 次，1 次失败」；混合时退回「执行 N 步」。
  const group = summarizeToolGroup(tools);
  const totalMs = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  return (
    <Collapsible.Root defaultOpen className="kapibala-tool-group my-1">
      <Collapsible.Trigger
        render={
          <Button
            className="kapibala-action group h-auto w-full justify-start gap-2 px-2 py-1.5 font-normal"
            variant="ghost"
            size="sm"
          />
        }
      >
        <summary.icon size={14} className={`shrink-0 ${summary.tone}`} aria-hidden="true" />
        <span className="shrink-0 text-xs font-medium text-kumo-default">
          {group?.text ?? `执行 ${tools.length} 步`}
        </span>
        <span className="min-w-0 truncate text-xs text-kumo-subtle">
          {summary.label}
          {totalMs > 0 ? ` · ${formatDuration(totalMs)}` : ''}
        </span>
        <CaretDownIcon
          size={14}
          className="ml-auto shrink-0 text-kumo-subtle transition-transform group-data-[panel-open]:rotate-180"
          aria-hidden="true"
        />
      </Collapsible.Trigger>
      <Collapsible.Panel>
        {/* 行间 2px 呼吸避免 hover 高亮块粘连；行内自带 px-2，图标锚点与组标题对齐在 8px。 */}
        <div className="flex flex-col gap-0.5 py-1">
          {blocks.map((block) => (
            <ToolRow key={block.id} tool={block.tool} onTool={onTool} onArtifact={onArtifact} />
          ))}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** 消息虚拟化由 TanStack 负责；滚动跟随只记录用户意图，切换会话保留内存草稿与阅读位置。 */
export function MessageList({
  messages,
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
  /** 唯一可重试的助手消息（最新一轮）；缺失时历史回答不出现重试按钮。 */
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
  const saved = useUI.getState().scrolls[memoryKey];
  const following = useRef(saved?.following ?? true);
  const userIntent = useRef(false);
  const frame = useRef<number | undefined>(undefined);
  const [atBottom, setAtBottom] = useState(following.current);
  const virtualizer = useVirtualizer({
    count: messages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 120,
    overscan: 5,
    getItemKey: (index) => messages[index].id,
    initialOffset: saved?.offset ?? 0,
    onChange(instance, sync) {
      if (!sync && following.current && frame.current === undefined && messages.length)
        frame.current = requestAnimationFrame(() => {
          frame.current = undefined;
          if (following.current) instance.scrollToIndex(messages.length - 1, { align: 'end' });
        });
    },
  });
  useLayoutEffect(() => {
    if (!messages.length) return;
    if (following.current) virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
  }, [messages.length, virtualizer]);
  // 证据 chip 挂载会把滚动容器压矮一行：跟随底部时立即补一次对齐，否则底部行被裁切，
  // 之后的滚动事件还会因 nearBottom 误判弹出「返回底部」。只补偿挂载瞬间，不追持续高度变化。
  const hadChip = useRef(false);
  useLayoutEffect(() => {
    const mounted = Boolean(summary) || Boolean(evidenceUnavailable);
    if (mounted && !hadChip.current && following.current && messages.length)
      virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
    hadChip.current = mounted;
  }, [summary, evidenceUnavailable, messages.length, virtualizer]);
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
    virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
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
        {messages.length === 0 && (
          <p className="py-12 text-center text-sm text-kumo-subtle">对话已就绪，输入你的问题。</p>
        )}
        <div className="kapibala-thread relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((row) => {
            const message = messages[row.index];
            const isUser = message.role === 'user';
            const copyText = message.blocks
              // 技能信封正文不进可复制文本：界面已折叠为徽章，复制原文不应带出整段技能。
              .filter((block) => block.kind === 'text' && !block.skillName)
              .map((block) => block.text)
              .join('\n');
            // 失败与中断在 ViewMessage 里统一为 interrupted：没有正文时界面原本只剩一段
            // 折叠的思考过程，看起来像「什么都没渲染」，必须显式说明这一轮没有产出。
            const interrupted = !isUser && message.state === 'interrupted';
            const hasBody = message.blocks.some(
              (block) => block.kind === 'text' || block.kind === 'tool',
            );
            // 重试只出现在宿主指定的最新回答上；历史回答保持只读，避免回退多轮。
            const retryable = message.id === retryableMessageId;
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className={`absolute top-0 left-0 w-full px-6 ${
                  isUser ? 'pt-7 pb-2' : row.index === 0 ? 'pt-5 pb-2' : 'pt-2 pb-2'
                }`}
                style={{ transform: `translateY(${row.start}px)` }}
              >
                <article
                  aria-label={isUser ? '你的消息' : 'Kapibala 回复'}
                  className={isUser ? 'group ml-auto w-fit max-w-[85%]' : 'group w-full'}
                >
                  <div
                    className={
                      isUser ? 'kapibala-user-bubble whitespace-pre-wrap break-words' : 'w-full'
                    }
                  >
                    {groupBlocks(message.blocks).map((group) =>
                      group.kind === 'tools' ? (
                        <ToolGroup
                          key={group.blocks[0].id}
                          blocks={group.blocks}
                          onTool={onTool}
                          onArtifact={onArtifact}
                        />
                      ) : group.block.kind === 'thinking' ? (
                        <Collapsible.Root
                          key={group.block.id}
                          defaultOpen={group.block.state === 'streaming'}
                        >
                          <Collapsible.Trigger
                            render={
                              <Button
                                className="kapibala-action group -ml-2 gap-2 text-kumo-subtle"
                                variant="ghost"
                                size="sm"
                              />
                            }
                          >
                            <BrainIcon size={15} />
                            思考过程
                            {/* 开合箭头与工具组头同语法：data-panel-open 落在触发按钮上，箭头随之转向。 */}
                            <CaretDownIcon
                              size={14}
                              className="text-kumo-subtle transition-transform group-data-[panel-open]:rotate-180"
                              aria-hidden="true"
                            />
                          </Collapsible.Trigger>
                          <Collapsible.Panel>
                            <p className="mt-1 mb-2 border-l-2 border-kumo-line pl-3 whitespace-pre-wrap text-xs leading-6 text-kumo-subtle">
                              {group.block.text}
                            </p>
                          </Collapsible.Panel>
                        </Collapsible.Root>
                      ) : group.block.skillName ? (
                        // 技能信封块折叠为徽章：正文与元数据已注入模型上下文，
                        // 界面只呈现「哪个技能在运行」，与补全面板的技能语义呼应。
                        <span
                          key={group.block.id}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-kumo-recessed px-3 py-2 text-sm"
                        >
                          <SparkleIcon size={15} className="text-kumo-brand" />
                          <span className="font-medium text-kumo-brand">
                            {group.block.skillName}
                          </span>
                        </span>
                      ) : (
                        <MessageMarkdown
                          key={group.block.id}
                          text={group.block.text}
                          root={root}
                          report={report}
                        />
                      ),
                    )}
                  </div>
                  {/* output 的隐式 role 就是 status：原生元素替代 ARIA 角色，a11y 门禁要求。 */}
                  {interrupted && (
                    <output className="mt-1 flex items-start gap-1.5 text-xs text-kumo-warning">
                      <WarningIcon size={14} className="mt-0.5 shrink-0" />
                      <span>
                        {hasBody
                          ? '本轮生成中断，输出可能不完整。'
                          : '本轮没有收到可展示的正文，常见原因是输出达到上限。可在「设置 → 高级设置」调大该模型的「最大输出 Token」后重试。'}
                      </span>
                    </output>
                  )}
                  {!isUser && (copyText || message.usage || retryable) && (
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
                      {/* token 来自模型真实 usage；缺记录时不补零。悬停行与复制按钮同显隐。 */}
                      {message.usage && (
                        <span
                          className="text-2xs text-kumo-faint tabular-nums"
                          title={`输入 ${message.usage.promptTokens.toLocaleString('zh-CN')} · 输出 ${message.usage.completionTokens.toLocaleString('zh-CN')}`}
                        >
                          | 消耗 {message.usage.totalTokens.toLocaleString('zh-CN')} token
                        </span>
                      )}
                    </div>
                  )}
                  {/* 用户消息 hover 操作：复制原文 + 回填编辑；协议不支持截断重发，编辑只填草稿。 */}
                  {isUser && copyText && (
                    <div className="mt-1 flex items-center justify-end gap-1 opacity-0 transition-opacity [@media(hover:none)]:opacity-100 group-hover:opacity-100 focus-within:opacity-100">
                      <InlineCopyText
                        className="kapibala-action text-kumo-subtle"
                        // 图标由组件内置（hover 显示），空文本节点仅满足 children 类型必填。
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
                    </div>
                  )}
                </article>
              </div>
            );
          })}
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
