/**
 * 终端显示宽度工具（画等宽边框用）。
 *
 * 为什么需要：`String.length` 按 UTF-16 码元计数，而终端里 CJK 汉字、全角标点、
 * emoji 实际占 2 列。用 length 推算补白会让含中文的行比边框多出若干列，
 * 表现为「右下角边框歪掉 / 豁口」。这里按 East Asian Width 粗略二分（1 列 / 2 列），
 * 精度足够画框，且不引入任何依赖。
 */

// biome 的 noControlCharactersInRegex 禁止在正则**字面量**里直接写 ESC 等控制字符，
// 所以这里用字符串构造。行为与 /\x1b\[[0-9;]*m/ 完全一致。
const ESC = '\x1b';
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-9;]*m`, 'g');

/** 占 2 列的码点区间：CJK 汉字、假名、谚文、全角标点、emoji。 */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // 谚文字母
  [0x2e80, 0xa4cf], // CJK 部首 ~ 彝文（覆盖汉字、假名、注音、CJK 符号）
  [0xac00, 0xd7a3], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容汉字
  [0xfe30, 0xfe6f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角 ASCII（含全角冒号等）
  [0xffe0, 0xffe6], // 全角符号
  [0x1f300, 0x1faff], // emoji 与补充符号（如 🐾）
];

/** 占 0 列的码点区间：组合符、零宽字符、变体选择符。 */
const ZERO_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0300, 0x036f], // 组合附加符号
  [0x200b, 0x200f], // 零宽字符与双向标记
  [0xfe00, 0xfe0f], // 变体选择符
];

const inRanges = (codePoint: number, ranges: ReadonlyArray<readonly [number, number]>): boolean => {
  for (const [start, end] of ranges) {
    if (codePoint >= start && codePoint <= end) return true;
  }
  return false;
};

/** 单个码点在终端占用的列数。 */
export function charWidth(codePoint: number): number {
  if (inRanges(codePoint, ZERO_RANGES)) return 0;
  if (inRanges(codePoint, WIDE_RANGES)) return 2;
  return 1;
}

/** 去掉 ANSI 转义序列，仅保留可见字符。 */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

/** 文本在终端占用的列数（ANSI 色码不计入）。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of stripAnsi(text)) {
    width += charWidth(ch.codePointAt(0) ?? 0);
  }
  return width;
}

/**
 * 把一行内容补齐或裁剪到恰好 `target` 列，用于绘制等宽边框。
 *
 * - 短于 target：右侧补空格（含 ANSI 色码时按可见宽度计算，色码不受影响）
 * - 恰好等于：原样返回
 * - 长于 target（如极深的 cwd 路径）：退化为纯文本裁剪并以 `…` 收尾。
 *   该分支会丢弃此行配色 —— 精确裁剪 ANSI 序列得不偿失，且此场景罕见。
 */
export function fitVisible(text: string, target: number): string {
  const width = displayWidth(text);
  if (width < target) return `${text}${' '.repeat(target - width)}`;
  if (width === target) return text;

  let plain = '';
  let used = 0;
  for (const ch of stripAnsi(text)) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    // 预留 1 列给省略号
    if (used + w > target - 1) break;
    plain += ch;
    used += w;
  }
  return `${plain}…${' '.repeat(Math.max(0, target - used - 1))}`;
}
