const ESC = '\x1b';
const BEL = String.fromCharCode(7);
const TERMINAL_SEQUENCE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\))`,
  'g',
);

/**
 * 清除外部文字的 ANSI/OSC 与 C0/C1 控制字符，保留换行和制表符。
 * 纯字符串净化不读取终端、不注册监听；原始历史保持不变，供文本和 Host 投影共用。
 */
export function sanitizeUntrustedOutput(value: string): string {
  let safe = '';
  for (const character of value.replace(TERMINAL_SEQUENCE, '')) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      (codePoint < 0x20 && codePoint !== 0x09 && codePoint !== 0x0a) ||
      (codePoint >= 0x7f && codePoint <= 0x9f)
    )
      continue;
    safe += character;
  }
  return safe;
}
