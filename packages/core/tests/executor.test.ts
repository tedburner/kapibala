import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolExecutor } from '../src/executor/index.js';
import { HookRegistry } from '../src/hooks/registry.js';
import { defineTool } from '../src/tools/index.js';
import { ToolRegistry } from '../src/tools/registry.js';

describe('ToolExecutor timeout', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a cooperative tool so it cannot commit a delayed side effect after timeout', async () => {
    vi.useFakeTimers();
    let committed = false;
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: 'delayed_write',
        description: 'Commit a delayed write unless cancelled.',
        parameters: { type: 'object', properties: {} },
        async execute(_input, ctx) {
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              committed = true;
              resolve();
            }, 100);
            ctx.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                reject(new Error('cancelled'));
              },
              { once: true },
            );
          });
          return 'written';
        },
      }),
    );
    const executor = new ToolExecutor({
      tools,
      hooks: new HookRegistry(),
      rootDir: process.cwd(),
      toolTimeoutMs: 10,
    });

    const resultPromise = executor.executeOne({
      type: 'tool_use',
      id: 'call_timeout',
      name: 'delayed_write',
      input: {},
    });
    await vi.advanceTimersByTimeAsync(10);
    const result = await resultPromise;
    await vi.advanceTimersByTimeAsync(100);

    expect(result).toMatchObject({ isError: true });
    expect(committed).toBe(false);
  });
});
