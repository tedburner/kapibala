import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { JsonlDecoder } from '../src/transport/jsonl.js';
import { createStdioTransport } from '../src/transport/stdio.js';

const ping = { jsonrpc: '2.0' as const, id: 'c:1', method: 'ping' as const, params: {} };
const wire = (value: unknown) => Buffer.from(`${JSON.stringify(value)}\n`);

describe('bounded local JSONL transport', () => {
  it('handles multibyte splits, CRLF, coalescing and Unicode separators inside strings', () => {
    const message = {
      jsonrpc: '2.0',
      id: 'c:1',
      method: 'run/start',
      params: {
        sessionId: 's',
        streamEpoch: 'e',
        controlEpoch: 'c',
        clientOperationId: 'o',
        input: '你好\u2028\u2029',
      },
    };
    const decoder = new JsonlDecoder();
    const bytes = Buffer.from(`${JSON.stringify(message)}\r\n${JSON.stringify(ping)}\n`);
    const result = [];
    for (const byte of bytes) result.push(...decoder.push(Uint8Array.of(byte)));
    expect(result).toEqual([message, ping]);
    expect(() => decoder.end()).not.toThrow();
  });

  it('rejects overlong, invalid UTF-8 and unfinished frames', () => {
    expect(() => new JsonlDecoder(4).push(Buffer.from('12345'))).toThrow(/frame/i);
    expect(() => new JsonlDecoder().push(Uint8Array.of(0xff, 10))).toThrow(/UTF|encoding/i);
    const decoder = new JsonlDecoder();
    decoder.push(Buffer.from('{'));
    expect(() => decoder.end()).toThrow(/frame/i);
    expect(() => decoder.push(wire(ping))).toThrow();
  });

  it('keeps the decoder usable after a content error and reports it to the caller', () => {
    const decoder = new JsonlDecoder();
    expect(() => decoder.push(Buffer.from('{bad}\n'))).toThrow(/JSON|message/i);
    expect(decoder.push(wire(ping))).toEqual([ping]);
    const invalid: { error: { code: number }; raw: string }[] = [];
    const messages = decoder.push(
      Buffer.from(`${JSON.stringify({ ...ping, method: 'unknown' })}\n${JSON.stringify(ping)}\n`),
      undefined,
      (frame) => invalid.push(frame),
    );
    expect(messages).toEqual([ping]);
    expect(invalid).toMatchObject([
      { error: { code: -32601 }, raw: expect.stringContaining('unknown') },
    ]);
  });

  it('answers invalid frames with standard errors and keeps the connection usable', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createStdioTransport(input, output);
    const messages = transport.messages[Symbol.asyncIterator]();
    let text = '';
    output.on('data', (chunk: Buffer) => {
      text += chunk.toString();
    });
    input.write('{bad}\n');
    input.write(`${JSON.stringify({ ...ping, params: { extra: true } })}\n`);
    input.write(`${JSON.stringify({ ...ping, method: 'unknown' })}\n`);
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 'c:9' })}\n`);
    input.write(wire(ping));
    expect((await messages.next()).value).toEqual(ping);
    await new Promise((resolve) => setImmediate(resolve));
    expect(
      text
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line)),
    ).toMatchObject([
      { id: null, error: { code: -32700, data: { code: 'PARSE_ERROR' } } },
      { id: 'c:1', error: { code: -32602, data: { code: 'INVALID_PARAMS' } } },
      { id: 'c:1', error: { code: -32601, data: { code: 'METHOD_NOT_FOUND' } } },
      { id: null, error: { code: -32600, data: { code: 'INVALID_REQUEST' } } },
    ]);
    await transport.close();
  });

  it('limits each frame rather than the size of a coalesced chunk', () => {
    const decoder = new JsonlDecoder(100);
    expect(decoder.push(Buffer.concat(Array.from({ length: 100 }, () => wire(ping))))).toHaveLength(
      100,
    );
  });

  it('rejects infinitely many tiny queued messages while the consumer is stalled', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const transport = createStdioTransport(input, output, { maxQueuedMessages: 2 });
    input.write(
      Buffer.concat([wire(ping), wire(ping), wire(ping), Buffer.from('{invalid later}\n')]),
    );
    await expect(transport.messages[Symbol.asyncIterator]().next()).rejects.toThrow(/queue/i);
    await transport.close();
  });

  it('keeps reading cancellation while output is backpressured, without owning supplied streams', async () => {
    const input = new PassThrough();
    const output = new PassThrough({ highWaterMark: 1 });
    const transport = createStdioTransport(input, output);
    const sending = transport.send(ping);
    input.write(wire(ping));
    expect((await transport.messages[Symbol.asyncIterator]().next()).value).toEqual(ping);
    output.resume();
    await sending;
    await transport.close();
    expect(input.destroyed).toBe(false);
    expect(output.destroyed).toBe(false);
    expect(input.listenerCount('data')).toBe(0);
  });

  it('rejects pending writes when closed and rejects sends after close', async () => {
    const input = new PassThrough();
    const output = new PassThrough({ highWaterMark: 1 });
    const transport = createStdioTransport(input, output);
    const sending = transport.send(ping);
    const rejection = expect(sending).rejects.toThrow(/closed/i);
    await transport.close();
    await rejection;
    await expect(transport.send(ping)).rejects.toThrow(/closed/i);
    expect(output.listenerCount('drain')).toBe(0);
  });
});
