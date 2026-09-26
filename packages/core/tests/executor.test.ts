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
        metadata: { permissions: ['fs:write'] },
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
      approvalChannel: {
        async requestApproval() {
          return 'allow_once';
        },
      },
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

describe('ToolExecutor telemetry and hooks', () => {
  it('records the duration of one tool call on its result', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValueOnce(100).mockReturnValueOnce(112);
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: 'echo',
        description: 'Echo input.',
        metadata: { permissions: ['fs:read'] },
        parameters: { type: 'object', properties: {} },
        async execute() {
          return 'ok';
        },
      }),
    );
    const executor = new ToolExecutor({
      tools,
      hooks: new HookRegistry(),
      rootDir: process.cwd(),
    });

    try {
      await expect(
        executor.executeOne({ type: 'tool_use', id: 'call_duration', name: 'echo', input: {} }),
      ).resolves.toMatchObject({ durationMs: 12 });
    } finally {
      now.mockRestore();
    }
  });

  it('runs before hooks in registration order and passes modified input to later hooks', async () => {
    const seen: number[] = [];
    const hooks = new HookRegistry();
    hooks.on('tool:before', async (_ctx, call) => {
      seen.push(call.input.value as number);
      return { action: 'modify', input: { value: 2 } };
    });
    hooks.on('tool:before', async (_ctx, call) => {
      seen.push(call.input.value as number);
      return { action: 'continue' };
    });
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: 'echo',
        description: 'Echo input.',
        metadata: { permissions: ['fs:read'] },
        parameters: { type: 'object', properties: {} },
        async execute(input) {
          return input;
        },
      }),
    );
    const executor = new ToolExecutor({ tools, hooks, rootDir: process.cwd() });

    const result = await executor.executeOne({
      type: 'tool_use',
      id: 'call_hooks',
      name: 'echo',
      input: { value: 1 },
    });

    expect(seen).toEqual([1, 2]);
    expect(JSON.parse(result.content)).toEqual({ value: 2 });
  });

  it('short-circuits later hooks and tool execution when a before hook skips the call', async () => {
    const events: string[] = [];
    const hooks = new HookRegistry();
    hooks.on('tool:before', async () => {
      events.push('first');
      return { action: 'skip', result: 'blocked', isError: true };
    });
    hooks.on('tool:before', async () => {
      events.push('second');
      return { action: 'continue' };
    });
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: 'dangerous',
        description: 'Must not execute.',
        parameters: { type: 'object', properties: {} },
        async execute() {
          events.push('execute');
          return 'unexpected';
        },
      }),
    );
    const executor = new ToolExecutor({ tools, hooks, rootDir: process.cwd() });

    const result = await executor.executeOne({
      type: 'tool_use',
      id: 'call_skip',
      name: 'dangerous',
      input: {},
    });

    expect(events).toEqual(['first']);
    expect(result).toMatchObject({ content: 'blocked', isError: true });
    expect(typeof result.durationMs).toBe('number');
  });

  it('runs after hooks in registration order after the tool result is available', async () => {
    const events: string[] = [];
    const hooks = new HookRegistry();
    hooks.on('tool:after', async (_ctx, _call, result) => {
      events.push(`first:${result.output}`);
    });
    hooks.on('tool:after', async (_ctx, _call, result) => {
      events.push(`second:${result.output}`);
    });
    const tools = new ToolRegistry();
    tools.register(
      defineTool({
        name: 'echo',
        description: 'Echo output.',
        metadata: { permissions: ['fs:read'] },
        parameters: { type: 'object', properties: {} },
        async execute() {
          events.push('execute');
          return 'ok';
        },
      }),
    );
    const executor = new ToolExecutor({ tools, hooks, rootDir: process.cwd() });

    await executor.executeOne({ type: 'tool_use', id: 'call_after', name: 'echo', input: {} });

    expect(events).toEqual(['execute', 'first:ok', 'second:ok']);
  });
});
