/**
 * @fileoverview 后台子代理任务状态机、来源元数据与限额类型定义。
 *
 * 约束、边界与为什么：
 * 1. 状态机严格单向/受控回环：
 *    preparing → accepted → running → waiting_children → completed / failed / cancelled / interrupted。
 *    有未结束后代时，自身主轮结束必须进入 waiting_children，等待后代收口后返回 running 完成终结。
 * 2. 来源链不可伪造（Origin Invariant）：
 *    每项任务持有稳定的 rootTaskId、parentAgentId、parentSessionId、originBranchId、originRunId
 *    与 spawnToolCallId，用作跨轮次对账、收件箱投递与去重键。
 * 3. 严格容量控制：
 *    每树活动上限 4，整运行时活动上限 8，每树累计上限 16，超额立即拒绝不排队，防止死锁。
 */

import type { SubagentRole } from '../../capabilities/security/subagent-policy.js';
import type { PrimaryModelRole } from '../../models/router.js';

/**
 * 子代理任务生命周期状态。
 */
export type AgentTaskStatus =
  | 'preparing'
  | 'accepted'
  | 'running'
  | 'waiting_children'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/**
 * 判断指定状态是否属于活跃占用槽位状态（preparing / accepted / running / waiting_children / cancelling）。
 */
export function isActiveTaskStatus(status: AgentTaskStatus): boolean {
  return (
    status === 'preparing' ||
    status === 'accepted' ||
    status === 'running' ||
    status === 'waiting_children' ||
    status === 'cancelling'
  );
}

/**
 * 判断指定状态是否为终态（completed / failed / cancelled / interrupted）。
 */
export function isTerminalTaskStatus(status: AgentTaskStatus): boolean {
  return (
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'interrupted'
  );
}

/**
 * 描述子代理任务的来源与继承上下文。
 */
export interface AgentTaskOrigin {
  /** 根任务标识（同一次根用户指令启动的所有子孙任务共享）。 */
  readonly rootTaskId: string;
  /** 父代理 ID（根任务派生的一级子代理其 parentAgentId 为 undefined）。 */
  readonly parentAgentId?: string;
  /** 父会话会话 ID。 */
  readonly parentSessionId: string;
  /** 派生来源分支 ID。 */
  readonly originBranchId: string;
  /** 派生来源运行轮次 ID。 */
  readonly originRunId: string;
  /** 触发派生的工具调用 ID。 */
  readonly spawnToolCallId: string;
  /** 派生代次（从 1 开始）。 */
  readonly generation: number;
  /** 任务树深度（根会话为 0，一级子代理为 1，最大支持深度通常为 3）。 */
  readonly depth: number;
}

/** 每棵任务树允许的最大并发活动子任务数。 */
export const MAX_ACTIVE_TASKS_PER_TREE = 4;
/** 整个 AgentRuntime 允许的最大并发活动子任务数。 */
export const MAX_ACTIVE_TASKS_PER_RUNTIME = 8;
/** 每棵任务树累计受理的最大任务数（失败/取消不返还额度）。 */
export const MAX_TOTAL_TASKS_PER_TREE = 16;
/** 默认最大步骤数。 */
export const DEFAULT_MAX_STEPS = 15;
/** 默认墙钟超时毫秒数（5 分钟）。 */
export const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

/** 子代理限额配置。 */
export interface AgentTaskLimits {
  /** 最大模型交互步骤数（默认 15）。 */
  maxSteps?: number;
  /** 墙钟最大超时毫秒数（默认 5 分钟 = 300,000ms）。 */
  timeoutMs?: number;
}

/** 创建子代理输入参数。 */
export interface SpawnAgentParams {
  [key: string]: unknown;
  /** 任务简要描述。 */
  description: string;
  /** 任务提示词与具体指令。 */
  prompt: string;
  /** 业务角色预设。 */
  role: SubagentRole;
  /** 显式限制的工具名称白名单（进一步收紧）。 */
  allowedTools?: string[];
  /** 子任务执行目录（必须在工作区根以内）。 */
  cwd?: string;
  /** 物理隔离模式。 */
  isolation?: 'inherit' | 'worktree';
  /**
   * 会话生命周期模式；缺省 'ephemeral' 保持既有行为（终态后销毁子会话并释放资源）。
   * 'detached' 在终态后保留子会话文件供续聊，保留策略（上限、删除入口）由宿主层实现。
   * 与 isolation 正交：isolation 是物理路径隔离，mode 是生命周期，不得互相替代。
   */
  mode?: 'ephemeral' | 'detached';
  /** 模型覆盖参数。 */
  modelOverride?: string;
  /** 限额配置。 */
  limits?: AgentTaskLimits;
  /**
   * 调用方幂等键；同一 requestId 且派发参数一致时返回原回执，不重复派发。
   * 参数不一致按冲突失败，不做「最后一次覆盖」或隐式去重。
   */
  requestId?: string;
}

/** spawn_agent 启动回执。 */
export interface SpawnAgentReceipt {
  /** 生成的子代理唯一标识。 */
  agentId: string;
  /** 受理状态（固定为 'accepted'）。 */
  status: 'accepted';
  /** 角色预设。 */
  role: SubagentRole;
  /** 任务简要描述。 */
  description: string;
  /** 任务树深度。 */
  depth: number;
  /** 归属的根任务标识。 */
  rootTaskId: string;
  /** 解析出的模型场景角色。 */
  modelRole: PrimaryModelRole | 'inherit';
  /** 实际工作区根。 */
  workspaceRoot: string;
  /** 实际执行目录。 */
  executionCwd: string;
  /**
   * 子会话 ID；仅 detached 任务在子会话创建后回填。
   * 幂等重放时用它把「原任务」直接指向可续聊的会话，无需再扫描历史。
   */
  sessionId?: string;
}

/**
 * send_agent 续聊输入参数。
 *
 * 约束：目标必须是 detached 且处于终态；活动态直接拒绝（DELEGATION_BUSY），不排队。
 */
export interface SendAgentParams {
  [key: string]: unknown;
  /** 要续聊的委派任务标识（spawn_agent 回执里的 agentId）。 */
  agentId: string;
  /** 追加给该委派会话的新一轮用户输入。 */
  prompt: string;
  /** 可选幂等键；同一 requestId 且目标与输入一致时返回原回执，不重复执行。 */
  requestId?: string;
}

/** send_agent 受理回执；与 spawn 一致，返回即闭合，结果经 outbox 通知回传。 */
export interface SendAgentReceipt {
  /** 被续聊的委派任务标识。 */
  agentId: string;
  /** 受理状态（固定为 'accepted'）。 */
  status: 'accepted';
  /** 角色预设（沿用首次派发时的快照）。 */
  role: SubagentRole;
  /** 任务描述（沿用首次派发时的快照）。 */
  description: string;
  /** 任务树深度。 */
  depth: number;
  /** 归属的根任务标识。 */
  rootTaskId: string;
  /** 保留型子会话 ID；续聊必须依赖它打开会话。 */
  sessionId?: string;
  /** 本次续聊对应的运行代次（首次派发为 1，每次续聊 +1）。 */
  runGeneration: number;
}

/**
 * 运行时内存中的子代理任务完整记录。
 */
export interface AgentTaskRecord {
  /** 子代理唯一标识。 */
  readonly agentId: string;
  /** 来源上下文。 */
  readonly origin: AgentTaskOrigin;
  /** 预设角色。 */
  readonly role: SubagentRole;
  /** 任务描述。 */
  readonly description: string;
  /** 任务 Prompt。 */
  readonly prompt: string;
  /** 当前生命周期状态。 */
  status: AgentTaskStatus;
  /** 创建时间。 */
  readonly createdAt: number;
  /** 开始运行时间。 */
  startedAt?: number;
  /** 终结时间。 */
  finishedAt?: number;
  /** 派生的直接子代理 ID 集合。 */
  readonly childAgentIds: Set<string>;
  /** 任务结果摘要。 */
  summary?: string;
  /** 失败或取消原因。 */
  error?: string;
  /** 实际使用的模型标识。 */
  modelId?: string;
  /** 工作区物理根路径。 */
  readonly workspaceRoot: string;
  /** 执行物理目录。 */
  readonly executionCwd: string;
  /** 剩余/分配的限额。 */
  readonly limits: Readonly<Required<AgentTaskLimits>>;
  /** 显式限制的工具名称白名单。 */
  allowedTools?: readonly string[];
  /** 物理隔离模式。 */
  isolation?: 'inherit' | 'worktree';
  /** 会话生命周期模式；ephemeral 为默认且行为与历史版本一致，detached 在终态后保留会话。 */
  readonly mode: 'ephemeral' | 'detached';
  /** 子会话 conversationId；仅 detached 终态由 runner 回填，是用户可见的唯一凭据。 */
  sessionId?: string;
  /** 委派会话展示名；仅 detached 任务回填，命名规则见 `formatDelegationTitle`。 */
  title?: string;
  /**
   * 运行代次：首次派发为 1，每次 send_agent 续聊 +1；缺省按 1 处理。
   * 续聊不新增任务记录，也不消耗「累计受理」配额，只重新占用活动槽位；
   * outbox 的 terminalRevision 用它区分不同轮次的终态通知。
   */
  runGeneration?: number;
  /** 本次运行由哪一轮续聊而来（`run-<代次>`）；首次派发缺省，仅用于观测对账。 */
  continuationOf?: string;
  /** 首次派发时的幂等键；随 detached 子会话头落盘，供重启后重建幂等索引。 */
  requestId?: string;
  /** 首次派发参数的规范化签名；与 requestId 成对出现，用于「同 ID 异参」判定。 */
  requestSignature?: string;
  /** 首次派发回执快照；宿主写委派头时原样转写，重启后据此重建可重放的幂等索引。 */
  requestReceipt?: SpawnAgentReceipt;
  /** 模型覆盖参数。 */
  modelOverride?: string;
  /** 派生并锁定的不可扩大策略快照。 */
  effectivePolicy?: unknown;
  /** 活动槽位是否已被安全释放（防止 cancelTask 与 runTask.finally 重复释放导致容量失真）。 */
  slotReleased?: boolean;
}

/** 查询子代理过滤选项。 */
export interface ListAgentsFilter {
  /** 限定根任务标识。 */
  rootTaskId?: string;
  /** 限定父代理 ID。 */
  parentAgentId?: string;
  /** 限定父会话 ID。 */
  parentSessionId?: string;
  /** 限定状态。 */
  status?: AgentTaskStatus | 'active' | 'terminal';
}
