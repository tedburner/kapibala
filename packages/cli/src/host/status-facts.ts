import { sanitizeUntrustedOutput } from '../ui/text-safety.js';
import type { StatusFacts } from '../view-model/status.js';

/**
 * 白名单复制宿主传入的真实状态事实；上下文和运行累计独立保留，未知用量不补零。
 * 不读取 Session、Git 或文件，不从任务数推导用量，也不保留输入中的私有扩展字段。
 */
export function projectStatusFacts(input: StatusFacts): StatusFacts {
  const clean = (value: string | undefined) =>
    value === undefined ? undefined : sanitizeUntrustedOutput(value);
  return {
    phase: input.phase,
    model: clean(input.model),
    permissionMode: clean(input.permissionMode),
    gitBranch: clean(input.gitBranch),
    contextUsage: input.contextUsage && {
      usedTokens: input.contextUsage.usedTokens,
      limitTokens: input.contextUsage.limitTokens,
      estimatedUsage: input.contextUsage.estimatedUsage,
      estimatedLimit: input.contextUsage.estimatedLimit,
      percent: input.contextUsage.percent,
    },
    runUsage: input.runUsage && {
      promptTokens: input.runUsage.promptTokens,
      completionTokens: input.runUsage.completionTokens,
      totalTokens: input.runUsage.totalTokens,
    },
    tasks: input.tasks?.map((task) => ({
      agentId: clean(task.agentId)!,
      description: clean(task.description)!,
      role: clean(task.role)!,
      status: task.status,
      originBranchId: clean(task.originBranchId)!,
      isOtherBranch: task.isOtherBranch,
      branchHint: clean(task.branchHint),
      delivery: task.delivery,
      summary: clean(task.summary),
      error: clean(task.error),
    })),
  };
}

/** Git 缓存策略；探测器由宿主注入，视图仅同步读取已有事实。 */
export interface GitStatusCacheOptions {
  readonly ttlMs?: number;
  readonly now?: () => number;
  readonly onChange?: (branch: string | undefined) => void | Promise<void>;
}

/**
 * 异步 Git 分支事实缓存；慢探测不阻塞 peek，失败保留旧值或省略，同步渲染不启动进程。
 * 宿主负责将 loader 绑定真实工作区与进程生命周期；关闭后中止信号并丢弃迟到结果。
 */
export class GitStatusCache {
  private value: string | undefined;
  private inFlight: Promise<void> | undefined;
  private lastAttempt: number | undefined;
  private controller: AbortController | undefined;
  private closed = false;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private onChange: GitStatusCacheOptions['onChange'];

  constructor(
    private readonly loader: (signal: AbortSignal) => Promise<string | undefined>,
    options: GitStatusCacheOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(0, options.ttlMs ?? 5000);
    this.onChange = options.onChange;
  }

  /** 只读缓存；尚无成功探测或已关闭时返回 undefined，不等待异步探测。 */
  peek(): string | undefined {
    return this.value;
  }

  /** 合并并发探测并按 TTL 限流；失败不抛至调用方，不阻塞继续读取已有状态。 */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    const now = this.now();
    if (this.lastAttempt !== undefined && now - this.lastAttempt < this.ttlMs)
      return Promise.resolve();
    this.lastAttempt = now;
    const controller = new AbortController();
    this.controller = controller;
    this.inFlight = Promise.resolve()
      .then(() => (this.closed ? undefined : this.loader(controller.signal)))
      .then((branch) => {
        if (this.closed) return;
        const next = branch === undefined ? undefined : sanitizeUntrustedOutput(branch);
        if (next === this.value) return;
        this.value = next;
        try {
          void Promise.resolve(this.onChange?.(next)).catch(() => {});
        } catch {
          /* 展示失败不影响缓存。 */
        }
      })
      .catch(() => {
        /* 探测失败保留缓存或未知。 */
      })
      .finally(() => {
        this.inFlight = undefined;
        this.controller = undefined;
      });
    return this.inFlight;
  }

  /** 幂等中止宿主探测并释放回调；不等待不遵守中止信号的外部 loader。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller?.abort();
    this.value = undefined;
    this.onChange = undefined;
  }
}
