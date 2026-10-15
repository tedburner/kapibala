import { AbortError, type AgentSession, type SessionEvent } from '@kiturone/kapibala';
import type { ActiveSessionController } from './active-session.js';
import type { CommandContext, CommandDispatcher } from './commands/dispatcher.js';
import { CliInputCoordinator } from './input-coordinator.js';
import type { CliApprovalChannel } from './ui/approval.js';
import { type EventRenderer, type OutputDetail, createEventRenderer } from './ui/events.js';
import { CLI_VERSION } from './version.js';

/**
 * REPL 启动参数。`controller` 缺省时退回裸会话（无切换能力）；
 * `inputCoordinator` 缺省时内部自建，宿主可注入同一实例以共享输入所有权。
 */
export interface REPLOptions {
  session: AgentSession;
  controller?: ActiveSessionController;
  inputCoordinator?: CliInputCoordinator;
  dispatcher: CommandDispatcher;
  context: CommandContext;
  debug?: boolean;
  /** 过程显示策略，回答文本始终完整流式显示。 */
  outputDetail?: OutputDetail;
  approvalChannel?: CliApprovalChannel;
}

/** 统一输入和活动引用的 REPL；取消后等待清理，不缓存旧 Session，不创建额外 stdin 消费者。 */
export async function startREPL(options: REPLOptions): Promise<void> {
  const { dispatcher, context, debug } = options;
  const input = options.inputCoordinator ?? new CliInputCoordinator();
  const session = () => options.controller?.session ?? options.session;
  const operations = new Set<Promise<void>>();
  let fallbackAbort: AbortController | undefined;
  let exiting = false;
  let lastInterrupt = 0;
  let activeRenderer: EventRenderer | undefined;
  input.setCompleter((line) => {
    if (line.startsWith('/skill ')) {
      const tail = line.slice('/skill '.length);
      if (/\s/.test(tail)) return [[], line];
      const names = session()
        .getSkills()
        .skills.filter((skill) => skill.userInvocable && skill.available && !skill.disabled)
        .map((skill) => `/skill ${skill.name}`);
      return [names.filter((name) => name.startsWith(line)), line];
    }
    const names = dispatcher.getDefinitions().map((definition) => `/${definition.name}`);
    return [names.filter((name) => name.startsWith(line)), line];
  });
  context.dispatcher = dispatcher;
  context.isInputBusy = () => input.isBusy();
  context.question = (prompt) => input.question(prompt);
  context.readSecret = (prompt) => input.readSecret(prompt);
  context.confirm = (prompt) => input.confirm(prompt);
  context.select = (config) => input.select(config);
  options.approvalChannel?.bind((request, signal) => input.approve(request, signal));
  const statusRenderer = createEventRenderer({ debug, outputDetail: options.outputDetail });
  context.renderEvent = (event) => statusRenderer.render(event);
  const busy = () => options.controller?.isBusy() ?? session().isBusy();
  const prompt = () =>
    input.prompt(
      `kpbl (${session().getModelRole()} | ${session().getActiveProfile().id} | ${session().getMode()} | ${session().conversationId.slice(0, 8)}) ❯ `,
    );
  const requestExit = () => {
    exiting = true;
    input.cancel();
    options.controller?.abort();
    fallbackAbort?.abort();
    input.close();
  };
  const runTask = async (operation: (signal: AbortSignal) => AsyncIterable<SessionEvent>) => {
    const abort = new AbortController();
    fallbackAbort = abort;
    const renderer = createEventRenderer({ debug, outputDetail: options.outputDetail });
    activeRenderer = renderer;
    const unbindToggle = input.onDetailToggle(() => renderer.toggleDetail());
    const unbindInteraction = input.onInteraction(() => renderer.invalidateAnchor());
    try {
      for await (const event of operation(abort.signal)) renderer.render(event);
    } catch (error) {
      if (!(error instanceof AbortError) && !abort.signal.aborted)
        console.error(`执行失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      unbindToggle();
      unbindInteraction();
      renderer.finish();
      if (activeRenderer === renderer) activeRenderer = undefined;
      if (fallbackAbort === abort) fallbackAbort = undefined;
    }
  };
  context.runSkill = (name, task) =>
    runTask((signal) =>
      options.controller
        ? options.controller.runSkill(name, task, { signal })
        : session().runSkill(name, task, { signal }),
    );
  context.runPreparedTask = (task, prepare) =>
    runTask((signal) =>
      options.controller
        ? options.controller.runPreparedTask(task, prepare, { signal })
        : session().runPreparedTask(task, prepare, { signal }),
    );
  context.onExit = requestExit;
  input.onInterrupt(() => {
    activeRenderer?.invalidateAnchor();
    if (busy()) {
      options.controller?.abort();
      fallbackAbort?.abort();
      console.log('\n已请求中止，正在等待工具、摘要与存储清理。');
      return;
    }
    if (input.getLine().trim()) {
      input.clearLine();
      prompt();
      return;
    }
    const now = Date.now();
    if (now - lastInterrupt < 1500) requestExit();
    else {
      lastInterrupt = now;
      console.log('\n再按一次 Ctrl+C 退出，或输入 /exit。');
      prompt();
    }
  });
  if (input.interactive)
    console.log(
      `\n🐾 Kapibala (kpbl) v${CLI_VERSION}\n会话: ${session().conversationId}\n/new 新建 | /resume 续答 | /context 预算 | /help 命令\n`,
    );
  prompt();
  input.onLine((raw) => {
    activeRenderer?.invalidateAnchor();
    if (!raw.trim() || exiting) {
      prompt();
      return;
    }
    const operation = (async () => {
      const handled = await dispatcher.dispatch(raw, context);
      if (handled) return;
      if (busy()) {
        console.log('会话忙，请等待执行与清理完成；只读命令仍可查询。');
        return;
      }
      await runTask((signal) =>
        options.controller
          ? options.controller.run(raw.trim(), { signal })
          : session().run(raw.trim(), { signal }),
      );
    })();
    operations.add(operation);
    void operation
      .catch((error) =>
        console.error(`命令失败: ${error instanceof Error ? error.message : '未知错误'}`),
      )
      .finally(() => {
        operations.delete(operation);
        if (!exiting && !busy()) prompt();
      });
  });
  try {
    await input.whenClosed;
    if (input.interactive) {
      options.controller?.abort();
      fallbackAbort?.abort();
    }
    await Promise.allSettled([...operations]);
    statusRenderer.finish();
    if (options.controller) await options.controller.close();
    else await session().destroy();
  } finally {
    input.close();
  }
}
