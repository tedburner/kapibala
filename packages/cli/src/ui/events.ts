import type { SessionEvent } from '@kiturone/kapibala';
import { getCurrentGitBranch } from '../git.js';
import { formatContextUsage, formatTokenCount } from './metrics.js';
import {
  formatToolInvocation,
  formatToolResultSummary,
  sanitizeToolName,
} from './tool-presentation.js';
import { charWidth, displayWidth } from './width.js';

export interface EventRendererOptions {
  debug?: boolean;
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
}

export interface EventRenderer {
  /** 渲染单个会话事件到终端。 */
  render(event: SessionEvent): void;
  /** 流结束后调用：补齐思考块未闭合的转义与末尾换行。 */
  finish(): void;
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

/** 过滤模型和错误消息中的终端控制序列，保留正文的换行与制表符。 */
function sanitizeUntrustedOutput(value: string): string {
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

function color(text: string, code: number, enabled: boolean): string {
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
    getGitBranch = getCurrentGitBranch,
    write = (chunk: string) => {
      process.stdout.write(chunk);
    },
    isTTY = Boolean(process.stdout.isTTY),
    columns = () => process.stdout.columns ?? 120,
  } = options;
  const currentColumns = (): number => (typeof columns === 'function' ? columns() : columns);
  let isThinking = false;
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
    markToolLinesStale();
    write(`${isTTY ? `${ESC}[0m` : ''}\n\n`);
  };

  return {
    render(event: SessionEvent): void {
      if (event.type === 'step_log') {
        if (debug) {
          const time = new Date(event.log.timestamp).toLocaleTimeString();
          const duration = event.log.durationMs !== undefined ? ` [${event.log.durationMs}ms]` : '';
          markToolLinesStale();
          write(
            `${color(`⚙ [LOG ${time} | Turn ${event.log.turn} | ${event.log.stage}] ${sanitizeUntrustedOutput(event.log.message)}${duration}`, 90, isTTY)}\n`,
          );
        }
      } else if (event.type === 'thinking_delta') {
        if (!isThinking) {
          isThinking = true;
          markToolLinesStale();
          write(`${color('💭 思考过程:', 90, isTTY)}\n`);
        }
        markToolLinesStale();
        write(color(sanitizeUntrustedOutput(event.thinking), 90, isTTY));
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
          write(
            `${color(formatToolLine(invocation, '…', undefined, currentColumns()), 33, true)}\n`,
          );
        }
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
      } else if (event.type === 'run_finish') {
        finishThinking();
        const metrics = event.metrics;
        const branch = getGitBranch();
        const segments: FooterSegment[] = [];
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
      } else if (event.type === 'error') {
        finishThinking();
        write(
          `\n${color(`❌ 错误: ${sanitizeUntrustedOutput(event.error.message)}`, 31, isTTY)}\n`,
        );
      }
    },

    finish(): void {
      if (isThinking) {
        isThinking = false;
        write(`${isTTY ? `${ESC}[0m` : ''}\n`);
      }
    },
  };
}
