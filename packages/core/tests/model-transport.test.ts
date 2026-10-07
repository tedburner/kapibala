import { describe, expect, it, vi } from 'vitest';
import { openModelResponse } from '../src/models/transport/http.js';
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
});
