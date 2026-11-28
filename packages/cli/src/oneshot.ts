import type { AgentRuntime, AgentSession } from '@kiturone/kapibala';
import type { CheckpointService, ExecutionRootCoordinator } from '@kiturone/kapibala-host/internal';
import type { ActiveSessionController } from './active-session.js';
import { CliInputCoordinator } from './input-coordinator.js';
import type { CliApprovalChannel } from './ui/approval.js';
import { type OutputDetail, createEventRenderer } from './ui/events.js';
import { createCliTheme } from './ui/theme.js';

/**
 * 单次问答的运行参数。传 `controller` 时经活动会话控制器执行（享有忙碌门与旧会话清理）；
 * 审批与快捷键共用同一输入协调器，未注入时由本入口创建并在收尾关闭。
 */
export interface OneShotOptions {
  session: AgentSession;
  prompt: string;
  debug?: boolean;
  /** 重定向 detailed 输出完整公开过程，只有展开缓存受 1 MiB 限制。 */
  outputDetail?: OutputDetail;
  approvalChannel?: CliApprovalChannel;
  controller?: ActiveSessionController;
  inputCoordinator?: CliInputCoordinator;
  /** 主仓库项目归属根（用于工作树会话跨进程恢复检查点分桶对齐）。 */
  projectRoot?: string;
  /** 宿主级 Shadow Git 检查点服务；注入后在单次问答首尾完整采集检查点供后续 `--resume` 还原。 */
  checkpoints?: CheckpointService;
  /** 物理执行目录协调器；注入后校验移除门闩并追踪在途本地运行。 */
  executionCoordinator?: ExecutionRootCoordinator;
  /** 可选子代理运行时，用于底栏与详情快照展示。 */
  runtime?: AgentRuntime;
}

/**
 * 极简单次问答模式 (直接执行传入的 prompt 并流式输出，执行完成后直接退出)
 * 类似于 Claude Code: `claude "explain this file"`
 * 终端按键和进程 SIGINT 共用取消逻辑；先等待执行与清理结束，再返回中止状态码 130。
 */
export async function runOneShot(options: OneShotOptions): Promise<number> {
  const { session, prompt, debug } = options;
  const input = options.inputCoordinator ?? new CliInputCoordinator();
  options.approvalChannel?.bind((request, signal) => input.approve(request, signal));

  const abortController = new AbortController();
  // 只负责中止：退出码与 destroy 统一走主流程的 catch/finally，
  // 避免在信号处理器里直接 process.exit 跳过插件 teardown 与 session:end 钩子。
  const onSigint = () => {
    if (abortController.signal.aborted) return;
    abortController.abort();
    renderer.invalidateAnchor();
    const ui = createCliTheme({ isTTY: Boolean(process.stdout.isTTY) });
    process.stdout.write(`\n${ui.warning('[任务已中止]')}\n`);
  };
  process.on('SIGINT', onSigint);
  const unbindInterrupt = input.onInterrupt(onSigint);

  let failed = false;
  const renderer = createEventRenderer({
    debug,
    outputDetail: options.outputDetail,
    runtime: options.runtime,
  });
  const unbindToggle = input.onDetailToggle(() => renderer.toggleDetail());
  const unbindInteraction = input.onInteraction(() => renderer.invalidateAnchor());
  const executionRoot = session.workspaceRoot;
  const projectRoot =
    options.projectRoot ?? options.controller?.manager.project.projectRoot ?? executionRoot;
  let turnOrdinal = 0;
  let preTurnStartTree: string | undefined;
  let preTurnCommitOid: string | undefined;
  let execRunHandle: ReturnType<ExecutionRootCoordinator['trackActiveRun']> | undefined;

  try {
    if (options.executionCoordinator && executionRoot) {
      options.executionCoordinator.assertNotFenced(executionRoot);
      execRunHandle = options.executionCoordinator.trackActiveRun({
        executionRoot,
        ownerId: session.conversationId ?? 'oneshot',
        kind: 'native',
      });
    }
    if (options.checkpoints && executionRoot && projectRoot) {
      turnOrdinal =
        typeof session.getHistory === 'function'
          ? session.getHistory().filter((m) => m.role === 'user').length
          : 0;
      const existing = await options.checkpoints
        .listCheckpoints({
          projectRoot,
          executionRoot,
          sessionId: session.conversationId,
        })
        .catch(() => []);
      if (existing.length > 0) {
        turnOrdinal = Math.max(turnOrdinal, Math.max(...existing.map((c) => c.ordinal)) + 1);
      }
      const pre = await options.checkpoints
        .capturePreTurn({
          projectRoot,
          executionRoot,
          sessionId: session.conversationId,
          ordinal: turnOrdinal,
          signal: abortController.signal,
        })
        .catch(() => undefined);
      if (pre?.captured) {
        preTurnStartTree = pre.startTree;
        preTurnCommitOid = pre.commitOid;
      }
    }
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
      console.error(`执行出错: ${(err as Error).message}`);
      failed = true;
    }
  } finally {
    if (options.checkpoints && preTurnStartTree) {
      await options.checkpoints
        .capturePostTurn({
          projectRoot,
          executionRoot,
          sessionId: session.conversationId,
          ordinal: turnOrdinal,
          startTree: preTurnStartTree,
          ...(preTurnCommitOid ? { startCommitOid: preTurnCommitOid } : {}),
          label: prompt.slice(0, 80),
        })
        .catch(() => {});
    }
    execRunHandle?.release();
    // 异常路径同样要闭合思考块转义（finish 幂等），避免 ANSI 状态泄漏到后续输出。
    renderer.finish();
    unbindToggle?.();
    unbindInteraction?.();
    if (!options.inputCoordinator) input.close();
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
