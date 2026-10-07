import readline from 'node:readline';
import type { AgentSession } from '@kiturone/kapibala';
import type { ActiveSessionController } from './active-session.js';
import type { CliInputCoordinator } from './input-coordinator.js';
import { type CliApprovalChannel, askWithReadline } from './ui/approval.js';
import { createEventRenderer } from './ui/events.js';

/**
 * 单次问答的运行参数。传 `controller` 时经活动会话控制器执行（享有忙碌门与旧会话清理）；
 * 传 `inputCoordinator` 时审批复用统一输入协调器，否则在 TTY 上自建临时 readline。
 */
export interface OneShotOptions {
  session: AgentSession;
  prompt: string;
  debug?: boolean;
  approvalChannel?: CliApprovalChannel;
  controller?: ActiveSessionController;
  inputCoordinator?: CliInputCoordinator;
}

/**
 * 极简单次问答模式 (直接执行传入的 prompt 并流式输出，执行完成后直接退出)
 * 类似于 Claude Code: `claude "explain this file"`
 * 终端按键和进程 SIGINT 共用取消逻辑；先等待执行与清理结束，再返回中止状态码 130。
 */
export async function runOneShot(options: OneShotOptions): Promise<number> {
  const { session, prompt, debug } = options;
  const approvalInput =
    !options.inputCoordinator && process.stdin.isTTY
      ? readline.createInterface({ input: process.stdin, output: process.stderr })
      : undefined;
  if (approvalInput)
    options.approvalChannel?.bind((request, signal) =>
      askWithReadline(approvalInput, request, signal),
    );
  if (options.inputCoordinator)
    options.approvalChannel?.bind((request, signal) =>
      options.inputCoordinator!.approve(request, signal),
    );

  const abortController = new AbortController();
  // 只负责中止：退出码与 destroy 统一走主流程的 catch/finally，
  // 避免在信号处理器里直接 process.exit 跳过插件 teardown 与 session:end 钩子。
  const onSigint = () => {
    if (abortController.signal.aborted) return;
    abortController.abort();
    process.stdout.write('\n\x1b[33m[任务已中止]\x1b[0m\n');
  };
  process.on('SIGINT', onSigint);
  const unbindInterrupt = options.inputCoordinator?.onInterrupt(onSigint);

  let failed = false;
  const renderer = createEventRenderer({ debug });

  try {
    for await (const event of options.controller
      ? options.controller.run(prompt, { signal: abortController.signal })
      : session.run(prompt, { signal: abortController.signal })) {
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
    // 异常路径同样要闭合思考块转义（finish 幂等），避免 ANSI 状态泄漏到后续输出。
    renderer.finish();
    approvalInput?.close();
    unbindInterrupt?.();
    process.off('SIGINT', onSigint);
    // 触发 session:end 与插件 teardown(设计文档 §3.2 / §3.3)，确保资源可回收
    await session.destroy();
  }

  if (abortController.signal.aborted) {
    return 130;
  }
  return failed ? 1 : 0;
}
