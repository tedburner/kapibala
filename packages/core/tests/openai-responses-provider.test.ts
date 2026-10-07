import { afterEach, describe, expect, it, vi } from 'vitest';
import { OpenAIResponsesProvider } from '../src/models/openai-responses/index.js';
import type { CanonicalMessage, ModelEvent, ModelRequest } from '../src/types/index.js';

const options = {
  baseURL: 'https://api.openai.com/v1/',
  apiKey: 'test-key',
  modelName: 'reasoning-model',
  supportsThinking: true,
};
const context = { runId: 'run-1', modelId: 'profile-1' };
const message = (id = 'msg-1', text = 'answer', phase?: string) => ({
  type: 'message',
  id,
  role: 'assistant',
  status: 'completed',
  ...(phase ? { phase } : {}),
  content: [{ type: 'output_text', text, annotations: [] }],
});
const call = (id = 'fc-1', callId = 'call-1', args = '{ "optional": 1 }') => ({
  type: 'function_call',
  id,
  call_id: callId,
  name: 'echo',
  arguments: args,
  status: 'completed',
});
const reasoning = {
  type: 'reasoning',
  id: 'rs-1',
  encrypted_content: 'opaque-test-state',
  summary: [],
  status: 'completed',
};
function completed(output: unknown[], usage?: unknown) {
  return {
    type: 'response.completed',
    response: { id: 'resp-1', status: 'completed', output, ...(usage ? { usage } : {}) },
  };
}
function mockStream(events: unknown[], cancel?: () => void) {
  const encoder = new TextEncoder();
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              for (const event of events)
                controller.enqueue(
                  encoder.encode(
                    `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`,
                  ),
                );
              controller.close();
            },
            cancel,
          }),
        ),
    ),
  );
}
async function collect(
  request: Partial<ModelRequest> = {},
  provider = new OpenAIResponsesProvider(options),
) {
  const events: ModelEvent[] = [];
  for await (const event of provider.create({ messages: [], context, ...request }))
    events.push(event);
  return events;
}
function payload() {
  return JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
}
function finalContent(events: ModelEvent[]) {
  const event = events.at(-1);
  if (event?.type !== 'message_stop') throw new Error('missing stop');
  return event.finalContent!;
}

afterEach(() => vi.unstubAllGlobals());
describe('OpenAIResponsesProvider', () => {
  it('uses stateless Responses with flat optional schemas and a total output budget', async () => {
    mockStream([completed([message()])]);
    await collect({
      systemPrompt: 'rules',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
      tools: [
        {
          name: 'echo',
          description: 'Echo',
          parameters: { type: 'object', properties: { optional: { type: 'number' } } },
        },
      ],
      maxTokens: 32768,
      temperature: 0.8,
    });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://api.openai.com/v1/responses');
    expect(payload()).toMatchObject({
      store: false,
      stream: true,
      max_output_tokens: 32768,
      instructions: 'rules',
      include: ['reasoning.encrypted_content'],
      tools: [
        {
          type: 'function',
          name: 'echo',
          strict: false,
          parameters: { properties: { optional: { type: 'number' } } },
        },
      ],
      input: [{ role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    });
    expect(payload()).not.toHaveProperty('temperature');
    expect(payload()).not.toHaveProperty('previous_response_id');
    expect(payload()).not.toHaveProperty('reasoning');
  });
  it('preserves multiple message phases, Item IDs, content parts and raw function arguments', async () => {
    const output = [
      message('comment', 'working', 'commentary'),
      call(),
      message('answer', 'ready', 'final_answer'),
    ];
    mockStream([completed(output)]);
    const content = finalContent(await collect());
    expect(content.map((block) => block.type)).toEqual(['text', 'tool_use', 'text']);
    expect(content[1]).toMatchObject({
      id: 'call-1',
      protocolMeta: { itemId: 'fc-1', itemIndex: 1, arguments: '{ "optional": 1 }' },
    });
    mockStream([completed([message()])]);
    await collect({
      context: { ...context, runId: 'new-run' },
      messages: [
        { role: 'assistant', content },
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call-1', content: 'done' }] },
      ],
    });
    expect(payload().input).toEqual([
      ...output,
      { type: 'function_call_output', call_id: 'call-1', output: 'done' },
    ]);
  });
  it('replays encrypted reasoning only on a matching tool continuation and never displays ciphertext', async () => {
    mockStream([completed([reasoning, call()])]);
    const events = await collect();
    expect(events.some((event) => JSON.stringify(event).includes('thinking_delta'))).toBe(false);
    const messages: CanonicalMessage[] = [
      { role: 'assistant', content: finalContent(events) },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call-1', content: 'done' }] },
    ];
    for (const requestContext of [
      context,
      { ...context, runId: 'other' },
      { ...context, modelId: 'other' },
    ]) {
      mockStream([completed([message()])]);
      await collect({ messages, context: requestContext });
      expect(payload().input.some((item: any) => item.type === 'reasoning')).toBe(
        requestContext === context,
      );
    }
    expect(messages[0].content[0]).toMatchObject({ type: 'provider_state', item: reasoning });
  });
  it('maps multiple functions and canonical results using business call IDs', async () => {
    mockStream([completed([call(), call('fc-2', 'call-2', '{}')])]);
    const provider = new OpenAIResponsesProvider(options);
    const content = finalContent(await collect({}, provider));
    const results = provider.assembleToolResults([
      { type: 'tool_result', toolUseId: 'call-1', content: 'one' },
      { type: 'tool_result', toolUseId: 'call-2', content: 'two', isError: true },
    ]);
    expect(results.map((result) => result.role)).toEqual(['tool', 'tool']);
    mockStream([completed([message()])]);
    await collect({ messages: [{ role: 'assistant', content }, ...results] });
    expect(payload().input.slice(-2)).toEqual([
      { type: 'function_call_output', call_id: 'call-1', output: 'one' },
      { type: 'function_call_output', call_id: 'call-2', output: 'two' },
    ]);
  });
  it('streams text and visible summaries while committing one ordered final content', async () => {
    const summaryItem = { ...reasoning, summary: [{ type: 'summary_text', text: 'checking' }] };
    mockStream([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...summaryItem, status: 'in_progress' },
      },
      {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs-1',
        output_index: 0,
        summary_index: 0,
        delta: 'checking',
      },
      { type: 'response.output_item.done', output_index: 0, item: summaryItem },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: { ...message(), status: 'in_progress', content: [] },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg-1',
        output_index: 1,
        content_index: 0,
        delta: 'answer',
      },
      { type: 'response.output_item.done', output_index: 1, item: message() },
      completed([summaryItem, message()], {
        input_tokens: 10,
        output_tokens: 20,
        total_tokens: 30,
        input_tokens_details: { cached_tokens: 4 },
      }),
    ]);
    const events = await collect();
    expect(events).toContainEqual({
      type: 'thinking_delta',
      blockId: 'rs-1:0',
      thinking: 'checking',
    });
    expect(events).toContainEqual({ type: 'text_delta', text: 'answer' });
    expect(events.at(-1)).toMatchObject({
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30, cachedPromptTokens: 4 },
      finalContent: [{ type: 'provider_state' }, { type: 'text', text: 'answer' }],
    });
  });
  it('displays a refusal and preserves its source kind', async () => {
    const refusal = { ...message(), content: [{ type: 'refusal', refusal: 'cannot comply' }] };
    mockStream([completed([refusal])]);
    const events = await collect();
    expect(events).toContainEqual({ type: 'text_delta', text: 'cannot comply' });
    expect(events.at(-1)).toMatchObject({
      refusal: true,
      finishReason: 'stop',
      finalContent: [
        { type: 'text', text: 'cannot comply', protocolMeta: { contentType: 'refusal' } },
      ],
    });
  });
  it.each([
    [
      'incomplete',
      [
        {
          type: 'response.incomplete',
          response: {
            status: 'incomplete',
            output: [call()],
            incomplete_details: { reason: 'max_output_tokens' },
          },
        },
      ],
    ],
    [
      'failed',
      [
        {
          type: 'response.failed',
          response: { status: 'failed', error: { code: 'server_error', message: 'private' } },
        },
      ],
    ],
    ['missing terminal', [{ type: 'response.output_item.done', output_index: 0, item: call() }]],
    ['truncated arguments', [completed([call('fc-1', 'call-1', '{')])]],
    ['array arguments', [completed([call('fc-1', 'call-1', '[]')])]],
    ['duplicate call ID', [completed([call(), call('fc-2')])]],
    ['duplicate Item ID', [completed([call(), call('fc-1', 'call-2')])]],
    ['unfinished Item', [completed([{ ...call(), status: 'in_progress' }])]],
    ['hosted tool', [completed([{ type: 'web_search_call', id: 'hosted', status: 'completed' }])]],
    ['commentary only', [completed([message('comment', 'working', 'commentary')])]],
    [
      'refusal with tool',
      [completed([{ ...message(), content: [{ type: 'refusal', refusal: 'no' }] }, call()])],
    ],
    ['invalid phase', [completed([message('msg', 'answer', 'unknown')])]],
    ['empty final', [completed([])]],
  ])('rejects %s without any executable completion', async (_name, events) => {
    mockStream(events);
    const seen: ModelEvent[] = [];
    await expect(async () => {
      for await (const event of new OpenAIResponsesProvider(options).create({
        messages: [],
        context,
      }))
        seen.push(event);
    }).rejects.toMatchObject({ name: 'ModelError' });
    expect(
      seen.some((event) => event.type === 'message_stop' || event.type === 'tool_call_finish'),
    ).toBe(false);
  });
  it('keeps usage unknown when it is missing', async () => {
    mockStream([completed([message()])]);
    expect((await collect()).at(-1)).not.toHaveProperty('usage');
  });
  it('rejects mismatched event Item identity before accepting the terminal', async () => {
    mockStream([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...call(), status: 'in_progress' },
      },
      {
        type: 'response.function_call_arguments.delta',
        output_index: 0,
        item_id: 'wrong',
        delta: '{}',
      },
      completed([call()]),
    ]);
    await expect(collect()).rejects.toMatchObject({ code: 'MODEL_INVALID_RESPONSE' });
  });
  it('redacts HTTP and stream error bodies while retaining safe error codes', async () => {
    mockStream([
      { type: 'error', code: 'rate_limit_exceeded', message: 'private prompt test-key' },
    ]);
    await expect(collect()).rejects.toMatchObject({
      providerCode: 'rate_limit_exceeded',
      message: 'Responses API reported an error',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: 'invalid_api_key', message: 'private prompt' } }),
            { status: 401 },
          ),
      ),
    );
    await expect(collect()).rejects.toMatchObject({
      status: 401,
      message: 'Model API request failed (401)',
    });
  });
  it('rejects malformed JSON with no raw response data in the diagnostic', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('data: private-invalid-json\n\n')),
    );
    await expect(collect()).rejects.toMatchObject({
      code: 'MODEL_INVALID_RESPONSE',
      message: 'Model response contained an invalid JSON event',
    });
  });
  it('cancels the reader and aborts transport when the consumer stops', async () => {
    let signal: AbortSignal | undefined;
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        signal = init.signal;
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: 'response.output_item.added', output_index: 0, item: { ...message(), content: [], status: 'in_progress' } })}\n\ndata: ${JSON.stringify({ type: 'response.output_text.delta', output_index: 0, item_id: 'msg-1', content_index: 0, delta: 'partial' })}\n\n`,
                ),
              );
            },
            cancel() {
              cancelled = true;
            },
          }),
        );
      }),
    );
    for await (const _event of new OpenAIResponsesProvider(options).create({ messages: [] })) break;
    expect(cancelled).toBe(true);
    expect(signal?.aborted).toBe(true);
  });
  it('does not expose executable completions when terminal usage is invalid', async () => {
    mockStream([completed([call()], { input_tokens: -1, output_tokens: 1, total_tokens: 0 })]);
    const seen: ModelEvent[] = [];
    await expect(async () => {
      for await (const event of new OpenAIResponsesProvider(options).create({ messages: [] }))
        seen.push(event);
    }).rejects.toMatchObject({ code: 'MODEL_INVALID_RESPONSE' });
    expect(seen.some((event) => event.type === 'tool_call_finish')).toBe(false);
  });
  it('accepts nullable phase/encryption and irrelevant metadata or JSON key order changes', async () => {
    const item = { ...message(), phase: null };
    const reordered = {
      status: item.status,
      id: item.id,
      type: item.type,
      content: item.content,
      role: item.role,
      phase: null,
      extra_metadata: 'safe',
    };
    mockStream([
      { type: 'response.output_item.done', output_index: 0, item },
      completed([reordered, { ...reasoning, encrypted_content: null }]),
    ]);
    expect(finalContent(await collect())).toMatchObject([
      { type: 'text', text: 'answer' },
      { type: 'provider_state', item: { id: 'rs-1' } },
    ]);
  });
  it.each([
    [
      'wrong final text',
      {
        type: 'response.output_text.done',
        item_id: 'msg-1',
        output_index: 0,
        content_index: 0,
        text: 'different',
      },
    ],
    [
      'unsupported content part',
      {
        type: 'response.content_part.added',
        item_id: 'msg-1',
        output_index: 0,
        content_index: 0,
        part: { type: 'output_audio' },
      },
    ],
  ])('rejects %s in otherwise completed streams', async (_name, badEvent) => {
    mockStream([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...message(), content: [], status: 'in_progress' },
      },
      {
        type: 'response.output_text.delta',
        item_id: 'msg-1',
        output_index: 0,
        content_index: 0,
        delta: 'answer',
      },
      badEvent,
      { type: 'response.output_item.done', output_index: 0, item: message() },
      completed([message()]),
    ]);
    await expect(collect()).rejects.toMatchObject({ code: 'MODEL_INVALID_RESPONSE' });
  });
  it('projects foreign protocol text and functions without claiming source Items', async () => {
    mockStream([completed([reasoning, call(), message()])]);
    const history: CanonicalMessage[] = [
      { role: 'assistant', content: finalContent(await collect()) },
      { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call-1', content: 'done' }] },
    ];
    mockStream([completed([message()])]);
    await collect(
      { messages: history },
      new OpenAIResponsesProvider({ ...options, modelName: 'another-model' }),
    );
    expect(
      payload().input.some(
        (item: any) => item.type === 'reasoning' || 'id' in item || 'phase' in item,
      ),
    ).toBe(false);
    expect(JSON.stringify(payload())).not.toContain('opaque-test-state');
  });
  it('sends cross-protocol assistant text as output_text instead of input_text', async () => {
    mockStream([completed([message()])]);
    await collect({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'question' }] },
        {
          // 跨协议投影降级后的 assistant 文本：无 protocolMeta 的普通文本块
          role: 'assistant',
          content: [
            { type: 'text', text: 'visible reasoning' },
            { type: 'text', text: 'final answer' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'continue' }] },
      ],
    });
    const assistantItem = payload().input.find((item: any) => item.role === 'assistant');
    expect(assistantItem).toMatchObject({ role: 'assistant' });
    expect(assistantItem.content).toEqual([
      { type: 'output_text', text: 'visible reasoning', annotations: [] },
      { type: 'output_text', text: 'final answer', annotations: [] },
    ]);
  });
  it('aliases unsafe cross-protocol call ids identically for calls and outputs', async () => {
    mockStream([completed([message()])]);
    await collect({
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'toolu 外来 id/64+', name: 'echo', input: {} }],
        },
        {
          role: 'tool',
          content: [{ type: 'tool_result', toolUseId: 'toolu 外来 id/64+', content: 'done' }],
        },
      ],
    });
    const input = payload().input;
    const callItem = input.find((item: any) => item.type === 'function_call');
    const outputItem = input.find((item: any) => item.type === 'function_call_output');
    expect(callItem.call_id).toMatch(/^call_[0-9a-f]{48}$/);
    expect(outputItem.call_id).toBe(callItem.call_id);
  });
  it('rejects invalid connection configuration before any request', () => {
    expect(
      () => new OpenAIResponsesProvider({ ...options, baseURL: 'https://e.test/v1?x=1' }),
    ).toThrow();
    expect(() => new OpenAIResponsesProvider({ ...options, modelName: ' ' })).toThrow();
    expect(() => new OpenAIResponsesProvider({ ...options, apiKey: '' })).toThrow();
  });
  it('does not replay encrypted state from a final reply without a tool continuation', async () => {
    mockStream([completed([reasoning, message()])]);
    const content = finalContent(await collect());
    mockStream([completed([message()])]);
    await collect({
      messages: [
        { role: 'assistant', content },
        { role: 'user', content: [{ type: 'text', text: 'another question' }] },
      ],
    });
    expect(payload().input.some((item: any) => item.type === 'reasoning')).toBe(false);
  });
  it('completes and cleans the reader when the server leaves the connection open after completed', async () => {
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                streamController = controller;
                controller.enqueue(
                  new TextEncoder().encode(`data: ${JSON.stringify(completed([message()]))}\n\n`),
                );
              },
              cancel() {
                cancelled = true;
              },
            }),
          ),
      ),
    );
    const collecting = collect();
    const outcome = await Promise.race([
      collecting.then(() => 'completed'),
      new Promise((resolve) => setTimeout(() => resolve('pending'), 40)),
    ]);
    if (outcome === 'pending') {
      streamController!.close();
      await collecting;
    }
    expect(outcome).toBe('completed');
    expect(cancelled).toBe(true);
  });
  it('rejects a function business identity that changes between added and done', async () => {
    mockStream([
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...call(), status: 'in_progress' },
      },
      { type: 'response.output_item.done', output_index: 0, item: call('fc-1', 'different-call') },
      completed([call('fc-1', 'different-call')]),
    ]);
    await expect(collect()).rejects.toMatchObject({ code: 'MODEL_INVALID_RESPONSE' });
  });
  it('reports socket interruption without exposing nested transport details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.error(
                  new TypeError('private transport', {
                    cause: Object.assign(new Error('secret socket'), { code: 'UND_ERR_SOCKET' }),
                  }),
                );
              },
            }),
          ),
      ),
    );
    await expect(collect()).rejects.toMatchObject({
      code: 'MODEL_STREAM_INTERRUPTED',
      transportCode: 'UND_ERR_SOCKET',
      message: 'Responses stream was interrupted',
    });
  });
  it('keeps the caller abort signal active while awaiting response bytes', async () => {
    const controller = new AbortController();
    let streamController: ReadableStreamDefaultController<Uint8Array>;
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        signal = init.signal;
        return new Response(
          new ReadableStream({
            start(stream) {
              streamController = stream;
              signal!.addEventListener(
                'abort',
                () => streamController.error(new DOMException('aborted', 'AbortError')),
                { once: true },
              );
            },
          }),
        );
      }),
    );
    const collecting = collect({ signal: controller.signal });
    await vi.waitFor(() => expect(signal).toBeDefined());
    controller.abort();
    await expect(collecting).rejects.toMatchObject({ name: 'AbortError' });
    expect(signal!.aborted).toBe(true);
  });
  it('preserves empty message and text parts within a valid ordered tool response', async () => {
    const empty = { ...message('empty', '', 'commentary'), content: [] };
    const parts = {
      ...message('parts', '', 'commentary'),
      content: [
        { type: 'output_text', text: '', annotations: [] },
        { type: 'output_text', text: 'checking', annotations: [] },
      ],
    };
    mockStream([completed([empty, parts, call()])]);
    const content = finalContent(await collect());
    mockStream([completed([message()])]);
    await collect({
      messages: [
        { role: 'assistant', content },
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'call-1', content: 'done' }] },
      ],
    });
    expect(payload().input.slice(0, 3)).toEqual([empty, parts, call()]);
  });
});
