import { type AgentRuntime, isTerminalTaskStatus } from '@kiturone/kapibala';
import { sanitizeUntrustedOutput } from '../ui/text-safety.js';
import type { TaskDeliveryStatus, TaskSummary } from '../view-model/status.js';

/**
 * 展示任务的真实身份范围；父会话必填，根身份只在宿主确知时附加，禁止自行拼接或猜测。
 * 来源分支不排除任务，用于提示显式切换分支；它不授予收集、审批或调度权限。
 */
export interface TaskObservationScope {
  readonly parentSessionId: string;
  readonly rootTaskId?: string;
  readonly branchId: string;
}

/**
 * 将运行时变化投影为只读任务摘要；不消费通知、不唤醒父模型，也不请求审批。
 * ACK 尚无独立观察 API，宿主显式收集后应调用 refresh；close 解除运行时订阅。
 */
export class TaskObservation {
  private scope: TaskObservationScope;
  private readonly unsubscribe: () => void;
  private tasks: readonly TaskSummary[] = [];
  /** 只保存实际见过的投递事件 ID，以 ACK 证明已收集；不复制 Core 的事件 ID 生成规则。 */
  private readonly observedEvents = new Map<string, string>();
  private closed = false;

  constructor(
    private readonly runtime: AgentRuntime,
    scope: TaskObservationScope,
    private onChange?: (tasks: readonly TaskSummary[]) => void | Promise<void>,
  ) {
    this.scope = this.validateScope(scope);
    this.unsubscribe = runtime.subscribeTaskChanges(() => {
      this.refresh();
    });
    this.refresh();
  }

  /** 返回独立摘要副本；宿主/UI 修改副本不影响后续刷新或运行时记录。 */
  snapshot(): readonly TaskSummary[] {
    return this.tasks.map((task) => ({ ...task }));
  }

  /**
   * 读取当前快照并通知宿主；用于显式 ACK 后刷新或切换父会话/根任务/分支。
   * 未提供 rootTaskId 时仍按父会话过滤直接子任务；关闭后不再读取运行时或触发回调。
   */
  refresh(scope?: TaskObservationScope): readonly TaskSummary[] {
    if (this.closed) return [];
    if (scope) this.scope = this.validateScope(scope);
    const outbox = this.runtime.getOutbox();
    const records = this.runtime.listTasks({
      parentSessionId: this.scope.parentSessionId,
      rootTaskId: this.scope.rootTaskId,
    });
    const visibleIds = new Set(records.map((task) => task.agentId));
    for (const id of this.observedEvents.keys())
      if (!visibleIds.has(id)) this.observedEvents.delete(id);
    const pendingIds = new Set<string>();
    for (const notification of outbox.getPendingNotifications()) {
      if (
        notification.parentSessionId !== this.scope.parentSessionId ||
        !visibleIds.has(notification.agentId)
      )
        continue;
      this.observedEvents.set(notification.agentId, notification.eventId);
      pendingIds.add(notification.agentId);
    }
    this.tasks = records.map((task): TaskSummary => {
      const terminal = isTerminalTaskStatus(task.status);
      const eventId = this.observedEvents.get(task.agentId);
      const delivery: TaskDeliveryStatus = !terminal
        ? 'not-ready'
        : pendingIds.has(task.agentId)
          ? 'pending'
          : eventId && outbox.isAcknowledged(eventId)
            ? 'collected'
            : 'unknown';
      const isOtherBranch = task.origin.originBranchId !== this.scope.branchId;
      const branch = sanitizeUntrustedOutput(task.origin.originBranchId);
      return {
        agentId: task.agentId,
        description: sanitizeUntrustedOutput(task.description),
        role: task.role,
        status: task.status,
        originBranchId: branch,
        isOtherBranch,
        branchHint: isOtherBranch ? `切换至来源分支 ${branch} 后显式收集` : undefined,
        delivery,
        summary: task.summary === undefined ? undefined : sanitizeUntrustedOutput(task.summary),
        error: task.error === undefined ? undefined : sanitizeUntrustedOutput(task.error),
      };
    });
    try {
      void Promise.resolve(this.onChange?.(this.snapshot())).catch(() => {});
    } catch {
      /* 展示失败不能影响任务。 */
    }
    return this.snapshot();
  }

  /** 幂等解除订阅并释放摘要、投递证据和回调；不取消或收集任何后台任务。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.tasks = [];
    this.observedEvents.clear();
    this.onChange = undefined;
  }

  /** 拒绝空身份，避免 Core 的可选过滤器将无效父会话意外当成无范围查询。 */
  private validateScope(scope: TaskObservationScope): TaskObservationScope {
    if (
      !scope.parentSessionId.trim() ||
      !scope.branchId.trim() ||
      (scope.rootTaskId !== undefined && !scope.rootTaskId.trim())
    )
      throw new Error('任务展示必须提供有效父会话、分支及可选根任务身份');
    return {
      parentSessionId: scope.parentSessionId,
      branchId: scope.branchId,
      rootTaskId: scope.rootTaskId,
    };
  }
}
