/**
 * Lightweight Server-Sent Events (SSE) stream parser for Node.js fetch
 */

export async function* parseSSEStream(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? ''; // 保持最后一个未完成行

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) {
          continue; // 心跳或注释
        }

        if (trimmed.startsWith('data:')) {
          const dataContent = trimmed.slice(5).trim();
          if (dataContent === '[DONE]') {
            return;
          }
          yield dataContent;
        }
      }
    }

    if (buffer.trim().startsWith('data:')) {
      const dataContent = buffer.trim().slice(5).trim();
      if (dataContent !== '[DONE]') {
        yield dataContent;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
