import type { Readable, Writable } from 'node:stream';
import {
  DEFAULT_LIMITS,
  type WireMessage,
  type WireResponse,
  validateMessage,
  wireCodeForRpcCode,
} from '../protocol/index.js';
import { JsonlDecoder } from './jsonl.js';
import type { LocalTransport } from './types.js';

/** 输入队列同时限制消息数量和字节数，避免大量小消息绕过字节预算。 */
export interface StdioTransportOptions {
  maxQueuedMessages?: number;
  maxQueueBytes?: number;
  maxFrameBytes?: number;
}

const REQUEST_ID = /^[cs]:[^\s]{1,254}$/;

/**
 * 从内容非法但仍是 JSON 的帧中恢复请求 id；语法错误没有可关联 id。
 * 只读取自有属性，避免触发访问器或执行调用方代码。
 */
function recoverRequestId(raw: string): string | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value);
    if (!keys.includes('method')) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'id');
    return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
      ? REQUEST_ID.test(descriptor.value)
        ? descriptor.value
        : null
      : null;
  } catch {
    return null;
  }
}

/**
 * 适配父子进程管道或 socket 的双向流；写入等待回调但不暂停输入。
 * 非法帧按 JSON-RPC 返回错误后连接保持可用；只有帧预算、UTF-8 与 EOF 半帧才终止。
 * 不注册全局进程事件、不写日志、不销毁传入流，流的所有者负责进程/socket 生命周期。
 */
export function createStdioTransport(
  input: Readable,
  output: Writable,
  options: StdioTransportOptions = {},
): LocalTransport {
  const maxMessages = options.maxQueuedMessages ?? DEFAULT_LIMITS.maxInflightRequests;
  const maxBytes = options.maxQueueBytes ?? DEFAULT_LIMITS.maxSendQueueBytes;
  const maxFrame = options.maxFrameBytes ?? DEFAULT_LIMITS.maxFrameBytes;
  if (![maxMessages, maxBytes, maxFrame].every((value) => Number.isSafeInteger(value) && value > 0))
    throw new Error('Invalid transport budget');
  const decoder = new JsonlDecoder(maxFrame);
  const queue: { message: WireMessage; bytes: number }[] = [];
  const writes = new Set<(error?: Error) => void>();
  let queuedBytes = 0;
  let writingBytes = 0;
  let stopped = false;
  let failure: Error | undefined;
  let claimed = false;
  let waiting:
    | { resolve: (result: IteratorResult<WireMessage>) => void; reject: (error: Error) => void }
    | undefined;

  const finish = (error?: Error) => {
    if (stopped) return;
    stopped = true;
    failure = error;
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('close', onClose);
    input.off('error', onError);
    output.off('error', onError);
    output.off('close', onOutputClose);
    if (error) {
      queue.length = 0;
      queuedBytes = 0;
    }
    if (waiting) {
      error ? waiting.reject(error) : waiting.resolve({ value: undefined, done: true });
      waiting = undefined;
    }
    for (const write of [...writes]) write(error ?? new Error('Transport closed'));
  };
  const onError = () => finish(new Error('Transport stream failed'));
  const onOutputClose = () => finish(new Error('Transport output closed'));
  const onEnd = () => {
    try {
      decoder.end();
      finish();
    } catch {
      finish(new Error('Unfinished JSONL frame at EOF'));
    }
  };
  const onClose = () => {
    if (!stopped) finish(new Error('Transport input closed'));
  };
  const onData = (chunk: Buffer | string) => {
    try {
      decoder.push(
        typeof chunk === 'string' ? Buffer.from(chunk) : chunk,
        (message) => {
          if (waiting) {
            const reader = waiting;
            waiting = undefined;
            reader.resolve({ value: message, done: false });
            return;
          }
          const bytes = Buffer.byteLength(JSON.stringify(message));
          if (queue.length >= maxMessages || queuedBytes + bytes > maxBytes)
            throw new Error('Transport input queue exceeded');
          queue.push({ message, bytes });
          queuedBytes += bytes;
        },
        (frame) => {
          // 内容非法只拒绝该帧；错误响应仍走同一发送队列，连接可继续处理后续帧。
          const response: WireResponse = {
            jsonrpc: '2.0',
            id: recoverRequestId(frame.raw),
            error: {
              code: frame.error.code,
              message: frame.error.message,
              data: { code: wireCodeForRpcCode(frame.error.code) },
            },
          };
          void transport
            .send(response)
            .catch(() => finish(new Error('Transport output queue exceeded')));
        },
      );
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Invalid transport message'));
    }
  };
  const transport: LocalTransport = {
    messages: {
      [Symbol.asyncIterator]() {
        if (claimed) throw new Error('Transport supports one message consumer');
        claimed = true;
        return {
          next(): Promise<IteratorResult<WireMessage>> {
            if (failure) return Promise.reject(failure);
            const entry = queue.shift();
            if (entry) {
              queuedBytes -= entry.bytes;
              return Promise.resolve({ value: entry.message, done: false });
            }
            if (stopped) return Promise.resolve({ value: undefined, done: true });
            if (waiting)
              return Promise.reject(new Error('Concurrent transport reads are not supported'));
            return new Promise((resolve, reject) => {
              waiting = { resolve, reject };
            });
          },
          async return(): Promise<IteratorResult<WireMessage>> {
            await transport.close();
            return { value: undefined, done: true };
          },
        };
      },
    },
    async send(message) {
      if (stopped || output.destroyed || output.writableEnded) throw new Error('Transport closed');
      const validated = validateMessage(message);
      if (!validated.ok) throw new Error('Invalid outgoing message');
      const text = `${JSON.stringify(validated.value)}\n`;
      const bytes = Buffer.byteLength(text);
      if (bytes - 1 > maxFrame || writingBytes + bytes > maxBytes)
        throw new Error('Transport output queue exceeded');
      writingBytes += bytes;
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (error?: Error | null) => {
          if (settled) return;
          settled = true;
          writes.delete(settle);
          writingBytes -= bytes;
          error ? reject(error) : resolve();
        };
        writes.add(settle);
        try {
          output.write(text, settle);
        } catch {
          settle(new Error('Transport write failed'));
        }
      });
    },
    async close() {
      finish();
      queue.length = 0;
      queuedBytes = 0;
    },
  };
  // 监听注册放在 transport 初始化之后：非法帧的错误响应需要复用 send 的预算与背压。
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('close', onClose);
  input.on('error', onError);
  output.on('error', onError);
  output.on('close', onOutputClose);
  return transport;
}
