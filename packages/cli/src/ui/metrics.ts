import type { ContextUsage } from '@kiturone/kapibala';

/** 将 Token 数格式化为适合终端状态行的十进制 K/M 简写。 */
export function formatTokenCount(tokens: number): string {
  const format = (value: number, suffix: string): string =>
    `${value.toFixed(2).replace(/\.0+$|(?<=\.[0-9])0$/, '')}${suffix}`;

  if (tokens >= 1_000_000) return format(tokens / 1_000_000, 'M');
  if (tokens >= 1_000) return format(tokens / 1_000, 'k');
  return String(tokens);
}

/** 格式化最近一次内部模型请求的上下文占用。 */
export function formatContextUsage(usage: ContextUsage, separator = '/'): string {
  const prefix = usage.estimatedLimit ? '≈' : '';
  const limit = formatTokenCount(usage.limitTokens);
  if (usage.usedTokens === undefined || usage.percent === undefined) {
    return `${prefix}未知${separator}${limit}`;
  }
  return `${prefix}${formatTokenCount(usage.usedTokens)}${separator}${limit} (${usage.percent.toFixed(1)}%)`;
}
