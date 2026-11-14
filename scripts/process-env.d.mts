/** 剥离指向仓库外的预加载钩子，保留堆大小等纯参数；全部被剥离时返回 undefined。 */
export function sanitizeNodeOptions(
  value: string | undefined,
  repository: string,
): string | undefined;
/** 构造 Node 工具链环境：继承 HOME / CI 变量，仅剥离外部预加载钩子与 ELECTRON_RUN_AS_NODE。 */
export function toolchainEnv(
  base?: NodeJS.ProcessEnv,
  repository?: string,
  extra?: Record<string, string>,
): Record<string, string>;
