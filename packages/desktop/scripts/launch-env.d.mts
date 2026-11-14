/** 启动 Electron 应用时透传的变量名清单；新增项必须显式登记，门禁据此校验。 */
export const DESKTOP_ENV_KEYS: readonly string[];
/** 按白名单构造 Electron 启动环境，extra 优先级最高。 */
export function desktopLaunchEnv(
  base?: NodeJS.ProcessEnv,
  extra?: Record<string, string>,
): Record<string, string>;
