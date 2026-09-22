import type { SessionEvent } from '@kiturone/kapibala';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEventRenderer } from '../src/ui/events.js';

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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createEventRenderer tool output', () => {
  it('redacts sensitive input fields and only adds an ellipsis when truncated', () => {
    const output = renderEvent({
      type: 'tool_start',
      id: 'call_secret',
      name: 'request',
      input: {
        city: 'Hangzhou',
        apiKey: 'sk-secret-value',
        nested: { password: 'hunter2' },
        access_token: 'oauth-secret',
        secret_access_key: 'akia-readonly',
        credential: 'aws-sts-cred',
      },
    });

    expect(output).toContain('[REDACTED]');
    expect(output).toContain('Hangzhou');
    expect(output).not.toContain('sk-secret-value');
    expect(output).not.toContain('hunter2');
    expect(output).not.toContain('oauth-secret');
    expect(output).not.toContain('akia-readonly');
    expect(output).not.toContain('aws-sts-cred');
    expect(output).not.toContain('...');
  });

  it('shows per-tool duration and a concise error summary', () => {
    const output = renderEvent({
      type: 'tool_finish',
      id: 'call_failed',
      name: 'read_file',
      result: 'first line\nsecond line',
      isError: true,
      durationMs: 37,
    });

    expect(output).toContain('[失败]');
    expect(output).toContain('37ms');
    expect(output).toContain('first line second line');
    expect(output).not.toContain('...');
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
      { getGitBranch: () => 'feature/footer' },
    );

    expect(output).toContain(
      'Git: feature/footer | 📊 总耗时: 2.00s | 上下文: ≈800k/1M (80.0%) | Token: 1.5M (输入 1.5M, 输出 100) | 模型: 1.20s | 工具: 0.30s (1 次) | TTFT: 45ms | 步骤: 2',
    );
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

    expect(output).toContain('\n\x1b[90m📊 总耗时: 1.00s');
    expect(output).not.toContain('Git:');
    expect(output).not.toContain('| 📊 总耗时: 1.00s');
  });
});
