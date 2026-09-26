import {
  type ToolRegistry,
  builtinTools,
  createRunCommandTool,
  detectShell,
} from '@kiturone/kapibala';

export interface BuiltinRegistrationOptions {
  cwd: string;
  disableShell?: boolean;
  /** 'auto'、具名解释器或解释器可执行文件全路径。 */
  shell?: string;
  /** 测试可注入假发现器；缺省使用真实 detectShell。 */
  detect?: typeof detectShell;
}

/** 注册 CLI 默认工具；显式关闭命令工具后，模式切换不会重新注册它。 */
export function registerBuiltinTools(
  registry: ToolRegistry,
  options: BuiltinRegistrationOptions,
): void {
  for (const tool of builtinTools) registry.register(tool);
  if (options.disableShell) return;
  registry.register(
    createRunCommandTool(
      (options.detect ?? detectShell)({ preference: options.shell ?? 'auto', cwd: options.cwd }),
    ),
  );
}
