import { Button, Collapsible, InlineCopyText } from '@cloudflare/kumo';
import type { ViewBlock, ViewMessage, ViewTool } from '@kiturone/kapibala-cli/view-model';
import {
  ArrowDownIcon,
  BrainIcon,
  CaretDownIcon,
  CaretRightIcon,
  CheckCircleIcon,
  MinusCircleIcon,
  PencilSimpleIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@phosphor-icons/react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from 'react';
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
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function ToolRow({
  tool,
  onTool,
}: {
  tool?: ViewTool;
  onTool(callId: string, trigger: HTMLElement): void;
}) {
  const state = TOOL_STATES[tool?.status ?? 'running'];
  // 限制单行预览长度与行数，完整的已脱敏内容仍由详情抽屉展示。
  const lines = tool?.result?.slice(0, 1201).split('\n') ?? [];
  const preview = lines.slice(0, 8).join('\n').slice(0, 1200);
  const truncated = lines.length > 8 || (tool?.result?.length ?? 0) > preview.length;
  const diff = lines.some((line) => /^(diff --git |@@ |--- |\+\+\+ )/.test(line));
  return (
    <div className="min-w-0 rounded-md hover:bg-kumo-tint">
      <div className="flex min-w-0 items-center gap-2 px-2 py-1">
        <state.icon size={14} className={`shrink-0 ${state.tone}`} aria-hidden="true" />
        <span className="sr-only">{state.label}</span>
        <span className="w-28 shrink-0 truncate font-mono text-xs text-kumo-default">
          {tool?.name ?? '工具'}
        </span>
        <span className="min-w-0 flex-1 truncate text-xs text-kumo-subtle" title={tool?.invocation}>
          {tool?.invocation}
        </span>
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
            <pre className="max-h-40 overflow-auto rounded-md bg-kumo-base px-3 py-2 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
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
    </div>
  );
}

function ToolGroup({
  blocks,
  onTool,
}: {
  blocks: readonly ViewBlock[];
  onTool(callId: string, trigger: HTMLElement): void;
}) {
  const tools = blocks.flatMap((block) => (block.tool ? [block.tool] : []));
  const summary = summarize(tools);
  const totalMs = tools.reduce((sum, tool) => sum + (tool.durationMs ?? 0), 0);
  return (
    <Collapsible.Root defaultOpen className="kapibala-tool-group my-2">
      <Collapsible.Trigger
        render={
          <Button
            className="kapibala-action group h-auto w-full justify-start gap-2 px-2.5 py-1.5 font-normal"
            variant="ghost"
            size="sm"
          />
        }
      >
        <summary.icon size={15} className={`shrink-0 ${summary.tone}`} aria-hidden="true" />
        <span className="shrink-0 text-xs font-medium text-kumo-default">
          执行 {tools.length} 步
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
        <div className="px-1 py-1">
          {blocks.map((block) => (
            <ToolRow key={block.id} tool={block.tool} onTool={onTool} />
          ))}
        </div>
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

/** 消息虚拟化由 TanStack 负责；滚动跟随只记录用户意图，切换会话保留内存草稿与阅读位置。 */
export function MessageList({
  messages,
  memoryKey,
  scrollRef,
  onTool,
  onEdit,
  report,
}: {
  messages: readonly ViewMessage[];
  memoryKey: string;
  scrollRef: RefObject<HTMLDivElement | null>;
  onTool(callId: string, trigger: HTMLElement): void;
  /** 将用户消息原文回填到输入框供修改重发；只填草稿，不改写已落盘历史。 */
  onEdit(text: string): void;
  report(message: string): void;
}) {
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
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        role="log"
        aria-label="对话内容"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: 可滚动消息区接受键盘阅读，并作为虚拟行卸载后的稳定焦点返回目标。
        tabIndex={0}
        className="h-full min-h-0 overflow-y-auto outline-offset-2"
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
              .filter((block) => block.kind === 'text')
              .map((block) => block.text)
              .join('\n');
            return (
              <div
                key={row.key}
                data-index={row.index}
                ref={virtualizer.measureElement}
                className={`absolute top-0 left-0 w-full px-6 ${
                  isUser ? 'pt-8 pb-3' : row.index === 0 ? 'pt-6 pb-1' : 'pt-1 pb-1'
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
                        <ToolGroup key={group.blocks[0].id} blocks={group.blocks} onTool={onTool} />
                      ) : group.block.kind === 'thinking' ? (
                        <Collapsible.Root
                          key={group.block.id}
                          defaultOpen={group.block.state === 'streaming'}
                        >
                          <Collapsible.Trigger
                            render={
                              <Button
                                className="kapibala-action -ml-2 text-kumo-subtle"
                                variant="ghost"
                                size="sm"
                              />
                            }
                          >
                            <BrainIcon size={15} />
                            思考过程
                          </Collapsible.Trigger>
                          <Collapsible.Panel>
                            <p className="mt-1 mb-2 border-l-2 border-kumo-line pl-3 whitespace-pre-wrap text-xs leading-6 text-kumo-subtle">
                              {group.block.text}
                            </p>
                          </Collapsible.Panel>
                        </Collapsible.Root>
                      ) : (
                        <MessageMarkdown
                          key={group.block.id}
                          text={group.block.text}
                          report={report}
                        />
                      ),
                    )}
                  </div>
                  {message.role === 'assistant' && copyText && (
                    <InlineCopyText
                      className="kapibala-action mt-2 text-xs text-kumo-subtle opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 focus-visible:opacity-100"
                      value={copyText}
                      labels={{ copyAction: '复制正文', copied: '已复制正文' }}
                    >
                      <span>复制正文</span>
                    </InlineCopyText>
                  )}
                  {/* 用户消息 hover 操作：复制原文 + 回填编辑；协议不支持截断重发，编辑只填草稿。 */}
                  {isUser && copyText && (
                    <div className="mt-1 flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
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
