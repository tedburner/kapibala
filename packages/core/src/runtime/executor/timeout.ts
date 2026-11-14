import { KapibalaError } from '../../errors/index.js';

/**
 * 给工具执行加超时护栏：Promise.race 在超时后 reject，执行方拿到 isError 结果继续运转，
 * 不会因某个异步工具挂起而永久卡死会话循环。
 *
 * 局限：同步 CPU 密集型实现会阻塞事件循环，timer 同样无法触发；
 * 因此内置工具仍需避免执行用户可控的同步高复杂度计算。
 *
 * 保证：超时错误为 OUTCOME_UNKNOWN（retryPolicy after_user_action）——副作用
 * 是否完成不可知，调用方不得将其闭合为普通失败结果；触发时以同一错误中止
 * executionController，让已注册的执行内监听同步感知取消。
 */
export function withToolTimeout<T>(
  promise: Promise<T>,
  toolName: string,
  timeoutMs: number,
  executionController: AbortController,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new KapibalaError(`Tool '${toolName}' timed out after ${timeoutMs}ms`, {
        code: 'OUTCOME_UNKNOWN',
        retryPolicy: 'after_user_action',
        safeMessage: 'Tool timed out; completion of side effects is unknown',
      });
      reject(error);
      executionController.abort(error);
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
