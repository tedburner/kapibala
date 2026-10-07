import { describe, expect, it, vi } from 'vitest';
import { AgentSession } from '../src/context/session/index.js';
import { ModelError } from '../src/errors/index.js';
import { OpenAICompatibleProvider } from '../src/models/openai-compatible/index.js';
import { parseSSEStream } from '../src/models/openai-compatible/sse.js';
import { makeEchoToolRegistry } from './helpers/mock.js';

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
  it('reports malformed stream frames without echoing the response body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createReadableStream(['data: private-invalid-json\n\n']),
    } as Response);
    await expect(async () => {
      for await (const _ of provider.create({ messages: [] })) {
      }
    }).rejects.toMatchObject({
      code: 'MODEL_INVALID_RESPONSE',
      category: 'invalid_response',
      stage: 'stream',
      message: 'Model response contained invalid JSON',
    });
  });
  it('preserves HTTP provider error details and redacts echoed credentials', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      statusText: 'Too Many Requests',
      text: async () =>
        JSON.stringify({
          error: {
            message: 'slow down api_key=private-value',
            code: 'rate_limit_exceeded',
            type: 'rate_limit_error',
          },
        }),
    } as Response);
    await expect(async () => {
      for await (const _ of provider.create({ messages: [] })) {
      }
    }).rejects.toMatchObject({
      category: 'rate_limit',
      status: 429,
      providerCode: 'rate_limit_exceeded',
      providerType: 'rate_limit_error',
      message: 'slow down api_key=[redacted]',
      stage: 'response',
      retryPolicy: 'backoff',
    });
  });
  it('continues after tools with complete reasoning history and produces a final answer', async () => {
    let requests = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const payload = JSON.parse(String(init.body));
      const second = requests++ > 0;
      if (second) {
        const assistant = payload.messages.find(
          (message: { role: string }) => message.role === 'assistant',
        );
        expect(assistant.reasoning_content).toBe('I need the file first.');
        expect(assistant.content).toBe('');
        expect(
          payload.messages.some(
            (message: { role: string; content: string }) =>
              message.role === 'tool' && message.content === 'echo:file result',
          ),
        ).toBe(true);
      }
      return {
        ok: true,
        body: createReadableStream([
          second
            ? 'data: {"choices":[{"delta":{"content":"Here is the complete answer."},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":10,"total_tokens":110}}\n\n'
            : 'data: {"choices":[{"delta":{"reasoning_content":"I need the file first.","tool_calls":[{"index":0,"id":"file","function":{"name":"echo","arguments":"{\\"value\\":\\"file result\\"}"}}]},"finish_reason":"tool_calls"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      } as Response;
    });
    const session = new AgentSession({
      defaultProfile: {
        id: 'deepseek-flash',
        name: 'DeepSeek',
        modelName: 'deepseek-flash',
        provider: 'openai-compatible',
        baseURL: 'https://api.deepseek.com/v1',
        apiKeyEnv: 'NONE',
        contextWindow: '1M',
      },
      defaultProvider: new OpenAICompatibleProvider({
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'test-key',
        modelName: 'deepseek-flash',
      }),
    });
    for (const tool of makeEchoToolRegistry().list()) session.tools.register(tool);
    try {
      const events = [];
      for await (const event of session.run('version plan')) events.push(event);
      expect(events).toContainEqual({ type: 'text_delta', text: 'Here is the complete answer.' });
      expect(events.at(-1)).toMatchObject({
        type: 'run_finish',
        metrics: { status: 'completed', contextUsage: { usedTokens: 100 } },
      });
      expect(requests).toBe(2);
    } finally {
      await session.destroy();
    }
  });
  it.each([
    ['https://api.deepseek.com/v1', undefined, true],
    ['https://api.openai.com/v1', undefined, false],
    ['https://gateway.example/v1', true, true],
  ] as const)(
    'replays reasoning only for compatible endpoints (%s)',
    async (baseURL, replayReasoningContent, expected) => {
      const adapted = new OpenAICompatibleProvider({
        baseURL,
        apiKey: 'test-key',
        modelName: 'test',
        replayReasoningContent,
      });
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: createReadableStream([
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
          'data: [DONE]\n\n',
        ]),
      } as Response);
      for await (const _ of adapted.create({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'prior answer reasoning' },
              { type: 'text', text: 'prior answer' },
            ],
          },
          { role: 'user', content: [{ type: 'text', text: 'check file' }] },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'first\n' },
              { type: 'thinking', thinking: 'second' },
              { type: 'tool_use', id: 'read', name: 'read_file', input: { path: 'package.json' } },
            ],
          },
          { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'read', content: '{}' }] },
        ],
        tools: [{ name: 'read_file', description: 'Read', parameters: {} }],
      })) {
      }
      const payload = JSON.parse(String(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body));
      const assistants = payload.messages.filter(
        (message: { role: string }) => message.role === 'assistant',
      );
      if (expected) {
        expect(assistants[0].reasoning_content).toBe('prior answer reasoning');
        expect(assistants[1].reasoning_content).toBe('first\nsecond');
      } else
        expect(assistants.every((message: object) => !('reasoning_content' in message))).toBe(true);
      expect(assistants[1].tool_calls[0].function.arguments).toBe('{"path":"package.json"}');
    },
  );

  it('retains a safe nested socket error code without exposing transport details', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        pull(controller) {
          controller.error(
            new TypeError('private socket details', {
              cause: Object.assign(new Error('private cause'), { code: 'UND_ERR_SOCKET' }),
            }),
          );
        },
      }),
    } as Response);
    await expect(async () => {
      for await (const _ of provider.create({ messages: [] })) {
      }
    }).rejects.toMatchObject({ code: 'MODEL_STREAM_INTERRUPTED', transportCode: 'UND_ERR_SOCKET' });
  });
  const provider = new OpenAICompatibleProvider({
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'test-key',
    modelName: 'gpt-4o',
    supportsThinking: true,
  });

  it.each(['closed', 'broken'])(
    'reports %s streams after thinking without completing the message',
    async (ending) => {
      let reads = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (reads++ === 0) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"reasoning_content":"Let me check package.json"}}]}\n\n',
              ),
            );
          } else if (ending === 'closed') controller.close();
          else controller.error(new TypeError('terminated'));
        },
      });
      globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body } as Response);
      const iterator = provider
        .create({ messages: [{ role: 'user', content: [{ type: 'text', text: 'version plan' }] }] })
        [Symbol.asyncIterator]();
      expect((await iterator.next()).value).toMatchObject({ type: 'thinking_delta' });
      await expect(iterator.next()).rejects.toMatchObject({
        name: 'ModelError',
        code: ending === 'closed' ? 'MODEL_STREAM_INCOMPLETE' : 'MODEL_STREAM_INTERRUPTED',
        retryable: false,
      });
    },
  );

  it('normalizes failed-turn user messages before sending wire history', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: createReadableStream([
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]),
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
      'data: {"choices":[{"delta":{"content":" World"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}\n\n',
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
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
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
