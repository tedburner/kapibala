import {
  AbortError,
  type AgentSession,
  type ApprovalChoice,
  type ApprovalRequest,
  type SessionEvent,
} from '@kiturone/kapibala';
import type { ActiveSessionController } from '../active-session.js';
import type { CommandContext, CommandDispatcher } from '../commands/dispatcher.js';
import type { CliApprovalChannel } from '../ui/approval.js';
import type { EventRenderer } from '../ui/events.js';
import type { SelectConfig } from '../ui/select.js';
import { resolveCommandOutput } from './command-output.js';

/**
 * 文本/TUI 共用的结构化输入端口；实现只能拥有一条实际输入链。
 * close 只停止输入、取消问答并完成 whenClosed，不能卸载渲染器或恢复终端模式；
 * 调用方必须等待 runInteractiveHost 完成在途操作和控制器关闭后，再恢复其终端资源。
 */
export interface HostInputPort {
  readonly interactive: boolean;
  readonly whenClosed: Promise<void>;
  onLine(handler: (line: string) => void): void;
  onInterrupt(handler: () => void): () => void;
  onDetailToggle(handler: () => void): () => void;
  onInteraction(handler: () => void): () => void;
  setCompleter(handler: (line: string) => [string[], string]): void;
  isBusy(): boolean;
  question(prompt: string): Promise<string>;
  readSecret(prompt: string): Promise<string>;
  confirm(prompt: string): Promise<boolean>;
  select<T>(config: SelectConfig<T>): Promise<T | null>;
  approve(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalChoice>;
  cancel(): void;
  close(): void;
  prompt(value: string): void;
  clearLine(): void;
  getLine(): string;
}

/** 本地交互操作身份；只用于展示对齐，不冒充 Core runId 或远程执行身份。 */
export interface InteractiveOperation {
  readonly id: string;
  readonly kind: 'message' | 'skill' | 'prepared';
  readonly session: AgentSession;
}

/** Host 操作生命周期；settled 只在迭代清理与控制器执行门释放后发送。 */
export type InteractiveAction =
  | { readonly type: 'started'; readonly operation: InteractiveOperation }
  | { readonly type: 'cancellation_requested'; readonly operation: InteractiveOperation }
  | {
      readonly type: 'settled';
      readonly operation: InteractiveOperation;
      readonly error?: unknown;
    };

/** 渲染器在 Host 内消费 Core 事件，TUI 客户端只接收 Host 进一步投影的展示契约。 */
export interface InteractiveRendererContext {
  readonly kind: 'status' | 'operation';
  readonly session: AgentSession;
  readonly operation?: InteractiveOperation;
  readonly context: CommandContext;
}

/**
 * 唯一交互执行循环的依赖；不构造终端输入或渲染器，不创建新的 Agent 调度循环。
 * 未提供 promptText 时传空提示，由图形客户端自己绘制输入区；文本包装负责旧提示文案。
 */
export interface InteractiveHostOptions {
  readonly session: AgentSession;
  readonly controller?: ActiveSessionController;
  readonly input: HostInputPort;
  readonly dispatcher: CommandDispatcher;
  readonly context: CommandContext;
  readonly rendererFactory: (context: InteractiveRendererContext) => EventRenderer;
  readonly approvalChannel?: CliApprovalChannel;
  readonly promptText?: (session: AgentSession) => string;
  readonly onAction?: (action: InteractiveAction) => void;
  /** 初始绑定以及命令切换/重载后重新发布活动引用，不缓存已经销毁的 Session。 */
  readonly onSessionChanged?: (session: AgentSession) => void;
}

/**
 * 文本与 TUI 共用现有 dispatcher、技能/提示词入口及 ActiveSessionController 执行门。
 * 取消只发送信号；退出停止输入后等待全部操作与控制器清理，不在此卸载宿主终端。
 * 绘制失败会取消并继续排空迭代，不能因视图异常提前放弃持久化和工具收口。
 */
export async function runInteractiveHost(options: InteractiveHostOptions): Promise<void> {
  const { input, dispatcher, context } = options;
  const session = () => options.controller?.session ?? options.session;
  const output = () => resolveCommandOutput(context);
  const operations = new Set<Promise<void>>();
  let fallbackAbort: AbortController | undefined;
  let exiting = false;
  let lastInterrupt: number | undefined;
  let activeRenderer: EventRenderer | undefined;
  let activeOperation: InteractiveOperation | undefined;
  let operationSequence = 0;
  let knownSession: AgentSession | undefined;
  const busy = () => options.controller?.isBusy() ?? session().isBusy();
  const notify = (callback: (() => void) | undefined) => {
    try {
      callback?.();
    } catch (error) {
      output().error(`展示通知失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  };
  const publishSession = () => {
    const current = session();
    if (current === knownSession) return;
    knownSession = current;
    notify(options.onSessionChanged && (() => options.onSessionChanged?.(current)));
  };
  const prompt = () => {
    if (!exiting) input.prompt(options.promptText?.(session()) ?? '');
  };
  const cancelOperation = () => {
    options.controller?.abort();
    fallbackAbort?.abort();
    if (activeOperation)
      notify(() =>
        options.onAction?.({ type: 'cancellation_requested', operation: activeOperation! }),
      );
  };
  const requestExit = () => {
    if (exiting) return;
    exiting = true;
    input.cancel();
    cancelOperation();
    input.close();
  };
  const statusRenderer = options.rendererFactory({ kind: 'status', session: session(), context });
  let statusFailed = false;
  context.renderEvent = (event) => {
    if (statusFailed) return;
    try {
      statusRenderer.render(event);
    } catch (error) {
      statusFailed = true;
      cancelOperation();
      output().error(`展示失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
  };
  input.setCompleter((line) => {
    if (line.startsWith('/skill ')) {
      if (/\s/.test(line.slice('/skill '.length))) return [[], line];
      const names = session()
        .getSkills()
        .skills.filter((skill) => skill.userInvocable && skill.available && !skill.disabled)
        .map((skill) => `/skill ${skill.name}`);
      return [names.filter((name) => name.startsWith(line)), line];
    }
    return [
      dispatcher
        .getDefinitions()
        .map((definition) => `/${definition.name}`)
        .filter((name) => name.startsWith(line)),
      line,
    ];
  });
  context.dispatcher = dispatcher;
  context.isInputBusy = () => input.isBusy();
  context.question = (value) => input.question(value);
  context.readSecret = (value) => input.readSecret(value);
  context.confirm = (value) => input.confirm(value);
  context.select = (config) => input.select(config);
  options.approvalChannel?.bind((request, signal) => input.approve(request, signal));

  const runTask = async (
    kind: InteractiveOperation['kind'],
    operation: (signal: AbortSignal) => AsyncIterable<SessionEvent>,
  ) => {
    const abort = new AbortController();
    fallbackAbort = abort;
    const current: InteractiveOperation = {
      id: `interactive-${++operationSequence}`,
      kind,
      session: session(),
    };
    activeOperation = current;
    let renderer: EventRenderer | undefined;
    let unbindToggle = () => {};
    let unbindInteraction = () => {};
    let failure: unknown;
    notify(() => options.onAction?.({ type: 'started', operation: current }));
    try {
      renderer = options.rendererFactory({
        kind: 'operation',
        session: current.session,
        operation: current,
        context,
      });
      activeRenderer = renderer;
      unbindToggle = input.onDetailToggle(() => renderer?.toggleDetail());
      unbindInteraction = input.onInteraction(() => renderer?.invalidateAnchor());
      for await (const event of operation(abort.signal)) {
        if (failure) continue;
        try {
          renderer.render(event);
        } catch (error) {
          failure = error;
          cancelOperation();
          output().error(`展示失败: ${error instanceof Error ? error.message : '未知错误'}`);
        }
      }
    } catch (error) {
      failure = error;
      if (!(error instanceof AbortError) && !abort.signal.aborted)
        output().error(`执行失败: ${error instanceof Error ? error.message : '未知错误'}`);
    } finally {
      unbindToggle();
      unbindInteraction();
      try {
        renderer?.finish();
      } catch (error) {
        failure = error;
        output().error(`展示收尾失败: ${error instanceof Error ? error.message : '未知错误'}`);
      }
      if (activeRenderer === renderer) activeRenderer = undefined;
      if (fallbackAbort === abort) fallbackAbort = undefined;
      if (activeOperation === current) activeOperation = undefined;
      notify(() => options.onAction?.({ type: 'settled', operation: current, error: failure }));
    }
  };
  context.runSkill = (name, task) =>
    runTask('skill', (signal) =>
      options.controller
        ? options.controller.runSkill(name, task, { signal })
        : session().runSkill(name, task, { signal }),
    );
  context.runPreparedTask = (task, prepare) =>
    runTask('prepared', (signal) =>
      options.controller
        ? options.controller.runPreparedTask(task, prepare, { signal })
        : session().runPreparedTask(task, prepare, { signal }),
    );
  context.onExit = requestExit;
  const unbindInterrupt = input.onInterrupt(() => {
    activeRenderer?.invalidateAnchor();
    if (input.isBusy()) {
      input.cancel();
      return;
    }
    const now = Date.now();
    if (lastInterrupt !== undefined && now - lastInterrupt < 1500) {
      requestExit();
      return;
    }
    if (busy()) {
      lastInterrupt = now;
      cancelOperation();
      output().log('\n已请求中止，正在等待工具、摘要与存储清理。');
      return;
    }
    if (input.getLine().trim()) {
      input.clearLine();
      lastInterrupt = undefined;
      prompt();
      return;
    }
    lastInterrupt = now;
    output().log('\n再按一次 Ctrl+C 退出，或输入 /exit。');
    prompt();
  });
  publishSession();
  prompt();
  input.onLine((raw) => {
    activeRenderer?.invalidateAnchor();
    if (exiting) return;
    if (!raw.trim()) {
      prompt();
      return;
    }
    lastInterrupt = undefined;
    const operation = (async () => {
      const handled = await dispatcher.dispatch(raw, context);
      publishSession();
      if (handled || exiting) return;
      if (busy()) {
        output().log('会话忙，请等待执行与清理完成；只读命令仍可查询。');
        return;
      }
      await runTask('message', (signal) =>
        options.controller
          ? options.controller.run(raw.trim(), { signal })
          : session().run(raw.trim(), { signal }),
      );
    })();
    operations.add(operation);
    void operation
      .catch((error) =>
        output().error(`命令失败: ${error instanceof Error ? error.message : '未知错误'}`),
      )
      .finally(() => {
        operations.delete(operation);
        if (!exiting && !busy()) prompt();
      });
  });
  try {
    await input.whenClosed;
    exiting = true;
    if (input.interactive) cancelOperation();
    await Promise.allSettled([...operations]);
    try {
      statusRenderer.finish();
    } catch (error) {
      output().error(`展示收尾失败: ${error instanceof Error ? error.message : '未知错误'}`);
    }
    if (options.controller) await options.controller.close();
    else await session().destroy();
  } finally {
    unbindInterrupt();
    options.approvalChannel?.bind(async () => 'deny_once');
    input.close();
  }
}
