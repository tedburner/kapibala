import readline from 'node:readline';
import { AbortError, type AgentSession } from '@kiturone/kapibala';
import type { CommandContext, CommandDispatcher } from './commands/dispatcher.js';
import { type CliApprovalChannel, askWithReadline, confirmWithReadline } from './ui/approval.js';
import { createEventRenderer } from './ui/events.js';
import { readSecret } from './ui/secret.js';
import { fitVisible } from './ui/width.js';

export interface REPLOptions {
  session: AgentSession;
  dispatcher: CommandDispatcher;
  context: CommandContext;
  debug?: boolean;
  approvalChannel?: CliApprovalChannel;
}

export async function startREPL(options: REPLOptions): Promise<void> {
  const { session, dispatcher, context, debug } = options;

  let activeAbortController: AbortController | null = null;
  let lastCtrlCTime = 0;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  options.approvalChannel?.bind((request, signal) => askWithReadline(rl, request, signal));
  context.confirm = (prompt) => confirmWithReadline(rl, prompt);

  context.readSecret = async (prompt: string) => {
    const secret = await readSecret(prompt);
    // readSecret 临时接管同一个 TTY；清除 readline 可能缓存的掩码输入，避免进入下一条命令。
    (rl as unknown as { line: string }).line = '';
    (rl as unknown as { cursor: number }).cursor = 0;
    return secret;
  };

  const updatePrompt = () => {
    const active = session.getActiveProfile();
    rl.setPrompt(
      `\x1b[36mkpbl\x1b[0m \x1b[90m(${active.id} | ${session.getMode()})\x1b[0m \x1b[32m❯\x1b[0m `,
    );
  };

  // 包装原始 onModelSwitched 回调，切换模型时即时刷新 prompt
  const originalOnModelSwitched = context.onModelSwitched;
  context.onModelSwitched = (newProfileId: string) => {
    originalOnModelSwitched(newProfileId);
    updatePrompt();
  };

  const gracefulExit = () => {
    console.log('\n\x1b[32m再见！🐾\x1b[0m');
    // 退出前触发 session:end 与插件 teardown(设计文档 §3.2 / §3.3)
    void session
      .destroy()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };

  // 优雅处理 Ctrl+C 中断状态机 (参考 Claude Code CLI 规范)
  process.on('SIGINT', () => {
    const now = Date.now();

    // 1. 处于流式生成或工具执行中：单次按下立即中止当前轮次生成并自愈
    if (activeAbortController) {
      activeAbortController.abort();
      activeAbortController = null;
      process.stdout.write('\n\x1b[33m^C [当前轮次已中止，会话上下文已就绪]\x1b[0m\n\n');
      updatePrompt();
      rl.prompt();
      return;
    }

    // 2. 处于等待输入中：
    // 若当前输入框有输入内容，单次 Ctrl+C 清空当前行
    if (rl.line && rl.line.trim().length > 0) {
      process.stdout.write('\n');
      // 清空当前编辑行
      (rl as any).line = '';
      (rl as any).cursor = 0;
      updatePrompt();
      rl.prompt();
      return;
    }

    // 若输入框为空：
    if (now - lastCtrlCTime < 1500) {
      // 连续 2 次快速按下：直接退出程序
      gracefulExit();
    } else {
      lastCtrlCTime = now;
      process.stdout.write('\n\x1b[90m(再按一次 Ctrl+C 退出程序，或输入 /exit)\x1b[0m\n');
      updatePrompt();
      rl.prompt();
    }
  });

  // 处理 Ctrl+D / EOF
  rl.on('close', () => {
    gracefulExit();
  });

  const printWelcome = () => {
    const active = session.getActiveProfile();
    const cwd = process.cwd();

    // 边框整体宽度 64 列 = 左右竖线各 1 列 + 内容区 62 列。
    // 内容区补白一律走 fitVisible 按「显示宽度」计算（CJK/emoji 记 2 列），
    // 不要手写空格 —— 手写极易按「汉字=1 列」估错，导致右边框凸出或错位。
    const BOX_INNER = 62;
    const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
    const row = (content: string): string =>
      `${cyan('│')}${fitVisible(content, BOX_INNER)}${cyan('│')}`;

    console.log(
      [
        '',
        cyan(`╭${'─'.repeat(BOX_INNER)}╮`),
        row('  🐾 \x1b[1m\x1b[37mKapibala (kpbl) v0.0.2\x1b[0m'),
        row(`  活跃模型: \x1b[32m${active.name}\x1b[0m (${active.modelName})`),
        row(`  工作目录: \x1b[90m${cwd}\x1b[0m`),
        row(''),
        row('  \x1b[1m快捷指令:\x1b[0m'),
        row('  • \x1b[33m/model\x1b[0m   交互式切换模型与配置向导'),
        row('  • \x1b[33m/clear\x1b[0m   清空上下文，开启新会话'),
        row('  • \x1b[33m/help\x1b[0m    查看所有指令与用量状态'),
        row('  • \x1b[33mCtrl+C\x1b[0m   生成中按 1 次中止当前回答；空闲连按 2 次退出程序'),
        cyan(`╰${'─'.repeat(BOX_INNER)}╯`),
        '',
      ].join('\n'),
    );
  };

  printWelcome();
  updatePrompt();
  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) {
      updatePrompt();
      rl.prompt();
      continue;
    }

    // 1. 优先检查并分发 Slash 命令
    const handled = await dispatcher.dispatch(input, context);
    if (handled) {
      updatePrompt();
      rl.prompt();
      continue;
    }

    // 2. 正常对话交互，启动流式执行
    // controller 用局部变量持有：SIGINT 处理器会把全局引用置 null，
    // 若 catch 里读全局会把中止误判为异常并重复报错。
    const controller = new AbortController();
    activeAbortController = controller;

    try {
      const renderer = createEventRenderer({ debug });
      for await (const event of session.run(input, { signal: controller.signal })) {
        renderer.render(event);
      }
      renderer.finish();
      process.stdout.write('\n');
    } catch (err: unknown) {
      if (err instanceof AbortError || controller.signal.aborted) {
        // 已由 SIGINT 处理
      } else {
        console.log(`\n\x1b[31m发生异常: ${(err as Error).message}\x1b[0m\n`);
      }
    } finally {
      if (activeAbortController === controller) {
        activeAbortController = null;
      }
    }

    updatePrompt();
    rl.prompt();
  }
}
