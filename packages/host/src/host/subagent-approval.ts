import {
  type ApprovalChannel,
  type ApprovalChoice,
  type ApprovalRequest,
  SessionApprovalCache,
  type SubagentApprovalOrigin,
} from '@kiturone/kapibala';

/**
 * 同一父会话任务树共享的人工审批指纹缓存。
 *
 * 前置约束与设计取舍：
 * - 指纹复用 Core `SessionApprovalCache.key`，覆盖 `toolName`、`capabilities`、`input`、`rootDir`、
 *   `shell` 与 `executionIdentity`，刻意不把 `subagentOrigin` 纳入哈希，使同一任务树下的兄弟子代理
 *   对完全相同的执行目标复用单次会话级裁决；
 * - 显式携带自定义收紧版 `allowedTools` 的子代理仅允许读取本缓存、禁止回写，防止缩权子代理污染父级缓存。
 */
export class TreeApprovalCache {
  private readonly keyBuilder = new SessionApprovalCache();
  private readonly choices = new Map<string, 'allow' | 'deny'>();

  /** 计算与子代理身份无关的确定性执行目标指纹。 */
  fingerprint(request: ApprovalRequest): string {
    return this.keyBuilder.key(request);
  }

  /** 查询同一会话树内已记录的会话级允许或拒绝结论。 */
  get(request: ApprovalRequest): 'allow' | 'deny' | undefined {
    return this.choices.get(this.fingerprint(request));
  }

  /** 按指纹查询会话树缓存。 */
  getByFingerprint(fingerprint: string): 'allow' | 'deny' | undefined {
    return this.choices.get(fingerprint);
  }

  /** 写入会话级允许或拒绝结论（允许结论要求请求自身允许会话缓存）。 */
  set(request: ApprovalRequest, choice: 'allow' | 'deny'): void {
    if (choice === 'allow' && !request.sessionAllowed) return;
    this.choices.set(this.fingerprint(request), choice);
  }

  /** 清空会话树缓存（父会话销毁时调用）。 */
  clear(): void {
    this.choices.clear();
  }
}

interface InFlightApprovalEntry {
  readonly id: number;
  readonly fingerprint: string;
  readonly sessionAllowed: boolean;
  readonly settleFromSibling: (choice: ApprovalChoice) => void;
}

/**
 * 绑定父会话生命周期的常驻审批中枢（`SessionApprovalHub`）。
 *
 * 职责与失败边界：
 * - 与单次父轮次运行解耦：即使父会话当前处于 `idle`，后台 `detached` 子代理冒泡的审批仍可经此中枢送达宿主；
 * - 持有同一父会话树的 `TreeApprovalCache` 与在途等待队列；当任一未缩权调用获得 `allow_session` / `deny_session` 时，
 *   立即唤醒同队列中等待相同指纹的兄弟请求并中止其冗余上游弹窗；
 * - 父会话 `dispose()` 时调用 `dispose()`，立即中止并收口树内全部挂起审批。
 */
export class SessionApprovalHub {
  readonly cache = new TreeApprovalCache();
  private readonly inFlight = new Map<number, InFlightApprovalEntry>();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly upstream: ApprovalChannel) {}

  /** 为根父会话自身生成绑定同树缓存与队列重判的审批通道。 */
  createRootChannel(): ApprovalChannel {
    return {
      requestApproval: (request, signal) =>
        this.requestThroughHub(request, { canWriteTreeCache: true, signal }),
    };
  }

  /**
   * 经中枢发起一次人工审批：命中同树缓存时直接放行/拒绝，未命中时登记在途队列并在会话级裁决到达时联动消解兄弟请求。
   */
  async requestThroughHub(
    request: ApprovalRequest,
    options: {
      readonly canWriteTreeCache: boolean;
      readonly signal?: AbortSignal;
      readonly onBeforePrompt?: () => () => void;
    },
  ): Promise<ApprovalChoice> {
    if (this.disposed || options.signal?.aborted) return 'cancel';

    const fingerprint = this.cache.fingerprint(request);
    const cached = this.cache.getByFingerprint(fingerprint);
    if (cached === 'allow' && request.sessionAllowed) return 'allow_once';
    if (cached === 'deny') return 'deny_once';

    const entryId = this.nextId++;
    const upstreamController = new AbortController();
    const onCallerAbort = () => upstreamController.abort(options.signal?.reason);
    if (options.signal) {
      if (options.signal.aborted) return 'cancel';
      options.signal.addEventListener('abort', onCallerAbort, { once: true });
    }

    const resumeHook = options.onBeforePrompt?.();
    let settledBySibling: ApprovalChoice | undefined;
    let resolveSibling!: (choice: ApprovalChoice) => void;
    const siblingPromise = new Promise<ApprovalChoice>((resolve) => {
      resolveSibling = resolve;
    });

    this.inFlight.set(entryId, {
      id: entryId,
      fingerprint,
      sessionAllowed: request.sessionAllowed,
      settleFromSibling: (choice) => {
        if (settledBySibling !== undefined) return;
        settledBySibling = choice;
        upstreamController.abort();
        resolveSibling(choice);
      },
    });

    try {
      const choice = await Promise.race([
        this.upstream.requestApproval(request, upstreamController.signal),
        siblingPromise,
      ]);
      const finalChoice = settledBySibling ?? choice;
      if (settledBySibling === undefined && options.canWriteTreeCache) {
        if (finalChoice === 'allow_session' && request.sessionAllowed) {
          this.cache.set(request, 'allow');
          this.resolveMatchingSiblings(entryId, fingerprint, 'allow_once', true);
        } else if (finalChoice === 'deny_session') {
          this.cache.set(request, 'deny');
          this.resolveMatchingSiblings(entryId, fingerprint, 'deny_once', false);
        }
      }
      return finalChoice;
    } finally {
      this.inFlight.delete(entryId);
      options.signal?.removeEventListener('abort', onCallerAbort);
      upstreamController.abort();
      resumeHook?.();
    }
  }

  /** 撤销当前会话树内所有挂起审批并清空缓存。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of [...this.inFlight.values()]) {
      entry.settleFromSibling('cancel');
    }
    this.inFlight.clear();
    this.cache.clear();
  }

  private resolveMatchingSiblings(
    sourceId: number,
    fingerprint: string,
    choice: ApprovalChoice,
    requireSessionAllowed: boolean,
  ): void {
    for (const entry of [...this.inFlight.values()]) {
      if (entry.id === sourceId || entry.fingerprint !== fingerprint) continue;
      if (requireSessionAllowed && !entry.sessionAllowed) continue;
      entry.settleFromSibling(choice);
    }
  }
}

/**
 * 子代理冒泡审批包装器配置选项。
 */
export interface SubagentApprovalChannelOptions {
  /** 父宿主或父会话审批通道；缺省时回退为非交互拒绝。 */
  readonly parentChannel?: ApprovalChannel;
  /** 可选会话树常驻审批中枢；提供时启用跨子代理 `allow_session` 缓存共享与排队重判。 */
  readonly hub?: SessionApprovalHub;
  /** 当前子代理自身的身份快照；仅在请求尚未携带更内层 `subagentOrigin` 时写入。 */
  readonly origin: SubagentApprovalOrigin;
  /** 是否允许将 `allow_session` / `deny_session` 写回父树共享缓存（传了自定义 `allowedTools` 时置 false）。 */
  readonly canWriteTreeCache?: boolean;
  /** 人工审批挂起期间暂停子代理运行超时钟的钩子；返回幂等恢复函数。 */
  readonly pauseTimeout?: () => () => void;
}

/**
 * 创建子代理向父会话冒泡的组合式 `ApprovalChannel` 包装器。
 *
 * 保证：
 * 1. 多层嵌套（`root -> A -> B`）采用 `request.subagentOrigin ?? options.origin` 保留最内层实际调用方身份；
 * 2. 先查询 `SessionApprovalHub` 同树缓存，已获 `allow_session` 授权时免弹窗直接返回 `'allow_once'`；
 * 3. 进入真实人工等待前调用 `pauseTimeout()` 冻结子代理 5 分钟墙钟预算，`finally` 内无条件恢复；
 * 4. 未缩权子代理获得 `'allow_session'` 时写入同树缓存并自动放行队列中同指纹的兄弟请求。
 */
export function createSubagentApprovalChannel(
  options: SubagentApprovalChannelOptions,
): ApprovalChannel | undefined {
  if (!options.hub && !options.parentChannel) return undefined;
  const canWriteTreeCache = options.canWriteTreeCache ?? true;

  return {
    async requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalChoice> {
      const enrichedRequest: ApprovalRequest = {
        ...request,
        subagentOrigin: request.subagentOrigin ?? options.origin,
      };
      if (options.hub) {
        return options.hub.requestThroughHub(enrichedRequest, {
          canWriteTreeCache,
          signal,
          onBeforePrompt: options.pauseTimeout,
        });
      }
      const resumeTimeout = options.pauseTimeout?.();
      try {
        return await options.parentChannel!.requestApproval(enrichedRequest, signal);
      } finally {
        resumeTimeout?.();
      }
    },
  };
}
