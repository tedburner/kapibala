import { describe, expect, it, vi } from 'vitest';
import { statusCommand } from '../src/commands/status.js';

describe('/status context usage', () => {
  it('shows the latest request context usage and marks an estimated limit', () => {
    const lines: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((...args) => {
      lines.push(args.join(' '));
    });
    const context = {
      session: {
        getStats: () => ({
          totalTurns: 2,
          totalTokens: { promptTokens: 1_500_000, completionTokens: 100, totalTokens: 1_500_100 },
          activeModel: 'Test Model',
          loadedToolsCount: 5,
          contextUsage: {
            usedTokens: 800_000,
            limitTokens: 1_000_000,
            percent: 80,
            estimatedLimit: true,
          },
        }),
      },
    } as never;

    try {
      statusCommand([], context);
    } finally {
      log.mockRestore();
    }

    expect(lines.join('\n')).toContain('≈800k / 1M (80.0%)');
  });
});
