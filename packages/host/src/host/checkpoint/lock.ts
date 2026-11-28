/**
 * @fileoverview 检查点桶级双层互斥锁（进程内 FIFO 异步队列 + 跨进程 `checkpoint.lock`）。
 *
 * 设计原因：
 * - 同一宿主进程内可能有后台子代理与主会话并发结算轮次，先由内存 FIFO 队列零轮询串行化；
 * - 跨进程（如 CLI 与 Desktop 同时附着同一项目）通过复用 Core `SessionLock` 在 `<bucketDir>/checkpoint.lock`
 *   落盘带进程启动时间戳的独占目录锁，既具备死亡进程自愈回收，又通过有界退避避免瞬态写竞争直接报错。
 */

import fs from 'node:fs';
import path from 'node:path';
import { SessionLock, toNativePhysicalPath } from '@kiturone/kapibala';
import { CheckpointError } from './types.js';

const CROSS_PROCESS_RETRY_MS = 25;
const DEFAULT_LOCK_WAIT_TIMEOUT_MS = 15_000;

interface QueueEntry {
  readonly run: () => void;
}

/**
 * 管理所有检查点分桶目录的串行化执行协调器。
 *
 * 保证：同一物理 `bucketDir` 在任一时刻至多只有一个写事务操纵 `<sideGitDir>/index` 与 `manifest.jsonl`。
 */
export class CheckpointBucketMutex {
  private readonly queues = new Map<string, QueueEntry[]>();
  private readonly activeKeys = new Set<string>();

  private toKey(bucketDir: string): string {
    const canonical = toNativePhysicalPath(path.resolve(bucketDir));
    return process.platform === 'win32' ? canonical.replaceAll('/', '\\').toLowerCase() : canonical;
  }

  /**
   * 在桶级内存锁与跨进程文件锁 `<bucketDir>/checkpoint.lock` 保护下执行回调。
   *
   * 失败边界：超时或 `signal` 取消时抛出 `CheckpointError`（超时带 `isTimeout = true` 供前置熔断识别）。
   */
  async withLock<T>(
    bucketDir: string,
    action: () => Promise<T>,
    options?: { readonly timeoutMs?: number; readonly signal?: AbortSignal },
  ): Promise<T> {
    fs.mkdirSync(bucketDir, { recursive: true, mode: 0o700 });
    const key = this.toKey(bucketDir);
    const deadline =
      options?.timeoutMs !== undefined
        ? Date.now() + Math.max(1, options.timeoutMs)
        : Date.now() + DEFAULT_LOCK_WAIT_TIMEOUT_MS;

    await this.acquireInProcess(key, deadline, options?.signal);
    let fileLock: SessionLock | undefined;
    try {
      const lockPath = path.join(bucketDir, 'checkpoint.lock');
      fileLock = await acquireCrossProcessLock(lockPath, deadline, options?.signal);
      return await action();
    } finally {
      try {
        await fileLock?.release();
      } finally {
        this.releaseInProcess(key);
      }
    }
  }

  private acquireInProcess(key: string, deadline: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(
        new CheckpointError('CHECKPOINT_LOCK_TIMEOUT', 'Checkpoint lock aborted'),
      );
    }
    if (!this.activeKeys.has(key)) {
      this.activeKeys.add(key);
      return Promise.resolve();
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const err = new CheckpointError(
        'CHECKPOINT_LOCK_TIMEOUT',
        'Timed out waiting for in-process checkpoint lock',
        'backoff',
      );
      (err as CheckpointError & { isTimeout?: boolean }).isTimeout = true;
      return Promise.reject(err);
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const queue = this.queues.get(key) ?? [];
      this.queues.set(key, queue);

      const entry: QueueEntry = {
        run: () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (signal && onAbort) signal.removeEventListener('abort', onAbort);
          resolve();
        },
      };

      const removeEntry = () => {
        const q = this.queues.get(key);
        if (!q) return;
        const idx = q.indexOf(entry);
        if (idx >= 0) q.splice(idx, 1);
        if (q.length === 0) this.queues.delete(key);
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (signal && onAbort) signal.removeEventListener('abort', onAbort);
        removeEntry();
        const err = new CheckpointError(
          'CHECKPOINT_LOCK_TIMEOUT',
          'Timed out waiting for in-process checkpoint lock',
          'backoff',
        );
        (err as CheckpointError & { isTimeout?: boolean }).isTimeout = true;
        reject(err);
      }, remaining);

      const onAbort = signal
        ? () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            removeEntry();
            reject(new CheckpointError('CHECKPOINT_LOCK_TIMEOUT', 'Checkpoint lock aborted'));
          }
        : undefined;

      if (signal && onAbort) {
        signal.addEventListener('abort', onAbort, { once: true });
      }

      queue.push(entry);
    });
  }

  private releaseInProcess(key: string): void {
    const queue = this.queues.get(key);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) this.queues.delete(key);
      next.run();
      return;
    }
    this.activeKeys.delete(key);
  }
}

async function acquireCrossProcessLock(
  lockPath: string,
  deadline: number,
  signal?: AbortSignal,
): Promise<SessionLock> {
  for (;;) {
    if (signal?.aborted) {
      throw new CheckpointError('CHECKPOINT_LOCK_TIMEOUT', 'Checkpoint lock aborted');
    }
    try {
      return await SessionLock.acquire(lockPath);
    } catch (err) {
      const code = (err as { code?: string }).code;
      const retryable =
        code === 'SESSION_LOCKED' ||
        code === 'SESSION_RECOVERY_IN_PROGRESS' ||
        code === 'SESSION_LOCK_OWNER_CHANGED';
      if (!retryable) throw err;

      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        const timeoutErr = new CheckpointError(
          'CHECKPOINT_LOCK_TIMEOUT',
          `Timed out acquiring ${path.basename(lockPath)}`,
          'backoff',
        );
        (timeoutErr as CheckpointError & { isTimeout?: boolean }).isTimeout = true;
        throw timeoutErr;
      }
      await sleepWithSignal(Math.min(CROSS_PROCESS_RETRY_MS, remaining), signal);
    }
  }
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CheckpointError('CHECKPOINT_LOCK_TIMEOUT', 'Checkpoint lock aborted'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = signal
      ? () => {
          clearTimeout(timer);
          reject(new CheckpointError('CHECKPOINT_LOCK_TIMEOUT', 'Checkpoint lock aborted'));
        }
      : undefined;
    if (signal && onAbort) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** Windows 下防瞬态杀毒软件或文件索引占用导致原子替换失败的重试封装。 */
export function renameAtomicSync(tempPath: string, targetPath: string): void {
  const maxAttempts = 4;
  const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        process.platform === 'win32' &&
        (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') &&
        attempt < maxAttempts
      ) {
        Atomics.wait(waitBuffer, 0, 0, 20);
        continue;
      }
      throw err;
    }
  }
}
