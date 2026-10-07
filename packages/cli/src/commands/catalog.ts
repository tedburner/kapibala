import { isInteractiveTerminal } from '../input-coordinator.js';
import { PRIMARY_MODEL_ROLES, ROUTABLE_MODEL_ROLES } from '../model-bindings.js';

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

/** 注册、帮助、别名、参数和状态门的唯一命令定义，不列出尚未交付的未来能力。 */
export const COMMAND_CATALOG: readonly CommandDefinition[] = [
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
    usage: '/history [page]',
    description: '按项目查看历史，每页 20 项',
    group: 'session',
    mutates: () => false,
    validate: (args) => integer(args),
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
