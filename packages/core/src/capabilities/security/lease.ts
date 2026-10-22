/**
 * @fileoverview 共享工作区写租约（Workspace Write Lease）协调器。
 *
 * 约束、边界与为什么：
 * 1. 串行化共享工作区写操作：
 *    当多个智能体（如父代理与后台子代理）在同一物理工作区运行且未挂载独立 Git worktree 时，
 *    并发写入会导致文件撕裂与状态脏化。通过写租约对文件写入、Shell 执行与外部写操作进行强制互斥。
 * 2. 覆盖范围不仅限文件写：
 *    写操作涵盖声明了 `fs:write` 的工具、声明了 `exec` 的命令执行、以及未显式声明 `readOnlyHint: true` 的外部 MCP 工具。
 * 3. 安全释放与排队唤醒：
 *    操作完成、异常中止或被取消时，必须在 finally 中安全释放写租约；释放后原子唤醒队列中的下一个排队者。
 *    支持 AbortSignal 取消与超时保护，被取消的排队项安全从队列剔除，防止死锁。
 * 4. 物理根分桶与大小写归一：
 *    租约按物理路径（经 toNativePhysicalPath 规范化）分桶，不同工作区互不影响；
 *    Windows 下路径对比大小写不敏感。
 */

import { randomUUID } from 'node:crypto';
import { isSamePath, toNativePhysicalPath } from '../../context/workspace.js';
import { KapibalaError } from '../../errors/index.js';
import type { Tool } from '../tools/index.js';

/** 活动写租约句柄。持有者调用 release() 释放写锁。 */
export interface WorkspaceWriteLease {
  /** 租约唯一标识。 */
  readonly leaseId: string;
  /** 规范化工作区物理根路径。 */
  readonly workspaceRoot: string;
  /** 租约持有者标识（如 sessionId 或 agentId）。 */
  readonly ownerId: string;
  /** 获取租约的时间戳（毫秒）。 */
  readonly acquiredAt: number;
  /** 释放租约并唤醒后续排队者；多次调用幂等。 */
  release(): void;
}

interface LeaseQueueItem {
  readonly leaseId: string;
  readonly ownerId: string;
  readonly resolve: (lease: WorkspaceWriteLease) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  cleanup?: () => void;
}

interface WorkspaceLeaseBucket {
  readonly canonicalWorkspace: string;
  active?: {
    leaseId: string;
    ownerId: string;
    acquiredAt: number;
  };
  readonly queue: LeaseQueueItem[];
}

/** 判定一个工具是否属于具有写副作用的操作。 */
export function isWriteOperation(tool: Tool): boolean {
  const perms = tool.metadata?.permissions ?? [];
  if (perms.includes('fs:write') || perms.includes('exec')) {
    return true;
  }
  // 外部 MCP 工具且未显式声明只读提示
  if (tool.metadata?.source !== 'builtin' && tool.metadata?.readOnlyHint !== true) {
    return true;
  }
  return false;
}

/**
 * 工作区写租约协调器。
 * 支持同工作区写操作排队与互斥，异工作区并发无阻。
 */
export class WorkspaceLeaseCoordinator {
  private readonly buckets = new Map<string, WorkspaceLeaseBucket>();

  private getBucketKey(workspaceRoot: string): string {
    const canonical = toNativePhysicalPath(workspaceRoot);
    return process.platform === 'win32' ? canonical.replaceAll('/', '\\').toLowerCase() : canonical;
  }

  private getOrCreateBucket(workspaceRoot: string): { key: string; bucket: WorkspaceLeaseBucket } {
    const canonical = toNativePhysicalPath(workspaceRoot);
    const key = this.getBucketKey(canonical);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = { canonicalWorkspace: canonical, queue: [] };
      this.buckets.set(key, bucket);
    }
    return { key, bucket };
  }

  /**
   * 检查指定工作区当前是否有活跃的写租约。
   */
  isLocked(workspaceRoot: string): boolean {
    const key = this.getBucketKey(workspaceRoot);
    const bucket = this.buckets.get(key);
    return bucket?.active !== undefined;
  }

  /**
   * 获取指定工作区当前活跃的租约所有者信息。
   */
  getActiveLease(
    workspaceRoot: string,
  ): { leaseId: string; ownerId: string; acquiredAt: number } | undefined {
    const key = this.getBucketKey(workspaceRoot);
    const bucket = this.buckets.get(key);
    return bucket?.active ? { ...bucket.active } : undefined;
  }

  /**
   * 尝试非阻塞获取写租约。若当前被占用立即返回 undefined。
   */
  tryAcquire(workspaceRoot: string, ownerId: string): WorkspaceWriteLease | undefined {
    const canonical = toNativePhysicalPath(workspaceRoot);
    const { key, bucket } = this.getOrCreateBucket(canonical);

    if (bucket.active) {
      return undefined;
    }

    const leaseId = randomUUID();
    const acquiredAt = Date.now();
    bucket.active = { leaseId, ownerId, acquiredAt };

    let released = false;
    const lease: WorkspaceWriteLease = {
      leaseId,
      workspaceRoot: canonical,
      ownerId,
      acquiredAt,
      release: () => {
        if (released) return;
        released = true;
        this.releaseLease(key, leaseId);
      },
    };

    return lease;
  }

  /**
   * 阻塞排队获取写租约。
   *
   * 保证：
   * - 若无活动租约，立即获取并返回；
   * - 若被占用，加入 FIFO 队列等待；
   * - 支持 AbortSignal 取消；取消时立即移出队列并抛出 ABORTED；
   * - 支持可选超时，超时抛出 LEASE_TIMEOUT。
   */
  async acquire(
    workspaceRoot: string,
    ownerId: string,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<WorkspaceWriteLease> {
    const canonical = toNativePhysicalPath(workspaceRoot);
    const { key, bucket } = this.getOrCreateBucket(canonical);

    if (options?.signal?.aborted) {
      throw new KapibalaError('Write lease acquisition aborted before start', {
        code: 'ABORTED',
        retryPolicy: 'after_user_action',
        safeMessage: '操作已被取消',
      });
    }

    // 若当前无活跃租约且无排队项，直接占有
    if (!bucket.active && bucket.queue.length === 0) {
      const leaseId = randomUUID();
      const acquiredAt = Date.now();
      bucket.active = { leaseId, ownerId, acquiredAt };

      let released = false;
      return {
        leaseId,
        workspaceRoot: canonical,
        ownerId,
        acquiredAt,
        release: () => {
          if (released) return;
          released = true;
          this.releaseLease(key, leaseId);
        },
      };
    }

    // 否则排队等待
    return new Promise<WorkspaceWriteLease>((resolve, reject) => {
      const leaseId = randomUUID();
      let timer: NodeJS.Timeout | undefined;

      const item: LeaseQueueItem = {
        leaseId,
        ownerId,
        resolve: (lease) => {
          if (timer) clearTimeout(timer);
          resolve(lease);
        },
        reject: (error) => {
          if (timer) clearTimeout(timer);
          reject(error);
        },
        signal: options?.signal,
      };

      if (options?.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.removeFromQueue(key, leaseId);
          item.reject(
            new KapibalaError(
              `Write lease acquisition timed out after ${options.timeoutMs}ms for workspace '${canonical}'`,
              {
                code: 'LEASE_TIMEOUT',
                retryPolicy: 'after_user_action',
                safeMessage: '等待工作区写租约超时',
              },
            ),
          );
        }, options.timeoutMs);
      }

      if (options?.signal) {
        const onAbort = () => {
          this.removeFromQueue(key, leaseId);
          item.reject(
            new KapibalaError('Write lease acquisition aborted while waiting in queue', {
              code: 'ABORTED',
              retryPolicy: 'after_user_action',
              safeMessage: '等待工作区写租约被取消',
            }),
          );
        };
        options.signal.addEventListener('abort', onAbort, { once: true });
        item.cleanup = () => {
          options.signal?.removeEventListener('abort', onAbort);
        };
      }

      bucket.queue.push(item);
    });
  }

  private removeFromQueue(key: string, leaseId: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket) return;
    const idx = bucket.queue.findIndex((q) => q.leaseId === leaseId);
    if (idx !== -1) {
      const removed = bucket.queue.splice(idx, 1)[0];
      removed?.cleanup?.();
    }
  }

  private releaseLease(key: string, leaseId: string): void {
    const bucket = this.buckets.get(key);
    if (!bucket || bucket.active?.leaseId !== leaseId) {
      return;
    }

    bucket.active = undefined;

    // 唤醒队列中下一个有效的排队者
    while (bucket.queue.length > 0) {
      const next = bucket.queue.shift()!;
      next.cleanup?.();

      if (next.signal?.aborted) {
        continue;
      }

      const nextLeaseId = next.leaseId;
      const acquiredAt = Date.now();
      bucket.active = { leaseId: nextLeaseId, ownerId: next.ownerId, acquiredAt };

      let released = false;
      const lease: WorkspaceWriteLease = {
        leaseId: nextLeaseId,
        workspaceRoot: bucket.canonicalWorkspace,
        ownerId: next.ownerId,
        acquiredAt,
        release: () => {
          if (released) return;
          released = true;
          this.releaseLease(key, nextLeaseId);
        },
      };

      next.resolve(lease);
      return;
    }

    // 若队列已空，且无活跃租约，清理 bucket
    if (bucket.queue.length === 0 && !bucket.active) {
      this.buckets.delete(key);
    }
  }

  /**
   * 使用写租约包装异步操作。执行完毕或发生异常时在 finally 中安全释放。
   */
  async withWriteLease<T>(
    workspaceRoot: string,
    ownerId: string,
    action: (lease: WorkspaceWriteLease) => Promise<T>,
    options?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<T> {
    const lease = await this.acquire(workspaceRoot, ownerId, options);
    try {
      return await action(lease);
    } finally {
      lease.release();
    }
  }
}
