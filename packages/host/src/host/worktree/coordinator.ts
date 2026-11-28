/**
 * @fileoverview `ExecutionRootCoordinator` —— 横跨本地会话与外部代理会话的物理执行根互斥与移除门闩协调器。
 *
 * 设计动机：
 * - `ManagedHostSession`（内置 Core `WorkspaceLeaseCoordinator`）与 `ExternalSessionService`（独立 CLI 进程）
 *   在未引入宿主级协调前互不感知；当两者同时绑定到同一物理 `executionRoot`（主仓或同一 Worktree）时，
 *   通过本协调器统一追踪活动写运行并按物理路径排队互斥；
 * - 删除或合并受管 Worktree 时，通过 `acquireRemovalFence` 施加排他门闩：若存在活动运行则立即拒绝，
 *   门闩生效期间阻止任何新运行、新子代理或新保活终端附着到该目录（含其子目录）。
 */

import { randomUUID } from 'node:crypto';
import { KapibalaError, isPathInside, isSamePath, toNativePhysicalPath } from '@kiturone/kapibala';
import { WorktreeError } from './types.js';

/**
 * 参与物理执行目录协调的运行子系统类别：
 * `native` 为内置会话与子代理，`external` 为外部 ACP/CLI 进程，`checkpoint` 为磁盘归因回滚事务。
 */
export type ExecutionSubsystemKind = 'native' | 'external' | 'checkpoint';

/** 登记在协调器中的活动写运行只读快照；路径固定为 `fs.realpathSync.native` 物理长路径。 */
export interface ActiveExecutionRun {
  readonly runId: string;
  readonly canonicalExecutionRoot: string;
  readonly ownerId: string;
  readonly kind: ExecutionSubsystemKind;
  readonly startedAt: number;
}

/** 活动写运行句柄；调用 `release()` 幂等注销（若通过排他队列获取则同时唤醒下一等待者）。 */
export interface ExecutionRunHandle extends ActiveExecutionRun {
  release(): void;
}

/** 工作树移除或合并期间持有的排他门闩句柄；生效期间拒绝一切重叠路径的新运行与排队等待者，`release()` 幂等解锁。 */
export interface ExecutionRemovalFence {
  readonly fenceId: string;
  readonly canonicalExecutionRoot: string;
  readonly reason: string;
  readonly acquiredAt: number;
  release(): void;
}

interface WaitQueueEntry {
  readonly runId: string;
  readonly canonicalExecutionRoot: string;
  readonly ownerId: string;
  readonly kind: ExecutionSubsystemKind;
  readonly resolve: (handle: ExecutionRunHandle) => void;
  readonly reject: (error: unknown) => void;
  cleanup?: () => void;
}

/**
 * 将物理执行根规范化为跨平台唯一分桶键（Windows 下采用 native 物理长路径并折叠大小写）。
 */
export function toExecutionRootKey(executionRoot: string): {
  readonly canonicalPath: string;
  readonly key: string;
} {
  const canonicalPath = toNativePhysicalPath(executionRoot);
  const key =
    process.platform === 'win32'
      ? canonicalPath.replaceAll('/', '\\').toLowerCase()
      : canonicalPath;
  return { canonicalPath, key };
}

function pathsOverlap(canonicalA: string, canonicalB: string): boolean {
  return (
    isSamePath(canonicalA, canonicalB) ||
    isPathInside(canonicalA, canonicalB) ||
    isPathInside(canonicalB, canonicalA)
  );
}

/**
 * 宿主级物理执行根活动运行协调器：统一提供跨 `native`/`external` 的 FIFO 排他写租约（`acquireMutatingLease`）、
 * 同树子代理/检查点的非阻塞活动登记（`trackActiveRun`），以及工作树移除/合并时的排他门闩（`acquireRemovalFence`）。
 */
export class ExecutionRootCoordinator {
  private readonly activeRuns = new Map<string, ActiveExecutionRun>();
  private readonly mutexOwners = new Map<string, string>();
  private readonly mutexQueues = new Map<string, WaitQueueEntry[]>();
  private readonly fences = new Map<
    string,
    {
      readonly fenceId: string;
      readonly canonicalExecutionRoot: string;
      readonly reason: string;
      readonly acquiredAt: number;
    }
  >();

  /**
   * 检查给定 `executionRoot`（或其祖先/后代目录）当前是否处于移除/合并门闩保护中。
   */
  isFenced(executionRoot: string): boolean {
    const { canonicalPath } = toExecutionRootKey(executionRoot);
    for (const fence of this.fences.values()) {
      if (pathsOverlap(canonicalPath, fence.canonicalExecutionRoot)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 断言目标执行目录未被施加移除/合并门闩；被门闩锁定时立即抛 `WORKTREE_FENCED`。
   */
  assertNotFenced(executionRoot: string): void {
    if (this.isFenced(executionRoot)) {
      throw new WorktreeError(
        'WORKTREE_FENCED',
        `Execution root is fenced for removal or merge: "${executionRoot}"`,
      );
    }
  }

  /**
   * 检查目标执行目录（或其祖先/后代目录）是否存在正在运行的本地或外部任务。
   */
  hasActiveRuns(executionRoot: string): boolean {
    const { canonicalPath } = toExecutionRootKey(executionRoot);
    for (const run of this.activeRuns.values()) {
      if (pathsOverlap(canonicalPath, run.canonicalExecutionRoot)) {
        return true;
      }
    }
    return false;
  }

  /**
   * 列出与指定 `executionRoot` 重叠的全部活动运行快照（缺省返回全宿主所有活动运行）。
   */
  listActiveRuns(executionRoot?: string): ActiveExecutionRun[] {
    if (!executionRoot) {
      return [...this.activeRuns.values()].map((item) => ({ ...item }));
    }
    const { canonicalPath } = toExecutionRootKey(executionRoot);
    const matches: ActiveExecutionRun[] = [];
    for (const run of this.activeRuns.values()) {
      if (pathsOverlap(canonicalPath, run.canonicalExecutionRoot)) {
        matches.push({ ...run });
      }
    }
    return matches;
  }

  /**
   * 登记一条非排队活动运行（适用于自身已受 `WorkspaceLeaseCoordinator` 约束的同树任务追踪），
   * 但若目标目录已被施加移除/合并门闩则立即抛 `WORKTREE_FENCED` 拦截。
   */
  trackActiveRun(input: {
    readonly executionRoot: string;
    readonly ownerId: string;
    readonly kind: ExecutionSubsystemKind;
  }): ExecutionRunHandle {
    const { canonicalPath } = toExecutionRootKey(input.executionRoot);
    this.assertNotFenced(canonicalPath);

    const runId = randomUUID();
    const record: ActiveExecutionRun = {
      runId,
      canonicalExecutionRoot: canonicalPath,
      ownerId: input.ownerId,
      kind: input.kind,
      startedAt: Date.now(),
    };
    this.activeRuns.set(runId, record);

    let released = false;
    return {
      ...record,
      release: () => {
        if (released) return;
        released = true;
        this.activeRuns.delete(runId);
      },
    };
  }

  /**
   * 跨 `native` 与 `external` 子系统按物理 `executionRoot` 排队获取排他写运行槽位。
   *
   * 保证：
   * - 入队前与唤醒时双重校验移除门闩（若等待期间工作树开始移除，立即拒绝唤醒）；
   * - 支持 `AbortSignal` 取消与 `timeoutMs` 超时，取消后立即从等待队列摘除且零泄漏。
   */
  async acquireMutatingLease(input: {
    readonly executionRoot: string;
    readonly ownerId: string;
    readonly kind: ExecutionSubsystemKind;
    readonly signal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<ExecutionRunHandle> {
    const { canonicalPath, key } = toExecutionRootKey(input.executionRoot);
    this.assertNotFenced(canonicalPath);

    if (input.signal?.aborted) {
      throw new KapibalaError('Execution lease aborted before start', {
        code: 'ABORTED',
        retryPolicy: 'after_user_action',
        safeMessage: '操作已被取消',
      });
    }

    const queue = this.mutexQueues.get(key);
    if (!this.mutexOwners.has(key) && (!queue || queue.length === 0)) {
      return this.installMutexOwner(key, canonicalPath, input.ownerId, input.kind);
    }

    return new Promise<ExecutionRunHandle>((resolve, reject) => {
      const runId = randomUUID();
      let timer: NodeJS.Timeout | undefined;
      const list = this.mutexQueues.get(key) ?? [];
      this.mutexQueues.set(key, list);

      const entry: WaitQueueEntry = {
        runId,
        canonicalExecutionRoot: canonicalPath,
        ownerId: input.ownerId,
        kind: input.kind,
        resolve: (handle) => {
          if (timer) clearTimeout(timer);
          resolve(handle);
        },
        reject: (err) => {
          if (timer) clearTimeout(timer);
          reject(err);
        },
      };

      const removeFromQueue = () => {
        const q = this.mutexQueues.get(key);
        if (!q) return;
        const idx = q.indexOf(entry);
        if (idx >= 0) q.splice(idx, 1);
        if (q.length === 0) this.mutexQueues.delete(key);
        entry.cleanup?.();
      };

      if (input.timeoutMs !== undefined && input.timeoutMs > 0) {
        timer = setTimeout(() => {
          removeFromQueue();
          entry.reject(
            new KapibalaError(
              `Timed out after ${input.timeoutMs}ms waiting for execution root '${canonicalPath}'`,
              {
                code: 'LEASE_TIMEOUT',
                retryPolicy: 'after_user_action',
                safeMessage: '等待工作区执行锁超时',
              },
            ),
          );
        }, input.timeoutMs);
      }

      if (input.signal) {
        const onAbort = () => {
          removeFromQueue();
          entry.reject(
            new KapibalaError('Execution lease aborted while waiting in queue', {
              code: 'ABORTED',
              retryPolicy: 'after_user_action',
              safeMessage: '等待工作区执行锁被取消',
            }),
          );
        };
        input.signal.addEventListener('abort', onAbort, { once: true });
        entry.cleanup = () => {
          input.signal?.removeEventListener('abort', onAbort);
        };
      }

      list.push(entry);
    });
  }

  /**
   * 在排他写运行槽位保护下执行异步动作，`finally` 自动释放。
   */
  async withMutatingLease<T>(
    input: {
      readonly executionRoot: string;
      readonly ownerId: string;
      readonly kind: ExecutionSubsystemKind;
      readonly signal?: AbortSignal;
      readonly timeoutMs?: number;
    },
    action: (handle: ExecutionRunHandle) => Promise<T>,
  ): Promise<T> {
    const handle = await this.acquireMutatingLease(input);
    try {
      return await action(handle);
    } finally {
      handle.release();
    }
  }

  /**
   * 为即将移除或合并的 `executionRoot` 获取同步排他门闩。
   *
   * 失败边界：
   * - 存在任何重叠的活动运行时立即抛 `WORKTREE_ACTIVE_RUN`；
   * - 已被其他门闩锁定时立即抛 `WORKTREE_BUSY`。
   */
  acquireRemovalFence(executionRoot: string, reason = 'remove'): ExecutionRemovalFence {
    const { canonicalPath } = toExecutionRootKey(executionRoot);

    for (const fence of this.fences.values()) {
      if (pathsOverlap(canonicalPath, fence.canonicalExecutionRoot)) {
        throw new WorktreeError(
          'WORKTREE_BUSY',
          `Execution root '${canonicalPath}' already fenced (${fence.reason})`,
        );
      }
    }

    for (const run of this.activeRuns.values()) {
      if (pathsOverlap(canonicalPath, run.canonicalExecutionRoot)) {
        throw new WorktreeError(
          'WORKTREE_ACTIVE_RUN',
          `Cannot fence '${canonicalPath}': active ${run.kind} run (${run.ownerId}) in progress`,
        );
      }
    }

    const fenceId = randomUUID();
    const acquiredAt = Date.now();
    this.fences.set(fenceId, {
      fenceId,
      canonicalExecutionRoot: canonicalPath,
      reason,
      acquiredAt,
    });

    // 主动拒绝正在该目录排队的后续写请求，避免门闩释放前悬空等待。
    for (const [key, queue] of this.mutexQueues.entries()) {
      const kept: WaitQueueEntry[] = [];
      for (const waiter of queue) {
        if (pathsOverlap(canonicalPath, waiter.canonicalExecutionRoot)) {
          waiter.cleanup?.();
          waiter.reject(
            new WorktreeError(
              'WORKTREE_FENCED',
              `Execution root '${canonicalPath}' entered ${reason} fence`,
            ),
          );
        } else {
          kept.push(waiter);
        }
      }
      if (kept.length === 0) {
        this.mutexQueues.delete(key);
      } else if (kept.length !== queue.length) {
        this.mutexQueues.set(key, kept);
      }
    }

    let released = false;
    return {
      fenceId,
      canonicalExecutionRoot: canonicalPath,
      reason,
      acquiredAt,
      release: () => {
        if (released) return;
        released = true;
        this.fences.delete(fenceId);
      },
    };
  }

  private installMutexOwner(
    key: string,
    canonicalExecutionRoot: string,
    ownerId: string,
    kind: ExecutionSubsystemKind,
    existingRunId: string = randomUUID(),
  ): ExecutionRunHandle {
    const record: ActiveExecutionRun = {
      runId: existingRunId,
      canonicalExecutionRoot,
      ownerId,
      kind,
      startedAt: Date.now(),
    };
    this.mutexOwners.set(key, existingRunId);
    this.activeRuns.set(existingRunId, record);

    let released = false;
    return {
      ...record,
      release: () => {
        if (released) return;
        released = true;
        this.activeRuns.delete(existingRunId);
        if (this.mutexOwners.get(key) !== existingRunId) return;
        this.mutexOwners.delete(key);
        this.wakeNextWaiter(key);
      },
    };
  }

  private wakeNextWaiter(key: string): void {
    const queue = this.mutexQueues.get(key);
    if (!queue) return;

    while (queue.length > 0) {
      const next = queue.shift()!;
      next.cleanup?.();
      if (this.isFenced(next.canonicalExecutionRoot)) {
        next.reject(
          new WorktreeError(
            'WORKTREE_FENCED',
            `Execution root '${next.canonicalExecutionRoot}' is fenced`,
          ),
        );
        continue;
      }
      const handle = this.installMutexOwner(
        key,
        next.canonicalExecutionRoot,
        next.ownerId,
        next.kind,
        next.runId,
      );
      next.resolve(handle);
      break;
    }

    if (queue.length === 0) {
      this.mutexQueues.delete(key);
    }
  }
}
