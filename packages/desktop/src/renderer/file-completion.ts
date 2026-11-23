/**
 * `@` 文件补全的匹配与排序（纯函数、零 I/O）。
 *
 * 约定与边界：
 * - 输入是宿主枚举的相对路径清单（可能截断），`prefix` 是 `@` 之后已输入的小写片段；
 * - 匹配口径保持「路径包含片段」不变，只加排序：文件名前缀 > 文件名包含 > 仅路径包含，
 *   同级内更短路径优先、再按字典序——否则清单顺序（宿主枚举序）里排在前面的
 *   同名片段会把这些文件挤出 `limit` 条，用户「明明有这个文件却搜不到」；
 * - 空前缀视为文件名前缀命中，按更短路径优先排序，首页补全先看到浅层文件；
 * - `limit` 只影响返回条数，不影响排序与匹配集合。
 */
/** 单个 `@` 文件补全候选条目；`insert` 带前导 `@`，确认后原样替换触发片段。 */
export interface FileCompletionItem {
  insert: string;
  label: string;
  detail: string;
}

/**
 * 按前缀对工作区相对路径清单打分并截取前 `limit` 条候选。
 *
 * 优先级固定为「文件名前缀命中 > 文件名子串命中 > 目录路径包含」，同级内短路径优先、字典序兜底；
 * 不访问文件系统，也不修改传入数组。
 */
export function rankFileMatches(
  files: readonly string[],
  prefix: string,
  limit = 8,
): FileCompletionItem[] {
  const scored: Array<{ file: string; rank: number }> = [];
  for (const file of files) {
    const lower = file.toLowerCase();
    if (!lower.includes(prefix)) continue;
    const basename = lower.slice(Math.max(lower.lastIndexOf('/'), lower.lastIndexOf('\\')) + 1);
    const rank = basename.startsWith(prefix) ? 0 : basename.includes(prefix) ? 1 : 2;
    scored.push({ file, rank });
  }
  scored.sort(
    (a, b) => a.rank - b.rank || a.file.length - b.file.length || a.file.localeCompare(b.file),
  );
  return scored
    .slice(0, limit)
    .map(({ file }) => ({ insert: `@${file}`, label: file, detail: '' }));
}
