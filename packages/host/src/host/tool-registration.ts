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

/** 注册默认工具；缺少解释器不阻断会话，命令调用前重试发现并绑定审批目标。显式关闭命令工具后不会重新注册。 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  options: BuiltinRegistrationOptions,
): void {
  for (const tool of builtinTools) registry.register(tool);
  if (!options.disableShell) {
    const discover = () =>
      createRunCommandTool(
        (options.detect ?? detectShell)({ preference: options.shell ?? 'auto', cwd: options.cwd }),
      );
    try {
      registry.register(discover());
    } catch (error) {
      // 仅将解释器不可用降级；其他编程或工作区错误仍须暴露。
      const e = error as NodeJS.ErrnoException;
      if (
        !/No usable Bash or PowerShell|Requested .* interpreter|Requested interpreter/.test(
          e.message,
        ) &&
        !(
          e.code === 'ENOENT' &&
          options.shell &&
          /[\\/]/.test(options.shell) &&
          e.path === options.shell
        )
      )
        throw error;
      let command: ReturnType<typeof createRunCommandTool> | undefined;
      const resolve = () => {
        command ??= discover();
        return command;
      };
      const template = createRunCommandTool({
        kind: 'bash',
        executable: '',
        executableDigest: '',
        cwd: options.cwd,
      });
      const fallback: typeof template = {
        ...template,
        description:
          'Run a shell command as the current OS user; an available interpreter is required. The file tool PathSandbox does not isolate this process or its network access.',
        parameters: {
          ...template.parameters,
          properties: {
            ...(template.parameters.properties as Record<string, unknown>),
            command: { type: 'string', description: 'Command using the available shell syntax.' },
          },
        },
        validateInput() {
          try {
            resolve();
            return { valid: true };
          } catch {
            return {
              valid: false,
              message: '未找到可用的 shell 解释器，请检查 PATH 或配置有效的 shell 路径。',
            };
          }
        },
        approvalScope: (input, rootDir, executionCwd) =>
          resolve().approvalScope!(input, rootDir, executionCwd),
        execute: (input, ctx) => resolve().execute(input, ctx),
      };
      registry.register(fallback);
    }
  }
  if (options.runtime) {
    for (const tool of createAgentTools(options.runtime)) {
      registry.register(tool);
    }
  }
}
