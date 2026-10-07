import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  OpenAICompatibleProvider,
  type OpenAIProviderOptions,
} from '../src/models/openai-compatible/index.js';
import type { ModelEvent } from '../src/types/index.js';

const options = { baseURL: 'https://gateway.example/v1', apiKey: 'test-key', modelName: 'test' };
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const delta = (value: unknown, finishReason?: string) =>
  frame({ choices: [{ delta: value, finish_reason: finishReason }] });
const tool = (
  argumentsText = '{}',
  id: string | undefined = 'call_1',
  name: string | undefined = 'echo',
  index = 0,
) => ({ index, id, function: { name, arguments: argumentsText } });

function response(chunks: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, body } as Response));
}

async function collect(
  chunks: string[],
  overrides: Partial<OpenAIProviderOptions> = {},
  events: ModelEvent[] = [],
) {
  response(chunks);
  for await (const event of new OpenAICompatibleProvider({ ...options, ...overrides }).create({
    messages: [],
  }))
    events.push(event);
  return events;
}

afterEach(() => vi.unstubAllGlobals());

describe('Chat completion contract', () => {
  it.each([
    ['finish reason without DONE', [delta({ tool_calls: [tool()] }, 'tool_calls')]],
    ['DONE without finish reason', [delta({ tool_calls: [tool()] }), 'data: [DONE]\n\n']],
    ['ordinary EOF', [delta({ content: 'partial' })]],
    ['filtered output', [delta({ tool_calls: [tool()] }, 'content_filter'), 'data: [DONE]\n\n']],
    ['unknown termination', [delta({ tool_calls: [tool()] }, 'future_reason'), 'data: [DONE]\n\n']],
    ['wrong tool termination', [delta({ tool_calls: [tool()] }, 'stop'), 'data: [DONE]\n\n']],
    ['empty tool termination', [delta({}, 'tool_calls'), 'data: [DONE]\n\n']],
  ])('rejects %s before any executable success event', async (_label, chunks) => {
    const events: ModelEvent[] = [];
    await expect(collect(chunks, {}, events)).rejects.toMatchObject({
      name: 'ModelError',
      stage: 'stream',
      retryable: false,
    });
    expect(
      events.some((event) => event.type === 'tool_call_finish' || event.type === 'message_stop'),
    ).toBe(false);
  });

  it('delivers truncation like the other protocols and lets the loop refuse tool execution', async () => {
    const events = await collect([delta({ tool_calls: [tool()] }, 'length'), 'data: [DONE]\n\n']);
    expect(events.at(-1)).toMatchObject({ type: 'message_stop', finishReason: 'length' });
    expect(
      await collect([delta({ content: 'partial answer' }, 'length'), 'data: [DONE]\n\n']),
    ).toMatchObject([expect.anything(), { type: 'message_stop', finishReason: 'length' }]);
  });

  it('allows a verified gateway to omit DONE only with a valid finish reason', async () => {
    const events = await collect([delta({ tool_calls: [tool()] }, 'tool_calls')], {
      chatCapabilities: { requiresDone: false },
    });
    expect(events).toContainEqual({
      type: 'tool_call_finish',
      id: 'call_1',
      name: 'echo',
      input: {},
    });
    expect(events.at(-1)).toMatchObject({ type: 'message_stop', finishReason: 'tool_calls' });
    await expect(
      collect([delta({ content: 'partial' })], { chatCapabilities: { requiresDone: false } }),
    ).rejects.toMatchObject({ code: 'MODEL_STREAM_INCOMPLETE' });
  });

  it.each(['{"broken":', '[]', 'null', 'true', '17', '"text"'])(
    'rejects nonobject or malformed arguments %s atomically',
    async (argumentsText) => {
      const events: ModelEvent[] = [];
      await expect(
        collect(
          [
            delta(
              {
                tool_calls: [
                  tool('{}', 'valid', 'echo'),
                  tool(argumentsText, 'invalid', 'echo', 1),
                ],
              },
              'tool_calls',
            ),
            'data: [DONE]\n\n',
          ],
          {},
          events,
        ),
      ).rejects.toMatchObject({ code: 'MODEL_INVALID_RESPONSE' });
      expect(
        events.some((event) => event.type === 'tool_call_finish' || event.type === 'message_stop'),
      ).toBe(false);
    },
  );

  it.each([
    { index: 0, function: { name: 'echo', arguments: '{}' } },
    { index: 0, id: 'call_1', function: { arguments: '{}' } },
    tool('{}', '', 'echo'),
    tool('{}', 'call_1', ''),
  ])('rejects incomplete tool identity %# without inventing IDs', async (call) => {
    const events: ModelEvent[] = [];
    await expect(
      collect([delta({ tool_calls: [call] }, 'tool_calls'), 'data: [DONE]\n\n'], {}, events),
    ).rejects.toMatchObject({ code: 'MODEL_INVALID_RESPONSE' });
    expect(events).toEqual([]);
  });

  it('buffers arguments until delayed ID and name are complete, keeping one stable identity', async () => {
    const events = await collect([
      delta({ tool_calls: [{ index: 0, function: { arguments: '{"value":' } }] }),
      delta({ tool_calls: [{ index: 0, id: 'delayed', function: { arguments: '1' } }] }),
      delta(
        { tool_calls: [{ index: 0, function: { name: 'echo', arguments: '}' } }] },
        'tool_calls',
      ),
      'data: [DONE]\n\n',
    ]);
    expect(events.slice(0, 5)).toEqual([
      { type: 'tool_call_start', id: 'delayed', name: 'echo' },
      { type: 'tool_call_delta', id: 'delayed', argumentChunk: '{"value":' },
      { type: 'tool_call_delta', id: 'delayed', argumentChunk: '1' },
      { type: 'tool_call_delta', id: 'delayed', argumentChunk: '}' },
      { type: 'tool_call_finish', id: 'delayed', name: 'echo', input: { value: 1 } },
    ]);
  });

  it('rejects duplicate or changed tool identities before completion', async () => {
    await expect(
      collect([
        delta({ tool_calls: [tool()] }),
        delta({ tool_calls: [tool('', 'changed')] }, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    ).rejects.toMatchObject({ code: 'MODEL_INVALID_RESPONSE' });
    await expect(
      collect([
        delta({ tool_calls: [tool(), tool('{}', 'call_1', 'echo', 1)] }, 'tool_calls'),
        'data: [DONE]\n\n',
      ]),
    ).rejects.toMatchObject({ code: 'MODEL_INVALID_RESPONSE' });
  });

  it('rejects a named SSE error after terminal choice before DONE', async () => {
    const events: ModelEvent[] = [];
    await expect(
      collect(
        [
          delta({ tool_calls: [tool()] }, 'tool_calls'),
          `event: error\n${frame({ message: 'gateway failed', code: 'server_error' })}`,
          'data: [DONE]\n\n',
        ],
        {},
        events,
      ),
    ).rejects.toMatchObject({ name: 'ModelError', providerCode: 'server_error', stage: 'stream' });
    expect(
      events.some((event) => event.type === 'tool_call_finish' || event.type === 'message_stop'),
    ).toBe(false);
  });

  it.each([null, 42, {}])(
    'rejects nonstring argument deltas %# without executing an empty object',
    async (argumentsValue) => {
      const call = {
        index: 0,
        id: 'call_1',
        function: { name: 'echo', arguments: argumentsValue },
      };
      await expect(
        collect([delta({ tool_calls: [call] }, 'tool_calls'), 'data: [DONE]\n\n']),
      ).rejects.toMatchObject({ code: 'MODEL_INVALID_RESPONSE' });
    },
  );

  it('does not send native private blocks to ordinary Chat and permits an explicit DeepSeek replay override', async () => {
    for (const baseURL of ['https://api.openai.com/v1', 'https://api.deepseek.com/v1']) {
      response([delta({ content: 'answer' }, 'stop'), 'data: [DONE]\n\n']);
      const provider = new OpenAICompatibleProvider({
        ...options,
        baseURL,
        replayReasoningContent: true,
        chatCapabilities: { replayReasoningContent: false },
      });
      for await (const _event of provider.create({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'prior' },
              { type: 'thinking', thinking: 'private thinking', signature: 'private signature' },
              { type: 'redacted_thinking', data: 'private redacted' },
              {
                type: 'provider_state',
                origin: {
                  version: 1,
                  protocol: 'openai-responses',
                  modelName: 'native',
                  runId: 'prior-run',
                  endpointScope: 'prior-endpoint',
                },
                item: {
                  type: 'reasoning',
                  id: 'reasoning_1',
                  encrypted_content: 'private encrypted item',
                  summary: [],
                },
              },
            ],
          },
        ],
      })) {
      }
      const payload = JSON.parse(String(vi.mocked(fetch).mock.calls[0]?.[1]?.body));
      expect(payload.messages).toEqual([{ role: 'assistant', content: 'prior' }]);
      expect(JSON.stringify(payload)).not.toContain('private');
    }
  });

  it('awaits reader cancellation and aborts the request when the consumer ends iteration', async () => {
    let cancellationFinished = false;
    let signal: AbortSignal | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(delta({ content: 'first' })));
      },
      async cancel() {
        await Promise.resolve();
        cancellationFinished = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (_url, init) => {
        signal = init.signal;
        return { ok: true, body } as Response;
      }),
    );
    const iterator = new OpenAICompatibleProvider(options)
      .create({ messages: [] })
      [Symbol.asyncIterator]();
    expect((await iterator.next()).value).toMatchObject({ type: 'text_delta', text: 'first' });
    await iterator.return?.();
    expect(cancellationFinished).toBe(true);
    expect(body.locked).toBe(false);
    expect(signal?.aborted).toBe(true);
  });

  it('keeps cache usage arriving after terminal choice and before DONE', async () => {
    const events = await collect([
      delta({ content: 'answer' }, 'stop'),
      frame({
        choices: [],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 5,
          total_tokens: 25,
          prompt_cache_hit_tokens: 12,
        },
      }),
      'data: [DONE]\n\n',
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'message_stop',
      usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25, cachedPromptTokens: 12 },
    });
  });

  it.each([
    [{}, 'max_tokens', true, true],
    [
      {
        maxTokensField: 'max_completion_tokens',
        supportsStreamingUsage: false,
        supportsTemperature: false,
      },
      'max_completion_tokens',
      false,
      false,
    ],
  ] as const)(
    'uses explicit request capabilities %#',
    async (chatCapabilities, field, usage, temperature) => {
      response([delta({ content: 'answer' }, 'stop'), 'data: [DONE]\n\n']);
      const provider = new OpenAICompatibleProvider({ ...options, chatCapabilities });
      for await (const _event of provider.create({
        messages: [],
        maxTokens: 100,
        temperature: 0.2,
      })) {
      }
      const request = vi.mocked(fetch).mock.calls[0];
      const payload = JSON.parse(String(request?.[1]?.body));
      expect(request?.[0]).toBe('https://gateway.example/v1/chat/completions');
      expect(payload[field]).toBe(100);
      expect(
        payload[field === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'],
      ).toBeUndefined();
      expect(payload.stream_options).toEqual(usage ? { include_usage: true } : undefined);
      expect(payload.temperature).toEqual(temperature ? 0.2 : undefined);
    },
  );
});
