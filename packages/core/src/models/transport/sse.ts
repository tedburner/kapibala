import { AbortError, ModelError } from '../../errors/index.js';

/** SSE 流分块空闲读取默认看门狗超时（90 秒）。 */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;

/** SSE 帧解析器守卫配置。 */
export interface ParseSSEOptions {
  /** 相邻分块最大空闲等待毫秒数；缺省 90_000ms，超时主动取消 reader 并抛出可重试超时错误。 */
  readonly idleTimeoutMs?: number;
  /** 外部取消信号；触发时立即唤醒挂起读取并抛出 AbortError，不误判为可重试网络中断。 */
  readonly signal?: AbortSignal;
}

/** 一帧完整的 SSE 事件；event 缺省为 'message'，多行 data 以换行符合并。 */
export interface SSEFrame {
  event: string;
  data: string;
}

/** 解析完整 SSE 帧；保留多行 data 和分片 UTF-8，内置分块空闲看门狗并在提前结束时等待 reader 清理。 */
export async function* parseSSEFrames(
  stream: ReadableStream<Uint8Array>,
  options?: ParseSSEOptions,
): AsyncIterable<SSEFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const signal = options?.signal;
  let buffer = '';
  let data: string[] = [];
  let event = 'message';
  let frameLength = 0;

  const readNextChunk = async () => {
    if (signal?.aborted) throw new AbortError();
    const readPromise = reader.read();
    readPromise.catch(() => undefined);
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const guard = new Promise<never>((_resolve, reject) => {
      if (Number.isFinite(idleTimeoutMs) && idleTimeoutMs > 0) {
        timer = setTimeout(() => {
          reject(
            new ModelError('Model stream idle timeout', {
              code: 'MODEL_STREAM_IDLE_TIMEOUT',
              stage: 'stream',
              transportCode: 'ETIMEDOUT',
              retryable: true,
            }),
          );
        }, idleTimeoutMs);
      }
      if (signal) {
        onAbort = () => reject(new AbortError());
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    try {
      return await Promise.race([readPromise, guard]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  };

  const feed = (line: string): SSEFrame | undefined => {
    if (!line) {
      const frame = data.length ? { event, data: data.join('\n') } : undefined;
      data = [];
      event = 'message';
      frameLength = 0;
      return frame;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') {
      data.push(value);
      frameLength += value.length;
    } else if (field === 'event') event = value || 'message';
    if (frameLength > 16 * 1024 * 1024)
      throw new ModelError('Model SSE frame exceeds the supported size', {
        code: 'MODEL_INVALID_RESPONSE',
        stage: 'stream',
        retryable: false,
      });
  };
  try {
    let ended = false;
    while (!ended) {
      const next = await readNextChunk();
      ended = next.done;
      try {
        buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
      } catch {
        if (next.done) {
          throw new ModelError('Model stream ended with an incomplete UTF-8 sequence', {
            code: 'MODEL_STREAM_INTERRUPTED',
            stage: 'stream',
            retryable: true,
          });
        }
        throw new ModelError('Model stream contained invalid UTF-8 bytes', {
          code: 'MODEL_INVALID_RESPONSE',
          stage: 'stream',
          retryable: false,
        });
      }
      while (true) {
        const index = buffer.search(/[\r\n]/);
        if (index < 0 || (!ended && buffer[index] === '\r' && index === buffer.length - 1)) break;
        const line = buffer.slice(0, index);
        const width = buffer[index] === '\r' && buffer[index + 1] === '\n' ? 2 : 1;
        buffer = buffer.slice(index + width);
        const frame = feed(line);
        if (frame) yield frame;
      }
      if (buffer.length > 16 * 1024 * 1024)
        throw new ModelError('Model SSE line exceeds the supported size', {
          code: 'MODEL_INVALID_RESPONSE',
          stage: 'stream',
          retryable: false,
        });
    }
    const hadUnterminatedLine = buffer.length > 0;
    if (buffer) feed(buffer);
    const tail = feed('');
    if (tail) {
      // 未遇空行终止符即到达 EOF 时，若载荷形似 JSON（或截断的 `[DONE]`）且无法解析，
      // 属于传输层在帧中间被正常 EOF 截断，必须报可重试的流中断而非不可重试的格式错误。
      const trimmed = tail.data.trimStart();
      if ((trimmed.startsWith('{') || trimmed.startsWith('[')) && trimmed.trim() !== '[DONE]') {
        try {
          JSON.parse(tail.data);
        } catch {
          throw new ModelError(
            hadUnterminatedLine
              ? 'Model SSE stream ended mid-line before JSON frame completed'
              : 'Model SSE stream ended before JSON frame boundary',
            {
              code: 'MODEL_STREAM_INTERRUPTED',
              stage: 'stream',
              retryable: true,
            },
          );
        }
      }
      yield tail;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 保留原始流错误；取消失败不覆盖它。 */
    }
    try {
      reader.releaseLock();
    } catch {
      /* 忽略极端态下的锁释放异常。 */
    }
  }
}
