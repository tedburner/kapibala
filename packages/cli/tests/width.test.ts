import { describe, expect, it } from 'vitest';
import { charWidth, displayWidth, fitVisible, stripAnsi } from '../src/ui/width.js';

describe('displayWidth', () => {
  it('counts ASCII as one column each', () => {
    expect(displayWidth('abc123')).toBe(6);
  });

  it('counts CJK characters as two columns each', () => {
    expect(displayWidth('活跃模型')).toBe(8);
  });

  it('counts full-width punctuation as two columns', () => {
    // 全角分号 U+FF1B
    expect(displayWidth('退出；')).toBe(6);
  });

  it('counts emoji as two columns', () => {
    expect(displayWidth('🐾')).toBe(2);
  });

  it('ignores ANSI color codes', () => {
    expect(displayWidth('\x1b[36m│\x1b[0m')).toBe(1);
    expect(displayWidth('\x1b[32mDeepSeek\x1b[0m')).toBe(8);
  });

  it('mixes widths correctly', () => {
    // "  • " 4 列 + "/model" 6 列 + 3 空格 + 12 汉字 * 2 列 = 37
    expect(displayWidth('  • /model   交互式切换模型与配置向导')).toBe(37);
  });
});

describe('charWidth', () => {
  it('treats combining marks and variation selectors as zero width', () => {
    expect(charWidth(0x0301)).toBe(0);
    expect(charWidth(0xfe0f)).toBe(0);
  });

  it('treats box-drawing characters as single width', () => {
    expect(charWidth('─'.codePointAt(0) ?? 0)).toBe(1);
    expect(charWidth('│'.codePointAt(0) ?? 0)).toBe(1);
  });
});

describe('stripAnsi', () => {
  it('removes escape sequences but keeps visible text', () => {
    expect(stripAnsi('\x1b[1m\x1b[37mKapibala\x1b[0m')).toBe('Kapibala');
  });
});

describe('fitVisible', () => {
  it('pads short content to the exact target width', () => {
    const line = fitVisible('  工作目录: F:\\some\\path', 62);
    expect(displayWidth(line)).toBe(62);
  });

  it('keeps ANSI colors and still pads to the target width', () => {
    const line = fitVisible('\x1b[32mDeepSeek V4 Flash\x1b[0m', 24);
    expect(displayWidth(line)).toBe(24);
    expect(line).toContain('\x1b[32m');
  });

  it('returns content unchanged when already at the target width', () => {
    const line = fitVisible('abc', 3);
    expect(line).toBe('abc');
  });

  it('truncates overlong content to the target width with an ellipsis', () => {
    const long = `F:\\${'deep\\'.repeat(40)}project`;
    const line = fitVisible(long, 62);
    expect(displayWidth(line)).toBe(62);
    expect(line.endsWith('…')).toBe(true);
  });

  it('produces a fully blank line for empty content', () => {
    expect(fitVisible('', 10)).toBe(' '.repeat(10));
  });
});
