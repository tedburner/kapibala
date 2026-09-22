import type { SessionEvent } from '@kiturone/kapibala';
import { getCurrentGitBranch } from '../git.js';
import { formatContextUsage, formatTokenCount } from './metrics.js';

export interface EventRendererOptions {
  debug?: boolean;
  /** 每轮结束时读取当前 Git 分支；返回 undefined 时不展示。 */
  getGitBranch?: () => string | undefined;
}

export interface EventRenderer {
  /** 渲染单个会话事件到终端 */
  render(event: SessionEvent): void;
  /** 流结束后调用：补齐思考块未闭合的转义与末尾换行 */
  finish(): void;
}

// 键名先剥离分隔符再匹配结尾：api_key → apikey、secret_access_key → secretaccesskey。
const SENSITIVE_FIELD =
  /(?:apikey|authorization|cookie|password|secret|credential|token|auth|key)$/i;

function redactSensitiveFields(value: unknown, key?: string): unknown {
  if (key && SENSITIVE_FIELD.test(key.replace(/[^a-z0-9]/gi, ''))) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactSensitiveFields(childValue, childKey),
      ]),
    );
  }
  return value;
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function toolInputPreview(input: Record<string, unknown>): string {
  return truncate(JSON.stringify(redactSensitiveFields(input)), 120);
}

function toolResultPreview(result: string): string {
  return truncate(result.trim().replace(/\s+/g, ' '), 160);
}

/**
 * REPL 与 one-shot 模式共用的事件渲染器。
 * 抽出公共实现避免两处 ~80 行分发逻辑各自漂移。
 */
export function createEventRenderer(options: EventRendererOptions = {}): EventRenderer {
  const { debug, getGitBranch = getCurrentGitBranch } = options;
  let isThinking = false;

  return {
    render(event: SessionEvent): void {
      if (event.type === 'step_log') {
        if (debug) {
          const time = new Date(event.log.timestamp).toLocaleTimeString();
          const dur = event.log.durationMs !== undefined ? ` [${event.log.durationMs}ms]` : '';
          process.stdout.write(
            `\x1b[90m⚙ [LOG ${time} | Turn ${event.log.turn} | ${event.log.stage}] ${event.log.message}${dur}\x1b[0m\n`,
          );
        }
      } else if (event.type === 'thinking_delta') {
        if (!isThinking) {
          isThinking = true;
          process.stdout.write('\x1b[90m💭 思考过程:\n');
        }
        process.stdout.write(`\x1b[90m${event.thinking}\x1b[0m`);
      } else if (event.type === 'text_delta') {
        if (isThinking) {
          isThinking = false;
          process.stdout.write('\x1b[0m\n\n');
        }
        process.stdout.write(event.text);
      } else if (event.type === 'tool_start') {
        if (isThinking) {
          isThinking = false;
          process.stdout.write('\x1b[0m\n\n');
        }
        process.stdout.write(
          `\n\x1b[33m⚙ 调用工具 [${event.name}]: ${toolInputPreview(event.input)}\x1b[0m\n`,
        );
      } else if (event.type === 'tool_finish') {
        const statusTag = event.isError ? '\x1b[31m[失败]\x1b[0m' : '\x1b[32m[完成]\x1b[0m';
        const duration = event.durationMs === undefined ? '' : ` ${event.durationMs}ms`;
        process.stdout.write(`  ${statusTag}${duration} ${toolResultPreview(event.result)}\n\n`);
      } else if (event.type === 'run_finish') {
        const m = event.metrics;
        const ttftStr = m.ttftMs !== undefined ? `${m.ttftMs}ms` : 'N/A';
        const totalSec = (m.totalDurationMs / 1000).toFixed(2);
        const modelSec = (m.modelDurationMs / 1000).toFixed(2);
        const toolSec = (m.toolDurationMs / 1000).toFixed(2);
        const context = m.contextUsage ? ` | 上下文: ${formatContextUsage(m.contextUsage)}` : '';
        const gitBranch = getGitBranch();
        const git = gitBranch ? `Git: ${gitBranch} | ` : '';
        process.stdout.write(
          `\n\x1b[90m${git}📊 总耗时: ${totalSec}s${context} | Token: ${formatTokenCount(m.totalTokens)} (输入 ${formatTokenCount(m.promptTokens)}, 输出 ${formatTokenCount(m.completionTokens)}) | 模型: ${modelSec}s | 工具: ${toolSec}s (${m.toolCalls} 次) | TTFT: ${ttftStr} | 步骤: ${m.turns}\x1b[0m\n`,
        );
      } else if (event.type === 'error') {
        process.stdout.write(`\n\x1b[31m❌ 错误: ${event.error.message}\x1b[0m\n`);
      }
    },

    finish(): void {
      if (isThinking) {
        process.stdout.write('\x1b[0m\n');
      }
    },
  };
}
