import readline from 'node:readline';
import type { AgentSession } from '@kiturone/kapibala';
import type { CommandContext, CommandDispatcher } from './commands/dispatcher.js';

export interface REPLOptions {
  session: AgentSession;
  dispatcher: CommandDispatcher;
  context: CommandContext;
  debug?: boolean;
}

export async function startREPL(options: REPLOptions): Promise<void> {
  const { session, dispatcher, context, debug } = options;

  let activeAbortController: AbortController | null = null;
  let lastCtrlCTime = 0;

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const updatePrompt = () => {
    const active = session.getActiveProfile();
    rl.setPrompt(`\x1b[36mkpbl\x1b[0m \x1b[90m(${active.id})\x1b[0m \x1b[32m❯\x1b[0m `);
  };

  // 包装原始 onModelSwitched 回调，切换模型时即时刷新 prompt
  const originalOnModelSwitched = context.onModelSwitched;
  context.onModelSwitched = (newProfileId: string) => {
    originalOnModelSwitched(newProfileId);
    updatePrompt();
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
      console.log('\n\x1b[32m再见！🐾\x1b[0m');
      process.exit(0);
    } else {
      lastCtrlCTime = now;
      process.stdout.write('\n\x1b[90m(再按一次 Ctrl+C 退出程序，或输入 /exit)\x1b[0m\n');
      updatePrompt();
      rl.prompt();
    }
  });

  // 处理 Ctrl+D / EOF
  rl.on('close', () => {
    // 退出前触发 session:end 与插件 teardown(设计文档 §3.2 / §3.3)
    session
      .destroy()
      .catch(() => undefined)
      .finally(() => {
        console.log('\n\x1b[32m再见！🐾\x1b[0m');
        process.exit(0);
      });
  });

  const printWelcome = () => {
    const active = session.getActiveProfile();
    const cwd = process.cwd();
    console.log(
      '\n\x1b[36m╭──────────────────────────────────────────────────────────────╮\x1b[0m',
    );
    console.log(
      '\x1b[36m│\x1b[0m  🐾 \x1b[1m\x1b[37mKapibala (kpbl) v0.0.1\x1b[0m                                    \x1b[36m│\x1b[0m',
    );
    console.log(`\x1b[36m│\x1b[0m  活跃模型: \x1b[32m${active.name}\x1b[0m (${active.modelName})`);
    console.log(`\x1b[36m│\x1b[0m  工作目录: \x1b[90m${cwd}\x1b[0m`);
    console.log(
      '\x1b[36m│\x1b[0m                                                              \x1b[36m│\x1b[0m',
    );
    console.log(
      '\x1b[36m│\x1b[0m  \x1b[1m快捷指令:\x1b[0m                                                   \x1b[36m│\x1b[0m',
    );
    console.log(
      '\x1b[36m│\x1b[0m  • \x1b[33m/model\x1b[0m   交互式切换模型与配置向导                          \x1b[36m│\x1b[0m',
    );
    console.log(
      '\x1b[36m│\x1b[0m  • \x1b[33m/clear\x1b[0m   清空上下文，开启新会话                            \x1b[36m│\x1b[0m',
    );
    console.log(
      '\x1b[36m│\x1b[0m  • \x1b[33m/help\x1b[0m    查看所有指令与用量状态                            \x1b[36m│\x1b[0m',
    );
    console.log(
      '\x1b[36m│\x1b[0m  • \x1b[33mCtrl+C\x1b[0m   生成中按 1 次中止当前回答；空闲连按 2 次退出程序 \x1b[36m│\x1b[0m',
    );
    console.log(
      '\x1b[36m╰──────────────────────────────────────────────────────────────╯\x1b[0m\n',
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
    activeAbortController = new AbortController();
    let isFirstText = true;
    let isThinking = false;

    try {
      for await (const event of session.run(input, { signal: activeAbortController.signal })) {
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
      if (activeAbortController?.signal.aborted) {
        // 已由 SIGINT 处理
      } else {
        console.log(`\n\x1b[31m发生异常: ${(err as Error).message}\x1b[0m\n`);
      }
    } finally {
      activeAbortController = null;
    }

    updatePrompt();
    rl.prompt();
  }
}
