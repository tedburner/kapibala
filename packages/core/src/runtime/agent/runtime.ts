/**
 * @fileoverview 后台子代理任务树运行时调度器（AgentRuntime）。
 *
 * 约束、边界与为什么：
 * 1. 状态机严格管理与等待收口：
 *    preparing → accepted → running → waiting_children → completed / failed / cancelled / interrupted。
 *    子代理主轮次执行结束若有活跃后代，必须进入 waiting_children 占槽等待收口，不得提前发最终完成通知。
 * 2. 启动事务即刻闭合（Launch Transaction Invariant）：
 *    spawn_agent 在准备阶段完成参数/权限/容量校验并登记意图后，立即向父返回 accepted 回执，
 *    父工具事务即刻闭合，父代理继续推进后续步骤；父事务提交确认后异步激活启动子会话。
 * 3. 严格容量控制与死锁防护：
 *    每树活动槽 4，运行时活动槽 8，每树累计受理 16，超额立即抛出 AGENT_CAPACITY_EXCEEDED，
 *    严禁持槽等待或隐式启动队列，防止祖先等待子级、子级等待槽位产生死锁。
 * 4. 级联取消与后代收口：
 *    任务失败或取消时无条件级联取消所有后代任务，并等待后代清理完成后才释放自身槽位与写入终态。
 */

import { createHash } from 'node:crypto';
import path from 'node:path';
import type { WorkspaceLeaseCoordinator } from '../../capabilities/security/lease.js';
import { isPathInside, toNativePhysicalPath } from '../../capabilities/security/sandbox.js';
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  type ParentPolicySnapshot,
  ROLE_PRESETS,
  type SubagentRole,
  deriveChildPolicy,
} from '../../capabilities/security/subagent-policy.js';
import { KapibalaError, createDelegationError } from '../../errors/index.js';
import { createMessageId } from '../../types/identity.js';
import { SubagentOutbox } from './outbox.js';
import {
  type AgentTaskLimits,
  type AgentTaskOrigin,
  type AgentTaskRecord,
  type AgentTaskStatus,
  DEFAULT_MAX_STEPS,
  DEFAULT_TIMEOUT_MS,
  type ListAgentsFilter,
  MAX_ACTIVE_TASKS_PER_RUNTIME,
  MAX_ACTIVE_TASKS_PER_TREE,
  MAX_TOTAL_TASKS_PER_TREE,
  type SendAgentParams,
  type SendAgentReceipt,
  type SpawnAgentParams,
  type SpawnAgentReceipt,
  isActiveTaskStatus,
  isTerminalTaskStatus,
} from './types.js';

/** 子代理会话执行器类型；生产环境调用真实的 AgentSession，测试环境可注入 Mock。 */
export type SubagentSessionRunner = (
  record: AgentTaskRecord,
  signal: AbortSignal,
  context: SubagentRunnerContext,
) => Promise<{ summary: string; modelId?: string; sessionId?: string; title?: string }>;

/**
 * 委派会话续聊执行器：打开已保留的子会话并追加一轮用户输入。
 *
 * 约束：
 * - 只在目标 detached 任务处于终态且已回填 sessionId 时被调用；
 * - 必须复用首次派发冻结的 `effectivePolicy` 与同一个写租约协调器，不得扩大权限；
 * - 与首次执行一样受墙钟超时与取消信号约束。
 */
export type SubagentSessionResumer = (
  record: AgentTaskRecord,
  prompt: string,
  signal: AbortSignal,
  context: SubagentRunnerContext,
) => Promise<{ summary: string; modelId?: string }>;

/** 子任务仅在内存中接收父协调器；runner 创建子会话时必须注入，不可序列化到任务记录。 */
export interface SubagentRunnerContext {
  readonly leaseCoordinator: WorkspaceLeaseCoordinator;
  /** 父会话标题快照，仅供 detached 委派命名；缺失时退化为仅委派名。 */
  readonly parentTitle?: string;
  /**
   * 子会话创建成功后的身份回填通道；仅 detached 任务会消费。
   * 调用它让运行时在运行中途就持有 sessionId，失败/取消后仍可续聊，
   * 不必等 runner 正常返回（异常路径拿不到返回值）。
   */
  readonly onSessionCreated?: (sessionId: string) => void;
}

/** 启动子代理时的调用方上下文。 */
export interface SpawnContext {
  /** 父会话实际持有的协调器；缺失时在受理和持久副作用前拒绝启动。 */
  readonly leaseCoordinator: WorkspaceLeaseCoordinator;
  /** 根任务标识；若为根会话直接派生，可缺省由 Runtime 自动初始化。 */
  rootTaskId?: string;
  /** 父会话会话 ID。 */
  sessionId: string;
  /** 派生来源分支 ID。 */
  branchId: string;
  /** 派生来源运行轮次 ID。 */
  runId: string;
  /** 触发派生的工具调用 ID。 */
  toolCallId: string;
  /** 当前父任务深度；根会话为 0。 */
  depth: number;
  /** 父代理 ID；根会话时为 undefined。 */
  agentId?: string;
  /** 当前派生代次。 */
  generation?: number;
  /** 父工作区根。 */
  workspaceRoot: string;
  /** 父执行目录。 */
  executionCwd: string;
  /** 父权限策略快照。 */
  parentPolicy?: ParentPolicySnapshot;
  /** 父会话标题快照；仅用于 detached 委派命名，不参与身份或去重。 */
  parentTitle?: string;
}

/**
 * 重启后重建 spawn 幂等索引的条目。
 *
 * 来源是宿主扫描保留型委派会话头得到的 `requestId` / 参数签名 / 原回执快照；
 * 运行时只做结构校验与登记，不凭它伪造任务状态：重放返回原回执，
 * 但跨进程的任务记录与 runner 上下文不存在，模型侧续聊仍不可用（见设计 007 §5.1）。
 */
export interface RestoredDelegationRequest {
  /** 首次派发时的幂等键。 */
  requestId: string;
  /** 首次派发参数的规范化签名。 */
  signature: string;
  /** 首次派发回执原样快照。 */
  receipt: SpawnAgentReceipt;
}

/**
 * AgentRuntime 初始化选项。
 */
export interface AgentRuntimeOptions {
  runner?: SubagentSessionRunner;
  /** 委派会话续聊执行器；缺失时 send_agent 可用但 prepareResume 直接拒绝。 */
  resumer?: SubagentSessionResumer;
  validateModelOverride?: (modelId: string) => boolean;
  outboxPath?: string;
  /** 宿主扫描委派会话头后回填的幂等索引；进程重启后防止同一 requestId 重复派发。 */
  restoredRequests?: readonly RestoredDelegationRequest[];
}

/** 幂等索引条目：签名决定「同 ID 是否同参」，回执用于直接重放。 */
interface IdempotentRequestEntry {
  readonly signature: string;
  receipt: SpawnAgentReceipt | SendAgentReceipt;
}

/** 续聊受理前的终态快照；父工具事务提交失败时原样回滚，不留下伪运行状态。 */
interface ResumeSnapshot {
  readonly status: AgentTaskStatus;
  readonly summary?: string;
  readonly error?: string;
  readonly finishedAt?: number;
  readonly startedAt?: number;
  readonly runGeneration: number;
  readonly continuationOf?: string;
  readonly requestId?: string;
}

/**
 * 后台子代理任务树调度与状态机协调器。
 */
export class AgentRuntime {
  private readonly runnerContexts = new Map<string, SubagentRunnerContext>();
  private readonly tasks = new Map<string, AgentTaskRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly stateListeners = new Set<() => void>();
  /** 宿主观察订阅独立于调度等待；关闭宿主订阅不能影响任务收口。 */
  private readonly taskChangeListeners = new Set<() => void | Promise<void>>();
  private taskChangeNotificationPending = false;
  private readonly outbox: SubagentOutbox;
  private readonly runningPromises = new Map<string, Promise<void>>();
  /** 幂等索引：spawn:/send: 前缀分离两条线的 requestId，避免碰撞。 */
  private readonly idempotentRequests = new Map<string, IdempotentRequestEntry>();
  /** 待激活的续聊输入；由 activateResume 消费，父事务回滚时清除。 */
  private readonly resumePrompts = new Map<string, string>();
  /** 续聊受理前的终态快照；仅用于父事务未提交时回滚。 */
  private readonly resumeSnapshots = new Map<string, ResumeSnapshot>();
  private runner: SubagentSessionRunner;
  private resumer?: SubagentSessionResumer;
  private readonly validateModelOverride?: (modelId: string) => boolean;
  private isClosed = false;

  private totalActiveCount = 0;
  private readonly treeActiveCounts = new Map<string, number>();
  private readonly treeTotalCounts = new Map<string, number>();

  constructor(options?: AgentRuntimeOptions) {
    this.runner =
      options?.runner ??
      (async () => {
        return { summary: 'Completed successfully' };
      });
    this.resumer = options?.resumer;
    this.validateModelOverride = options?.validateModelOverride;
    this.outbox = new SubagentOutbox({ storagePath: options?.outboxPath });
    if (options?.restoredRequests) this.restoreIdempotentRequests(options.restoredRequests);
  }

  /**
   * 登记宿主从委派会话头重建的 spawn 幂等条目。
   *
   * 约束：只登记结构完整的条目；重复 requestId 以先到者为准，
   * 不覆盖进程内已发生的派发（内存索引优先级高于持久快照）。
   *
   * @param entries 宿主扫描得到的幂等条目列表
   */
  restoreIdempotentRequests(entries: readonly RestoredDelegationRequest[]): void {
    for (const entry of entries) {
      if (!entry?.requestId || !entry.signature || !entry.receipt?.agentId) continue;
      const key = `spawn:${entry.requestId}`;
      if (this.idempotentRequests.has(key)) continue;
      this.idempotentRequests.set(key, { signature: entry.signature, receipt: entry.receipt });
    }
  }

  /**
   * 注入或替换委派续聊执行器；替换只影响后续续聊，已受理的续聊仍走原执行器。
   */
  setResumer(resumer: SubagentSessionResumer): void {
    this.resumer = resumer;
  }

  /**
   * 获取发件箱实例，供通知查询与 ACK 对账。
   */
  getOutbox(): SubagentOutbox {
    return this.outbox;
  }

  /**
   * 注入或替换子代理执行器。
   */
  setRunner(runner: SubagentSessionRunner): void {
    this.runner = runner;
  }

  /**
   * 获取指定子代理记录快照。
   */
  getTask(agentId: string): AgentTaskRecord | undefined {
    const task = this.tasks.get(agentId);
    return task ? structuredClone(task) : undefined;
  }

  /**
   * 订阅任务创建与状态变化；通知只表示快照可能已更新，不提供可变任务对象。
   * 同一轮微任务内的变化可合并，不保证逐个中间状态；订阅时不主动发送通知，
   * 宿主应先订阅，再通过 listTasks 按会话和根任务读取独立复制的快照。
   * 监听器的同步异常与异步拒绝均隔离，不等待监听器，也不触发结果投递或父模型请求。
   *
   * @param listener 无参数变化监听器；应只读取展示状态，异步监听器可自行重叠执行。
   * @returns 幂等取消函数；同一监听器的多次订阅独立取消，运行时关闭时全部释放。
   * 已关闭的运行时不保留新订阅，返回的取消函数可安全调用。
   */
  subscribeTaskChanges(listener: () => void | Promise<void>): () => void {
    if (this.isClosed) return () => {};
    const subscription = () => listener();
    this.taskChangeListeners.add(subscription);
    return () => {
      this.taskChangeListeners.delete(subscription);
    };
  }

  /**
   * 判断目标任务是否为指定祖先任务的后代（直接或间接子任务）。
   */
  isDescendantOf(targetId: string, ancestorId: string): boolean {
    let current = this.tasks.get(targetId);
    while (current?.origin.parentAgentId) {
      if (current.origin.parentAgentId === ancestorId) return true;
      current = this.tasks.get(current.origin.parentAgentId);
    }
    return false;
  }

  /**
   * 准备并受理子代理启动请求（spawn_agent 执行第一阶段）。
   *
   * 保证：
   * - 严格校验参数必填项与预设角色；
   * - 深度超限立即拒绝（SUBAGENT_DEPTH_EXCEEDED）；
   * - 容量超限立即拒绝（AGENT_CAPACITY_EXCEEDED）；
   * - 工作区路径越界立即拒绝（SUBAGENT_WORKSPACE_VIOLATION）；
   * - 生成 agentId 并原子预留活动槽与累计槽；
   * - 登记为 preparing 状态并返回 accepted 回执，使父工具事务能立刻闭合。
   */
  async prepareSpawn(context: SpawnContext, params: SpawnAgentParams): Promise<SpawnAgentReceipt> {
    // 宿主可能从另一份 Core 模块传入同一协调器；检查所需接口，保留父会话实例身份。
    const coordinator = context.leaseCoordinator;
    if (
      !coordinator ||
      typeof coordinator !== 'object' ||
      typeof coordinator.isLocked !== 'function' ||
      typeof coordinator.getActiveLease !== 'function' ||
      typeof coordinator.tryAcquire !== 'function' ||
      typeof coordinator.acquire !== 'function'
    ) {
      throw new KapibalaError('Spawn requires the parent workspace lease coordinator', {
        code: 'CONFIG_INVALID',
        safeMessage: '必须显式传入父会话写租约协调器',
      });
    }
    if (this.isClosed) {
      throw new KapibalaError('AgentRuntime is closed', {
        code: 'CONFIG_INVALID',
        safeMessage: '子代理运行时已关闭，无法受理新任务',
      });
    }

    // 幂等优先于一切校验与容量检查：同 requestId 同参直接重放原回执，不再预留槽位。
    const requestId = params.requestId?.trim();
    let requestSignature: string | undefined;
    if (requestId) {
      requestSignature = spawnRequestSignature(params);
      const existing = this.idempotentRequests.get(`spawn:${requestId}`);
      if (existing) {
        if (existing.signature !== requestSignature) {
          throw createDelegationError(
            'DELEGATION_REQUEST_CONFLICT',
            `Spawn requestId "${requestId}" was already used with different parameters`,
          );
        }
        return existing.receipt as SpawnAgentReceipt;
      }
    }

    if (params.isolation === 'worktree') {
      throw new KapibalaError(
        'Worktree isolation is not currently supported; use inherit isolation',
        {
          code: 'CONFIG_INVALID',
          safeMessage: '当前环境暂不支持 worktree 物理隔离模式',
        },
      );
    }

    if (
      params.modelOverride &&
      this.validateModelOverride &&
      !this.validateModelOverride(params.modelOverride)
    ) {
      throw new KapibalaError(
        `Invalid model override: "${params.modelOverride}" is not a recognized profile`,
        {
          code: 'CONFIG_INVALID',
          safeMessage: `无效的模型覆盖参数: "${params.modelOverride}" 不是可用的模型配置`,
        },
      );
    }

    if (
      !params.description ||
      typeof params.description !== 'string' ||
      !params.description.trim()
    ) {
      throw new Error('Description is required for spawn_agent');
    }
    if (!params.prompt || typeof params.prompt !== 'string' || !params.prompt.trim()) {
      throw new Error('Prompt is required for spawn_agent');
    }
    if (!params.role || !ROLE_PRESETS[params.role]) {
      throw new Error(`Invalid role preset: ${params.role}`);
    }

    const currentDepth = context.depth ?? 0;
    const targetDepth = currentDepth + 1;
    if (targetDepth > DEFAULT_MAX_SUBAGENT_DEPTH) {
      throw new KapibalaError(
        `Subagent depth limit exceeded: current depth ${currentDepth}, max allowed ${DEFAULT_MAX_SUBAGENT_DEPTH}`,
        {
          code: 'SUBAGENT_DEPTH_EXCEEDED',
          safeMessage: `子代理调用深度超限（当前 ${currentDepth}，上限 ${DEFAULT_MAX_SUBAGENT_DEPTH}）`,
        },
      );
    }

    const rootTaskId = context.rootTaskId ?? createMessageId();
    const treeActive = this.treeActiveCounts.get(rootTaskId) ?? 0;
    const treeTotal = this.treeTotalCounts.get(rootTaskId) ?? 0;

    if (this.totalActiveCount >= MAX_ACTIVE_TASKS_PER_RUNTIME) {
      throw new KapibalaError(
        `Global subagent active capacity exceeded: max ${MAX_ACTIVE_TASKS_PER_RUNTIME}`,
        {
          code: 'AGENT_CAPACITY_EXCEEDED',
          safeMessage: `全局活动子代理数量已达上限（${MAX_ACTIVE_TASKS_PER_RUNTIME}）`,
        },
      );
    }

    if (treeActive >= MAX_ACTIVE_TASKS_PER_TREE) {
      throw new KapibalaError(
        `Tree subagent active capacity exceeded: max ${MAX_ACTIVE_TASKS_PER_TREE}`,
        {
          code: 'AGENT_CAPACITY_EXCEEDED',
          safeMessage: `当前任务树并发活动子代理已达上限（${MAX_ACTIVE_TASKS_PER_TREE}）`,
        },
      );
    }

    if (treeTotal >= MAX_TOTAL_TASKS_PER_TREE) {
      throw new KapibalaError(
        `Tree subagent total capacity exceeded: max ${MAX_TOTAL_TASKS_PER_TREE}`,
        {
          code: 'AGENT_CAPACITY_EXCEEDED',
          safeMessage: `当前任务树累计受理子代理已达上限（${MAX_TOTAL_TASKS_PER_TREE}）`,
        },
      );
    }

    const nativeWorkspaceRoot = toNativePhysicalPath(context.workspaceRoot);
    const nativeExecutionCwd = params.cwd
      ? toNativePhysicalPath(path.resolve(nativeWorkspaceRoot, params.cwd))
      : toNativePhysicalPath(context.executionCwd);

    if (!isPathInside(nativeWorkspaceRoot, nativeExecutionCwd)) {
      throw new KapibalaError(
        `Subagent execution cwd escapes workspace boundary: ${nativeExecutionCwd}`,
        {
          code: 'SUBAGENT_WORKSPACE_VIOLATION',
          safeMessage: '子代理执行目录超出工作区根目录范围',
        },
      );
    }

    // 校验角色预设与 ChildGrant 白名单求交
    if (params.role === 'custom' && (!params.allowedTools || !params.allowedTools.length)) {
      throw new KapibalaError('Custom role requires explicit allowedTools whitelist', {
        code: 'CONFIG_INVALID',
        safeMessage: 'Custom 角色必须显式提供 allowedTools 白名单',
      });
    }

    const agentId = createMessageId();
    const maxSteps = Math.min(params.limits?.maxSteps ?? DEFAULT_MAX_STEPS, DEFAULT_MAX_STEPS);
    const timeoutMs = Math.min(params.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

    const parentPolicy: ParentPolicySnapshot = context.parentPolicy ?? {
      mode: 'Approval',
      rules: [],
      currentDepth,
      maxDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
      workspaceRoot: nativeWorkspaceRoot,
      executionCwd: nativeExecutionCwd,
      availableTools: (params.allowedTools ?? []).map((t) => ({ name: t })),
    };

    const derivedPolicy = deriveChildPolicy(parentPolicy, {
      role: params.role,
      allowedTools: params.allowedTools,
      executionCwd: nativeExecutionCwd,
      limits: {
        maxSteps,
        timeoutMs,
      },
    });

    const origin: AgentTaskOrigin = {
      rootTaskId,
      parentAgentId: context.agentId,
      parentSessionId: context.sessionId,
      originBranchId: context.branchId,
      originRunId: context.runId,
      spawnToolCallId: context.toolCallId,
      generation: (context.generation ?? 0) + 1,
      depth: targetDepth,
    };

    const taskRecord: AgentTaskRecord = {
      agentId,
      origin,
      role: params.role,
      description: params.description.trim(),
      prompt: params.prompt.trim(),
      status: 'preparing',
      createdAt: Date.now(),
      childAgentIds: new Set(),
      workspaceRoot: nativeWorkspaceRoot,
      executionCwd: nativeExecutionCwd,
      allowedTools: params.allowedTools,
      isolation: params.isolation ?? 'inherit',
      mode: params.mode ?? 'ephemeral',
      runGeneration: 1,
      modelOverride: params.modelOverride,
      effectivePolicy: derivedPolicy,
      limits: Object.freeze({
        maxSteps,
        timeoutMs,
      }),
      ...(requestId ? { requestId } : {}),
      ...(requestSignature ? { requestSignature } : {}),
    };

    // 原子预留容量
    this.runnerContexts.set(
      agentId,
      Object.freeze({
        leaseCoordinator: context.leaseCoordinator,
        ...(context.parentTitle ? { parentTitle: context.parentTitle } : {}),
        onSessionCreated: (sessionId: string) => {
          const target = this.tasks.get(agentId);
          if (!target || target.mode !== 'detached') return;
          target.sessionId = sessionId;
          if (target.requestReceipt) {
            target.requestReceipt = { ...target.requestReceipt, sessionId };
            if (target.requestId) {
              const entry = this.idempotentRequests.get(`spawn:${target.requestId}`);
              if (entry) entry.receipt = target.requestReceipt;
            }
          }
          this.notifyStateChange();
        },
      }),
    );
    this.tasks.set(agentId, taskRecord);
    this.totalActiveCount++;
    this.treeActiveCounts.set(rootTaskId, treeActive + 1);
    this.treeTotalCounts.set(rootTaskId, treeTotal + 1);

    if (context.agentId) {
      const parentTask = this.tasks.get(context.agentId);
      if (parentTask) {
        parentTask.childAgentIds.add(agentId);
      }
    }
    this.notifyTaskChanges();

    const preferredRole = ROLE_PRESETS[params.role].preferredRole;

    const receipt: SpawnAgentReceipt = {
      agentId,
      status: 'accepted',
      role: params.role,
      description: params.description.trim(),
      depth: targetDepth,
      rootTaskId,
      modelRole: preferredRole,
      workspaceRoot: nativeWorkspaceRoot,
      executionCwd: nativeExecutionCwd,
    };

    if (requestId && requestSignature) {
      // 回执快照同时挂在任务记录上，宿主创建委派会话时可原样转写进 header。
      taskRecord.requestReceipt = receipt;
      this.idempotentRequests.set(`spawn:${requestId}`, { signature: requestSignature, receipt });
    }

    return receipt;
  }

  /**
   * 激活并启动已受理的子代理任务（父事务提交确认后触发）。
   *
   * 状态跃迁：preparing → accepted → running。
   */
  async activateSpawn(agentId: string): Promise<void> {
    const task = this.tasks.get(agentId);
    if (!task) {
      throw new Error(`Task not found: ${agentId}`);
    }
    if (task.status !== 'preparing') {
      return;
    }

    task.status = 'accepted';
    this.notifyStateChange();

    const runPromise = this.runTask(task);
    this.runningPromises.set(agentId, runPromise);
    runPromise.finally(() => {
      this.runningPromises.delete(agentId);
    });
  }

  /**
   * 撤销处于 preparing 状态的子代理任务（父事务提交失败或异常中止时触发）。
   */
  async rollbackPreparedSpawn(agentId: string): Promise<void> {
    const task = this.tasks.get(agentId);
    if (!task) return;
    if (task.status === 'preparing') {
      this.runnerContexts.delete(agentId);
      // 回滚后同 requestId 允许重新派发：保留索引会把失败派发误判为已完成。
      if (task.requestId) this.idempotentRequests.delete(`spawn:${task.requestId}`);
      task.status = 'cancelled';
      task.error = 'Parent transaction aborted before commit';
      task.finishedAt = Date.now();
      this.releaseTaskSlotOnce(task);
      this.notifyStateChange();
    }
  }

  /**
   * 受理委派会话续聊请求（send_agent 执行第一阶段）。
   *
   * 保证：
   * - 目标必须是本运行时的 detached 任务且已回到终态；活动态 DELEGATION_BUSY，不排队；
   * - 只重新占用活动槽位，不消耗「累计受理」配额，也不新增任务记录；
   * - 递增 runGeneration 并回执，父工具事务可立即闭合；真正执行由 activateResume 触发；
   * - 同 requestId 同参直接重放原回执，异参抛 DELEGATION_REQUEST_CONFLICT。
   */
  async prepareResume(params: SendAgentParams): Promise<SendAgentReceipt> {
    if (this.isClosed) {
      throw new KapibalaError('AgentRuntime is closed', {
        code: 'CONFIG_INVALID',
        safeMessage: '子代理运行时已关闭，无法受理续聊任务',
      });
    }
    if (!this.resumer) {
      throw new KapibalaError('Subagent resumer is not configured', {
        code: 'CONFIG_INVALID',
        safeMessage: '宿主未注入续聊执行器，当前无法继续委派会话',
      });
    }

    const requestId = params.requestId?.trim();
    let requestSignature: string | undefined;
    if (requestId) {
      requestSignature = resumeRequestSignature(params);
      const existing = this.idempotentRequests.get(`send:${requestId}`);
      if (existing) {
        if (existing.signature !== requestSignature) {
          throw createDelegationError(
            'DELEGATION_REQUEST_CONFLICT',
            `Send requestId "${requestId}" was already used with different parameters`,
          );
        }
        return existing.receipt as SendAgentReceipt;
      }
    }

    const prompt = params.prompt?.trim();
    if (!prompt) throw new Error('Prompt is required for send_agent');

    const task = this.tasks.get(params.agentId);
    if (!task) {
      throw createDelegationError(
        'DELEGATION_NOT_FOUND',
        `Delegation task not found in current runtime: ${params.agentId}`,
      );
    }
    if (task.mode !== 'detached' || !task.sessionId) {
      throw createDelegationError(
        'DELEGATION_NOT_RETAINED',
        `Task ${params.agentId} has no retained delegation session`,
      );
    }
    if (!isTerminalTaskStatus(task.status)) {
      throw createDelegationError(
        'DELEGATION_BUSY',
        `Task ${params.agentId} is still ${task.status}; busy delegations are not queued`,
      );
    }

    if (this.totalActiveCount >= MAX_ACTIVE_TASKS_PER_RUNTIME) {
      throw new KapibalaError(
        `Global subagent active capacity exceeded: max ${MAX_ACTIVE_TASKS_PER_RUNTIME}`,
        {
          code: 'AGENT_CAPACITY_EXCEEDED',
          safeMessage: `全局活动子代理数量已达上限（${MAX_ACTIVE_TASKS_PER_RUNTIME}）`,
        },
      );
    }
    const treeActive = this.treeActiveCounts.get(task.origin.rootTaskId) ?? 0;
    if (treeActive >= MAX_ACTIVE_TASKS_PER_TREE) {
      throw new KapibalaError(
        `Tree subagent active capacity exceeded: max ${MAX_ACTIVE_TASKS_PER_TREE}`,
        {
          code: 'AGENT_CAPACITY_EXCEEDED',
          safeMessage: `当前任务树并发活动子代理已达上限（${MAX_ACTIVE_TASKS_PER_TREE}）`,
        },
      );
    }

    const snapshot: ResumeSnapshot = {
      status: task.status,
      summary: task.summary,
      error: task.error,
      finishedAt: task.finishedAt,
      startedAt: task.startedAt,
      runGeneration: task.runGeneration ?? 1,
      continuationOf: task.continuationOf,
      requestId,
    };
    this.resumeSnapshots.set(task.agentId, snapshot);
    this.resumePrompts.set(task.agentId, prompt);

    task.status = 'accepted';
    task.runGeneration = snapshot.runGeneration + 1;
    task.continuationOf = `run-${snapshot.runGeneration}`;
    task.summary = undefined;
    task.error = undefined;
    task.startedAt = undefined;
    task.finishedAt = undefined;
    task.slotReleased = false;

    this.totalActiveCount++;
    this.treeActiveCounts.set(task.origin.rootTaskId, treeActive + 1);

    const receipt: SendAgentReceipt = {
      agentId: task.agentId,
      status: 'accepted',
      role: task.role,
      description: task.description,
      depth: task.origin.depth,
      rootTaskId: task.origin.rootTaskId,
      sessionId: task.sessionId,
      runGeneration: task.runGeneration,
    };
    if (requestId && requestSignature) {
      this.idempotentRequests.set(`send:${requestId}`, { signature: requestSignature, receipt });
    }
    this.notifyStateChange();
    return receipt;
  }

  /**
   * 清理已被物理删除的委派会话在运行时留下的身份（用户执行 `/delegations delete` 后调用）。
   *
   * 保证：
   * - 只清空 `sessionId` / `title`，让后续 send_agent 在 prepareResume 阶段直接得到
   *   DELEGATION_NOT_RETAINED，而不是在 resumer 里以未分类的打开错误失败；
   * - 同步移除指向该会话的 spawn 幂等条目，避免重放回执再次指向已删除的会话；
   * - 不删除任务记录、不改状态机：父会话对账与历史观测仍需看到该任务已结束。
   *
   * @param sessionId 被物理删除的委派会话 ID
   */
  forgetDelegationSession(sessionId: string): void {
    let changed = false;
    for (const task of this.tasks.values()) {
      if (task.sessionId !== sessionId) continue;
      task.sessionId = undefined;
      task.title = undefined;
      changed = true;
    }
    for (const [key, entry] of this.idempotentRequests) {
      if (entry.receipt.sessionId === sessionId) this.idempotentRequests.delete(key);
    }
    if (changed) this.notifyStateChange();
  }

  /**
   * 激活已受理的续聊（父事务提交确认后触发）；状态跃迁 accepted → running。
   */
  async activateResume(agentId: string): Promise<void> {
    const task = this.tasks.get(agentId);
    const prompt = this.resumePrompts.get(agentId);
    if (!task || task.status !== 'accepted' || prompt === undefined) return;
    const runPromise = this.runTask(task, prompt);
    this.runningPromises.set(agentId, runPromise);
    runPromise.finally(() => {
      this.runningPromises.delete(agentId);
    });
  }

  /**
   * 撤销未提交的续聊受理：恢复原终态、释放重新占用的槽位并清理幂等条目。
   */
  async rollbackPreparedResume(agentId: string): Promise<void> {
    const task = this.tasks.get(agentId);
    const snapshot = this.resumeSnapshots.get(agentId);
    if (!task || !snapshot) return;
    this.resumeSnapshots.delete(agentId);
    this.resumePrompts.delete(agentId);
    if (task.status !== 'accepted') return;

    task.status = snapshot.status;
    task.summary = snapshot.summary;
    task.error = snapshot.error;
    task.finishedAt = snapshot.finishedAt;
    task.startedAt = snapshot.startedAt;
    task.runGeneration = snapshot.runGeneration;
    task.continuationOf = snapshot.continuationOf;
    task.slotReleased = false;
    if (snapshot.requestId) this.idempotentRequests.delete(`send:${snapshot.requestId}`);
    this.releaseActiveSlot(task.origin.rootTaskId);
    this.notifyStateChange();
  }

  /**
   * 任务主执行流程与生命周期状态机驱动。
   *
   * @param task 目标任务记录
   * @param resumePrompt 续聊输入；给出时走 resumer，缺省走首次执行 runner
   */
  private async runTask(task: AgentTaskRecord, resumePrompt?: string): Promise<void> {
    if (task.status !== 'accepted') {
      return;
    }

    task.status = 'running';
    task.startedAt = Date.now();
    this.notifyStateChange();

    const controller = new AbortController();
    this.controllers.set(task.agentId, controller);

    // 启动墙钟硬超时守卫
    const timer = setTimeout(() => {
      void this.handleTaskTimeout(task.agentId);
    }, task.limits.timeoutMs);
    this.timers.set(task.agentId, timer);

    let runError: Error | undefined;
    try {
      const context = this.runnerContexts.get(task.agentId);
      if (!context)
        throw new KapibalaError('Runner context is unavailable', { code: 'CONFIG_INVALID' });
      // 续聊只接受 summary/modelId；会话身份在首次派发时已确定，不允许被改写。
      let result: { summary: string; modelId?: string; sessionId?: string; title?: string };
      if (resumePrompt === undefined) {
        result = await this.runner(task, controller.signal, context);
      } else {
        result = await this.resumer!(task, resumePrompt, controller.signal, context);
      }

      // 执行期间已被取消，拒绝跃迁为 completed
      if ((task.status as AgentTaskStatus) === 'cancelling') {
        task.status = 'cancelled';
        return;
      }
      if (controller.signal.aborted) {
        task.status = 'failed';
        task.error = task.error ?? 'Task timed out';
        return;
      }

      task.summary = result.summary;
      task.modelId = result.modelId;
      // 只有 detached 任务回填对外身份与展示名；ephemeral 保持历史行为，不留可见会话。
      if (task.mode === 'detached' && result.sessionId) {
        task.sessionId = result.sessionId;
        task.title = result.title;
      }

      // 自身主轮结束后，检查是否有未结束的后代子代理
      const hasActiveChildren = () =>
        Array.from(task.childAgentIds).some((childId) => {
          const child = this.tasks.get(childId);
          return child && isActiveTaskStatus(child.status);
        });

      if (hasActiveChildren()) {
        task.status = 'waiting_children';
        this.notifyStateChange();

        // 持续等待后代全部终结或当前任务超时/取消
        await this.waitForChildren(task.agentId, controller.signal);

        if ((task.status as AgentTaskStatus) === 'cancelling') {
          task.status = 'cancelled';
          return;
        }
        if (controller.signal.aborted) {
          task.status = 'failed';
          task.error = task.error ?? 'Task timed out';
          return;
        }
        task.status = 'running';
      }

      if ((task.status as AgentTaskStatus) === 'cancelling') {
        task.status = 'cancelled';
        return;
      }
      if (controller.signal.aborted) {
        task.status = 'failed';
        task.error = task.error ?? 'Task timed out';
        return;
      }

      task.status = 'completed';
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
      if ((task.status as AgentTaskStatus) === 'cancelling') {
        task.status = 'cancelled';
      } else {
        task.status = 'failed';
      }
      task.error = runError.message;
    } finally {
      // detached 任务保留运行上下文：sessionId 已给出，续聊仍需同一租约协调器与父标题快照。
      // ephemeral 会话终态即销毁，上下文一并释放，避免按已结束任务累积内存。
      if (task.mode !== 'detached') this.runnerContexts.delete(task.agentId);
      this.resumePrompts.delete(task.agentId);
      this.resumeSnapshots.delete(task.agentId);
      this.clearTaskTimer(task.agentId);
      this.controllers.delete(task.agentId);

      if (!isTerminalTaskStatus(task.status)) {
        task.status = 'failed';
        task.error = runError?.message ?? 'Unknown execution failure';
      }

      // 失败任务在此无条件级联取消后代：墙钟超时与取消信号下 runner 正常返回的路径
      // 不经过 catch，级联只在异常路径做会漏掉它们（违反文件头约束 4）。
      // cancelled 的后代由 cancelTask 发起时已经级联，这里不重复触发，避免覆盖调用方原因。
      if (task.status === 'failed') {
        await this.cascadeCancelChildren(task.agentId, task.error ?? 'Parent task failed');
      }

      task.finishedAt = Date.now();

      // 幂等安全释放活动槽位（避免与 cancelTask 重复扣减）
      this.releaseTaskSlotOnce(task);
      // 续聊复用同一 agentId/generation，终态通知必须换 revision，否则会被当作重复事件丢弃。
      const runGeneration = task.runGeneration ?? 1;
      this.outbox.enqueueFromTask(task, runGeneration > 1 ? `run-${runGeneration}` : 'final');
      this.notifyStateChange();
    }
  }

  /**
   * 等待指定任务的所有直接与间接后代达到终态。
   */
  private async waitForChildren(agentId: string, signal: AbortSignal): Promise<void> {
    const task = this.tasks.get(agentId);
    if (!task) return;

    while (!signal.aborted) {
      const activeChildren = Array.from(task.childAgentIds).filter((childId) => {
        const child = this.tasks.get(childId);
        return child && isActiveTaskStatus(child.status);
      });
      if (activeChildren.length === 0) {
        break;
      }
      await this.waitForNextStateChange(signal);
    }
  }

  /**
   * 级联取消指定任务的所有直接与间接活跃后代。
   */
  private async cascadeCancelChildren(agentId: string, reason: string): Promise<void> {
    const task = this.tasks.get(agentId);
    if (!task) return;

    const childPromises = Array.from(task.childAgentIds).map(async (childId) => {
      const child = this.tasks.get(childId);
      if (child && isActiveTaskStatus(child.status)) {
        await this.cancelTask(childId, reason);
      }
    });

    await Promise.all(childPromises);
  }

  /**
   * 处理任务超时事件。
   */
  private async handleTaskTimeout(agentId: string): Promise<void> {
    const task = this.tasks.get(agentId);
    if (!task || !isActiveTaskStatus(task.status)) return;

    task.error = `Task wall-clock timeout exceeded: ${task.limits.timeoutMs}ms`;
    const controller = this.controllers.get(agentId);
    controller?.abort(new Error(task.error));
  }

  /**
   * 显式取消指定子代理任务。
   *
   * 保证：
   * - 幂等性：已处于终态直接返回；
   * - 跃迁为 cancelling 并中断当前执行信号；
   * - 级联取消所有后代子代理并等待后代清理完成；
   * - 等待自身 runner 退出并完成清理（R07）；
   * - 释放活动槽位，写入 cancelled 终态，生成可靠通知（R08）。
   */
  async cancelTask(agentId: string, reason = 'Cancelled by caller'): Promise<void> {
    const task = this.tasks.get(agentId);
    if (!task || isTerminalTaskStatus(task.status)) {
      return;
    }

    task.status = 'cancelling';
    task.error = reason;
    this.notifyStateChange();

    const controller = this.controllers.get(agentId);
    controller?.abort(new Error(reason));

    // 级联取消后代
    await this.cascadeCancelChildren(agentId, reason);

    // 关键：等待自身的 runner 异步退出完成资源清理（R07），增加 5 秒宽限超时保护
    const inFlight = this.runningPromises.get(agentId);
    if (!inFlight) this.runnerContexts.delete(agentId);
    if (inFlight) {
      const GRACE_PERIOD_MS = 5000;
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), GRACE_PERIOD_MS);
      });
      const outcome = await Promise.race([
        inFlight.then(() => 'completed' as const).catch(() => 'error' as const),
        timeoutPromise,
      ]).finally(() => clearTimeout(timer));

      if (outcome === 'timed_out') {
        task.error = `${reason} (runner did not respond to abort within grace period)`;
      }
    }

    this.clearTaskTimer(agentId);
    this.controllers.delete(agentId);

    task.status = 'cancelled';
    task.finishedAt = Date.now();

    this.releaseTaskSlotOnce(task);
    const runGeneration = task.runGeneration ?? 1;
    this.outbox.enqueueFromTask(task, runGeneration > 1 ? `run-${runGeneration}` : 'final');
    this.notifyStateChange();
  }

  /**
   * 等待指定的子代理任务终结或超时。
   *
   * @param agentIds 目标子代理 ID 列表
   * @param timeoutMs 超时毫秒数（默认 30,000，上限 60,000）
   * @param signal 中止信号
   */
  async waitAgents(
    agentIds: string[],
    timeoutMs = 30_000,
    signal?: AbortSignal,
  ): Promise<{ completed: string[]; pending: string[] }> {
    const boundedTimeout = Math.min(Math.max(timeoutMs, 100), 60_000);
    const deadline = Date.now() + boundedTimeout;

    while (Date.now() < deadline && !signal?.aborted) {
      const pending: string[] = [];
      const completed: string[] = [];

      for (const id of agentIds) {
        const task = this.tasks.get(id);
        if (!task || isTerminalTaskStatus(task.status)) {
          completed.push(id);
        } else {
          pending.push(id);
        }
      }

      if (pending.length === 0) {
        return { completed, pending: [] };
      }

      const remainingTime = deadline - Date.now();
      if (remainingTime <= 0) break;

      const waitSignal = signal
        ? AbortSignal.any([signal, AbortSignal.timeout(remainingTime)])
        : AbortSignal.timeout(remainingTime);
      await this.waitForNextStateChange(waitSignal);
    }

    const pending: string[] = [];
    const completed: string[] = [];
    for (const id of agentIds) {
      const task = this.tasks.get(id);
      if (!task || isTerminalTaskStatus(task.status)) {
        completed.push(id);
      } else {
        pending.push(id);
      }
    }
    return { completed, pending };
  }

  /**
   * 按过滤条件查询子代理任务列表；每条记录深度复制，调用方修改快照不影响运行时。
   */
  listTasks(filter?: ListAgentsFilter): AgentTaskRecord[] {
    const results: AgentTaskRecord[] = [];
    for (const task of this.tasks.values()) {
      if (filter?.rootTaskId && task.origin.rootTaskId !== filter.rootTaskId) {
        continue;
      }
      if (filter?.parentAgentId && task.origin.parentAgentId !== filter.parentAgentId) {
        continue;
      }
      if (filter?.parentSessionId && task.origin.parentSessionId !== filter.parentSessionId) {
        continue;
      }
      if (filter?.status) {
        if (filter.status === 'active' && !isActiveTaskStatus(task.status)) {
          continue;
        }
        if (filter.status === 'terminal' && !isTerminalTaskStatus(task.status)) {
          continue;
        }
        if (
          filter.status !== 'active' &&
          filter.status !== 'terminal' &&
          task.status !== filter.status
        ) {
          continue;
        }
      }
      results.push(structuredClone(task));
    }
    return results;
  }

  /**
   * 关闭 Runtime 并取消所有活动任务；立即释放宿主订阅，再等待任务清理收口。
   */
  async close(): Promise<void> {
    this.isClosed = true;
    this.taskChangeListeners.clear();
    const activeTasks = Array.from(this.tasks.values()).filter((t) => isActiveTaskStatus(t.status));
    await Promise.all(activeTasks.map((t) => this.cancelTask(t.agentId, 'Runtime closing')));
    await Promise.all(Array.from(this.runningPromises.values()).map((p) => p.catch(() => {})));
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.controllers.clear();
    this.runnerContexts.clear();
    this.stateListeners.clear();
  }

  /**
   * 幂等释放指定任务占用的活动容量槽位。
   * 防止取消操作与主轮次 finally 重复扣减导致槽位泄漏。
   */
  private releaseTaskSlotOnce(task: AgentTaskRecord): void {
    if (task.slotReleased) return;
    task.slotReleased = true;
    this.releaseActiveSlot(task.origin.rootTaskId);
  }

  private releaseActiveSlot(rootTaskId: string): void {
    if (this.totalActiveCount > 0) {
      this.totalActiveCount--;
    }
    const treeCount = this.treeActiveCounts.get(rootTaskId) ?? 0;
    if (treeCount > 0) {
      this.treeActiveCounts.set(rootTaskId, treeCount - 1);
    }
  }

  private clearTaskTimer(agentId: string): void {
    const timer = this.timers.get(agentId);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(agentId);
    }
  }

  /** 先保留调度等待者的同步唤醒时序，再异步通知宿主读取任务快照。 */
  private notifyStateChange(): void {
    for (const listener of this.stateListeners) {
      try {
        listener();
      } catch {
        /* 忽略监听器内部异常 */
      }
    }
    this.notifyTaskChanges();
  }

  /**
   * 合并宿主变化通知，避免宿主回调同步重入任务状态转换；不改变内部等待者的唤醒时序。
   * 派发前再次检查订阅与关闭状态，取消后的回调不会执行，观察者失败不传播至任务。
   */
  private notifyTaskChanges(): void {
    if (
      this.isClosed ||
      this.taskChangeNotificationPending ||
      this.taskChangeListeners.size === 0
    ) {
      return;
    }
    this.taskChangeNotificationPending = true;
    queueMicrotask(() => {
      this.taskChangeNotificationPending = false;
      for (const listener of [...this.taskChangeListeners]) {
        if (!this.taskChangeListeners.has(listener)) continue;
        try {
          void Promise.resolve(listener()).catch(() => {});
        } catch {
          /* 观察者异常不能破坏其他观察者或后台任务。 */
        }
      }
    });
  }

  private waitForNextStateChange(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
      const cleanup = () => {
        this.stateListeners.delete(onStateChange);
        signal.removeEventListener('abort', onAbort);
      };
      const onStateChange = () => {
        cleanup();
        resolve();
      };
      const onAbort = () => {
        cleanup();
        resolve();
      };
      this.stateListeners.add(onStateChange);
      signal.addEventListener('abort', onAbort);
    });
  }
}

/**
 * 生成参数签名：字段顺序固定的规范化对象再取 sha256。
 *
 * 约束：只用于「同 requestId 是否同参」判定，不作为安全凭证；
 * 未给出的可选参数统一写成显式默认值，避免 undefined 与缺省值被判成不同派发。
 */
function buildRequestSignature(normalized: Record<string, unknown>): string {
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
}

/** spawn_agent 的参数签名；description/prompt 去首尾空白后参与比较。 */
function spawnRequestSignature(params: SpawnAgentParams): string {
  return buildRequestSignature({
    description: params.description?.trim() ?? '',
    prompt: params.prompt?.trim() ?? '',
    role: params.role,
    allowedTools: params.allowedTools ?? [],
    cwd: params.cwd ?? '',
    isolation: params.isolation ?? 'inherit',
    mode: params.mode ?? 'ephemeral',
    modelOverride: params.modelOverride ?? '',
    maxSteps: params.limits?.maxSteps ?? null,
    timeoutMs: params.limits?.timeoutMs ?? null,
  });
}

/** send_agent 的参数签名：目标 agentId 与新一轮输入共同决定幂等身份。 */
function resumeRequestSignature(params: SendAgentParams): string {
  return buildRequestSignature({
    agentId: params.agentId,
    prompt: params.prompt?.trim() ?? '',
  });
}
