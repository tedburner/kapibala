import { describe, expect, it, vi } from 'vitest';
import { ModelError } from '../src/errors/index.js';
import { OpenAICompatibleProvider } from '../src/models/openai-compatible/index.js';
import { parseSSEStream } from '../src/models/openai-compatible/sse.js';

function createReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe('parseSSEStream', () => {
  it('should parse standard SSE events and stop at [DONE]', async () => {
    const rawChunks = [
      'data: {"text": "hello"}\n\n',
      ': ping heartbeat\n\n',
      'data: {"text": " world"}\n\n',
      'data: [DONE]\n\n',
    ];

    const stream = createReadableStream(rawChunks);
    const results: string[] = [];

    for await (const data of parseSSEStream(stream)) {
      results.push(data);
    }

    expect(results).toEqual(['{"text": "hello"}', '{"text": " world"}']);
  });

  it('should handle fragmented packets across chunk boundaries', async () => {
    const rawChunks = ['data: {"foo":', ' "bar"}\n\ndata: 12', '3\n\ndata: [DONE]\n'];

    const stream = createReadableStream(rawChunks);
    const results: string[] = [];

    for await (const data of parseSSEStream(stream)) {
      results.push(data);
    }

    expect(results).toEqual(['{"foo": "bar"}', '123']);
  });
});

describe('OpenAICompatibleProvider', () => {
  const provider = new OpenAICompatibleProvider({
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    modelName: 'gpt-4o',
    supportsThinking: true,
  });

  it('normalizes failed-turn user messages before sending wire history', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createReadableStream(['data: [DONE]\n\n']),
    } as any);

    const messages = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'first' }] },
      { role: 'assistant' as const, content: [] },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'second' }] },
    ];
    for await (const _event of provider.create({ messages })) {
      // drain
    }

    const request = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    const body = JSON.parse(String(request?.body));
    expect(body.messages).toEqual([{ role: 'user', content: 'first\n\nsecond' }]);
    expect(messages).toHaveLength(3);
  });
  it('should stream text deltas and reasoning content', async () => {
    const sseData = [
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[{"delta":{"reasoning_content":"Thinking..."}}]}\n\n',
      'data: {"choices":[{"delta":{"content":" World"}}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
      'data: [DONE]\n\n',
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createReadableStream(sseData),
    } as any);

    const events: any[] = [];
    for await (const ev of provider.create({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], timestamp: Date.now() }],
    })) {
      events.push(ev);
    }

    expect(events.slice(0, 3)).toEqual([
      { type: 'text_delta', text: 'Hello' },
      { type: 'thinking_delta', thinking: 'Thinking...' },
      { type: 'text_delta', text: ' World' },
    ]);
    const stopEvent = events[3];
    expect(stopEvent.type).toBe('message_stop');
    expect(stopEvent.usage).toEqual({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
    expect(typeof stopEvent.ttftMs).toBe('number');
    expect(typeof stopEvent.durationMs).toBe('number');
  });

  it('should assemble split tool call chunks properly', async () => {
    const sseData = [
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_123","function":{"name":"read_file","arguments":""}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\": "}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"test.txt\\"}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createReadableStream(sseData),
    } as any);

    const events: any[] = [];
    for await (const ev of provider.create({
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Read test.txt' }], timestamp: Date.now() },
      ],
    })) {
      events.push(ev);
    }

    const startEv = events.find((e) => e.type === 'tool_call_start');
    const finishEv = events.find((e) => e.type === 'tool_call_finish');

    expect(startEv).toEqual({
      type: 'tool_call_start',
      id: 'call_123',
      name: 'read_file',
    });

    expect(finishEv).toEqual({
      type: 'tool_call_finish',
      id: 'call_123',
      name: 'read_file',
      input: { path: 'test.txt' },
    });
  });

  it('should throw ModelError when HTTP request fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ error: { message: 'Incorrect API key' } }),
    } as any);

    const gen = provider.create({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], timestamp: Date.now() }],
    });

    await expect(async () => {
      for await (const _ of gen) {
      }
    }).rejects.toThrow(ModelError);
  });

  it('should throw ModelError for an error frame inside an HTTP 200 SSE stream', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createReadableStream([
        'data: {"error":{"message":"Quota exhausted","type":"insufficient_quota","code":"quota"}}\n\n',
        'data: [DONE]\n\n',
      ]),
    } as Response);

    const consume = async () => {
      for await (const _event of provider.create({
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
      })) {
        // drive provider
      }
    };

    await expect(consume()).rejects.toMatchObject({
      name: 'ModelError',
      message: 'Quota exhausted (insufficient_quota, quota)',
    });
  });

  it('should keep the caller abort signal connected while reading the response stream', async () => {
    const controller = new AbortController();
    let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let streamCancelled = false;

    const stream = new ReadableStream<Uint8Array>({
      start(currentController) {
        streamController = currentController;
      },
      cancel() {
        streamCancelled = true;
      },
    });

    globalThis.fetch = vi.fn().mockImplementation(async (_url, init?: RequestInit) => {
      init?.signal?.addEventListener(
        'abort',
        () => {
          streamCancelled = true;
          streamController?.error(new DOMException('aborted', 'AbortError'));
        },
        { once: true },
      );
      return { ok: true, body: stream } as Response;
    });

    const iterator = provider
      .create({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }], timestamp: Date.now() },
        ],
        signal: controller.signal,
      })
      [Symbol.asyncIterator]();
    const pendingRead = iterator.next().then(
      () => 'settled',
      () => 'settled',
    );

    await Promise.resolve();
    controller.abort();

    const outcome = await Promise.race([
      pendingRead,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 30)),
    ]);

    if (outcome === 'timeout' && !streamCancelled) {
      streamController?.close();
      await pendingRead;
    }
    expect(outcome).toBe('settled');
    expect(streamCancelled).toBe(true);
  });

  it('should propagate an already-aborted caller signal before starting fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    let fetchSignalWasAborted = false;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init?: RequestInit) => {
      fetchSignalWasAborted = init?.signal?.aborted ?? false;
      throw new DOMException('aborted', 'AbortError');
    });

    const consume = async () => {
      for await (const _event of provider.create({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Hi' }], timestamp: Date.now() },
        ],
        signal: controller.signal,
      })) {
        // 无事件可消费；该循环仅驱动异步生成器执行。
      }
    };

    await expect(consume()).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchSignalWasAborted).toBe(true);
  });
});
