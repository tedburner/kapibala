/** 启动 Electron 应用时透传的变量名清单；新增项必须显式登记，门禁据此校验。 */
export const DESKTOP_ENV_KEYS: readonly string[];
/** 仅序列化当前桌面 home 中明确配置的外部代理变量，配置损坏时返回空载荷。 */
export function desktopExternalLaunchEnv(
  base: NodeJS.ProcessEnv,
  homeDir?: string,
): Promise<Record<string, string>>;
/** 按白名单构造 Electron 启动环境，extra 优先级最高。 */
export function desktopLaunchEnv(
  base?: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): Record<string, string>;
