import {
  type AgentRuntime,
  type ToolRegistry,
  builtinTools,
  createAgentTools,
  createRunCommandTool,
  detectShell,
} from '@kiturone/kapibala';

/** CLI 默认工具集的注册参数；shell 与 detect 供测试注入或显式覆盖解释器选择。 */
export interface BuiltinRegistrationOptions {
  cwd: string;
  disableShell?: boolean;
  /** 'auto'、具名解释器或解释器可执行文件全路径。 */
  shell?: string;
  /** 测试可注入假发现器；缺省使用真实 detectShell。 */
  detect?: typeof detectShell;
  /** 后台子代理任务树运行时调度器；提供时自动注册 spawn_agent、list_agents、wait_agent、cancel_agent 四大管理工具。 */
  runtime?: AgentRuntime;
}

/** 注册 CLI 默认工具；显式关闭命令工具后，模式切换不会重新注册它。若提供 runtime 则同步注册四大子代理调度管理工具。 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  options: BuiltinRegistrationOptions,
): void {
  for (const tool of builtinTools) registry.register(tool);
  if (!options.disableShell) {
    registry.register(
      createRunCommandTool(
        (options.detect ?? detectShell)({ preference: options.shell ?? 'auto', cwd: options.cwd }),
      ),
    );
  }
  if (options.runtime) {
    for (const tool of createAgentTools(options.runtime)) {
      registry.register(tool);
    }
  }
}
