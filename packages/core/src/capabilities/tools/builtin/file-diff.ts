import type { ToolDiffFacts } from '../../../types/index.js';

/**
 * 单次写入差分允许扫描的原始文本预算（前后文本合计，字节）。
 *
 * 与设计 010 的「单文件 patch 文本上限 10 MB」对齐：超限时不再产出精确行数，
 * 只返回 `truncated`，避免为了一个数字把大文件整段读进内存做 O(n·m) 比对。
 */
export const MAX_DIFF_BYTES = 10 * 1024 * 1024;

/**
 * 行级 LCS 动态规划的单元格预算。
 *
 * 前后缀裁剪后仍可能剩下两个很大的中段（例如整文件重写）；此时精确 LCS 的时间与内存
 * 都会随行数乘积增长。预算内给出精确值，超预算明确截断，绝不无界计算。
 */
export const MAX_DIFF_CELLS = 4_000_000;

/** 按行切分文本；末尾换行不额外算一行，空文本为零行。 */
export function countTextLines(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.length;
}

/**
 * 统计两次文本之间的行级增删数量。
 *
 * 边界与保证：
 * - 纯函数、零 I/O、零依赖；不做字符级 diff，也不把字符数折算成行数；
 * - 先剥公共前后缀，只对真正的变化中段求 LCS，常见的小范围编辑是线性的；
 * - 任一侧超 `MAX_DIFF_BYTES` 或中段超出 `MAX_DIFF_CELLS` 时返回 `{ truncated: true }`，
 *   不返回一个猜出来的数字（调用方必须按「未记录」展示，而不是按 0 行处理）；
 * - 只用于工具执行时生成事实，不在历史投影期重算。
 */
export function countLineDiff(before: string, after: string): ToolDiffFacts {
  if (before === after) return { additions: 0, deletions: 0 };
  if (Buffer.byteLength(before, 'utf-8') + Buffer.byteLength(after, 'utf-8') > MAX_DIFF_BYTES) {
    return { truncated: true };
  }

  const from = splitLines(before);
  const to = splitLines(after);

  let start = 0;
  while (start < from.length && start < to.length && from[start] === to[start]) start++;

  let endFrom = from.length - 1;
  let endTo = to.length - 1;
  while (endFrom >= start && endTo >= start && from[endFrom] === to[endTo]) {
    endFrom--;
    endTo--;
  }

  const removed = from.slice(start, endFrom + 1);
  const added = to.slice(start, endTo + 1);
  if (removed.length === 0) return { additions: added.length, deletions: 0 };
  if (added.length === 0) return { additions: 0, deletions: removed.length };
  if (removed.length * added.length > MAX_DIFF_CELLS) return { truncated: true };

  const common = longestCommonSubsequenceLength(removed, added);
  return {
    additions: added.length - common,
    deletions: removed.length - common,
  };
}

/** 与 `countTextLines` 共用同一行切分口径，保证计数与差分不会出现差一错误。 */
function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * 滚动两行 DP 求 LCS 长度；只保留上一行的结果，内存为 O(min(列数))。
 * 调用方已按 `MAX_DIFF_CELLS` 限制输入规模，这里不再做额外预算判断。
 */
function longestCommonSubsequenceLength(from: readonly string[], to: readonly string[]): number {
  let previous = new Int32Array(to.length + 1);
  let current = new Int32Array(to.length + 1);
  for (let i = 1; i <= from.length; i++) {
    const line = from[i - 1];
    for (let j = 1; j <= to.length; j++) {
      current[j] = line === to[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[to.length];
}
