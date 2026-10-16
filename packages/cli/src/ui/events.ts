import {
  ModelError,
  type ModelErrorInfo,
  type SessionEvent,
  describeModelError,
  sanitizeModelErrorMessage,
} from '@kiturone/kapibala';
import { getCurrentGitBranch } from '../git.js';
import { formatContextUsage, formatTokenCount } from './metrics.js';
import { formatModelError, formatModelFailureSummary } from './model-errors.js';
import {
  formatToolDetail,
  formatToolInvocation,
  formatToolResultSummary,
  sanitizeToolName,
} from './tool-presentation.js';
import { charWidth, displayWidth } from './width.js';

/** 事件渲染器的可注入项；全部缺省时直接写 stdout，宿主可替换以复用同一渲染逻辑。 */
export interface EventRendererOptions {
  /** 摘要只折叠过程；detailed 完整流式输出公开内容，不受 UI 缓存上限约束。 */
  outputDetail?: OutputDetail;
  /** 当前轮次详情 UTF-8 上限，缺省 1 MiB；只影响展开快照。 */
  cacheBytes?: number;
  debug?: boolean;
  /** 开发诊断独立写入 stderr，避免污染非 TTY 的答案 stdout。 */
  debugWrite?: (chunk: string) => void;
  /** 每轮结束时读取当前 Git 分支；返回 undefined 时不展示。 */
  getGitBranch?: () => string | undefined;
  /** 注入输出目标，便于宿主复用与测试；默认写入 stdout。 */
  write?: (chunk: string) => void;
  /** 是否支持 ANSI 光标回写；默认跟随 stdout.isTTY。 */
  isTTY?: boolean;
  /**
   * 可用终端列数；用于避免工具行和底栏自动折行。
   * 传函数可在每次渲染时动态取值（跟随终端 resize）；传数字则固定不变。
   */
  columns?: number | (() => number);
  /** 可选注入的后台任务运行时，用于在状态栏与详情快照中展示子代理状态。 */
  runtime?: import('@kiturone/kapibala').AgentRuntime;
}

/** 会话事件渲染契约：render 逐事件输出，finish 收尾（幂等，异常路径可重复调用）。 */
export interface EventRenderer {
  /** 渲染单个会话事件到终端。 */
  render(event: SessionEvent): void;
  /** 流结束后调用：补齐思考块未闭合的转义与末尾换行。 */
  finish(): void;
  /** 真实 TTY 切换本轮详情；锚点不可靠时追加有标签快照，不删除旧滚动历史。 */
  toggleDetail(): void;
  /** 宿主即将写提示符、审批或其他内容时使当前工具回写锚点失效。 */
  invalidateAnchor(): void;
}

/** 终端过程显示策略；所有模式均完整输出 assistant 文本和错误。 */
export type OutputDetail = 'summary' | 'detailed';

/** 启动阶段严格校验，非法值不能回退或产生模型请求。 */
export function parseOutputDetail(value: unknown): OutputDetail {
  if (value === undefined) return 'summary';
  if (value === 'summary' || value === 'detailed') return value;
  throw new Error('用法: --output-detail summary|detailed');
}

interface PendingToolLine {
  invocation: string;
}

interface FooterSegment {
  text: string;
  /** 数字越大越先在窄终端隐藏；0 表示必须保留。 */
  dropPriority: number;
}

const ESC = '\x1b';
const BEL = String.fromCharCode(7);
const TERMINAL_SEQUENCE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\))`,
  'g',
);

/**
 * 过滤不可信外部文本中的终端控制序列与非法控制字符，保留换行与制表符。
 *
 * 保证与约束：
 * - 剥离 ANSI 转义序列、OSC 标题序列及 C0/C1 控制字符，防止终端注入向量与界面篡改；
 * - 完整保留制表符（\t）与换行符（\n）；
 * - 纯字符串操作，不分配系统资源，绝不抛出异常。
 *
 * @param value - 待净化的不可信外部字符串。
 * @returns 已清除所有终端转义控制序列的安全文本。
 */
export function sanitizeUntrustedOutput(value: string): string {
  let safe = '';
  for (const character of value.replace(TERMINAL_SEQUENCE, '')) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    )
      continue;
    safe += character;
  }
  return safe;
}

/**
 * 根据终端能力受控为文本添加 ANSI 色彩控制序列。
 *
 * 保证与约束：
 * - 当 enabled 为 true 时包裹 ANSI 色彩码并在末尾以 reset（\x1b[0m）闭合；
 * - 当 enabled 为 false（非 TTY、管道或重定向环境）时原样返回 text，绝不输出任何 ESC 字节；
 * - 调用方应基于 isTTY 门控传入 enabled，防止管道消费乱码。
 *
 * @param text - 待着色的文本内容。
 * @param code - ANSI SGR 代码（如 1 为粗体，31 为红，32 为绿，36 为青，90 为灰）。
 * @param enabled - 是否允许输出 ANSI 控制序列。
 * @returns 格式化后的安全文本。
 */
export function color(text: string, code: number, enabled: boolean): string {
  return enabled ? `${ESC}[${code}m${text}${ESC}[0m` : text;
}

function formatDuration(durationMs: number): string {
  return durationMs < 1_000 ? `${durationMs}ms` : `${(durationMs / 1_000).toFixed(2)}s`;
}

function takeVisibleStart(text: string, maxWidth: number): string {
  let output = '';
  let width = 0;
  for (const character of text) {
    const characterWidth = charWidth(character.codePointAt(0) ?? 0);
    if (width + characterWidth > maxWidth) break;
    output += character;
    width += characterWidth;
  }
  return output;
}

function takeVisibleEnd(text: string, maxWidth: number): string {
  let output = '';
  let width = 0;
  for (const character of [...text].reverse()) {
    const characterWidth = charWidth(character.codePointAt(0) ?? 0);
    if (width + characterWidth > maxWidth) break;
    output = character + output;
    width += characterWidth;
  }
  return output;
}

function truncateVisibleMiddle(text: string, maxWidth: number): string {
  if (displayWidth(text) <= maxWidth) return text;
  if (maxWidth <= 1) return '…';
  const contentWidth = maxWidth - 1;
  const startWidth = Math.ceil(contentWidth * 0.55);
  const endWidth = contentWidth - startWidth;
  return `${takeVisibleStart(text, startWidth)}…${takeVisibleEnd(text, endWidth)}`;
}

function formatToolLine(
  invocation: string,
  status: string,
  resultSummary: string | undefined,
  columns: number,
): string {
  const maxColumns = Number.isFinite(columns)
    ? Math.max(1, Math.floor(columns))
    : Number.POSITIVE_INFINITY;
  const statusSuffix = `  ${status}`;
  const statusWidth = displayWidth(statusSuffix);
  if (statusWidth >= maxColumns) {
    return truncateVisibleMiddle(statusSuffix.trimStart(), maxColumns);
  }

  let resultSuffix = '';
  if (resultSummary) {
    const separator = ' · ';
    const availableSummary = maxColumns - 1 - statusWidth - displayWidth(separator);
    if (availableSummary > 0) {
      resultSuffix = `${separator}${truncateVisibleMiddle(resultSummary, availableSummary)}`;
    }
  }

  const suffix = `${statusSuffix}${resultSuffix}`;
  const availablePrefix = Math.max(1, maxColumns - displayWidth(suffix));
  return `${truncateVisibleMiddle(`⚙  ${invocation}`, availablePrefix)}${suffix}`;
}

function fitFooter(segments: FooterSegment[], columns: number): string {
  const visible = [...segments];
  const join = () => visible.map((segment) => segment.text).join(' | ');
  while (displayWidth(join()) > columns) {
    const highestPriority = Math.max(...visible.map((segment) => segment.dropPriority));
    if (highestPriority <= 0) break;
    let index = visible.length - 1;
    while (index >= 0 && visible[index]?.dropPriority !== highestPriority) index--;
    visible.splice(index, 1);
  }
  return truncateVisibleMiddle(join(), columns);
}

/** REPL 与 one-shot 模式共用的事件渲染器。 */
export function createEventRenderer(options: EventRendererOptions = {}): EventRenderer {
  const {
    debug = false,
    debugWrite = (chunk: string) => {
      process.stderr.write(chunk);
    },
    getGitBranch = getCurrentGitBranch,
    write = (chunk: string) => {
      process.stdout.write(chunk);
    },
    isTTY = Boolean(process.stdout.isTTY),
    columns = () => process.stdout.columns ?? 120,
    runtime = options.runtime,
  } = options;
  const currentColumns = (): number => (typeof columns === 'function' ? columns() : columns);
  let isThinking = false;
  let detail = options.outputDetail ?? 'summary';
  let finished = false;
  let thinkingSequence = 0;
  let thinkingKey: string | undefined;
  let anchorColumns = currentColumns();
  const cacheLimit = Math.max(0, Math.floor(options.cacheBytes ?? 1024 * 1024));
  const details = new Map<string, string>();
  let cacheUsed = 0;
  let cacheTruncated = false;
  /** 按真实块/工具身份累计安全文本，连关联键也计入上限，不保存原事件或无限空记录。 */
  const cache = (key: string, text: string): void => {
    const keyCost = details.has(key) ? 0 : Buffer.byteLength(key);
    const remaining = Math.max(0, cacheLimit - cacheUsed - keyCost);
    let retained = '';
    let bytes = 0;
    for (const character of text) {
      const size = Buffer.byteLength(character);
      if (bytes + size > remaining) {
        cacheTruncated = true;
        break;
      }
      retained += character;
      bytes += size;
    }
    if (!retained) {
      if (text) cacheTruncated = true;
      return;
    }
    details.set(key, (details.get(key) ?? '') + retained);
    cacheUsed += bytes + keyCost;
  };
  const processDetail = (key: string, text: string): void => {
    const safe = sanitizeUntrustedOutput(text);
    cache(key, safe);
    if (detail === 'detailed') {
      markToolLinesStale();
      write(safe);
    }
  };
  let renderedModelError: ModelErrorInfo | undefined;
  let summaryFailure: ModelErrorInfo | undefined;
  const pendingTools = new Map<string, PendingToolLine>();
  const interactiveToolLines: string[] = [];
  /**
   * TTY 原地改写的前置契约：tool_start 与 tool_finish 之间，core 不得穿插任何
   * 其他输出（当前 loop 满足——工具结果在同一同步临界段 yield）。一旦违反
   * （宿主重放历史、未来 core 行为变更），任何中间 write 都会把该标记置脏，
   * tool_finish 自动退回「追加一行」模式，避免光标上移写错行。
   */
  let toolLinesRewritable = true;

  const markToolLinesStale = (): void => {
    if (interactiveToolLines.length > 0) toolLinesRewritable = false;
  };

  const finishThinking = (): void => {
    if (!isThinking) return;
    isThinking = false;
    thinkingKey = undefined;
    markToolLinesStale();
    write(`${isTTY ? `${ESC}[0m` : ''}\n\n`);
  };

  return {
    render(event: SessionEvent): void {
      if (finished) return;
      if (currentColumns() !== anchorColumns) {
        markToolLinesStale();
        anchorColumns = currentColumns();
      }
      if (
        event.type === 'compaction_start' ||
        event.type === 'compaction_finish' ||
        event.type === 'compaction_failed'
      ) {
        finishThinking();
        markToolLinesStale();
        const label = event.kind === 'prune' ? '旧工具结果剪裁' : '历史摘要';
        const text =
          event.type === 'compaction_start'
            ? `${label}开始 (${event.reason}, ${event.persistence})`
            : event.type === 'compaction_finish'
              ? `${label}已提交: ${event.beforeTokens} → ${event.afterTokens} 估算 tokens (${event.durationMs}ms, ${event.persistence})`
              : `${label}失败，保留最近有效投影；连续失败 ${event.consecutiveFailures}: ${sanitizeUntrustedOutput(event.error)}`;
        write(`\n${color(text, event.type === 'compaction_failed' ? 33 : 90, isTTY)}\n`);
        if (event.type === 'compaction_failed' && event.modelError) {
          summaryFailure = event.modelError;
          write(`\n${color(formatModelError(event.modelError), 33, isTTY)}`);
        }
      } else if (event.type === 'context_budget_exceeded') {
        finishThinking();
        markToolLinesStale();
        write(
          `\n上下文超限: 估算 ${event.usedTokens} / 输入预算 ${event.inputBudget}。当前任务保持原文，请选择更大窗口或拆分任务。\n`,
        );
      } else if (event.type === 'session_resumed' || event.type === 'session_switched') {
        markToolLinesStale();
        write(`\n活动会话: ${sanitizeUntrustedOutput(event.conversationId)}\n`);
      } else if (event.type === 'skill_loaded') {
        finishThinking();
        markToolLinesStale();
        write(
          `\n技能已加载: ${sanitizeToolName(event.source.name)} (${event.source.caller}, ${event.persistence})\n`,
        );
      } else if (event.type === 'mcp_prompt_loaded') {
        finishThinking();
        markToolLinesStale();
        if (detail === 'detailed') {
          const digest = event.promptSource.contentDigest
            ? event.promptSource.contentDigest.slice(0, 8)
            : '无';
          write(
            `\nMCP 提示词已加载: ${sanitizeUntrustedOutput(event.server)}/${sanitizeUntrustedOutput(event.name)} (摘要: ${digest}, 存储: ${event.persistence})\n`,
          );
        } else {
          write(
            `\nMCP 提示词已加载: ${sanitizeUntrustedOutput(event.server)}/${sanitizeUntrustedOutput(event.name)}\n`,
          );
        }
      } else if (event.type === 'step_log') {
        if (debug) {
          const time = new Date(event.log.timestamp).toLocaleTimeString();
          const duration = event.log.durationMs !== undefined ? ` [${event.log.durationMs}ms]` : '';
          markToolLinesStale();
          debugWrite(
            `${color(`⚙ [LOG ${time} | Turn ${event.log.turn} | ${event.log.stage}] ${sanitizeUntrustedOutput(event.log.message)}${duration}`, 90, isTTY)}\n`,
          );
        }
      } else if (event.type === 'tool_progress') {
        if (debug) {
          debugWrite(
            `⚙ ${sanitizeToolName(event.name)}: ${event.elapsedMs}ms, ${event.outputBytes} bytes\n`,
          );
        }
      } else if (event.type === 'thinking_delta') {
        if (!isThinking) {
          isThinking = true;
          thinkingKey = event.blockId
            ? `thinking:${event.blockId}`
            : `thinking:${++thinkingSequence}`;
          markToolLinesStale();
          write(
            `${color(detail === 'detailed' ? '💭 思考过程:' : isTTY ? '💭 思考中（Ctrl+O 查看本轮详情）' : '💭 思考中', 90, isTTY)}\n`,
          );
          cache(thinkingKey, '\n💭 思考过程:\n');
        }
        markToolLinesStale();
        processDetail(event.blockId ? `thinking:${event.blockId}` : thinkingKey!, event.thinking);
      } else if (event.type === 'text_delta') {
        finishThinking();
        markToolLinesStale();
        write(sanitizeUntrustedOutput(event.text));
      } else if (event.type === 'tool_start') {
        finishThinking();
        const safeToolName = sanitizeToolName(event.name);
        let invocation = formatToolInvocation(event.name, event.input);
        if (debug && !invocation.startsWith(safeToolName)) {
          invocation = `${invocation} [${safeToolName}]`;
        }
        pendingTools.set(event.id, { invocation });

        if (isTTY) {
          if (interactiveToolLines.length === 0) write('\n');
          interactiveToolLines.push(event.id);
          if (interactiveToolLines.length > 8) markToolLinesStale();
          write(
            `${color(formatToolLine(invocation, '…', undefined, currentColumns()), 33, true)}\n`,
          );
        }
        processDetail(
          `tool:${event.id}`,
          `\n⚙ ${safeToolName} [${sanitizeToolName(event.id)}] 输入:\n${formatToolDetail(event.input)}\n`,
        );
      } else if (event.type === 'tool_finish') {
        const pending = pendingTools.get(event.id);
        const invocation = pending?.invocation ?? sanitizeToolName(event.name);
        const duration =
          event.durationMs === undefined ? '' : ` ${formatDuration(event.durationMs)}`;
        const status = event.isError ? `✗${duration}` : `✓${duration}`;
        const summary = formatToolResultSummary(event.name, event.result, event.isError);
        const line = formatToolLine(invocation, status, summary, currentColumns());

        if (isTTY && pending && toolLinesRewritable) {
          const index = interactiveToolLines.indexOf(event.id);
          const distance = index >= 0 ? interactiveToolLines.length - index : 0;
          if (distance > 0) {
            write(
              `${ESC}[${distance}A\r${ESC}[2K${color(line, event.isError ? 31 : 32, true)}${ESC}[${distance}B\r`,
            );
          } else {
            write(`${color(line, event.isError ? 31 : 32, true)}\n`);
          }
        } else {
          // 契约被破坏（中间穿插了其他输出，光标位置不可信）、孤儿 tool_finish
          // 或非 TTY：退回追加模式，不做光标回写。
          write(`\n${line}\n`);
        }

        pendingTools.delete(event.id);
        if (interactiveToolLines.every((id) => !pendingTools.has(id))) {
          interactiveToolLines.length = 0;
          toolLinesRewritable = true;
        }
        processDetail(
          `tool:${event.id}`,
          `\n⚙ ${sanitizeToolName(event.name)} [${sanitizeToolName(event.id)}] ${event.isError ? '错误' : '结果'}:\n${formatToolDetail(event.result)}\n`,
        );
      } else if (event.type === 'run_finish') {
        finishThinking();
        const metrics = event.metrics;
        if (metrics.failure && !renderedModelError)
          write(`\n${color(formatModelError(metrics.failure), 31, isTTY)}`);
        if (metrics.status === 'failed') {
          write(
            `\n${color('本次请求失败，未获得完整答复。可以在当前会话重试；已完成的工具结果仍保留。', 31, isTTY)}\n`,
          );
        }
        if (metrics.status === 'aborted') write('\n任务已中止；已完成工具结果保留。\n');
        markToolLinesStale();
        const branch = getGitBranch();
        const segments: FooterSegment[] = [];
        if (metrics.failure)
          segments.push({ text: formatModelFailureSummary(metrics.failure), dropPriority: 0 });
        else if (summaryFailure)
          segments.push({ text: formatModelFailureSummary(summaryFailure), dropPriority: 1 });
        if (branch) segments.push({ text: `Git: ${branch}`, dropPriority: 0 });
        segments.push({
          text: `📊 总耗时: ${(metrics.totalDurationMs / 1_000).toFixed(2)}s`,
          dropPriority: 0,
        });
        if (metrics.contextUsage) {
          segments.push({
            text: `上下文: ${formatContextUsage(metrics.contextUsage)}`,
            dropPriority: 1,
          });
        }
        segments.push({
          text: `本轮 Token: ↑${formatTokenCount(metrics.promptTokens)} ↓${formatTokenCount(metrics.completionTokens)}`,
          dropPriority: 2,
        });
        segments.push({
          text: `工具: ${metrics.toolCalls}次/${formatDuration(metrics.toolDurationMs)}`,
          dropPriority: 3,
        });
        if (runtime) {
          const activeTasks = runtime
            .listTasks()
            .filter((t) =>
              ['preparing', 'accepted', 'running', 'waiting_children'].includes(t.status),
            );
          if (activeTasks.length > 0) {
            segments.push({
              text: `🤖 子代理: ${activeTasks.length}个运行中`,
              dropPriority: 2,
            });
          }
        }
        if (debug) {
          segments.push({
            text: `模型耗时: ${(metrics.modelDurationMs / 1_000).toFixed(2)}s`,
            dropPriority: 4,
          });
          segments.push({
            text: `TTFT: ${metrics.ttftMs === undefined ? 'N/A' : `${metrics.ttftMs}ms`}`,
            dropPriority: 5,
          });
        }
        const footer = fitFooter(segments, isTTY ? currentColumns() : Number.POSITIVE_INFINITY);
        write(`\n${color(footer, 90, isTTY)}\n`);
        renderedModelError = undefined;
        summaryFailure = undefined;
      } else if (event.type === 'error') {
        finishThinking();
        markToolLinesStale();
        const info =
          event.modelError ??
          (event.error instanceof ModelError
            ? describeModelError(event.error, { operation: 'primary' })
            : undefined);
        if (info) {
          renderedModelError = info;
          write(`\n${color(formatModelError(info), 31, isTTY)}`);
        } else
          write(
            `\n${color(`❌ 错误: ${sanitizeModelErrorMessage(event.error.message)}`, 31, isTTY)}\n`,
          );
      }
    },

    finish(): void {
      if (finished) return;
      finishThinking();
      markToolLinesStale();
      finished = true;
      details.clear();
      pendingTools.clear();
      interactiveToolLines.length = 0;
    },
    invalidateAnchor: markToolLinesStale,
    toggleDetail(): void {
      if (!isTTY || finished) return;
      finishThinking();
      markToolLinesStale();
      detail = detail === 'summary' ? 'detailed' : 'summary';
      if (detail === 'detailed') {
        write('\n── 本轮过程详情快照 ──\n');
        for (const text of details.values()) write(text);
        if (cacheTruncated) write('\n[过程缓存已截断；完整内容仍按 Core 历史规则保留]\n');
        if (runtime) {
          const tasks = runtime.listTasks();
          if (tasks.length > 0) {
            write('\n── 后台子代理任务状态 ──\n');
            for (const t of tasks) {
              write(
                `  • [${t.agentId}] (${t.role}) ${t.status} | 来源分支: ${t.origin.originBranchId} | 深度: ${t.origin.depth}\n`,
              );
            }
          }
        }
        write('\n── 后续过程以详细模式输出 ──\n');
      } else write('\n── 后续过程以摘要模式输出；已显示详情保留在滚动历史 ──\n');
    },
  };
}
