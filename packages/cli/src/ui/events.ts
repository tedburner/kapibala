import type { SessionEvent } from '@kiturone/kapibala';

export interface EventRendererOptions {
  debug?: boolean;
}

export interface EventRenderer {
  /** 渲染单个会话事件到终端 */
  render(event: SessionEvent): void;
  /** 流结束后调用：补齐思考块未闭合的转义与末尾换行 */
  finish(): void;
}

/**
 * REPL 与 one-shot 模式共用的事件渲染器。
 * 抽出公共实现避免两处 ~80 行分发逻辑各自漂移。
 */
export function createEventRenderer(options: EventRendererOptions = {}): EventRenderer {
  const { debug } = options;
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
        const inputPreview = JSON.stringify(event.input).slice(0, 80);
        process.stdout.write(`\n\x1b[33m⚙ 调用工具 [${event.name}]: ${inputPreview}...\x1b[0m\n`);
      } else if (event.type === 'tool_finish') {
        const statusTag = event.isError ? '\x1b[31m[失败]\x1b[0m' : '\x1b[32m[完成]\x1b[0m';
        const preview = event.result.trim().slice(0, 100).replace(/\n/g, ' ');
        process.stdout.write(`  ${statusTag} ${preview}...\n\n`);
      } else if (event.type === 'run_finish') {
        const m = event.metrics;
        const ttftStr = m.ttftMs !== undefined ? `${m.ttftMs}ms` : 'N/A';
        const totalSec = (m.totalDurationMs / 1000).toFixed(2);
        process.stdout.write(
          `\n\x1b[90m📊 耗时: ${totalSec}s | 首Token(TTFT): ${ttftStr} | Token: ${m.totalTokens} (输入 ${m.promptTokens}, 输出 ${m.completionTokens}) | 步骤: ${m.turns} | 工具: ${m.toolCalls}\x1b[0m\n`,
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
