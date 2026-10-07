import type { AgentSession, ModelRole, PrimaryModelRole } from '@kiturone/kapibala';
import type { ActiveSessionController } from '../active-session.js';
import type { UserSettings } from '../settings.js';
import type { SelectConfig } from '../ui/select.js';
import type { CommandDefinition } from './catalog.js';

/**
 * 命令处理器的宿主环境：能力全部以回调注入，命令层不得直接触达终端或输入协调器。
 * `session` 始终是当前活动会话，切换后由宿主换新，处理器不得跨轮次缓存。
 */
export interface CommandContext {
  session: AgentSession;
  settings: UserSettings;
  /** 实际生效的配置文件路径；仅使用内置默认（未加载文件）时缺省。 */
  settingsPath?: string;
  /** 模型切换已在宿主侧生效（含设置重载与绑定重建）后回调。 */
  onModelSwitched: (newProfileId: string) => void;
  /** 角色绑定持久化成功后回调，宿主据此同步运行时绑定。 */
  onRoleBound?: (role: Exclude<ModelRole, 'default'>, profileId: string) => void;
  /** `/model route <role>` 的主任务角色选择回调，由宿主执行严格校验与切换。 */
  onRoleSelected?: (role: PrimaryModelRole) => void;
  /** 密钥写入成功后回调，宿主据此重建同组全部角色绑定。 */
  onCredentialsUpdated?: (profileId: string) => void;
  onExit: () => void | Promise<void>;
  readSecret?: (prompt: string) => Promise<string>;
  confirm?: (prompt: string) => Promise<boolean>;
  controller?: ActiveSessionController;
  dispatcher?: CommandDispatcher;
  /** 输入协调器是否正被问答占用；变更门禁会参考它避免打断进行中的确认。 */
  isInputBusy?: () => boolean;
  question?: (prompt: string) => Promise<string>;
  select?: <T>(config: SelectConfig<T>) => Promise<T | null>;
  renderEvent?: (event: import('@kiturone/kapibala').SessionEvent) => void;
}

/** 命令处理器：args 已按定义切分（rawTail 命令为单元素）；抛错由 dispatcher 统一捕获输出。 */
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

/**
 * 斜杠命令的路由与执行门禁。
 * dispatch 返回 false 表示输入不是命令（应交给模型）；变更类命令在会话/输入忙碌期被拒绝，
 * 只读命令始终放行。同名或别名重复注册会抛错，不产生半注册状态。
 */
export class CommandDispatcher {
  private readonly handlers = new Map<string, CommandHandler>();
  private readonly definitions = new Map<string, CommandDefinition>();
  /** 变更互斥门：一个变更类命令执行期间，其它变更类命令即使状态已空闲也不得重入。 */
  private mutationActive = false;

  /** 以只读诊断定义快速注册（无 usage/描述，且不做变更门禁）；需要门禁的命令应走 registerDefinition。 */
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

  /** 按名称或别名取定义；入参可带前导斜杠。 */
  getDefinition(name: string): CommandDefinition | undefined {
    return this.definitions.get(name.toLowerCase().replace(/^\//, ''));
  }
  /** 全部定义；别名与主名共享同一份，这里已去重。 */
  getDefinitions(): CommandDefinition[] {
    return [...new Set(this.definitions.values())];
  }

  /**
   * 路由一条输入：斜杠命令或裸退出别名。执行前先做参数校验与变更门禁检查，
   * 处理器抛错只输出不外传。返回 false 表示非命令，调用方应转交模型处理。
   */
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
