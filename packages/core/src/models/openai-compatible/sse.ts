import { parseSSEFrames } from '../transport/sse.js';

/** 逐行解析 SSE；报告明确 DONE，提前退出时取消并等待 reader 清理再释放锁。 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  onDone?: () => void,
): AsyncIterable<string> {
  for await (const frame of parseSSEFrames(stream)) {
    if (frame.data.trim() === '[DONE]') {
      onDone?.();
      return;
    }
    yield frame.data;
  }
}
