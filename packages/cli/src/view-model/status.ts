import type { OperationPhase } from './types.js';

/** 子任务公开执行状态；与结果收集状态分开，不引入 Core 或调度能力。 */
export type TaskExecutionStatus =
  | 'preparing'
  | 'accepted'
  | 'running'
  | 'waiting_children'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/** 收集证据未知时保持 unknown；终态本身不能证明结果已经投递。 */
export type TaskDeliveryStatus = 'not-ready' | 'pending' | 'collected' | 'unknown';

/** 宿主白名单投影后的子任务摘要；不携带提示词、权限、路径或原始可变任务对象。 */
export interface TaskSummary {
  readonly agentId: string;
  readonly description: string;
  readonly role: string;
  readonly status: TaskExecutionStatus;
  readonly originBranchId: string;
  readonly isOtherBranch: boolean;
  readonly branchHint?: string;
  readonly delivery: TaskDeliveryStatus;
  readonly summary?: string;
  readonly error?: string;
}

/** 最近一次请求的上下文事实；估算标识必须保留，不能从运行累计输入推导。 */
export interface StatusContextUsage {
  readonly usedTokens?: number;
  readonly limitTokens: number;
  readonly estimatedUsage?: boolean;
  readonly estimatedLimit: boolean;
  readonly percent?: number;
}

/** 当前运行累计 Token；缺失字段仍为未知，不用任务数量或上下文占用补齐。 */
export interface StatusRunUsage {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
}

/** 宿主提供的只读展示事实；动态字符串已经净化，不支持自行探测环境或计算树级账单。 */
export interface StatusFacts {
  readonly phase: OperationPhase;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly gitBranch?: string;
  readonly contextUsage?: StatusContextUsage;
  readonly runUsage?: StatusRunUsage;
  readonly tasks?: readonly TaskSummary[];
}

/** 纯语义状态段；priority 越大越优先保留，detailRef 由宿主解释为详情入口。 */
export interface StatusSegment {
  readonly id: string;
  readonly text: string;
  readonly priority: number;
  readonly detailRef: string;
}

/**
 * 从已净化的宿主事实组合状态段；不读取文件、不启动命令、不发起模型请求。
 * 上下文、当前运行累计用量独立展示；没有子代理账本时明确未知，不推导树级费用。
 */
export function buildStatusSegments(facts: StatusFacts): StatusSegment[] {
  const phases: Record<OperationPhase, string> = {
    idle: '空闲',
    running: '执行中',
    cancelling: '取消中',
    settling: '清理中',
  };
  const segments: StatusSegment[] = [
    { id: 'phase', text: phases[facts.phase], priority: 100, detailRef: '/status' },
  ];
  if (facts.model)
    segments.push({ id: 'model', text: facts.model, priority: 50, detailRef: '/model' });
  if (facts.permissionMode)
    segments.push({
      id: 'permission',
      text: facts.permissionMode,
      priority: 70,
      detailRef: '/status',
    });
  if (facts.gitBranch)
    segments.push({ id: 'git', text: facts.gitBranch, priority: 10, detailRef: '/status' });
  if (facts.contextUsage) {
    const usage = facts.contextUsage;
    const prefix = usage.estimatedUsage || usage.estimatedLimit ? '≈' : '';
    segments.push({
      id: 'context',
      text: `上下文 ${prefix}${usage.usedTokens ?? '未知'}/${usage.limitTokens}`,
      priority: 40,
      detailRef: '/status',
    });
  }
  if (facts.runUsage)
    segments.push({
      id: 'run-usage',
      text: `本轮 Token ${facts.runUsage.totalTokens ?? '未知'}`,
      priority: 30,
      detailRef: '/status',
    });
  const tasks = facts.tasks ?? [];
  if (tasks.length) {
    const active = tasks.filter((task) =>
      ['preparing', 'accepted', 'running', 'waiting_children', 'cancelling'].includes(task.status),
    ).length;
    const pending = tasks.filter((task) => task.delivery === 'pending').length;
    const otherBranch = tasks.filter((task) => task.isOtherBranch).length;
    segments.push({
      id: 'tasks',
      text: `后台 ${active}运行 · ${pending}待收集`,
      priority: pending ? 90 : 80,
      detailRef: '/agents',
    });
    if (otherBranch)
      segments.push({
        id: 'task-branch',
        text: `${otherBranch}异分支任务，切换来源分支后收集`,
        priority: 95,
        detailRef: '/agents',
      });
    segments.push({
      id: 'children-usage',
      text: '子代理 Token 未知',
      priority: 20,
      detailRef: '/status',
    });
  }
  return segments;
}

/**
 * 按优先级稳定选择完整状态段，预算不足时隐藏而不截断安全提示；同优先级保留输入顺序。
 * 调用方注入纯文本宽度计算器以适配中文等显示宽度；段间按三个空格列预算，不修改输入。
 */
export function selectStatusSegments(
  segments: readonly StatusSegment[],
  columns: number,
  measureWidth: (text: string) => number,
): StatusSegment[] {
  if (!Number.isFinite(columns) || columns <= 0) return [];
  const selected: StatusSegment[] = [];
  let used = 0;
  const ordered = segments
    .map((segment, index) => ({ segment, index }))
    .sort((a, b) => b.segment.priority - a.segment.priority || a.index - b.index);
  for (const { segment } of ordered) {
    const width = measureWidth(segment.text);
    if (!Number.isFinite(width) || width < 0) continue;
    const next = used + width + (selected.length ? 3 : 0);
    if (next <= columns) {
      selected.push({ ...segment });
      used = next;
    }
  }
  return selected;
}
