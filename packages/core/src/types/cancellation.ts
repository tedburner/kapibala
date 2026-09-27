/**
 * 包装异步生成器，在消费者 return/throw 时立即中止在途工作，并等候生成器 finally 收口。
 * 外部 signal 只单向传入；结束后解除监听，不能中止宿主的共享 signal。
 */
export function cancellableGenerator<T>(
  create: (signal: AbortSignal) => AsyncGenerator<T>,
  external?: AbortSignal,
): AsyncGenerator<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  external?.addEventListener('abort', abort, { once: true });
  if (external?.aborted) abort();
  const inner = create(controller.signal);
  const cleanup = () => external?.removeEventListener('abort', abort);
  return {
    async next(value) {
      try {
        const result = await inner.next(value);
        if (result.done) cleanup();
        return result;
      } catch (error) {
        cleanup();
        throw error;
      }
    },
    async return(value) {
      abort();
      try {
        return await inner.return(value);
      } finally {
        cleanup();
      }
    },
    async throw(error) {
      abort();
      try {
        return await inner.throw(error);
      } finally {
        cleanup();
      }
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}
