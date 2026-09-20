import type { AgentSession } from '@kiturone/kapibala';
import type { UserSettings } from '../settings.js';

export interface CommandContext {
  session: AgentSession;
  settings: UserSettings;
  settingsPath?: string;
  onModelSwitched: (newProfileId: string) => void;
  onExit: () => void;
  readSecret?: (prompt: string) => Promise<string>;
}

export type CommandHandler = (args: string[], ctx: CommandContext) => Promise<void> | void;

/**
 * 不带斜杠也生效的命令白名单别名。
 *
 * 只放「用户凭直觉一定会敲」的退出类命令：裸 `exit` 若不被识别，会被当成普通提问
 * 发给模型，既白烧一次 API 调用、又让用户以为程序卡住。
 *
 * 刻意做成**白名单**而不是「裸词也算命令」：后者会把 `help`、`status` 这类
 * 正常词汇（甚至英文提问里的词）误判成命令，反而更危险。
 * 必须是单个词（`exit now` 仍按普通提问处理），避免误伤自然语言。
 */
const BARE_ALIASES = new Map<string, string>([
  ['exit', 'exit'],
  ['quit', 'quit'],
]);

export class CommandDispatcher {
  private readonly handlers = new Map<string, CommandHandler>();

  register(command: string, handler: CommandHandler): void {
    this.handlers.set(command.toLowerCase(), handler);
  }

  async dispatch(rawInput: string, ctx: CommandContext): Promise<boolean> {
    const trimmed = rawInput.trim();

    let command: string | undefined;
    let args: string[] = [];

    if (trimmed.startsWith('/')) {
      const parts = trimmed.slice(1).split(/\s+/);
      command = parts[0]?.toLowerCase();
      args = parts.slice(1);
      // 单独一个 "/" 视为已处理（避免落到模型）
      if (!command) return true;
    } else {
      const parts = trimmed.split(/\s+/);
      const alias =
        parts.length === 1 ? BARE_ALIASES.get(parts[0]?.toLowerCase() ?? '') : undefined;
      if (!alias) return false;
      command = alias;
    }

    const handler = this.handlers.get(command);
    if (!handler) {
      console.log(`\x1b[33m未知命令: /${command}。输入 /help 查看支持的命令。\x1b[0m`);
      return true;
    }

    try {
      await handler(args, ctx);
    } catch (err: unknown) {
      console.log(`\x1b[31m命令执行失败: ${(err as Error).message}\x1b[0m`);
    }

    return true;
  }
}
