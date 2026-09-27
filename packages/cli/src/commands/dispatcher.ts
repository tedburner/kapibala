import type { AgentSession } from '@kiturone/kapibala';
import type { ActiveSessionController } from '../active-session.js';
import type { UserSettings } from '../settings.js';
import type { SelectConfig } from '../ui/select.js';
import type { CommandDefinition } from './catalog.js';

export interface CommandContext {
  session: AgentSession;
  settings: UserSettings;
  settingsPath?: string;
  onModelSwitched: (newProfileId: string) => void;
  onCredentialsUpdated?: (profileId: string) => void;
  onExit: () => void | Promise<void>;
  readSecret?: (prompt: string) => Promise<string>;
  confirm?: (prompt: string) => Promise<boolean>;
  controller?: ActiveSessionController;
  dispatcher?: CommandDispatcher;
  isInputBusy?: () => boolean;
  question?: (prompt: string) => Promise<string>;
  select?: <T>(config: SelectConfig<T>) => Promise<T | null>;
  renderEvent?: (event: import('@kiturone/kapibala').SessionEvent) => void;
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
  private readonly definitions = new Map<string, CommandDefinition>();
  private mutationActive = false;

  register(command: string, handler: CommandHandler): void {
    this.registerDefinition(
      {
        name: command,
        usage: `/${command}`,
        description: '',
        group: 'diagnostic',
        mutates: () => false,
        validate: () => undefined,
      },
      handler,
    );
  }

  /** 主入口与别名共享定义，先检查所有名称冲突再注册，失败不产生半注册状态。 */
  registerDefinition(definition: CommandDefinition, handler: CommandHandler): void {
    const names = [definition.name, ...(definition.aliases ?? [])].map((name) =>
      name.toLowerCase(),
    );
    if (new Set(names).size !== names.length || names.some((name) => this.handlers.has(name)))
      throw new Error('Duplicate command or alias registration');
    for (const name of names) {
      this.handlers.set(name, handler);
      this.definitions.set(name, definition);
    }
  }

  getDefinition(name: string): CommandDefinition | undefined {
    return this.definitions.get(name.toLowerCase().replace(/^\//, ''));
  }
  getDefinitions(): CommandDefinition[] {
    return [...new Set(this.definitions.values())];
  }

  async dispatch(rawInput: string, ctx: CommandContext): Promise<boolean> {
    const trimmed = rawInput.trim();

    let command: string | undefined;
    let args: string[] = [];

    if (trimmed.startsWith('/')) {
      const match = rawInput.trimStart().match(/^\/(\S+)(?:\s+([\s\S]*))?$/);
      command = match?.[1]?.toLowerCase();
      const tail = match?.[2] ?? '';
      args = this.definitions.get(command ?? '')?.rawTail
        ? tail.length
          ? [tail]
          : []
        : tail.trim()
          ? tail.trim().split(/\s+/)
          : [];
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
      console.log(`未知命令: /${command}。输入 /help 查看支持的命令。`);
      return true;
    }

    try {
      const definition = this.definitions.get(command)!;
      const validation = definition.validate(args);
      if (validation) throw new Error(`${validation}。用法: ${definition.usage}`);
      const mutating = definition.mutates(args);
      if (
        mutating &&
        (this.mutationActive ||
          ctx.controller?.isBusy() ||
          ctx.session.isBusy?.() ||
          ctx.isInputBusy?.())
      )
        throw new Error('会话忙，请等待执行和清理完成后重试');
      if (mutating) this.mutationActive = true;
      try {
        await handler(args, ctx);
      } finally {
        if (mutating) this.mutationActive = false;
      }
    } catch (err: unknown) {
      console.log(`命令执行失败: ${(err as Error).message}`);
    }

    return true;
  }
}
