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

import path from 'node:path';
import { isPathInside, toNativePhysicalPath } from '../../capabilities/security/sandbox.js';
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  type ParentPolicySnapshot,
  ROLE_PRESETS,
  type SubagentRole,
  deriveChildPolicy,
} from '../../capabilities/security/subagent-policy.js';
import { KapibalaError } from '../../errors/index.js';
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
  type SpawnAgentParams,
  type SpawnAgentReceipt,
  isActiveTaskStatus,
  isTerminalTaskStatus,
} from './types.js';

/** 子代理会话执行器类型；生产环境调用真实的 AgentSession，测试环境可注入 Mock。 */
export type SubagentSessionRunner = (
  record: AgentTaskRecord,
  signal: AbortSignal,
) => Promise<{ summary: string; modelId?: string }>;

/** 启动子代理时的调用方上下文。 */
export interface SpawnContext {
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
}

/**
 * AgentRuntime 初始化选项。
 */
export interface AgentRuntimeOptions {
  runner?: SubagentSessionRunner;
  validateModelOverride?: (modelId: string) => boolean;
  outboxPath?: string;
}

/**
 * 后台子代理任务树调度与状态机协调器。
 */
export class AgentRuntime {
  private readonly tasks = new Map<string, AgentTaskRecord>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly stateListeners = new Set<() => void>();
  private readonly outbox: SubagentOutbox;
  private readonly runningPromises = new Map<string, Promise<void>>();
  private runner: SubagentSessionRunner;
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
    this.validateModelOverride = options?.validateModelOverride;
    this.outbox = new SubagentOutbox({ storagePath: options?.outboxPath });
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
    if (this.isClosed) {
      throw new KapibalaError('AgentRuntime is closed', {
        code: 'CONFIG_INVALID',
        safeMessage: '子代理运行时已关闭，无法受理新任务',
      });
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
      modelOverride: params.modelOverride,
      effectivePolicy: derivedPolicy,
      limits: Object.freeze({
        maxSteps,
        timeoutMs,
      }),
    };

    // 原子预留容量
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

    const preferredRole = ROLE_PRESETS[params.role].preferredRole;

    return {
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
      task.status = 'cancelled';
      task.error = 'Parent transaction aborted before commit';
      task.finishedAt = Date.now();
      this.releaseTaskSlotOnce(task);
      this.notifyStateChange();
    }
  }

  /**
   * 任务主执行流程与生命周期状态机驱动。
   */
  private async runTask(task: AgentTaskRecord): Promise<void> {
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
      const result = await this.runner(task, controller.signal);

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

      // 自身运行失败时，无条件级联取消所有后代
      await this.cascadeCancelChildren(task.agentId, 'Parent task failed');
    } finally {
      this.clearTaskTimer(task.agentId);
      this.controllers.delete(task.agentId);

      if (!isTerminalTaskStatus(task.status)) {
        task.status = 'failed';
        task.error = runError?.message ?? 'Unknown execution failure';
      }

      task.finishedAt = Date.now();

      // 幂等安全释放活动槽位（避免与 cancelTask 重复扣减）
      this.releaseTaskSlotOnce(task);
      this.outbox.enqueueFromTask(task);
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
    this.outbox.enqueueFromTask(task);
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
   * 按过滤条件查询子代理任务列表。
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
   * 关闭 Runtime 并取消所有活动任务。
   */
  async close(): Promise<void> {
    this.isClosed = true;
    const activeTasks = Array.from(this.tasks.values()).filter((t) => isActiveTaskStatus(t.status));
    await Promise.all(activeTasks.map((t) => this.cancelTask(t.agentId, 'Runtime closing')));
    await Promise.all(Array.from(this.runningPromises.values()).map((p) => p.catch(() => {})));
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.controllers.clear();
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

  private notifyStateChange(): void {
    for (const listener of this.stateListeners) {
      try {
        listener();
      } catch {
        /* 忽略监听器内部异常 */
      }
    }
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
