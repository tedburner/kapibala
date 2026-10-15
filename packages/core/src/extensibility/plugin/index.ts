import type { ToolRegistry } from '../../capabilities/tools/registry.js';
import type { HookRegistry } from '../hooks/registry.js';

/** setup 收到的能力入口；tools / hooks 是会话共享的注册表，注册的条目影响后续所有执行。 */
export interface PluginContext {
  readonly tools: ToolRegistry;
  readonly hooks: HookRegistry;
  /** 本次会话的绝对工具根目录；工具的路径解析与审批都以此为基准。 */
  readonly rootDir: string;
  readonly logger?: (msg: string) => void;
}

/**
 * 插件声明的命令贡献描述元数据。
 *
 * 约束、边界与为什么：
 * 1. 纯元数据定义：只包含名称、描述、用法与变更标记，禁止引入 ANSI 渲染、Readline 或 TTY 依赖，坚守 Core Headless 铁律；
 * 2. 供宿主（CLI/TUI/Web）按需消费并装配到人机交互界面；非交互或 Headless 宿主可安全忽略本字段；
 * 3. 别名与主名均遵循全小写规范，防止跨平台输入歧义。
 */
export interface PluginCommandContribution {
  /** 命令主名称（不含前导斜杠，如 'mcp' 或 'prompts'）。 */
  readonly name: string;
  /** 命令用途说明，供帮助菜单展示。 */
  readonly description: string;
  /** 格式化调用用法（如 '/mcp [tools <server>]'）。 */
  readonly usage?: string;
  /** 可选别名列表（如 ['plugin']）。 */
  readonly aliases?: readonly string[];
  /** 命令是否产生状态变更；true 表示写操作（受忙碌状态门拦截），false 表示纯只读诊断。 */
  readonly mutates?: boolean;
}

/**
 * 插件声明的扩展贡献元数据聚合容器。
 *
 * 约束与边界：
 * 1. 声明式规范：允许外部扩展包一次性声明技能根目录、交互命令与扩展元数据；
 * 2. 宿主（CLI）在会话挂载插件时自动读取并完成装配，无需在宿主层硬编码插件内部命令。
 */
export interface PluginContribution {
  /** 插件显式携带或依赖的技能根目录集合（绝对物理路径）。 */
  readonly skillsRoots?: readonly string[];
  /** 插件贡献给宿主交互终端的斜杠命令列表。 */
  readonly commands?: readonly PluginCommandContribution[];
}

/**
 * 插件生命周期契约：setup 在会话空闲时挂载执行一次，teardown 在会话销毁时逐个调用以回收资源。
 * 遵循「一 Session 一插件实例」约束，实现外部生态向 Agent Harness 的受控单向注入。
 */
export interface AgentPlugin {
  /** 插件唯一识别名称，用于诊断输出与依赖追踪。 */
  readonly name: string;
  /** 插件语义版本号，默认遵循包版本。 */
  readonly version?: string;
  /** 插件用途与功能描述。 */
  readonly description?: string;
  /** 插件声明的扩展贡献元数据（命令清单、技能目录等）。 */
  readonly contributes?: PluginContribution;
  /** 挂载执行入口；仅在空闲状态调用，可向 tools / hooks 注册能力。 */
  setup(ctx: PluginContext): void | Promise<void>;
  /** 销毁回收入口；必须幂等执行，彻底清理进程、网络连接或定时器。 */
  teardown?(): void | Promise<void>;
}
