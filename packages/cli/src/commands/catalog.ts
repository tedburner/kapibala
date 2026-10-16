import { isInteractiveTerminal } from '../input-coordinator.js';
import { PRIMARY_MODEL_ROLES, ROUTABLE_MODEL_ROLES } from '../model-bindings.js';
import { parseSkillTask } from './skills.js';

/**
 * 单个命令的静态定义：/help、注册冲突检查与运行期门禁共用的唯一事实。
 * `validate` 只做参数合法性检查，返回人类可读的错误消息或 undefined；
 * `mutates` 判定该次调用是否改变状态，dispatcher 据此在忙碌期拒绝变更类调用。
 */
export interface CommandDefinition {
  name: string;
  aliases?: string[];
  usage: string;
  description: string;
  group: 'session' | 'context' | 'model' | 'permissions' | 'diagnostic';
  /** 尾部不按空白切分，整段作为单个参数传递（供 /rename 这类自由文本）。 */
  rawTail?: boolean;
  mutates: (args: string[]) => boolean;
  validate: (args: string[]) => string | undefined;
}

const none = (args: string[]) => (args.length ? '不接受参数' : undefined);
const one = (args: string[]) => (args.length > 1 ? '最多接受一个参数' : undefined);
/** 可选上限的计数参数：至多一个正整数且不超过 maximum。 */
const integer = (args: string[], maximum = Number.MAX_SAFE_INTEGER) =>
  args.length > 1 ||
  (args[0] !== undefined &&
    (!/^[1-9]\d*$/.test(args[0]) ||
      !Number.isSafeInteger(Number(args[0])) ||
      Number(args[0]) > maximum))
    ? '参数必须为范围内的正整数'
    : undefined;
const settings = (args: string[]) =>
  !args.length ||
  (args[0] === 'setup' && args.length === 1) ||
  (args[0] === 'default' && args.length === 2)
    ? undefined
    : '使用 setup 或 default <id>';
// /model 的参数白名单：无参、key [id]、setup、set-default <id>、route <主任务角色>、
// 显式角色绑定 <角色> <id>，以及裸 <id> 直切。
const model = (args: string[]) =>
  !args.length ||
  (args[0] === 'key' && args.length <= 2) ||
  (args[0] === 'setup' && args.length === 1) ||
  (args[0] === 'set-default' && args.length === 2) ||
  (args[0] === 'route' && args.length === 2 && PRIMARY_MODEL_ROLES.includes(args[1] as never)) ||
  (ROUTABLE_MODEL_ROLES.includes(args[0] as never) && args.length === 2) ||
  (![...ROUTABLE_MODEL_ROLES, 'route', 'key', 'setup', 'set-default'].includes(args[0]) &&
    args.length === 1)
    ? undefined
    : '模型参数或子命令不正确';

const mcp = (args: string[]) => {
  if (args.length === 0) return undefined;
  const sub = args[0];
  if (['tools', 'reconnect', 'enable', 'disable'].includes(sub)) {
    return args.length === 2 && args[1].trim() ? undefined : `用法: /mcp ${sub} <server>`;
  }
  return '用法: /mcp [tools <server> | reconnect <server> | enable <server> | disable <server>]';
};

const history = (args: string[]) => {
  if (args.length === 0) return undefined;
  if (args[0] === '--tree' || args[0] === '--agents') {
    return args.length === 1 ? undefined : '选项 --tree 与 --agents 不接受额外参数';
  }
  if (args[0] === '--all') {
    return args.length === 1 || (args.length === 2 && /^[1-9]\d*$/.test(args[1]))
      ? undefined
      : '用法: /history --all [页码]';
  }
  if (args[0] === '--search' || args[0] === '-s') {
    return args.length >= 2 ? undefined : '用法: /history --search <关键词>';
  }
  return integer(args);
};

const branch = (args: string[]) => {
  if (args.length === 0) return undefined;
  if (args[0] === 'switch') {
    return args.length === 2 && args[1].trim() ? undefined : '用法: /branch switch <branchId>';
  }
  if (args[0] === 'create') {
    return args.length >= 2 && args[1].trim()
      ? undefined
      : '用法: /branch create <recordId> [branchName]';
  }
  if (args.length <= 2) return undefined;
  return '用法: /branch [recordId [name]] | /branch switch <branchId>';
};

const archive = (args: string[]) => {
  if (args.length === 0)
    return '用法: /archive <id> | /archive list [page] | /archive restore <id>';
  if (args[0] === 'list') {
    return args.length === 1 || (args.length === 2 && /^[1-9]\d*$/.test(args[1]))
      ? undefined
      : '用法: /archive list [page]';
  }
  if (args[0] === 'restore') {
    return args.length === 2 && args[1].trim() ? undefined : '用法: /archive restore <id>';
  }
  return args.length === 1 ? undefined : '用法: /archive <id>';
};

const agents = (args: string[]) => {
  if (args.length === 0) return undefined;
  const sub = args[0];
  if (sub === 'show' || sub === 'cancel' || sub === 'collect') {
    return args.length === 2 && args[1].trim() ? undefined : `用法: /agents ${sub} <agentId>`;
  }
  return '用法: /agents [show <id> | cancel <id> | collect <id>]';
};

/**
 * 解析 /prompt 原始输入行，提取 `<server>/<name>` 与可选参数。
 */
export function parsePromptInvocation(
  input: string,
): { promptId: string; rawArgs?: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const spaceIdx = trimmed.search(/\s/);
  const promptId = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const rawArgs = spaceIdx === -1 ? undefined : trimmed.slice(spaceIdx).trim();

  const slashIdx = promptId.indexOf('/');
  if (slashIdx <= 0 || slashIdx === promptId.length - 1) {
    return null;
  }
  return { promptId, rawArgs: rawArgs && rawArgs.length > 0 ? rawArgs : undefined };
}

/** 注册、帮助、别名、参数和状态门的唯一命令定义，不列出尚未交付的未来能力。 */
export const COMMAND_CATALOG: readonly CommandDefinition[] = [
  {
    name: 'plugins',
    aliases: ['plugin'],
    usage: '/plugins [name]',
    description: '查看当前会话已挂载的扩展插件与能力贡献清单',
    group: 'diagnostic',
    mutates: () => false,
    validate: one,
  },
  {
    name: 'mcp',
    usage: '/mcp [tools <server> | reconnect <server> | enable <server> | disable <server>]',
    description: '查看 MCP 服务状态、已注册工具或重连/开关当前会话服务',
    group: 'diagnostic',
    mutates: (args) => args.length > 0 && ['reconnect', 'enable', 'disable'].includes(args[0]),
    validate: mcp,
  },
  {
    name: 'prompts',
    usage: '/prompts [query]',
    description: '搜索 MCP 提示词模板与参数',
    group: 'diagnostic',
    rawTail: true,
    mutates: () => false,
    validate: one,
  },
  {
    name: 'prompt',
    usage: '/prompt <server/name> [arguments-json]',
    description: '执行 MCP 提示词模板任务',
    group: 'session',
    rawTail: true,
    mutates: () => true,
    validate: (args) =>
      args.length === 1 && parsePromptInvocation(args[0])
        ? undefined
        : '请输入合法提示词标识 <server>/<name> 及可选参数',
  },
  {
    name: 'skills',
    usage: '/skills [query]',
    description: '搜索技能、来源、诊断和活动状态',
    group: 'diagnostic',
    rawTail: true,
    mutates: () => false,
    validate: one,
  },
  {
    name: 'skill',
    usage: '/skill <name> <task...>',
    description: '显式加载技能并执行原始任务',
    group: 'session',
    rawTail: true,
    mutates: () => true,
    validate: (args) =>
      args.length === 1 && parseSkillTask(args[0]) ? undefined : '请输入合法技能名和非空任务',
  },
  {
    name: 'new',
    aliases: ['clear'],
    usage: '/new',
    description: '保留旧历史并新建会话',
    group: 'session',
    mutates: () => true,
    validate: none,
  },
  {
    name: 'resume',
    usage: '/resume [id]',
    description: '选择历史或按唯一 ID 前缀续答',
    group: 'session',
    mutates: () => true,
    validate: one,
  },
  {
    name: 'history',
    usage:
      '/history [page] | /history --all [page] | /history --search <query> | /history --tree | /history --agents',
    description: '查看或全文检索历史；支持跨项目、因果树与子代理任务',
    group: 'session',
    mutates: () => false,
    validate: history,
  },
  {
    name: 'branch',
    usage: '/branch [recordId [name]] | /branch switch <branchId>',
    description: '查看、创建或切换历史因果持久分支',
    group: 'session',
    mutates: (args) => args.length > 0,
    validate: branch,
  },
  {
    name: 'fork',
    usage: '/fork [title]',
    description: '从当前活动路径导出全新独立会话',
    group: 'session',
    rawTail: true,
    mutates: () => true,
    validate: one,
  },
  {
    name: 'archive',
    usage: '/archive <id> | /archive list [page] | /archive restore <id>',
    description: '查看已归档会话或逻辑归档/恢复指定会话',
    group: 'session',
    mutates: (args) => args[0] !== 'list',
    validate: archive,
  },
  {
    name: 'agents',
    usage: '/agents [show <id> | cancel <id> | collect <id>]',
    description: '查看后台子代理任务树状态、取消或收集结果',
    group: 'diagnostic',
    mutates: (args) => args[0] === 'cancel' || args[0] === 'collect',
    validate: agents,
  },
  {
    name: 'rename',
    usage: '/rename <title>',
    description: '修改当前会话标题',
    group: 'session',
    rawTail: true,
    mutates: () => true,
    validate: (args) => (args.length === 1 && args[0].trim() ? undefined : '请输入非空标题'),
  },
  {
    name: 'context',
    usage: '/context',
    description: '查看最终请求预算和压缩状态快照',
    group: 'context',
    mutates: () => false,
    validate: none,
  },
  {
    name: 'compact',
    usage: '/compact',
    description: '手动摘要旧完整交互，保留当前任务',
    group: 'context',
    mutates: () => true,
    validate: none,
  },
  {
    name: 'model',
    usage:
      '/model [id] | /model <planning|execution|fast|summary> <id> | /model route <default|planning|execution|fast> | /model key [id]',
    description: '选择当前模型或更新密钥；兼容 setup/set-default',
    group: 'model',
    // 与协调器同口径的双边判定：stdout 非终端时无参 /model 只是只读列表，
    // 忙碌期不应按「变更命令」拒绝（ctx.select 届时返回 null，什么都改不了）。
    mutates: (args) => args.length > 0 || isInteractiveTerminal(),
    validate: model,
  },
  {
    name: 'settings',
    aliases: ['config'],
    usage: '/settings [setup | default <id>]',
    description: '查看配置或设置下次默认启动模型',
    group: 'model',
    mutates: (args) => args.length > 0,
    validate: settings,
  },
  {
    name: 'permissions',
    aliases: ['mode'],
    usage: '/permissions [approval|plan|auto|full-access]',
    description: '查看或切换权限；FullAccess 需显式确认',
    group: 'permissions',
    mutates: (args) => args.length > 0,
    validate: (args) =>
      one(args) ??
      (args[0] && !['approval', 'plan', 'auto', 'full-access'].includes(args[0].toLowerCase())
        ? '未知权限模式'
        : undefined),
  },
  {
    name: 'status',
    usage: '/status',
    description: '查看当前会话、模型、权限及消耗概况',
    group: 'diagnostic',
    mutates: () => false,
    validate: none,
  },
  {
    name: 'logs',
    usage: '/logs [count]',
    description: '查看最近 1–100 条运行和审批日志',
    group: 'diagnostic',
    mutates: () => false,
    validate: (args) => integer(args, 100),
  },
  {
    name: 'instructions',
    usage: '/instructions',
    description: '查看当前项目指令来源',
    group: 'diagnostic',
    mutates: () => false,
    validate: none,
  },
  {
    name: 'help',
    usage: '/help [command]',
    description: '查看实际注册命令的用法与别名',
    group: 'diagnostic',
    mutates: () => false,
    validate: one,
  },
  {
    name: 'exit',
    aliases: ['quit'],
    usage: '/exit',
    description: '取消并等待资源清理后退出；兼容裸 exit/quit',
    group: 'diagnostic',
    mutates: () => false,
    validate: none,
  },
];
