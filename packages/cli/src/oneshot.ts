import readline from 'node:readline';
import type { AgentSession } from '@kiturone/kapibala';
import { type CliApprovalChannel, askWithReadline } from './ui/approval.js';
import { createEventRenderer } from './ui/events.js';

export interface OneShotOptions {
  session: AgentSession;
  prompt: string;
  debug?: boolean;
  approvalChannel?: CliApprovalChannel;
}

/**
 * 极简单次问答模式 (直接执行传入的 prompt 并流式输出，执行完成后直接退出)
 * 类似于 Claude Code: `claude "explain this file"`
 */
export async function runOneShot(options: OneShotOptions): Promise<number> {
  const { session, prompt, debug } = options;
  const approvalInput = process.stdin.isTTY
    ? readline.createInterface({ input: process.stdin, output: process.stderr })
    : undefined;
  if (approvalInput)
    options.approvalChannel?.bind((request, signal) =>
      askWithReadline(approvalInput, request, signal),
    );

  const abortController = new AbortController();
  // 只负责中止：退出码与 destroy 统一走主流程的 catch/finally，
  // 避免在信号处理器里直接 process.exit 跳过插件 teardown 与 session:end 钩子。
  const onSigint = () => {
    abortController.abort();
    process.stdout.write('\n\x1b[33m[任务已中止]\x1b[0m\n');
  };
  process.on('SIGINT', onSigint);

  let failed = false;

  try {
    const renderer = createEventRenderer({ debug });
    for await (const event of session.run(prompt, { signal: abortController.signal })) {
      if (event.type === 'error') failed = true;
      renderer.render(event);
    }
    renderer.finish();
    process.stdout.write('\n');
  } catch (err: unknown) {
    if ((err instanceof Error && err.name === 'AbortError') || abortController.signal.aborted) {
      // 已由 SIGINT 处理
    } else {
      console.error(`\x1b[31m执行出错: ${(err as Error).message}\x1b[0m`);
      failed = true;
    }
  } finally {
    approvalInput?.close();
    process.off('SIGINT', onSigint);
    // 触发 session:end 与插件 teardown(设计文档 §3.2 / §3.3)，确保资源可回收
    await session.destroy();
  }

  if (abortController.signal.aborted) {
    return 130;
  }
  return failed ? 1 : 0;
}
