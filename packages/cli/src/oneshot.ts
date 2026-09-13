import type { AgentSession } from '@kiturone/kapibala';

export interface OneShotOptions {
  session: AgentSession;
  prompt: string;
  debug?: boolean;
}

/**
 * 极简单次问答模式 (直接执行传入的 prompt 并流式输出，执行完成后直接退出)
 * 类似于 Claude Code: `claude "explain this file"`
 */
export async function runOneShot(options: OneShotOptions): Promise<void> {
  const { session, prompt, debug } = options;

  let isThinking = false;
  let isFirstText = true;

  const abortController = new AbortController();
  process.on('SIGINT', () => {
    abortController.abort();
    process.stdout.write('\n\x1b[33m[任务已中止]\x1b[0m\n');
    process.exit(130);
  });

  let failed = false;

  try {
    for await (const event of session.run(prompt, { signal: abortController.signal })) {
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
        if (isFirstText) {
          isFirstText = false;
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
      } else if (event.type === 'turn_finish') {
        const m = event.metrics;
        const ttftStr = m.ttftMs !== undefined ? `${m.ttftMs}ms` : 'N/A';
        const totalSec = (m.totalDurationMs / 1000).toFixed(2);
        process.stdout.write(
          `\n\x1b[90m📊 耗时: ${totalSec}s | 首Token(TTFT): ${ttftStr} | Token: ${m.totalTokens} (输入 ${m.promptTokens}, 输出 ${m.completionTokens})\x1b[0m\n`,
        );
      } else if (event.type === 'error') {
        process.stdout.write(`\n\x1b[31m❌ 错误: ${event.error.message}\x1b[0m\n`);
      }
    }

    if (isThinking) {
      process.stdout.write('\x1b[0m\n');
    }
    process.stdout.write('\n');
  } catch (err: unknown) {
    if (!abortController.signal.aborted) {
      console.error(`\x1b[31m执行出错: ${(err as Error).message}\x1b[0m`);
      failed = true;
    }
  } finally {
    // 触发 session:end 与插件 teardown(设计文档 §3.2 / §3.3)，确保资源可回收
    await session.destroy();
  }

  if (failed) {
    process.exit(1);
  }
}
