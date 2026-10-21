import { describe, expect, it } from 'vitest';
import { StreamingRedactor, redactText, sanitizeDisplayText } from '../src/local-host/redaction.js';

describe('streaming credential redaction', () => {
  it('redacts complete secrets even when split across every possible boundary', () => {
    const secret = 'fixture-credential';
    for (let split = 1; split < secret.length; split++) {
      const redactor = new StreamingRedactor([secret]);
      const result =
        redactor.push(`before ${secret.slice(0, split)}`) +
        redactor.push(`${secret.slice(split)} after`) +
        redactor.flush();
      expect(result).toBe('before [REDACTED] after');
    }
  });
  it('preserves unicode text and incomplete nonsecret suffixes on flush', () => {
    const redactor = new StreamingRedactor(['fixture']);
    expect(redactor.push('你好 fi') + redactor.flush()).toBe('你好 fi');
  });

  it('redacts labeled tokens, bearer values, known keys and URL credentials', () => {
    expect(
      redactText(
        'curl -H "Authorization: Bearer abcdefgh123" --token=custom value sk-abcdefgh12345678 https://user:pass@example.test/mcp',
        ['fixture-credential'],
      ),
    ).toBe(
      'curl -H "Authorization: Bearer [REDACTED]" --token=[REDACTED] value [REDACTED] https://[REDACTED]@example.test/mcp',
    );
    expect(redactText('使用 fixture-credential 配置', ['fixture-credential'])).toBe(
      '使用 [REDACTED] 配置',
    );
  });

  it('normalizes control characters and bounds display text', () => {
    expect(sanitizeDisplayText(' a\n\tb\u0000c ')).toBe('a b c');
    expect(sanitizeDisplayText('x'.repeat(10), 5)).toBe('xxxx…');
    expect(sanitizeDisplayText('\u0000\n')).toBeUndefined();
  });
});
