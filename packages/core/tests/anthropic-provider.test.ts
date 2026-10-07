import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../src/context/session/index.js';
import { ContextOverflowError } from '../src/errors/index.js';
import { AnthropicProvider } from '../src/models/anthropic/index.js';
import { createProtocolOrigin } from '../src/models/protocol-state.js';
import type { CanonicalMessage, ModelEvent, ModelRequest } from '../src/types/index.js';

const options = {
  baseURL: 'https://example.test/v1/',
  apiKey: 'fixture-key',
  modelName: 'claude-fixture',
};
const request: ModelRequest = {
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  context: { runId: 'run-fixture', modelId: 'claude' },
};
const event = (type: string, fields: Record<string, unknown> = {}) => ({ type, ...fields });
const start = (usage?: Record<string, number>) =>
  event('message_start', {
    message: { id: 'msg_fixture', type: 'message', role: 'assistant', content: [], usage },
  });
const blockStart = (index: number, content_block: Record<string, unknown>) =>
  event('content_block_start', { index, content_block });
const delta = (index: number, delta: Record<string, unknown>) =>
  event('content_block_delta', { index, delta });
const blockStop = (index: number) => event('content_block_stop', { index });
const finish = (reason = 'end_turn', usage?: Record<string, number>) => [
  event('message_delta', { delta: { stop_reason: reason }, usage }),
  event('message_stop'),
];
const textResponse = () => [
  start(),
  blockStart(0, { type: 'text', text: '' }),
  delta(0, { type: 'text_delta', text: 'done' }),
  blockStop(0),
  ...finish(),
];

function mockResponse(events: Record<string, unknown>[]) {
  const wire = events
    .map((value) => `event: ${value.type ?? 'message'}\ndata: ${JSON.stringify(value)}\n\n`)
    .join('');
  const fetch = vi.fn(
    async () => new Response(wire, { headers: { 'Content-Type': 'text/event-stream' } }),
  );
  vi.stubGlobal('fetch', fetch);
  return fetch;
}

async function collect(provider: AnthropicProvider, req = request): Promise<ModelEvent[]> {
  const values: ModelEvent[] = [];
  for await (const value of provider.create(req)) values.push(value);
  return values;
}

afterEach(() => vi.unstubAllGlobals());

describe('Anthropic Messages requests', () => {
  it('uses Messages, version, workspace, native tools and effective max_tokens', async () => {
    const fetch = mockResponse(textResponse());
    const provider = new AnthropicProvider({ ...options, workspaceId: 'wrkspc_fixture' });
    await collect(provider, {
      ...request,
      systemPrompt: 'system',
      maxTokens: 16384,
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/messages');
    expect(init.headers).toMatchObject({
      'x-api-key': 'fixture-key',
      Authorization: 'Bearer fixture-key',
      'anthropic-version': '2023-06-01',
      'anthropic-workspace-id': 'wrkspc_fixture',
    });
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'claude-fixture',
      system: 'system',
      max_tokens: 16384,
      stream: true,
      tools: [{ name: 'read', description: 'read a file', input_schema: { type: 'object' } }],
    });
    expect(JSON.parse(init.body as string)).not.toHaveProperty('thinking');
    expect(provider.binding).toEqual({
      protocol: 'anthropic',
      baseURL: 'https://example.test/v1',
      modelName: 'claude-fixture',
      workspaceId: 'wrkspc_fixture',
    });
  });

  it('projects canonical results into the next user message before ordinary text without mutating history', async () => {
    const fetch = mockResponse(textResponse());
    const provider = new AnthropicProvider(options);
    const results = provider.assembleToolResults([
      { type: 'tool_result', toolUseId: 'tool_one', content: 'first' },
      { type: 'tool_result', toolUseId: 'tool_two', content: 'second', isError: true },
    ]);
    const messages: CanonicalMessage[] = [
      ...request.messages,
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool_one', name: 'read', input: {} },
          { type: 'tool_use', id: 'tool_two', name: 'read', input: {} },
        ],
      },
      ...results,
      { role: 'user', content: [{ type: 'text', text: 'continue' }] },
    ];
    const original = structuredClone(messages);
    await collect(provider, { ...request, messages });
    const payload = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(results.map((value) => value.role)).toEqual(['tool', 'tool']);
    expect(payload.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'tool_one', content: 'first' },
        { type: 'tool_result', tool_use_id: 'tool_two', content: 'second', is_error: true },
        { type: 'text', text: 'continue' },
      ],
    });
    expect(messages).toEqual(original);
    expect(payload.max_tokens).toBe(4096);
  });

  it('replays private blocks only with matching run/model/endpoint/workspace provenance', async () => {
    const provider = new AnthropicProvider(options);
    const origin = createProtocolOrigin(provider.binding, request.context);
    const messages: CanonicalMessage[] = [
      ...request.messages,
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'visible', signature: 'signed-private', origin },
          { type: 'redacted_thinking', data: 'cipher-private', origin },
          { type: 'tool_use', id: 'tool_one', name: 'read', input: {} },
        ],
      },
      ...provider.assembleToolResults([
        { type: 'tool_result', toolUseId: 'tool_one', content: 'result' },
      ]),
    ];
    for (const context of [request.context, { runId: 'other', modelId: 'claude' }, undefined]) {
      const fetch = mockResponse(textResponse());
      await collect(provider, { ...request, messages, context });
      const payload = JSON.parse(
        (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
      );
      if (context === request.context)
        expect(payload.messages[1].content.slice(0, 2)).toEqual([
          { type: 'thinking', thinking: 'visible', signature: 'signed-private' },
          { type: 'redacted_thinking', data: 'cipher-private' },
        ]);
      else {
        expect(payload.messages[1].content[0]).toEqual({ type: 'text', text: 'visible' });
        expect(JSON.stringify(payload)).not.toContain('private');
      }
    }
  });

  it.each([0, -1, 1.2, Number.NaN])(
    'rejects invalid maxTokens %s before connecting',
    async (maxTokens) => {
      const fetch = mockResponse(textResponse());
      await expect(
        collect(new AnthropicProvider(options), { ...request, maxTokens }),
      ).rejects.toMatchObject({ stage: 'request' });
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it('maps an incompatible persisted ID consistently for calls and results', async () => {
    const fetch = mockResponse(textResponse());
    const provider = new AnthropicProvider(options);
    const id = 'cross.protocol:id/with spaces';
    await collect(provider, {
      ...request,
      messages: [
        ...request.messages,
        { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read', input: {} }] },
        ...provider.assembleToolResults([
          { type: 'tool_result', toolUseId: id, content: 'result' },
        ]),
      ],
    });
    const payload = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(payload.messages[1].content[0].id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(payload.messages[2].content[0].tool_use_id).toBe(payload.messages[1].content[0].id);
  });

  it.each([
    { modelName: 'other' },
    { baseURL: 'https://other.test/v1' },
    { workspaceId: 'wrkspc_other' },
  ])('drops private replay after target change %s', async (change) => {
    const provider = new AnthropicProvider(options);
    const origin = createProtocolOrigin(provider.binding, request.context);
    const fetch = mockResponse(textResponse());
    await collect(new AnthropicProvider({ ...options, ...change }), {
      ...request,
      messages: [
        ...request.messages,
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'visible', signature: 'private', origin },
            { type: 'redacted_thinking', data: 'private', origin },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    });
    const payload = JSON.parse(
      (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body as string,
    );
    expect(payload.messages[1].content).toEqual([
      { type: 'text', text: 'visible' },
      { type: 'text', text: 'answer' },
    ]);
  });

  it('rejects malformed provenance before HTTP rather than relabeling signed history', async () => {
    const provider = new AnthropicProvider(options);
    const origin = {
      ...createProtocolOrigin(provider.binding, request.context),
      endpointScope: 'invalid',
    };
    const fetch = mockResponse(textResponse());
    await expect(
      collect(provider, {
        ...request,
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: 'visible', signature: 'private', origin }],
          },
        ],
      }),
    ).rejects.toMatchObject({ stage: 'request' });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('Anthropic ordered streaming', () => {
  it('preserves thinking signatures/redacted/text/multiple tools in block order and counts cache input correctly', async () => {
    mockResponse([
      start({
        input_tokens: 10,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 30,
        output_tokens: 1,
      }),
      blockStart(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'thinking_delta', thinking: 'consider' }),
      delta(0, { type: 'signature_delta', signature: 'sig-' }),
      delta(0, { type: 'signature_delta', signature: 'tail' }),
      blockStop(0),
      blockStart(1, { type: 'redacted_thinking', data: 'hidden' }),
      blockStop(1),
      blockStart(2, { type: 'text', text: '' }),
      delta(2, { type: 'text_delta', text: 'reading' }),
      blockStop(2),
      blockStart(3, { type: 'tool_use', id: 'tool_one', name: 'read', input: {} }),
      delta(3, { type: 'input_json_delta', partial_json: '{"path":' }),
      delta(3, { type: 'input_json_delta', partial_json: '"a"}' }),
      blockStop(3),
      blockStart(4, { type: 'tool_use', id: 'tool_two', name: 'read', input: {} }),
      delta(4, { type: 'input_json_delta', partial_json: '{"path":"b"}' }),
      blockStop(4),
      event('message_delta', { delta: { stop_reason: null }, usage: { output_tokens: 5 } }),
      ...finish('tool_use', { output_tokens: 9 }),
    ]);
    const provider = new AnthropicProvider(options);
    const values = await collect(provider);
    const stop = values.at(-1);
    const origin = createProtocolOrigin(provider.binding, request.context);
    expect(stop).toMatchObject({
      type: 'message_stop',
      finishReason: 'tool_calls',
      usage: { promptTokens: 60, completionTokens: 9, totalTokens: 69, cachedPromptTokens: 20 },
      finalContent: [
        { type: 'thinking', thinking: 'consider', signature: 'sig-tail', origin },
        { type: 'redacted_thinking', data: 'hidden', origin },
        { type: 'text', text: 'reading' },
        { type: 'tool_use', id: 'tool_one', name: 'read', input: { path: 'a' } },
        { type: 'tool_use', id: 'tool_two', name: 'read', input: { path: 'b' } },
      ],
    });
    const thinking = values.filter((value) => value.type.startsWith('thinking'));
    expect(thinking).toEqual([
      { type: 'thinking_block_start', blockId: expect.any(String) },
      { type: 'thinking_delta', thinking: 'consider', blockId: expect.any(String) },
      { type: 'thinking_block_stop', blockId: expect.any(String) },
    ]);
    expect(
      new Set(thinking.map((value) => ('blockId' in value ? value.blockId : undefined))).size,
    ).toBe(1);
    expect(values.filter((value) => value.type === 'tool_call_finish')).toHaveLength(2);
    expect(JSON.stringify(values.filter((value) => value.type !== 'message_stop'))).not.toContain(
      'sig-tail',
    );
  });

  it('retains signed omitted thinking without fake visible deltas and leaves missing usage unknown', async () => {
    mockResponse([
      start(),
      blockStart(0, { type: 'thinking', thinking: '' }),
      delta(0, { type: 'signature_delta', signature: 'signature' }),
      blockStop(0),
      ...finish(),
    ]);
    const values = await collect(new AnthropicProvider(options));
    expect(values.some((value) => value.type === 'thinking_delta')).toBe(false);
    expect(values.at(-1)).toMatchObject({
      finalContent: [{ type: 'thinking', thinking: '', signature: 'signature' }],
    });
    expect(values.at(-1)).not.toHaveProperty('usage');
  });

  it.each(['max_tokens', 'model_context_window_exceeded'])(
    'maps truncation %s to length',
    async (reason) => {
      mockResponse([
        start(),
        blockStart(0, { type: 'tool_use', id: 'call_a', name: 'read', input: {} }),
        blockStop(0),
        ...finish(reason),
      ]);
      expect((await collect(new AnthropicProvider(options))).at(-1)).toMatchObject({
        finishReason: 'length',
      });
    },
  );

  it('rejects pause_turn without reporting a completed response', async () => {
    mockResponse([
      start(),
      blockStart(0, { type: 'text', text: '' }),
      delta(0, { type: 'text_delta', text: 'partial turn' }),
      blockStop(0),
      ...finish('pause_turn'),
    ]);
    await expect(collect(new AnthropicProvider(options))).rejects.toMatchObject({
      code: 'MODEL_INVALID_RESPONSE',
      stage: 'stream',
      retryable: false,
      providerCode: 'pause_turn',
    });
  });

  it('rejects pause_turn even when it includes a complete client tool call', async () => {
    mockResponse([
      start(),
      blockStart(0, { type: 'tool_use', id: 'call_a', name: 'read', input: {} }),
      blockStop(0),
      ...finish('pause_turn'),
    ]);
    await expect(collect(new AnthropicProvider(options))).rejects.toMatchObject({
      code: 'MODEL_INVALID_RESPONSE',
      providerCode: 'pause_turn',
    });
  });

  it.each([false, true])(
    'fails a paused session without executing client tools (tool included: %s)',
    async (withTool) => {
      const fetch = mockResponse([
        start(),
        blockStart(0, { type: 'text', text: 'Still working...' }),
        blockStop(0),
        ...(withTool
          ? [
              blockStart(1, { type: 'tool_use', id: 'call_a', name: 'read', input: {} }),
              blockStop(1),
            ]
          : []),
        ...finish('pause_turn'),
      ]);
      const session = new AgentSession({
        defaultProfile: {
          id: 'claude',
          name: 'Claude',
          provider: 'anthropic',
          modelName: options.modelName,
          baseURL: options.baseURL,
          apiKeyEnv: 'NONE',
          contextWindow: 128000,
        },
        defaultProvider: new AnthropicProvider(options),
        mode: 'Plan',
        eventLogger: { record: async () => {}, recordAudit: async () => {} } as never,
      });
      const execute = vi.fn(async () => 'read result');
      session.tools.register({
        name: 'read',
        description: 'Read fixture',
        parameters: { type: 'object' },
        metadata: { permissions: ['fs:read'] },
        execute,
      });
      try {
        for await (const _ of session.run('Read the fixture')) {
          /* consume */
        }
        expect(session.getLastRunMetrics()?.status).toBe('failed');
        expect(session.getHistory().map((message) => message.role)).toEqual(['user']);
        expect(execute).not.toHaveBeenCalled();
        expect(fetch).toHaveBeenCalledTimes(1);
      } finally {
        await session.destroy();
      }
    },
  );

  it('reports unsupported stop reasons with the provider code', async () => {
    mockResponse([
      start(),
      blockStart(0, { type: 'text', text: '' }),
      blockStop(0),
      ...finish('mystery_reason'),
    ]);
    await expect(collect(new AnthropicProvider(options))).rejects.toMatchObject({
      name: 'ModelError',
      stage: 'stream',
      retryable: false,
      providerCode: 'mystery_reason',
    });
  });

  it.each([
    ['missing message_stop', [start(), ...finish().slice(0, 1)]],
    ['delta without block', [start(), delta(0, { type: 'text_delta', text: 'bad' }), ...finish()]],
    [
      'duplicate block index',
      [
        start(),
        blockStart(0, { type: 'text', text: '' }),
        blockStart(0, { type: 'text', text: '' }),
        ...finish(),
      ],
    ],
    ['unclosed block', [start(), blockStart(0, { type: 'text', text: '' }), ...finish()]],
    ['out of order index', [start(), blockStart(1, { type: 'text', text: '' }), ...finish()]],
    [
      'delta type mismatch',
      [
        start(),
        blockStart(0, { type: 'text', text: '' }),
        delta(0, { type: 'input_json_delta', partial_json: '{}' }),
        blockStop(0),
        ...finish(),
      ],
    ],
    [
      'invalid tool JSON',
      [
        start(),
        blockStart(0, { type: 'tool_use', id: 'a', name: 'read', input: {} }),
        delta(0, { type: 'input_json_delta', partial_json: '{' }),
        blockStop(0),
        ...finish('tool_use'),
      ],
    ],
    [
      'nonobject tool JSON',
      [
        start(),
        blockStart(0, { type: 'tool_use', id: 'a', name: 'read', input: {} }),
        delta(0, { type: 'input_json_delta', partial_json: '[]' }),
        blockStop(0),
        ...finish('tool_use'),
      ],
    ],
    [
      'duplicate tool ID',
      [
        start(),
        blockStart(0, { type: 'tool_use', id: 'a', name: 'read', input: {} }),
        blockStop(0),
        blockStart(1, { type: 'tool_use', id: 'a', name: 'read', input: {} }),
        blockStop(1),
        ...finish('tool_use'),
      ],
    ],
    [
      'unsupported tool block',
      [
        start(),
        blockStart(0, { type: 'server_tool_use', id: 'a', name: 'web_search', input: {} }),
        blockStop(0),
        ...finish(),
      ],
    ],
    ['unknown stop reason', [start(), ...finish('unknown')]],
    [
      'missing thinking signature',
      [
        start(),
        blockStart(0, { type: 'thinking', thinking: 'visible' }),
        blockStop(0),
        ...finish(),
      ],
    ],
    [
      'thinking after signature',
      [
        start(),
        blockStart(0, { type: 'thinking', thinking: '' }),
        delta(0, { type: 'signature_delta', signature: 'sig' }),
        delta(0, { type: 'thinking_delta', thinking: 'late' }),
        blockStop(0),
        ...finish(),
      ],
    ],
    [
      'text stop containing tools',
      [
        start(),
        blockStart(0, { type: 'tool_use', id: 'a', name: 'read', input: {} }),
        blockStop(0),
        ...finish(),
      ],
    ],
    ['tool stop without tools', [start(), ...finish('tool_use')]],
    ['negative usage', [start({ input_tokens: -1, output_tokens: 0 }), ...finish()]],
    ['missing event type', [start(), {}, ...finish()]],
  ])('rejects %s before a completed response', async (_name, events) => {
    mockResponse(events as Record<string, unknown>[]);
    const values: ModelEvent[] = [];
    const run = async () => {
      for await (const value of new AnthropicProvider(options).create(request)) values.push(value);
    };
    await expect(run()).rejects.toMatchObject({ stage: 'stream' });
    expect(values.some((value) => value.type === 'message_stop')).toBe(false);
  });

  it('sanitizes SSE errors and preserves retry classification', async () => {
    mockResponse([
      start(),
      event('error', {
        error: { type: 'overloaded_error', message: 'private fixture-key prompt' },
      }),
    ]);
    await expect(collect(new AnthropicProvider(options))).rejects.toMatchObject({
      category: 'service',
      stage: 'stream',
      message: 'Anthropic stream failed',
    });
  });

  it('sanitizes HTTP authentication/workspace failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: { type: 'permission_error', message: 'private fixture-key workspace' },
            }),
            { status: 403 },
          ),
      ),
    );
    await expect(collect(new AnthropicProvider(options))).rejects.toMatchObject({
      category: 'authentication',
      status: 403,
      stage: 'response',
      message: 'Model API request failed (403)',
    });
  });

  it.each(['http', 'stream'] as const)(
    'classifies native prompt-too-long %s errors without exposing the provider message',
    async (transport) => {
      const error = {
        type: 'invalid_request_error',
        message: 'prompt is too long: 210000 tokens > 200000 maximum',
      };
      if (transport === 'stream') mockResponse([event('error', { error })]);
      else
        vi.stubGlobal(
          'fetch',
          vi.fn(
            async () => new Response(JSON.stringify({ type: 'error', error }), { status: 400 }),
          ),
        );
      const failure = await collect(new AnthropicProvider(options)).catch(
        (value: unknown) => value,
      );
      expect(failure).toBeInstanceOf(ContextOverflowError);
      expect(failure).toMatchObject({
        category: 'context',
        code: 'MODEL_CONTEXT_EXCEEDED',
        stage: transport === 'http' ? 'response' : 'stream',
        message: 'Model context window exceeded',
      });
      expect(String(failure)).not.toContain(error.message);
    },
  );

  it.each([
    [401, 'invalid_request_error', 'prompt is too long: 210000 tokens > 200000 maximum'],
    [400, 'permission_error', 'prompt is too long: 210000 tokens > 200000 maximum'],
    [400, 'invalid_request_error', 'max_tokens must be positive'],
    [400, 'invalid_request_error', 'quoted prompt is too long: 210000 tokens > 200000 maximum'],
    [400, 'invalid_request_error', 'prompt is too long: 210000 tokens > 200000 maximum PRIVATE'],
  ])('does not classify unrelated HTTP %i/%s errors as overflow', async (status, type, message) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: { type, message } }), { status })),
    );
    const failure = await collect(new AnthropicProvider(options)).catch((value: unknown) => value);
    expect(failure).not.toBeInstanceOf(ContextOverflowError);
    expect(failure).toMatchObject({ stage: 'response', status });
    expect(String(failure)).not.toContain(message);
  });

  it('maps a refusal without treating it as successful tool completion', async () => {
    mockResponse([
      start(),
      blockStart(0, { type: 'text', text: 'cannot help' }),
      blockStop(0),
      ...finish('refusal'),
    ]);
    expect((await collect(new AnthropicProvider(options))).at(-1)).toMatchObject({
      finishReason: 'content_filter',
      refusal: true,
    });
  });

  it('sanitizes transport failures after headers while retaining the known socket code', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(
          Object.assign(new Error('private fixture-key prompt'), { code: 'ECONNRESET' }),
        );
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(stream)),
    );
    await expect(collect(new AnthropicProvider(options))).rejects.toMatchObject({
      code: 'MODEL_STREAM_INTERRUPTED',
      stage: 'stream',
      transportCode: 'ECONNRESET',
      message: 'Anthropic response stream interrupted',
    });
  });

  it('links caller cancellation after headers and waits for cleanup', async () => {
    const caller = new AbortController();
    let cleaned = false;
    let controller: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        const stream = new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            value.enqueue(
              new TextEncoder().encode(
                [
                  start(),
                  blockStart(0, { type: 'text', text: '' }),
                  delta(0, { type: 'text_delta', text: 'first' }),
                ]
                  .map((value) => `data: ${JSON.stringify(value)}\n\n`)
                  .join(''),
              ),
            );
          },
          async cancel() {
            await Promise.resolve();
            cleaned = true;
          },
        });
        init.signal.addEventListener(
          'abort',
          () => controller.enqueue(new TextEncoder().encode('data: {"type":"ping"}\n\n')),
          { once: true },
        );
        return new Response(stream);
      }),
    );
    const values: ModelEvent[] = [];
    const run = async () => {
      for await (const value of new AnthropicProvider(options).create({
        ...request,
        signal: caller.signal,
      })) {
        values.push(value);
        if (value.type === 'text_delta') caller.abort();
      }
    };
    await expect(run()).rejects.toMatchObject({ code: 'ABORTED' });
    expect(values.some((value) => value.type === 'message_stop')).toBe(false);
    expect(cleaned).toBe(true);
  });

  it('awaits reader cleanup and aborts fetch when the consumer exits early', async () => {
    let cleaned = false;
    let signal: AbortSignal | undefined;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            [
              start(),
              blockStart(0, { type: 'text', text: '' }),
              delta(0, { type: 'text_delta', text: 'first' }),
            ]
              .map((value) => `data: ${JSON.stringify(value)}\n\n`)
              .join(''),
          ),
        );
      },
      async cancel() {
        await Promise.resolve();
        cleaned = true;
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        signal = init.signal;
        return new Response(stream);
      }),
    );
    for await (const value of new AnthropicProvider(options).create(request)) {
      if (value.type === 'text_delta') break;
    }
    expect(cleaned).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
});
