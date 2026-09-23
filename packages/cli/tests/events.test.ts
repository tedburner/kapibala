import type { SessionEvent } from '@kiturone/kapibala';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventRenderer } from '../src/ui/events.js';
import { displayWidth } from '../src/ui/width.js';

function renderEvent(
  event: SessionEvent,
  options: Parameters<typeof createEventRenderer>[0] = {},
): string {
  const chunks: string[] = [];
  const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    chunks.push(String(chunk));
    return true;
  });
  try {
    createEventRenderer({ getGitBranch: () => undefined, ...options }).render(event);
    return chunks.join('');
  } finally {
    write.mockRestore();
  }
}

function renderEvents(
  events: SessionEvent[],
  options: Parameters<typeof createEventRenderer>[0] = {},
): string {
  const chunks: string[] = [];
  const renderer = createEventRenderer({
    getGitBranch: () => undefined,
    write: (chunk) => {
      chunks.push(chunk);
    },
    ...options,
  });
  for (const event of events) renderer.render(event);
  renderer.finish();
  return chunks.join('');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createEventRenderer tool output', () => {
  it('separates the tool icon from a completed Search invocation', () => {
    const output = renderEvents(
      [
        { type: 'tool_start', id: 'search', name: 'glob', input: { pattern: '*' } },
        {
          type: 'tool_finish',
          id: 'search',
          name: 'glob',
          result: Array.from({ length: 25 }, (_, index) => `file-${index}`).join('\n'),
          isError: false,
          durationMs: 9,
        },
      ],
      { isTTY: false },
    );

    expect(output).toBe('\n⚙  Search *  ✓ 9ms · 25 个匹配\n');
  });

  it('filters terminal controls from untrusted model output while keeping line breaks', () => {
    const output = renderEvents(
      [
        { type: 'text_delta', text: 'hello\x1b[2J\x1b]52;c;YWJj\x07\nworld' },
        { type: 'thinking_delta', thinking: 'thought\x1b[1A' },
        { type: 'error', error: new Error('bad\x1b[2J') },
      ],
      { isTTY: false },
    );
    expect(output).toContain('hello\nworld');
    expect(output).toContain('thought');
    expect(output).toContain('bad');
    expect(output).not.toContain('\x1b');
    expect(output).not.toContain('52;c;');
  });
  it('rewrites an interactive tool call into one completed terminal line', () => {
    const output = renderEvents(
      [
        {
          type: 'tool_start',
          id: 'call_write',
          name: 'write_file',
          input: { path: 'packages/cli/src/foo.ts', content: 'x'.repeat(1_229) },
        },
        {
          type: 'tool_finish',
          id: 'call_write',
          name: 'write_file',
          result: 'Successfully wrote 1229 bytes to packages/cli/src/foo.ts',
          isError: false,
          durationMs: 4,
        },
      ],
      { isTTY: true, columns: 120 },
    );

    expect(output).toContain('⚙  Write packages/cli/src/foo.ts · 1.2KB');
    expect(output).toContain('✓ 4ms');
    expect(output).toContain('\x1b[1A');
    expect(output).not.toContain('{"path"');
    expect(output).not.toContain('Successfully wrote');
  });

  it('uses one ANSI-free completed line when terminal rewriting is unavailable', () => {
    const output = renderEvents(
      [
        {
          type: 'tool_start',
          id: 'call_failed',
          name: 'read_file',
          input: { path: 'missing.txt' },
        },
        {
          type: 'tool_finish',
          id: 'call_failed',
          name: 'read_file',
          result: 'File not found: missing.txt',
          isError: true,
          durationMs: 37,
        },
      ],
      { isTTY: false },
    );

    expect(output).toBe('\n⚙  Read missing.txt  ✗ 37ms · File not found: missing.txt\n');
    expect(output).not.toContain('\x1b');
  });

  it('keeps long error summaries within the terminal width', () => {
    const chunks: string[] = [];
    const renderer = createEventRenderer({
      getGitBranch: () => undefined,
      write: (chunk) => {
        chunks.push(chunk);
      },
      isTTY: true,
      columns: 40,
    });

    renderer.render({
      type: 'tool_start',
      id: 'a',
      name: 'request',
      input: { query: 'first' },
    });
    renderer.render({
      type: 'tool_start',
      id: 'b',
      name: 'read_file',
      input: { path: 'b.ts' },
    });
    renderer.render({
      type: 'tool_finish',
      id: 'a',
      name: 'request',
      result: 'X'.repeat(100),
      isError: true,
      durationMs: 3,
    });

    const completedChunk = chunks.find((chunk) => chunk.includes('✗')) ?? '';
    const completedLine = completedChunk.split('\x1b[31m')[1]?.split('\x1b[0m')[0] ?? '';
    expect(displayWidth(completedLine)).toBeLessThanOrEqual(40);
  });

  it('sanitizes tool names in debug labels and orphan completions', () => {
    const unsafeName = 'request\x1b[2J\nforged';
    const debugOutput = renderEvents(
      [
        { type: 'tool_start', id: 'unsafe', name: unsafeName, input: {} },
        {
          type: 'tool_finish',
          id: 'unsafe',
          name: unsafeName,
          result: 'done',
          isError: false,
        },
      ],
      { debug: true, isTTY: false },
    );
    const orphanOutput = renderEvents(
      [
        {
          type: 'tool_finish',
          id: 'orphan',
          name: unsafeName,
          result: 'done',
          isError: false,
        },
      ],
      { isTTY: false },
    );

    for (const output of [debugOutput, orphanOutput]) {
      expect(output).not.toContain('\x1b[2J');
      expect(output).not.toContain('\nforged');
      expect(output).toContain('request forged');
    }
  });

  it('keeps streaming the complete thinking content until folding is implemented later', () => {
    const event: SessionEvent = {
      type: 'thinking_delta',
      thinking: 'The user asks to search for a file.',
    };

    const output = renderEvents([event], { isTTY: false });

    expect(output).toContain('💭 思考过程:');
    expect(output).toContain('The user asks to search for a file.');
  });

  it('rewrites parallel tool lines in place regardless of finish order', () => {
    const output = renderEvents(
      [
        { type: 'tool_start', id: 'a', name: 'read_file', input: { path: 'a.ts' } },
        { type: 'tool_start', id: 'b', name: 'read_file', input: { path: 'b.ts' } },
        {
          type: 'tool_finish',
          id: 'a',
          name: 'read_file',
          result: 'x',
          isError: false,
          durationMs: 3,
        },
        {
          type: 'tool_finish',
          id: 'b',
          name: 'read_file',
          result: 'y',
          isError: false,
          durationMs: 4,
        },
      ],
      { isTTY: true, columns: 120 },
    );

    expect(output).toContain('\x1b[2A');
    expect(output).toContain('\x1b[1A');
    expect(output).toContain('✓ 3ms');
    expect(output).toContain('✓ 4ms');
  });

  it('appends an orphan tool finish without cursor rewriting', () => {
    const output = renderEvents(
      [
        {
          type: 'tool_finish',
          id: 'ghost',
          name: 'read_file',
          result: 'late',
          isError: false,
          durationMs: 9,
        },
      ],
      { isTTY: true, columns: 120 },
    );

    expect(output).toContain('⚙  read_file');
    expect(output).toContain('✓ 9ms');
    expect(output).not.toContain('\x1b[1A');
    expect(output).not.toContain('\x1b[2K');
  });

  it('falls back to append mode when output interleaves between tool start and finish', () => {
    const degraded = renderEvents(
      [
        { type: 'tool_start', id: 'a', name: 'read_file', input: { path: 'a.ts' } },
        { type: 'text_delta', text: 'interleaved' },
        {
          type: 'tool_finish',
          id: 'a',
          name: 'read_file',
          result: 'x',
          isError: false,
          durationMs: 3,
        },
      ],
      { isTTY: true, columns: 120 },
    );

    expect(degraded).toContain('interleaved');
    expect(degraded).toContain('✓ 3ms');
    expect(degraded).not.toContain('\x1b[1A');
    expect(degraded).not.toContain('\x1b[2K');

    // 全部工具收尾后改写能力必须恢复：新一轮工具重新走原地改写路径。
    const recovered = renderEvents(
      [
        { type: 'tool_start', id: 'b', name: 'read_file', input: { path: 'b.ts' } },
        {
          type: 'tool_finish',
          id: 'b',
          name: 'read_file',
          result: 'y',
          isError: false,
          durationMs: 5,
        },
      ],
      { isTTY: true, columns: 120 },
    );
    expect(recovered).toContain('\x1b[1A');
  });

  it('supports dynamic column providers for resize-aware rendering', () => {
    const output = renderEvents(
      [
        {
          type: 'tool_start',
          id: 'a',
          name: 'read_file',
          input: { path: 'packages/cli/src/very-long-file-name.ts' },
        },
      ],
      { isTTY: true, columns: () => 30 },
    );

    expect(output).toContain('…');
  });
});

describe('createEventRenderer request metrics', () => {
  it('shows the last-request context usage separately from aggregate run tokens', () => {
    const output = renderEvent(
      {
        type: 'run_finish',
        metrics: {
          startTime: 0,
          endTime: 2_000,
          totalDurationMs: 2_000,
          modelDurationMs: 1_200,
          toolDurationMs: 300,
          ttftMs: 45,
          promptTokens: 1_500_000,
          completionTokens: 100,
          totalTokens: 1_500_100,
          turns: 2,
          toolCalls: 1,
          status: 'completed',
          contextUsage: {
            usedTokens: 800_000,
            limitTokens: 1_000_000,
            percent: 80,
            estimatedLimit: true,
          },
        },
      },
      { getGitBranch: () => 'feature/footer', isTTY: false, columns: 500 },
    );

    expect(output).toContain(
      'Git: feature/footer | 📊 总耗时: 2.00s | 上下文: ≈800k/1M (80.0%) | 本轮 Token: ↑1.5M ↓100 | 工具: 1次/300ms',
    );
    expect(output).not.toContain('步骤:');
    expect(output).not.toContain('模型轮次:');
  });

  it('keeps diagnostic timing in debug mode without restoring the removed step metric', () => {
    const output = renderEvent(
      {
        type: 'run_finish',
        metrics: {
          startTime: 0,
          endTime: 2_000,
          totalDurationMs: 2_000,
          modelDurationMs: 1_200,
          toolDurationMs: 300,
          ttftMs: 45,
          promptTokens: 1_500,
          completionTokens: 100,
          totalTokens: 1_600,
          turns: 2,
          toolCalls: 1,
          status: 'completed',
        },
      },
      { debug: true, isTTY: false, columns: 500 },
    );

    expect(output).toContain('模型耗时: 1.20s');
    expect(output).toContain('TTFT: 45ms');
    expect(output).not.toContain('步骤:');
    expect(output).not.toContain('模型轮次:');
  });

  it('omits the Git segment without leaving a leading separator when no branch is available', () => {
    const output = renderEvent({
      type: 'run_finish',
      metrics: {
        startTime: 0,
        endTime: 1_000,
        totalDurationMs: 1_000,
        modelDurationMs: 800,
        toolDurationMs: 0,
        promptTokens: 900,
        completionTokens: 100,
        totalTokens: 1_000,
        turns: 1,
        toolCalls: 0,
        status: 'completed',
      },
    });

    expect(output).toContain('\n📊 总耗时: 1.00s');
    expect(output).not.toContain('Git:');
    expect(output).not.toContain('| 📊 总耗时: 1.00s');
  });

  it('drops less important footer segments first on narrow terminals', () => {
    const metrics = {
      startTime: 0,
      endTime: 2_000,
      totalDurationMs: 2_000,
      modelDurationMs: 1_200,
      toolDurationMs: 300,
      ttftMs: 45,
      promptTokens: 1_500,
      completionTokens: 100,
      totalTokens: 1_600,
      turns: 2,
      toolCalls: 1,
      status: 'completed' as const,
      contextUsage: {
        usedTokens: 800_000,
        limitTokens: 1_000_000,
        percent: 80,
        estimatedLimit: true,
      },
    };
    // 用 displayWidth 实测段宽推导列数，避免手估 CJK/emoji 宽度造成阈值漂移。
    const total = '📊 总耗时: 2.00s';
    const context = '上下文: ≈800k/1M (80.0%)';
    const tokens = '本轮 Token: ↑1.5k ↓100';
    const tools = '工具: 1次/300ms';
    const full = [total, context, tokens, tools].join(' | ');
    const withoutTools = [total, context, tokens].join(' | ');

    // 展示顺序越靠后越先隐藏：刚好放不下完整底栏时，先丢弃「工具」，Token 与上下文保留。
    const oneDrop = renderEvent(
      { type: 'run_finish', metrics },
      { getGitBranch: () => undefined, isTTY: true, columns: displayWidth(full) - 1 },
    );
    expect(oneDrop).not.toContain(tools);
    expect(oneDrop).toContain(tokens);
    expect(oneDrop).toContain(context);

    // 再窄一档：继续丢弃「本轮 Token」，上下文仍在。
    const twoDrops = renderEvent(
      { type: 'run_finish', metrics },
      { getGitBranch: () => undefined, isTTY: true, columns: displayWidth(withoutTools) - 1 },
    );
    expect(twoDrops).not.toContain(tools);
    expect(twoDrops).not.toContain(tokens);
    expect(twoDrops).toContain(context);
  });
});
