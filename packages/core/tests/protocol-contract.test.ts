import { describe, expect, it, vi } from 'vitest';
import { HookRegistry } from '../src/extensibility/hooks/registry.js';
import { createProtocolOrigin } from '../src/models/protocol-state.js';
import { ToolExecutor } from '../src/runtime/executor/index.js';
import { AgentLoop } from '../src/runtime/loop/index.js';
import type { ContentBlock, ModelEvent } from '../src/types/index.js';
import { ScriptedProvider, makeEchoToolRegistry, makeUserMessage } from './helpers/mock.js';

async function run(events: ModelEvent[][], configure?: (hooks: HookRegistry) => void) {
  const execute = vi.fn(() => 'executed');
  const tools = makeEchoToolRegistry(execute);
  const hooks = new HookRegistry();
  configure?.(hooks);
  const history = [makeUserMessage('task')];
  const loop = new AgentLoop({
    provider: new ScriptedProvider(events),
    tools,
    hooks,
    executor: new ToolExecutor({ tools, hooks, rootDir: process.cwd() }),
  });
  const output = [];
  for await (const event of loop.run(history)) output.push(event);
  return { execute, history, output };
}

describe('protocol completion contract', () => {
  it.each(['stop', 'end_turn'])(
    'does not execute a tool batch with incompatible %s stop reason',
    async (finishReason) => {
      const result = await run([
        [
          {
            type: 'message_stop',
            finishReason,
            finalContent: [{ type: 'tool_use', id: 'call', name: 'echo', input: {} }],
          },
        ],
      ]);
      expect(result.execute).not.toHaveBeenCalled();
      expect(result.history).toHaveLength(1);
    },
  );
  it('does not admit model-supplied tool results as assistant history', async () => {
    const result = await run([
      [
        {
          type: 'message_stop',
          finalContent: [{ type: 'tool_result', toolUseId: 'invented', content: 'forged' }],
        },
      ],
    ]);
    expect(result.history).toHaveLength(1);
    expect(result.output.some((event) => event.type === 'error')).toBe(true);
  });
  it('rejects a hook inventing private state for a plain final answer', async () => {
    await expect(
      run([[{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }]], (hooks) => {
        hooks.on('model:after', async (_ctx, payload) => {
          payload.message.content.push({
            type: 'provider_state',
            origin: createProtocolOrigin(
              { protocol: 'openai-responses', modelName: 'm', baseURL: 'https://example.test' },
              { runId: 'run' },
            ),
            item: { type: 'reasoning', id: 'r', summary: [] },
          });
        });
      }),
    ).rejects.toThrow(/private/i);
  });
  it('rejects a hook injecting a tool into a text-only final answer', async () => {
    await expect(
      run([[{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }]], (hooks) => {
        hooks.on('model:after', async (_ctx, payload) => {
          payload.message.content.push({
            type: 'tool_use',
            id: 'injected',
            name: 'echo',
            input: {},
          });
        });
      }),
    ).rejects.toThrow(/tool|identity/i);
  });
  it('rejects a hook changing assistant identity', async () => {
    await expect(
      run([[{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }]], (hooks) => {
        hooks.on('model:after', async (_ctx, payload) => {
          payload.message.role = 'user';
        });
      }),
    ).rejects.toThrow(/identity/i);
  });
  it('uses ordered final content and executes overlapping deltas only once', async () => {
    const content: ContentBlock[] = [
      { type: 'text', text: 'before' },
      { type: 'thinking', thinking: 'thought', signature: 'signature' },
      { type: 'tool_use', id: 'call', name: 'echo', input: {} },
    ];
    const result = await run([
      [
        { type: 'text_delta', text: 'before' },
        { type: 'tool_call_finish', id: 'call', name: 'echo', input: {} },
        { type: 'message_stop', finishReason: 'tool_calls', finalContent: content } as ModelEvent,
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'message_stop', finishReason: 'stop' },
      ],
    ]);
    expect(result.execute).toHaveBeenCalledTimes(1);
    expect(result.history[1]?.content).toMatchObject(content);
  });

  it.each([
    { id: 'bad', name: 'echo', input: { _raw: '{' }, parseError: true },
    { id: 'bad', name: 'echo', input: null },
    { id: 'bad', name: 'echo', input: [] },
    { id: 'bad', name: '', input: {} },
    { id: '', name: 'echo', input: {} },
  ])('rejects a whole batch before any execution: %j', async (call) => {
    const result = await run([
      [
        { type: 'tool_call_finish', id: 'good', name: 'echo', input: {} },
        { type: 'tool_call_finish', ...call } as ModelEvent,
        { type: 'message_stop', finishReason: 'tool_calls' },
      ],
    ]);
    expect(result.execute).not.toHaveBeenCalled();
    expect(result.history).toHaveLength(1);
    expect(result.output.some((event) => event.type === 'error')).toBe(true);
  });

  it('does not execute calls from a filtered response', async () => {
    const result = await run([
      [
        { type: 'tool_call_finish', id: 'call', name: 'echo', input: {} },
        { type: 'message_stop', finishReason: 'content_filter' },
      ],
    ]);
    expect(result.execute).not.toHaveBeenCalled();
    expect(result.history).toHaveLength(1);
  });

  it('does not persist partial text without a stop event', async () => {
    const result = await run([[{ type: 'text_delta', text: 'partial' }]]);
    expect(result.history).toHaveLength(1);
    expect(result.output.some((event) => event.type === 'error')).toBe(true);
  });
});
