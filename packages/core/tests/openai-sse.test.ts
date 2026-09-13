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
});
