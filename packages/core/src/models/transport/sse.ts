import { ModelError } from '../../errors/index.js';

/** 一帧完整的 SSE 事件；event 缺省为 'message'，多行 data 以换行符合并。 */
export interface SSEFrame {
  event: string;
  data: string;
}

/** 解析完整 SSE 帧；保留多行 data 和分片 UTF-8，提前结束时等待 reader 清理。 */
export async function* parseSSEFrames(stream: ReadableStream<Uint8Array>): AsyncIterable<SSEFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let data: string[] = [];
  let event = 'message';
  let frameLength = 0;
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
      const next = await reader.read();
      ended = next.done;
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true });
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
    if (buffer) feed(buffer);
    const tail = feed('');
    if (tail) yield tail;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* 保留原始流错误；取消失败不覆盖它。 */
    }
    reader.releaseLock();
  }
}
