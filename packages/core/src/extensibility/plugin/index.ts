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

/** 插件生命周期：setup 在会话空闲时挂载执行一次，teardown 在会话销毁时逐个调用以回收资源。 */
export interface AgentPlugin {
  /** 用于挂载失败与 teardown 的诊断信息。 */
  readonly name: string;
  readonly version?: string;
  setup(ctx: PluginContext): void | Promise<void>;
  teardown?(): void | Promise<void>;
}
