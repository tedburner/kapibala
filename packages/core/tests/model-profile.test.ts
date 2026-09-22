import { describe, expect, it } from 'vitest';
import { DEFAULT_CONTEXT_WINDOW_TOKENS, resolveContextWindow } from '../src/models/router.js';

describe('resolveContextWindow', () => {
  it('uses an explicitly configured integer token limit', () => {
    expect(resolveContextWindow(256_000)).toEqual({
      tokens: 256_000,
      estimated: false,
    });
  });

  it.each([
    ['1M', 1_000_000],
    ['1m', 1_000_000],
    ['256K', 256_000],
    ['1.05M', 1_050_000],
  ] as const)('parses the context window shorthand %s', (input, expected) => {
    expect(resolveContextWindow(input)).toEqual({
      tokens: expected,
      estimated: false,
    });
  });

  it('uses an estimated 1M limit when the profile omits contextWindow', () => {
    expect(resolveContextWindow()).toEqual({
      tokens: DEFAULT_CONTEXT_WINDOW_TOKENS,
      estimated: true,
    });
  });

  it.each(['0K', '-1M', '128KB', '1e6', 'unknown'])('rejects invalid shorthand %s', (input) => {
    expect(() => resolveContextWindow(input as never)).toThrow(/contextWindow/i);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid numeric context window %s',
    (input) => {
      expect(() => resolveContextWindow(input)).toThrow(/contextWindow/i);
    },
  );
});
