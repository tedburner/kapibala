/** macOS 开发运行时使用隔离应用包名称；其他平台返回原可执行路径。 */
export function developmentExecutable(
  executable: string,
  cacheRoot: string,
  platform?: NodeJS.Platform,
): string;
