import {
  formatToolInvocation,
  formatToolResultSummary,
  resolveToolDisplay,
} from '@kiturone/kapibala-host/internal';
import { describe, expect, it } from 'vitest';

describe('tool presentation', () => {
  it('formats built-in file tools as concise commands', () => {
    expect(formatToolInvocation('read_file', { path: '需求点.txt' })).toBe('读取 需求点.txt');
    expect(formatToolInvocation('glob', { pattern: '*.ts', subDirectory: 'packages/cli' })).toBe(
      '搜索 *.ts in packages/cli',
    );
    expect(formatToolInvocation('grep', { pattern: '关键字', path: '需求点.txt' })).toBe(
      '搜索 "关键字" in 需求点.txt',
    );
    expect(
      formatToolInvocation('write_file', {
        path: 'packages/cli/src/foo.ts',
        content: 'x'.repeat(1_229),
      }),
    ).toBe('写入 packages/cli/src/foo.ts · 1.2KB');
    expect(
      formatToolInvocation('edit_file', {
        path: 'packages/cli/src/foo.ts',
        targetContent: 'x'.repeat(42),
        replacementContent: 'updated',
      }),
    ).toBe('编辑 packages/cli/src/foo.ts · 替换 42 字符');
  });

  it('resolves display names for built-in, mcp, and unknown tools', () => {
    expect(resolveToolDisplay('read_file').label).toBe('读文件');
    expect(resolveToolDisplay('spawn_agent').label).toBe('派发子代理');
    expect(resolveToolDisplay('spawn_agent').verb).toBe('派发');
    expect(resolveToolDisplay('send_agent').label).toBe('续聊子代理');
    expect(resolveToolDisplay('mcp__doc-server__read_file').label).toBe('doc-server · read_file');
    expect(resolveToolDisplay('totally_new_tool').label).toBe('Totally new tool');
  });

  it('renders registered built-ins as verb + chip instead of bare ids', () => {
    expect(formatToolInvocation('send_agent', { agentId: 'agent-1', prompt: 'next' })).toBe(
      '续聊 · agent-1',
    );
    expect(formatToolInvocation('spawn_agent', { description: '梳理模块' })).toBe(
      '派发 · 梳理模块',
    );
    expect(formatToolInvocation('list_agents', {})).toBe('查询子代理');
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
