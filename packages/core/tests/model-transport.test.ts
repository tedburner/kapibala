import { describe, expect, it, vi } from 'vitest';
import { AbortError } from '../src/errors/index.js';
import { OpenAICompatibleProvider } from '../src/models/openai-compatible/index.js';
import { OpenAIResponsesProvider } from '../src/models/openai-responses/index.js';
import { openModelResponse, parseRetryHeaders } from '../src/models/transport/http.js';
import { parseSSEFrames } from '../src/models/transport/sse.js';

function bytes(chunks: Uint8Array[], cancel = vi.fn()) {
  return {
    cancel,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
      cancel,
    }),
  };
}

describe('shared SSE framing', () => {
  it('preserves named multiline data and split UTF-8/CRLF', async () => {
    const data = new TextEncoder().encode(
      ': heartbeat\r\nevent: delta\r\ndata: {"text":\r\ndata: "水豚"}\r\n\r\n',
    );
    const source = bytes(Array.from(data, (b) => new Uint8Array([b])));
    const frames = [];
    for await (const frame of parseSSEFrames(source.stream)) frames.push(frame);
    expect(frames).toEqual([{ event: 'delta', data: '{"text":\n"水豚"}' }]);
  });

  it('dispatches an EOF frame and awaits consumer cancellation cleanup', async () => {
    let cleaned = false;
    const source = {
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: first\n\ndata: second'));
        },
        async cancel() {
          await Promise.resolve();
          cleaned = true;
        },
      }),
    };
    for await (const frame of parseSSEFrames(source.stream)) {
      expect(frame.data).toBe('first');
      break;
    }
    expect(cleaned).toBe(true);
    const eof = bytes([new TextEncoder().encode('data: tail')]);
    const frames = [];
    for await (const frame of parseSSEFrames(eof.stream)) frames.push(frame);
    expect(frames).toEqual([{ event: 'message', data: 'tail' }]);
  });

  it('cancels reader and throws retryable MODEL_STREAM_IDLE_TIMEOUT when no chunk arrives in time', async () => {
    vi.useFakeTimers();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"step":1}\n\n'));
      },
      cancel() {
        cancelled = true;
      },
    });
    try {
      const seen: string[] = [];
      const consuming = (async () => {
        for await (const frame of parseSSEFrames(stream, { idleTimeoutMs: 25 })) {
          seen.push(frame.data);
        }
      })();
      const check = expect(consuming).rejects.toMatchObject({
        code: 'MODEL_STREAM_IDLE_TIMEOUT',
        stage: 'stream',
        transportCode: 'ETIMEDOUT',
        category: 'timeout',
        retryable: true,
      });
      await vi.advanceTimersByTimeAsync(25);
      await check;
      expect(seen).toEqual(['{"step":1}']);
      expect(cancelled).toBe(true);
      expect(stream.locked).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws AbortError cleanly without misclassifying as network failure when signal aborts', async () => {
    const controller = new AbortController();
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start() {
        // 保持挂起等待取消信号
      },
      cancel() {
        cancelled = true;
      },
    });
    const consuming = (async () => {
      for await (const _frame of parseSSEFrames(stream, {
        idleTimeoutMs: 5_000,
        signal: controller.signal,
      })) {
        // no-op
      }
    })();
    await Promise.resolve();
    controller.abort();
    await expect(consuming).rejects.toMatchObject({
      name: 'AbortError',
      code: 'ABORTED',
    });
    expect(cancelled).toBe(true);
  });
});

describe('parseRetryHeaders', () => {
  it('parses x-should-retry, retry-after-ms, float seconds and HTTP-date headers', () => {
    const now = Date.parse('2026-11-27T10:00:00.000Z');
    expect(
      parseRetryHeaders(
        new Headers({ 'x-should-retry': 'false', 'retry-after-ms': '1200.2' }),
        now,
      ),
    ).toEqual({ shouldRetry: false, retryAfterMs: 1201 });
    expect(
      parseRetryHeaders(new Headers({ 'x-should-retry': '1', 'retry-after': '1.5' }), now),
    ).toEqual({ shouldRetry: true, retryAfterMs: 1500 });
    expect(
      parseRetryHeaders(
        new Headers({ 'x-should-retry': '0', 'retry-after': 'Fri, 27 Nov 2026 10:00:04 GMT' }),
        now,
      ),
    ).toEqual({ shouldRetry: false, retryAfterMs: 4000 });
    expect(
      parseRetryHeaders(new Headers({ 'retry-after': 'Fri, 27 Nov 2026 09:59:55 GMT' }), now),
    ).toEqual({ retryAfterMs: 0 });
    expect(parseRetryHeaders(new Headers({ 'retry-after': '-5' }), now)).toEqual({});
  });
});

describe('shared model HTTP lifecycle', () => {
  it('limits only connection time and closes a timed out fetch', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init.signal.addEventListener('abort', () => reject(new Error('aborted')), {
              once: true,
            }),
          ),
      ),
    );
    try {
      const opening = openModelResponse({
        url: 'https://example.test',
        headers: {},
        payload: {},
        connectTimeoutMs: 10,
      });
      const check = expect(opening).rejects.toMatchObject({ stage: 'connect', status: 408 });
      await vi.advanceTimersByTimeAsync(10);
      await check;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
  it('preserves a caller abort instead of classifying it as a connection timeout', async () => {
    const caller = new AbortController();
    caller.abort();
    const error = new DOMException('aborted', 'AbortError');
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        expect(init.signal.aborted).toBe(true);
        throw error;
      }),
    );
    try {
      await expect(
        openModelResponse({
          url: 'https://example.test',
          headers: {},
          payload: {},
          signal: caller.signal,
        }),
      ).rejects.toBe(error);
    } finally {
      vi.unstubAllGlobals();
    }
  });
  it('keeps caller abort linked after headers and closes the request explicitly', async () => {
    const caller = new AbortController();
    let fetchSignal: AbortSignal | null | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        fetchSignal = init.signal;
        return { ok: true, body: new ReadableStream() };
      }),
    );
    try {
      const opened = await openModelResponse({
        url: 'https://example.test/v1/messages',
        headers: {},
        payload: {},
        signal: caller.signal,
      });
      expect(fetchSignal?.aborted).toBe(false);
      caller.abort();
      expect(fetchSignal?.aborted).toBe(true);
      opened.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('classifies context overflow without returning private error text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        text: async () =>
          JSON.stringify({ error: { code: 'context_length_exceeded', message: 'private prompt' } }),
      })),
    );
    try {
      await expect(
        openModelResponse({ url: 'https://example.test', headers: {}, payload: {} }),
      ).rejects.toMatchObject({
        code: 'MODEL_CONTEXT_EXCEEDED',
        message: 'Model context window exceeded',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('keeps Anthropic message-based overflow recognition out of other protocols', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: {
                type: 'invalid_request_error',
                message: 'prompt is too long: 210000 tokens > 200000 maximum',
              },
            }),
            { status: 400 },
          ),
      ),
    );
    try {
      for (const protocol of [undefined, 'openai-compatible', 'openai-responses'] as const)
        await expect(
          openModelResponse({ url: 'https://example.test', headers: {}, payload: {}, protocol }),
        ).rejects.toMatchObject({
          code: 'MODEL_INVALID_REQUEST',
          category: 'invalid_request',
          message: 'Model API request failed (400)',
        });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('attaches retryAfterMs and honors x-should-retry except for auth/quota/context', async () => {
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: { code: 'rate_limit_error' } }), {
              status: 429,
              headers: { 'x-should-retry': 'false', 'retry-after': '3' },
            }),
        ),
      );
      await expect(
        openModelResponse({ url: 'https://example.test', headers: {}, payload: {} }),
      ).rejects.toMatchObject({
        status: 429,
        category: 'rate_limit',
        retryable: false,
        retryAfterMs: 3000,
      });

      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: { code: 'lock_timeout' } }), {
              status: 409,
              headers: { 'x-should-retry': 'true', 'retry-after-ms': '750' },
            }),
        ),
      );
      await expect(
        openModelResponse({ url: 'https://example.test', headers: {}, payload: {} }),
      ).rejects.toMatchObject({
        status: 409,
        retryable: true,
        retryAfterMs: 750,
      });

      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: { code: 'insufficient_quota' } }), {
              status: 429,
              headers: { 'x-should-retry': 'true' },
            }),
        ),
      );
      await expect(
        openModelResponse({ url: 'https://example.test', headers: {}, payload: {} }),
      ).rejects.toMatchObject({
        status: 429,
        category: 'quota',
        retryable: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('bounds non-2xx error body reads so stalled 502/429 bodies cannot hang openModelResponse forever', async () => {
    vi.useFakeTimers();
    let fetchAborted = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url, init) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            fetchAborted = true;
          },
          { once: true },
        );
        return {
          ok: false,
          status: 502,
          statusText: 'Bad Gateway',
          headers: new Headers(),
          text: () => new Promise<string>(() => {}),
        };
      }),
    );
    try {
      const opening = openModelResponse({
        url: 'https://example.test/v1/chat/completions',
        headers: {},
        payload: {},
        connectTimeoutMs: 30_000,
      });
      const assertion = expect(opening).rejects.toMatchObject({
        status: 502,
        stage: 'response',
        category: 'service',
        retryable: true,
      });
      // Bounded at Math.min(connectTimeoutMs, 15_000) = 15_000ms
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(fetchAborted).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('parses top-level Zhipu 429 quota JSON and string error payloads as non-retryable quota errors', async () => {
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ code: '1304', message: '配额已耗尽' }), {
              status: 429,
            }),
        ),
      );
      await expect(
        openModelResponse({
          url: 'https://open.bigmodel.cn/api/paas/v4/chat/completions',
          headers: {},
          payload: {},
        }),
      ).rejects.toMatchObject({
        status: 429,
        providerCode: '1304',
        category: 'quota',
        retryable: false,
      });

      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () =>
            new Response(JSON.stringify({ error: 'insufficient_quota' }), {
              status: 429,
            }),
        ),
      );
      await expect(
        openModelResponse({
          url: 'https://example.test/v1/chat/completions',
          headers: {},
          payload: {},
        }),
      ).rejects.toMatchObject({
        status: 429,
        providerCode: 'insufficient_quota',
        category: 'quota',
        retryable: false,
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('normalizes caller aborts during stream consumption to AbortError in OpenAICompatibleProvider and OpenAIResponsesProvider', async () => {
    try {
      const chatController = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          body: new ReadableStream<Uint8Array>({
            pull() {
              chatController.abort();
              throw new Error('raw socket abort error');
            },
          }),
        })),
      );
      const chatProvider = new OpenAICompatibleProvider({
        baseURL: 'https://example.test/v1',
        apiKey: 'test',
        modelName: 'gpt-test',
      });
      await expect(
        (async () => {
          for await (const _ of chatProvider.create({
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            signal: chatController.signal,
          })) {
            // drain
          }
        })(),
      ).rejects.toBeInstanceOf(AbortError);

      const respController = new AbortController();
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({
          ok: true,
          body: new ReadableStream<Uint8Array>({
            pull() {
              respController.abort();
              throw new Error('raw socket abort error');
            },
          }),
        })),
      );
      const responsesProvider = new OpenAIResponsesProvider({
        baseURL: 'https://example.test/v1',
        apiKey: 'test',
        modelName: 'gpt-test',
      });
      await expect(
        (async () => {
          for await (const _ of responsesProvider.create({
            messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
            signal: respController.signal,
          })) {
            // drain
          }
        })(),
      ).rejects.toBeInstanceOf(AbortError);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
