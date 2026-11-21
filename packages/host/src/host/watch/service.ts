/**
 * @fileoverview 会话级监视的宿主触发源与投递调度（v0.1.4，设计 008 §7–§9）。
 *
 * 约束、边界与为什么：
 * 1. 监视没有执行体：`WatchService` 只负责「布置触发源 → 生成通知 → 落盘背景消息 → 空闲时续跑」，
 *    绝不自己创建 AgentSession，也不把轮询结果写进模型可见的正文之外。
 * 2. 水位而不是布尔闩锁：`WatchState.lastSeenAt` 记录「已确认投递过的事件时间」。
 *    崩溃后只要没确认过就仍欠一次投递，确认过就自然不欠；布尔标记表达不了「错过多次」。
 * 3. 先落盘再推进水位：`fire()` 先把终态写进 `watch_state`，等背景消息真正落盘成功后才回写
 *    `lastSeenAt` / `lastNotifiedAt`。中途崩溃会重投，但 `eventId = watchId` 让收件箱幂等去重。
 * 4. 所有依赖（时钟、文件系统、端口探测、续跑）都注入，便于单测与宿主替换；
 *    默认实现只使用 Node 内置模块，不读取 cwd，也不访问工作区之外的路径。
 */

import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  KapibalaError,
  type WatchKind,
  type WatchNotification,
  type WatchSpec,
  type WatchState,
  type WatchStatus,
  type WatchTerminalStatus,
} from '@kiturone/kapibala';

/** 自动续跑注入的用户消息正文；宿主与文档共用这一份，避免两端措辞漂移。 */
export const WATCH_RESUME_INPUT = '（会话监视事件已触发，请根据上一条通知继续。）';

/** 轮询间隔下限；低于它会退化成忙轮询，且与去抖窗口叠加后没有实际收益。 */
const MIN_INTERVAL_MS = 2_000;
/** 未指定 intervalMs 时的默认轮询间隔。 */
const DEFAULT_INTERVAL_MS = 5_000;
/** 文件变化去抖窗口；窗口内同路径只保留最后一次变化。 */
const DEBOUNCE_MS = 300;
/** 忙碌期间多次唤醒的合并窗口。 */
const MERGE_WINDOW_MS = 2_000;
/** 队列非空但会话不空闲时的重试间隔。 */
const IDLE_RETRY_MS = 1_000;
/** 每会话自动续跑的最小间隔（一分钟最多 1 次）。 */
const MIN_RESUME_INTERVAL_MS = 60_000;
/** 每会话最多同时处于监视中的条目数。 */
const MAX_ARMED_PER_SESSION = 8;
/** 同一宿主进程内全部会话合计的监视上限。 */
const MAX_ARMED_GLOBAL = 32;
/** 单文件内容哈希上限；超过只依赖 size + mtime 判定，避免把大文件整体读进内存。 */
const MAX_HASH_BYTES = 10 * 1024 * 1024;
/** 端口探测的建连超时。 */
const PORT_PROBE_TIMEOUT_MS = 500;
/** file_change 明确忽略的目录段：这三类变化不构成「外部条件」。 */
const IGNORED_SEGMENTS = new Set(['.git', 'node_modules', 'dist']);
/** 同一通知的最大连续投递尝试；达到上限即放弃并转 orphaned，防止每秒无限重试回读历史。 */
const MAX_DELIVERY_ATTEMPTS = 5;
/** 进程内保留的终态条目上限；超过后按关闭时间淘汰最旧，只清内存，不影响落盘记录。 */
const MAX_TERMINAL_ENTRIES = 50;

/** 列出监视时展示的只读视图；不包含任何可回写的执行句柄。 */
export interface WatchView {
  readonly watchId: string;
  readonly kind: WatchKind;
  readonly target: string;
  readonly state: WatchStatus;
  readonly armedAt: number;
  readonly deadlineAt: number;
  readonly lastSeenAt: number;
  readonly lastNotifiedAt?: number;
  readonly closedAt?: number;
  /** 人类可读的终态事实摘要（内容摘要 / 连接耗时）；仅进程内保留。 */
  readonly detail?: string;
}

/** 监视状态所需的会话存储子集；只读写 `watch_state` 控制记录，不触碰正文历史。 */
export interface WatchStateStore {
  readWatchStates(): Promise<WatchState[]>;
  appendWatchState(state: WatchState): Promise<unknown>;
  getActiveBranchId(): string;
}

/** 文件系统子集；注入后可用内存实现做确定性测试。 */
export interface WatchFileSystem {
  /** 读取签名（size + mtimeMs）；文件不存在或不可读时返回 undefined。 */
  stat(file: string): { size: number; mtimeMs: number } | undefined;
  /** 读取内容用于哈希；不可读时返回 undefined。 */
  read(file: string): Buffer | undefined;
  /** 规范化真实路径；不存在或越界时返回 undefined。 */
  realpath(file: string): string | undefined;
}

/** {@link WatchService} 的构造参数；除工作区与存储外全部依赖都是注入的。 */
export interface WatchServiceOptions {
  /** 会话工作区物理根（已规范化）；文件目标必须落在它内部。 */
  workspaceRoot: string;
  store: WatchStateStore;
  /** 把通知作为背景消息落盘；返回值区分「新写入」与「幂等跳过」。 */
  deliver(notification: WatchNotification, branchId: string): Promise<boolean>;
  /** 自动续跑一轮；由宿主决定走哪条运行管线以复用渲染与取消语义。 */
  resume(input: string, signal: AbortSignal): Promise<void>;
  /** 会话是否空闲（无在途运行、无待审批）；投递与续跑只在空闲时发生。 */
  isIdle(): boolean;
  /** 状态变化回调；宿主用它刷新徽标或观察面。 */
  onChange?(): void;
  /** 终态产生时的宿主通知钩子（桌面系统通知）；缺省只落盘背景消息。 */
  onNotify?(notification: WatchNotification): void;
  now?(): number;
  fileSystem?: WatchFileSystem;
  probePort?(port: number): Promise<boolean>;
  resumeInput?: string;
}

/** 进程内正在运行的监视服务集合；用于计算全局并发上限。 */
const liveServices = new Set<WatchService>();

/** 单条监视的运行时状态；持久化字段在 `state`，其余只服务于本轮进程。 */
interface ArmedEntry {
  state: WatchState;
  detail?: string;
  timer?: NodeJS.Timeout;
  debounce?: NodeJS.Timeout;
  signature?: string;
  hash?: string;
}

/** 待投递通知；`branchId` 在触发时冻结，保证通知落回登记时的分支。 */
interface PendingDelivery {
  notification: WatchNotification;
  branchId: string;
}

/** 默认文件系统实现：全部错误都收敛为 undefined，由调用方按「不可判定」处理。 */
const defaultFileSystem: WatchFileSystem = {
  stat(file) {
    try {
      const stat = fs.statSync(file);
      return stat.isFile() ? { size: stat.size, mtimeMs: stat.mtimeMs } : undefined;
    } catch {
      return undefined;
    }
  },
  read(file) {
    try {
      return fs.readFileSync(file);
    } catch {
      return undefined;
    }
  },
  realpath(file) {
    try {
      return fs.realpathSync.native(file);
    } catch {
      return undefined;
    }
  },
};

/** 仅用于展示的路径包含判断：Windows 下大小写不敏感，避免同一文件被判成越界。 */
function isInside(root: string, candidate: string): boolean {
  const normalize = (value: string) => (process.platform === 'win32' ? value.toLowerCase() : value);
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 单行化事实摘要；通知正文与 `/watches` 共用同一份截断规则。 */
function brief(value: string, limit = 120): string {
  const single = value.replace(/\s+/g, ' ').trim();
  return single.length > limit ? `${single.slice(0, limit)}…` : single;
}

/**
 * 会话级监视服务。
 *
 * 每个宿主会话持有一个实例：`start()` 恢复已登记监视，`register()` 登记新监视，
 * `cancel()` 终止未触发的监视，`dispose()` 停掉全部定时器。
 * **不持久化队列**：待投递通知只存在于进程内，崩溃后由 `lastSeenAt` 水位驱动恢复补投，
 * 因此服务不可跨实例共享，也不能在无写租约的宿主里创建。
 */
export class WatchService {
  private readonly entries = new Map<string, ArmedEntry>();
  private readonly queue: PendingDelivery[] = [];
  /** 同一通知（按 `eventId = watchId`）的连续投递失败计数；成功或放弃后清除。 */
  private readonly deliveryFailures = new Map<string, number>();
  private readonly fileSystem: WatchFileSystem;
  private readonly now: () => number;
  private readonly resumeInput: string;
  private flushTimer?: NodeJS.Timeout;
  private lastResumeAt = 0;
  private resuming?: Promise<void>;
  /** 在途续跑的中止控制器；`dispose()` 必须 abort，否则关闭后仍可能拉起一轮运行。 */
  private resumeController?: AbortController;
  private started = false;
  private disposed = false;

  constructor(private readonly options: WatchServiceOptions) {
    this.fileSystem = options.fileSystem ?? defaultFileSystem;
    this.now = options.now ?? Date.now;
    this.resumeInput = options.resumeInput ?? WATCH_RESUME_INPUT;
  }

  /**
   * 恢复持久化监视。
   *
   * 只持会话写租约的宿主才应调用：其余宿主读同一份 `watch_state` 但不布置触发源，
   * 以免 CLI 与桌面同时轮询、同时续跑。终态但水位未确认的条目会补投一次简报。
   */
  async start(): Promise<void> {
    if (this.started || this.disposed) return;
    this.started = true;
    liveServices.add(this);
    let states: WatchState[];
    try {
      states = await this.options.store.readWatchStates();
    } catch {
      return;
    }
    for (const state of states) {
      if (state.state === 'armed') {
        this.entries.set(state.watchId, { state });
        this.arm(this.entries.get(state.watchId)!);
        continue;
      }
      // 终态但从未确认投递：说明上次进程在落盘与水位回写之间退出，补一条简报即可。
      if (state.closedAt !== undefined && state.lastSeenAt < state.closedAt) {
        this.queue.push({
          notification: {
            eventId: state.watchId,
            watchId: state.watchId,
            kind: state.spec.kind,
            target: state.spec.target,
            state: state.state as WatchTerminalStatus,
            firedAt: state.closedAt,
            detail: '恢复后补投：该监视在进程退出前已结束',
          },
          branchId: state.branchId,
        });
        this.entries.set(state.watchId, { state });
      }
    }
    if (this.queue.length) this.scheduleFlush(0);
    this.pruneTerminalEntries();
    this.options.onChange?.();
  }

  /** 当前视图列表；按登记顺序返回，终态条目在内存中按关闭时间保留最近若干条。 */
  list(): WatchView[] {
    return [...this.entries.values()].map((entry) => ({
      watchId: entry.state.watchId,
      kind: entry.state.spec.kind,
      target: entry.state.spec.target,
      state: entry.state.state,
      armedAt: entry.state.armedAt,
      deadlineAt: entry.state.spec.deadlineAt,
      lastSeenAt: entry.state.lastSeenAt,
      ...(entry.state.lastNotifiedAt !== undefined
        ? { lastNotifiedAt: entry.state.lastNotifiedAt }
        : {}),
      ...(entry.state.closedAt !== undefined ? { closedAt: entry.state.closedAt } : {}),
      ...(entry.detail ? { detail: entry.detail } : {}),
    }));
  }

  /**
   * 登记一条监视。
   *
   * 校验顺序固定：规格合法性 → 目标归属（工作区 / localhost）→ 数量上限。
   * 任何一步失败都抛出稳定错误码且不写 `watch_state`，杜绝「登记成功但没人轮询」的假象。
   */
  async register(spec: WatchSpec): Promise<WatchView> {
    if (this.disposed) throw new KapibalaError('Watch service is closed', { code: 'WATCH_CLOSED' });
    const now = this.now();
    if (!Number.isFinite(spec.deadlineAt) || spec.deadlineAt <= now)
      throw new KapibalaError('Watch deadline must be in the future', {
        code: 'WATCH_DEADLINE_INVALID',
        safeMessage: '监视必须给出未来的截止时间',
      });
    // NaN 会让 Math.max 退化为 NaN，setTimeout(fn, NaN) 按 1ms 忙轮询，必须在入口拦截。
    if (spec.intervalMs !== undefined && !Number.isFinite(spec.intervalMs))
      throw new KapibalaError('Watch interval must be a finite number', {
        code: 'WATCH_INTERVAL_INVALID',
        safeMessage: '轮询间隔必须是有效数字',
      });
    const intervalMs = Math.max(MIN_INTERVAL_MS, spec.intervalMs ?? DEFAULT_INTERVAL_MS);
    const target = spec.target.trim();
    if (!target)
      throw new KapibalaError('Watch target is required', {
        code: 'WATCH_TARGET_INVALID',
        safeMessage: '监视目标不能为空',
      });
    if (spec.kind === 'file_change') this.resolveFileTarget(target);
    if (spec.kind === 'port_ready') {
      const port = Number(target);
      if (!Number.isInteger(port) || port < 1 || port > 65_535)
        throw new KapibalaError('Watch port is invalid', {
          code: 'WATCH_TARGET_INVALID',
          safeMessage: '端口必须是 1–65535 的整数',
        });
    }
    // v0.1.4 摘除 process_exit（本版未接线，宿主没有子进程 PID 注册表）：
    // wire 与模型输入仍可能带来该遗留值，按字符串比较显式拒绝并说明支持范围。
    if ((spec.kind as string) === 'process_exit')
      throw new KapibalaError('process_exit watches are not supported in this version', {
        code: 'WATCH_KIND_UNSUPPORTED',
        safeMessage: '本版本仅支持 file_change 与 port_ready 监视',
      });
    if (!['file_change', 'port_ready'].includes(spec.kind))
      throw new KapibalaError('Unknown watch kind', {
        code: 'WATCH_KIND_INVALID',
        safeMessage: '不支持的监视类型',
      });
    const armedTotal = [...this.entries.values()].filter(
      (entry) => entry.state.state === 'armed',
    ).length;
    if (armedTotal >= MAX_ARMED_PER_SESSION)
      throw new KapibalaError('Too many watches in this session', {
        code: 'WATCH_LIMIT',
        safeMessage: `每个会话最多同时监视 ${MAX_ARMED_PER_SESSION} 个条件`,
      });
    if (this.globalArmedCount() >= MAX_ARMED_GLOBAL)
      throw new KapibalaError('Too many watches in this host', {
        code: 'WATCH_LIMIT',
        safeMessage: `本宿主最多同时监视 ${MAX_ARMED_GLOBAL} 个条件`,
      });

    const state: WatchState = {
      watchId: randomUUID(),
      spec: { ...spec, target, intervalMs },
      state: 'armed',
      lastSeenAt: now,
      branchId: this.options.store.getActiveBranchId(),
      armedAt: now,
    };
    const entry: ArmedEntry = { state };
    if (spec.kind === 'file_change') {
      const initial = this.initialFileSignature(this.resolveFileTarget(target));
      if (initial) {
        entry.signature = initial.signature;
        entry.hash = initial.hash;
      }
    }
    this.entries.set(state.watchId, entry);
    try {
      await this.options.store.appendWatchState(state);
    } catch (error) {
      // 持久化失败必须回滚内存登记，否则条目在轮询却不在落盘，重启后凭空消失。
      this.entries.delete(state.watchId);
      throw error;
    }
    this.arm(entry);
    this.options.onChange?.();
    return this.viewOf(entry);
  }

  /** 取消一条仍在监视中的条目；已触发/已超时/已取消的条目拒绝重复取消。 */
  async cancel(watchId: string): Promise<void> {
    const entry = this.entries.get(watchId);
    if (!entry)
      throw new KapibalaError('Watch not found', {
        code: 'WATCH_NOT_FOUND',
        safeMessage: '未找到该监视',
      });
    if (entry.state.state !== 'armed')
      throw new KapibalaError('Watch is not armed', {
        code: 'WATCH_NOT_ARMED',
        safeMessage: '该监视已经结束，无需取消',
      });
    await this.close(entry, 'cancelled', '由用户取消');
  }

  /**
   * 停止全部定时器并中止在途续跑；不写 `watch_state`，未触发的监视在下次宿主启动时继续恢复。
   * 续跑若已进入宿主运行管线，由其自行响应 abort 信号收尾，本方法不等待。
   */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    liveServices.delete(this);
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.resumeController?.abort();
    this.resumeController = undefined;
    for (const entry of this.entries.values()) this.clearTimers(entry);
    this.entries.clear();
    this.queue.length = 0;
    this.deliveryFailures.clear();
  }

  /** 把相对/绝对目标解析为工作区内的真实路径；越界与被忽略目录明确拒绝，目标可以尚未创建。 */
  private resolveFileTarget(target: string): string {
    const absolute = path.resolve(this.options.workspaceRoot, target);
    if (!isInside(this.options.workspaceRoot, absolute))
      throw new KapibalaError('Watch target escapes workspace', {
        code: 'WATCH_TARGET_OUTSIDE',
        safeMessage: '监视目标必须位于当前工作区内',
      });
    for (const segment of path.relative(this.options.workspaceRoot, absolute).split(/[\\/]/))
      if (IGNORED_SEGMENTS.has(segment))
        throw new KapibalaError('Watch target is ignored', {
          code: 'WATCH_TARGET_IGNORED',
          safeMessage: '不能监视 .git / node_modules / dist 内部路径',
        });
    // 只对已存在的路径做物理身份校验；目标可以尚未创建（等待首次出现）。
    const real = this.fileSystem.realpath(absolute);
    if (real && !isInside(this.options.workspaceRoot, real))
      throw new KapibalaError('Watch target escapes workspace', {
        code: 'WATCH_TARGET_OUTSIDE',
        safeMessage: '监视目标必须位于当前工作区内',
      });
    return real ?? absolute;
  }

  /** 跨实例统计仍在监视中的条目；只用于全局上限，不参与单会话判定。 */
  private globalArmedCount(): number {
    let total = 0;
    for (const service of liveServices)
      for (const entry of service.entries.values()) if (entry.state.state === 'armed') total++;
    return total;
  }

  private viewOf(entry: ArmedEntry): WatchView {
    return this.list().find((item) => item.watchId === entry.state.watchId)!;
  }

  /** 排下一次 tick：不超过截止时间，也不低于轮询下限。 */
  private arm(entry: ArmedEntry): void {
    if (this.disposed) return;
    // 只重置轮询定时器：去抖窗口可能刚刚由 inspectFile 布置，提前清掉会吞掉本次变化。
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = undefined;
    const interval = Math.max(MIN_INTERVAL_MS, entry.state.spec.intervalMs ?? DEFAULT_INTERVAL_MS);
    const untilDeadline = entry.state.spec.deadlineAt - this.now();
    const delay = Math.max(0, Math.min(interval, untilDeadline));
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      // tick 自身已处理已知错误并重新布置轮询；能到达这里的只剩关闭路径的意外崩溃，记诊断即可。
      void this.tick(entry).catch((error: unknown) => {
        console.warn(`[watch] tick crashed for ${entry.state.watchId}`, error);
      });
    }, delay);
    entry.timer.unref?.();
  }

  /**
   * 单次轮询：先判截止，再按类型判定触发；未触发则续排下一次。
   *
   * tick 内的已知失败不允许把条目留在 `armed` 变成僵尸：目标被替换为工作区外的
   * 符号链接（realpath 复检失败）时直接转 orphaned；其余意外异常记录诊断后继续
   * 重新布置轮询，等待下一轮自愈或自然到期。
   */
  private async tick(entry: ArmedEntry): Promise<void> {
    if (this.disposed || entry.state.state !== 'armed') return;
    const now = this.now();
    if (now >= entry.state.spec.deadlineAt) {
      await this.close(entry, 'timeout', '已到截止时间');
      return;
    }
    const { kind, target } = entry.state.spec;
    try {
      if (kind === 'port_ready') {
        const started = this.now();
        const ready = await (this.options.probePort ?? probeLocalPort)(Number(target));
        if (ready) {
          await this.close(entry, 'fired', `端口已就绪（连接耗时 ${this.now() - started}ms）`);
          return;
        }
      } else {
        this.inspectFile(entry);
        if (entry.state.state !== 'armed') return;
      }
    } catch (error) {
      // 目标物理身份已脱离工作区（如被替换为外链符号链接），继续轮询没有意义。
      if (error instanceof KapibalaError && error.code === 'WATCH_TARGET_OUTSIDE') {
        await this.close(entry, 'orphaned', '监视目标已变为工作区外的链接');
        return;
      }
      // 意外异常不能让条目永久停留在 armed：记录诊断后仍尝试重新布置轮询。
      console.warn(`[watch] tick failed for ${entry.state.watchId}, will retry`, error);
    }
    this.arm(entry);
  }

  /**
   * 文件变化检测：先比对 `size + mtimeMs` 签名，签名未变时复用条目上的缓存哈希、零读盘；
   * 签名变化才读内容算哈希确认（设计 008 §5：变化后才计算内容哈希）。
   * 同内容只更新缓存不触发；窗口内重复变化只保留最后一次。
   */
  private inspectFile(entry: ArmedEntry): void {
    const file = this.resolveFileTarget(entry.state.spec.target);
    const stat = this.fileSystem.stat(file);
    if (!stat) return;
    const signature = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    if (entry.signature === signature) return;
    entry.signature = signature;
    // 超过哈希上限或暂时不可读的文件降级为仅签名判定，不把内容整体读进内存。
    if (stat.size > MAX_HASH_BYTES) {
      this.scheduleFileFire(entry, `${stat.size} 字节`);
      return;
    }
    const content = this.fileSystem.read(file);
    if (!content) {
      this.scheduleFileFire(entry, `${stat.size} 字节`);
      return;
    }
    const hash = createHash('sha256').update(content).digest('hex');
    if (entry.hash !== undefined && entry.hash === hash) return;
    entry.hash = hash;
    this.scheduleFileFire(entry, `${content.length} 字节，摘要 ${hash.slice(0, 12)}`);
  }

  /** 进入去抖窗口后投递 fired；窗口内同路径重复变化只保留最后一次。 */
  private scheduleFileFire(entry: ArmedEntry, summary: string): void {
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
      entry.debounce = undefined;
      void this.close(entry, 'fired', `文件内容已变化：${brief(summary)}`).catch(() => {});
    }, DEBOUNCE_MS);
    entry.debounce.unref?.();
  }

  /**
   * 登记时的初始签名与内容哈希；之后 tick 只在签名变化时才重新读盘。
   * 超过哈希上限或不可读时降级为仅签名比较（hash 缺省）。
   */
  private initialFileSignature(file: string): { signature: string; hash?: string } | undefined {
    const stat = this.fileSystem.stat(file);
    if (!stat) return undefined;
    const signature = `${stat.size}:${Math.round(stat.mtimeMs)}`;
    if (stat.size > MAX_HASH_BYTES) return { signature };
    const content = this.fileSystem.read(file);
    if (!content) return { signature };
    return { signature, hash: createHash('sha256').update(content).digest('hex') };
  }

  /**
   * 关闭一条监视并生成通知。
   *
   * 顺序固定：先持久化终态（列表立刻正确）→ 入队投递 → 空闲时落盘背景消息 → 回写水位。
   * 因此崩溃后最多重投一次，且收件箱按 `eventId = watchId` 幂等。
   * 终态条目超过内存上限时按关闭时间淘汰最旧，落盘的 `watch_state` 记录不受影响。
   */
  private async close(
    entry: ArmedEntry,
    state: WatchTerminalStatus,
    detail: string,
  ): Promise<void> {
    if (entry.state.state !== 'armed') return;
    this.clearTimers(entry);
    const firedAt = this.now();
    const terminal: WatchState = { ...entry.state, state, closedAt: firedAt };
    entry.state = terminal;
    entry.detail = detail;
    try {
      await this.options.store.appendWatchState(terminal);
    } catch {
      /* 落盘失败不阻断投递：水位仍落后，重启后会补投。 */
    }
    const notification: WatchNotification = {
      eventId: terminal.watchId,
      watchId: terminal.watchId,
      kind: terminal.spec.kind,
      target: terminal.spec.target,
      state,
      firedAt,
      detail,
    };
    this.queue.push({ notification, branchId: terminal.branchId });
    this.options.onNotify?.(notification);
    this.pruneTerminalEntries();
    this.options.onChange?.();
    this.scheduleFlush(0);
  }

  /**
   * 淘汰内存中最早的终态条目，保证长会话的 `entries` 不会无界增长。
   * 只清内存视图：落盘的 `watch_state` 记录保持完整，重启后仍按水位恢复。
   */
  private pruneTerminalEntries(): void {
    const terminal = [...this.entries.values()].filter(
      (candidate) => candidate.state.state !== 'armed',
    );
    const excess = terminal.length - MAX_TERMINAL_ENTRIES;
    if (excess <= 0) return;
    terminal.sort((a, b) => (a.state.closedAt ?? 0) - (b.state.closedAt ?? 0));
    for (const stale of terminal.slice(0, excess)) this.entries.delete(stale.state.watchId);
  }

  /** 排一次投递；已有的定时器优先，避免窗口被无限推迟。 */
  private scheduleFlush(delay: number): void {
    if (this.flushTimer || this.disposed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flush().catch(() => {});
    }, delay);
    this.flushTimer.unref?.();
  }

  /**
   * 投递队列。
   *
   * 只有空闲且没有在途续跑时才真正落盘；忙时按 {@link IDLE_RETRY_MS} 重试，
   * 期间新到达的通知自然合并进同一批，从而坍缩成一次续跑。
   * 同一通知连续失败达到 {@link MAX_DELIVERY_ATTEMPTS} 即放弃：条目转 orphaned
   * （带原因），输出诊断，不再每秒全量重试回读历史。
   */
  private async flush(): Promise<void> {
    if (this.disposed || this.queue.length === 0) return;
    if (this.resuming || !this.options.isIdle()) {
      this.scheduleFlush(IDLE_RETRY_MS);
      return;
    }
    const batch = this.queue.splice(0, this.queue.length);
    let delivered = 0;
    // 只有真实条件命中（fired / timeout / orphaned）才值得唤醒续跑；
    // 用户主动取消不产生新信息，续跑只会空烧一轮。
    let resumable = 0;
    for (const item of batch) {
      try {
        const written = await this.options.deliver(item.notification, item.branchId);
        if (written) delivered++;
        this.deliveryFailures.delete(item.notification.eventId);
        await this.advanceWater(item);
        if (written && item.notification.state !== 'cancelled') resumable++;
      } catch (error) {
        const attempts = (this.deliveryFailures.get(item.notification.eventId) ?? 0) + 1;
        this.deliveryFailures.set(item.notification.eventId, attempts);
        if (attempts >= MAX_DELIVERY_ATTEMPTS) {
          this.abandonDelivery(item, attempts, error);
          continue;
        }
        // 投递失败：保留原文等待空闲重试，绝不在未落盘时推进水位。
        this.queue.push(item);
      }
    }
    if (resumable > 0 && this.queue.length === 0) await this.resumeOnce();
    if (this.queue.length) this.scheduleFlush(IDLE_RETRY_MS);
  }

  /**
   * 放弃一条反复投递失败的通知。
   *
   * 条目若仍在内存且保持该通知对应的终态，则改判为 `orphaned` 并落盘（带原因），
   * 让 `/watches` 与恢复路径都能看到「投递从未确认」的事实；水位不动，
   * 下次重启按水位补投时由收件箱按 `eventId` 幂等去重。
   */
  private abandonDelivery(item: PendingDelivery, attempts: number, cause: unknown): void {
    this.deliveryFailures.delete(item.notification.eventId);
    const entry = this.entries.get(item.notification.watchId);
    if (entry && entry.state.state === item.notification.state) {
      entry.state = { ...entry.state, state: 'orphaned' };
      entry.detail = `投递连续 ${attempts} 次失败，已放弃投递`;
      void this.options.store.appendWatchState(entry.state).catch(() => {
        /* 落盘失败只影响下一次恢复时的展示，不影响本次放弃决策。 */
      });
    }
    console.warn(
      `[watch] delivery of ${item.notification.watchId} failed ${attempts} times, giving up`,
      cause,
    );
    this.options.onChange?.();
  }

  /** 回写「已确认投递」的水位；失败不重试，下次恢复会按落后水位补投。 */
  private async advanceWater(item: PendingDelivery): Promise<void> {
    const entry = this.entries.get(item.notification.watchId);
    const base = entry?.state;
    if (!base || base.lastSeenAt >= item.notification.firedAt) return;
    const advanced: WatchState = {
      ...base,
      lastSeenAt: item.notification.firedAt,
      lastNotifiedAt: this.now(),
    };
    if (entry) entry.state = advanced;
    try {
      await this.options.store.appendWatchState(advanced);
    } catch {
      /* 水位落后只会导致重复投递，不会丢失事件。 */
    }
  }

  /** 每分钟最多一次自动续跑；超出只保留已落盘的背景消息。 */
  private async resumeOnce(): Promise<void> {
    const now = this.now();
    if (now - this.lastResumeAt < MIN_RESUME_INTERVAL_MS) return;
    this.lastResumeAt = now;
    const controller = new AbortController();
    this.resumeController = controller;
    this.resuming = (async () => {
      try {
        await this.options.resume(this.resumeInput, controller.signal);
      } catch {
        /* 续跑失败不影响已落盘的通知；用户下次输入即可继续。 */
      } finally {
        if (this.resumeController === controller) this.resumeController = undefined;
        this.resuming = undefined;
        if (this.queue.length) this.scheduleFlush(IDLE_RETRY_MS);
      }
    })();
    await this.resuming;
  }

  private clearTimers(entry: ArmedEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.timer = undefined;
    entry.debounce = undefined;
  }
}

/** 默认端口探测：只连 127.0.0.1，成功接近即视为就绪。 */
function probeLocalPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const finish = (ready: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ready);
    };
    socket.setTimeout(PORT_PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}
