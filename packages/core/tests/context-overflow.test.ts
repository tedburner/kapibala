import { afterEach, describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../src/capabilities/tools/registry.js';
import { ContextOverflowError, ModelError } from '../src/errors/index.js';
import { HookRegistry } from '../src/extensibility/hooks/registry.js';
import { AnthropicProvider } from '../src/models/anthropic/index.js';
import { OpenAICompatibleProvider } from '../src/models/openai-compatible/index.js';
import { ToolExecutor } from '../src/runtime/executor/index.js';
import { AgentLoop } from '../src/runtime/loop/index.js';
import type { ModelEvent, ModelRequest } from '../src/types/index.js';

afterEach(() => vi.unstubAllGlobals());
const request: ModelRequest = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'old' }], timestamp: 0 }],
};

describe('explicit context overflow', () => {
  it('recovers an Anthropic HTTP overflow through one shorter request before any output', async () => {
    const response = [
      { type: 'message_start', message: { id: 'm', role: 'assistant', content: [] } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'done' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ];
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              type: 'invalid_request_error',
              message: 'prompt is too long: 210000 tokens > 200000 maximum',
            },
          }),
          { status: 400 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(response.map((value) => `data: ${JSON.stringify(value)}\n\n`).join('')),
      );
    vi.stubGlobal('fetch', fetch);
    const provider = new AnthropicProvider({
      baseURL: 'https://test.invalid/v1',
      apiKey: 'test',
      modelName: 'claude',
    });
    const tools = new ToolRegistry();
    const hooks = new HookRegistry();
    const loop = new AgentLoop({
      provider,
      tools,
      hooks,
      executor: new ToolExecutor({ tools, hooks, rootDir: process.cwd() }),
      async *prepareRequest(candidate, _history, reason) {
        yield* [];
        return reason === 'overflow'
          ? {
              ...candidate,
              messages: [{ role: 'user', content: [{ type: 'text', text: 'short' }] }],
            }
          : candidate;
      },
    });
    const history = structuredClone(request.messages);
    const events = [];
    for await (const event of loop.run(history)) events.push(event);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1].body).messages[0].content[0].text).toBe('short');
    expect(history.at(-1)?.content).toEqual([{ type: 'text', text: 'done' }]);
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('rejects unmarked EOF before exposing a partial tool call', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"write_file","arguments":"{}"}}]}}]}\n',
          ),
        ),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://test.invalid',
      apiKey: 'test',
      modelName: 'test',
    });
    const events: ModelEvent[] = [];
    await expect(async () => {
      for await (const event of provider.create(request)) events.push(event);
    }).rejects.toBeInstanceOf(ModelError);
    expect(
      events.some((event) => event.type === 'tool_call_finish' || event.type === 'message_stop'),
    ).toBe(false);
  });
  it.each([400, 413, 422])('classifies explicit HTTP %i codes', async (status) => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: { code: 'context_length_exceeded' } }), { status }),
        ),
    );
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://test.invalid',
      apiKey: 'test',
      modelName: 'test',
    });
    await expect(async () => {
      for await (const _ of provider.create(request)) {
      }
    }).rejects.toBeInstanceOf(ContextOverflowError);
  });
  it('keeps authentication and generic 400 errors out of compaction', async () => {
    for (const status of [400, 401]) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              error: {
                message: 'context length exceeded',
                code: status === 401 ? 'context_length_exceeded' : 'invalid_request',
              },
            }),
            { status },
          ),
        ),
      );
      const provider = new OpenAICompatibleProvider({
        baseURL: 'https://test.invalid',
        apiKey: 'test',
        modelName: 'test',
      });
      try {
        for await (const _ of provider.create(request)) {
        }
      } catch (error) {
        expect(error).toBeInstanceOf(ModelError);
        expect(error).not.toBeInstanceOf(ContextOverflowError);
      }
    }
  });
  it('delivers length-truncated output to the loop gate and passes explicit overflow through', async () => {
    const provider = new OpenAICompatibleProvider({
      baseURL: 'https://test.invalid',
      apiKey: 'test',
      modelName: 'test',
    });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\ndata: [DONE]\n',
          ),
        ),
    );
    // 截断语义三协议一致：length 交付到 Loop，由其统一裁决（无工具交付、有工具拒绝）。
    const events: ModelEvent[] = [];
    for await (const event of provider.create(request)) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'message_stop', finishReason: 'length' });
    expect(events.some((event) => event.type === 'tool_call_finish')).toBe(false);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('data: {"error":{"code":"context_length_exceeded"}}\n')),
    );
    await expect(async () => {
      for await (const _ of provider.create(request)) {
      }
    }).rejects.toBeInstanceOf(ContextOverflowError);
  });
  it.each([false, true])('retries only before output (partial=%s)', async (partial) => {
    let calls = 0;
    let preparations = 0;
    const provider = {
      name: 'script',
      async *create(): AsyncIterable<ModelEvent> {
        calls++;
        if (calls === 1) {
          if (partial) yield { type: 'text_delta', text: 'partial' };
          throw new ContextOverflowError();
        }
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'message_stop' };
      },
      assembleToolResults: () => [],
    };
    const tools = new ToolRegistry();
    const hooks = new HookRegistry();
    const loop = new AgentLoop({
      provider,
      tools,
      hooks,
      executor: new ToolExecutor({ tools, hooks, rootDir: process.cwd() }),
      async *prepareRequest(candidate, _history, reason) {
        yield* [];
        if (reason === 'overflow') {
          preparations++;
          return {
            ...candidate,
            messages: [{ role: 'user', content: [{ type: 'text', text: 'short' }], timestamp: 0 }],
          };
        }
        return candidate;
      },
    });
    const history = structuredClone(request.messages);
    const events = [];
    for await (const event of loop.run(history)) events.push(event);
    expect(calls).toBe(partial ? 1 : 2);
    expect(preparations).toBe(partial ? 0 : 1);
    expect(history).toHaveLength(partial ? 1 : 2);
  });
  it('does not resend an unchanged request or retry twice', async () => {
    let calls = 0;
    const provider = {
      name: 'script',
      async *create(): AsyncIterable<ModelEvent> {
        yield* [];
        calls++;
        throw new ContextOverflowError();
      },
      assembleToolResults: () => [],
    };
    const tools = new ToolRegistry();
    const hooks = new HookRegistry();
    const loop = new AgentLoop({
      provider,
      tools,
      hooks,
      executor: new ToolExecutor({ tools, hooks, rootDir: process.cwd() }),
      async *prepareRequest(candidate) {
        yield* [];
        return candidate;
      },
    });
    for await (const _ of loop.run(structuredClone(request.messages))) {
    }
    expect(calls).toBe(1);
  });
  it.each(['message_stop', 'thinking_block_start'] as const)(
    'does not retry overflow after a %s boundary',
    async (type) => {
      let calls = 0;
      const provider = {
        name: 'final-only',
        async *create(): AsyncIterable<ModelEvent> {
          calls++;
          yield type === 'message_stop'
            ? { type, finalContent: [{ type: 'text', text: 'done' }] }
            : { type, blockId: 'thinking' };
          throw new ContextOverflowError();
        },
        assembleToolResults: () => [],
      };
      const tools = new ToolRegistry();
      const hooks = new HookRegistry();
      const loop = new AgentLoop({
        provider,
        tools,
        hooks,
        executor: new ToolExecutor({ tools, hooks, rootDir: process.cwd() }),
        async *prepareRequest(candidate, _history, reason) {
          yield* [];
          return reason === 'overflow' ? { ...candidate, messages: [] } : candidate;
        },
      });
      for await (const _ of loop.run(structuredClone(request.messages))) {
        /* consume */
      }
      expect(calls).toBe(1);
    },
  );
});
