/**
 * Lightweight Server-Sent Events (SSE) stream parser for Node.js fetch
 */

/** 逐行解析 SSE；报告明确 DONE，提前退出时取消并等待 reader 清理再释放锁。 */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  onDone?: () => void,
): AsyncIterable<string> {
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
            onDone?.();
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
      } else onDone?.();
    }
  } finally {
    try {
      await reader.cancel();
    } finally {
      reader.releaseLock();
    }
  }
}
