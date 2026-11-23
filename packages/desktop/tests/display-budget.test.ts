import { describe, expect, it } from 'vitest';
import { clipForDisplay } from '../src/renderer/display-budget.js';
import { LIMITS } from '../src/shared/contracts.js';

describe('展示预算', () => {
  it('预算内原样返回且不标记截断，超限恰好保留 maximum 个字符并要求提示', () => {
    const within = 'x'.repeat(LIMITS.displayBudget);
    expect(clipForDisplay(within)).toEqual({ text: within, truncated: false });
    const over = `${within}y`;
    const clip = clipForDisplay(over);
    expect(clip.truncated).toBe(true);
    expect(clip.text).toHaveLength(LIMITS.displayBudget);
    expect(clip.text).toBe(within);
  });

  it('自定义上限同样生效；非正数或非安全整数直接拒绝，不静默放大', () => {
    expect(clipForDisplay('abcdef', 3)).toEqual({ text: 'abc', truncated: true });
    expect(() => clipForDisplay('abc', 0)).toThrow();
    expect(() => clipForDisplay('abc', 1.5)).toThrow();
    expect(() => clipForDisplay('abc', Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });
});
