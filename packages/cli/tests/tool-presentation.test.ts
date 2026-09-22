import { describe, expect, it } from 'vitest';
import { formatToolInvocation, formatToolResultSummary } from '../src/ui/tool-presentation.js';

describe('tool presentation', () => {
  it('formats built-in file tools as concise commands', () => {
    expect(formatToolInvocation('read_file', { path: '需求点.txt' })).toBe('Read 需求点.txt');
    expect(formatToolInvocation('glob', { pattern: '*.ts', subDirectory: 'packages/cli' })).toBe(
      'Search *.ts in packages/cli',
    );
    expect(formatToolInvocation('grep', { pattern: '关键字', path: '需求点.txt' })).toBe(
      'Search "关键字" in 需求点.txt',
    );
    expect(
      formatToolInvocation('write_file', {
        path: 'packages/cli/src/foo.ts',
        content: 'x'.repeat(1_229),
      }),
    ).toBe('Write packages/cli/src/foo.ts · 1.2KB');
    expect(
      formatToolInvocation('edit_file', {
        path: 'packages/cli/src/foo.ts',
        targetContent: 'x'.repeat(42),
        replacementContent: 'updated',
      }),
    ).toBe('Edit packages/cli/src/foo.ts · 替换 42 字符');
  });

  it('redacts sensitive values and removes terminal control characters in generic tools', () => {
    const output = formatToolInvocation('request', {
      city: 'Hangzhou\nInjected',
      apiKey: 'sk-secret-value',
      nested: { password: 'hunter2' },
      access_token: 'oauth-secret',
    });

    expect(output).toContain('request');
    expect(output).toContain('city=');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('sk-secret-value');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('oauth-secret');
    expect(output).not.toContain('\n');
    expect(output).not.toContain('\x1b');
  });

  it('summarizes successful results as metadata and keeps failures concise', () => {
    expect(formatToolResultSummary('glob', 'a.ts\nb.ts', false)).toBe('2 个匹配');
    expect(formatToolResultSummary('read_file', 'first\nsecond', false)).toBe('12B · 2 行');
    expect(formatToolResultSummary('write_file', 'Successfully wrote 12 bytes', false)).toBe(
      undefined,
    );
    expect(formatToolResultSummary('read_file', 'first line\nsecond line', true)).toBe(
      'first line second line',
    );
  });

  it('does not overcount lines when results end with a trailing newline', () => {
    expect(formatToolResultSummary('read_file', 'a\nb\n', false)).toBe('4B · 2 行');
    expect(formatToolResultSummary('read_file', 'a\n', false)).toBe('2B · 1 行');
  });

  it('reports zero matches for the exact empty-result messages from core fs tools', () => {
    expect(formatToolResultSummary('glob', 'No matching files found.', false)).toBe('0 个匹配');
    expect(formatToolResultSummary('grep', 'No matches found.', false)).toBe('0 个匹配');
  });
});
