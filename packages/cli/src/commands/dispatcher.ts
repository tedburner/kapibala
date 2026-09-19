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

export class CommandDispatcher {
  private readonly handlers = new Map<string, CommandHandler>();

  register(command: string, handler: CommandHandler): void {
    this.handlers.set(command.toLowerCase(), handler);
  }

  async dispatch(rawInput: string, ctx: CommandContext): Promise<boolean> {
    const trimmed = rawInput.trim();
    if (!trimmed.startsWith('/')) {
      return false;
    }

    const parts = trimmed.slice(1).split(/\s+/);
    const command = parts[0]?.toLowerCase();
    const args = parts.slice(1);

    if (!command) return true;

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
