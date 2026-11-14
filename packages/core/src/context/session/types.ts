import type { ApprovalChannel } from '../../capabilities/security/approval.js';
import type { WorkspaceLeaseCoordinator } from '../../capabilities/security/lease.js';
import type { PermissionRule, SessionMode } from '../../capabilities/security/permissions.js';
import type { PathSandbox } from '../../capabilities/security/sandbox.js';
import type { SkillOptions } from '../../capabilities/skills/types.js';
import type { ToolRegistrySnapshot } from '../../capabilities/tools/registry.js';
import type { EventLogger } from '../../extensibility/logging/index.js';
import type { ModelProfile, ModelProvider } from '../../models/index.js';
import type {
  ContentBlock,
  ContextUsage,
  PromptContentSource,
  RunMetrics,
  TurnMetrics,
  Usage,
} from '../../types/index.js';
import type { TokenEstimator } from '../budget.js';
import type { ContextSnapshot } from '../manager.js';
import type { MessageStore } from '../store/index.js';

/**
 * 任务准备上下文；提供当前会话取消信号、runId 与不可变工具快照。
 */
export interface PreparedTaskContext {
  signal?: AbortSignal;
  runId: string;
  tools: ToolRegistrySnapshot;
}

/**
 * 任务准备产物；包含要附加到 User 消息的内容块，以及提交前的身份复核回调。
 */
export interface PreparedTaskResult {
  /** 任务附加内容块或纯文本（如 Prompt 内容或技能正文）。 */
  content: ContentBlock[] | string;
  /** 可选来源元数据；仅在 content 为 string 时由宿主自动包装为带来源的 TextBlock。 */
  promptSource?: PromptContentSource;
  /** 最终提交前核对准备身份；若在此期间目录变化或连接重置，返回 false 拒绝提交并零发送闭合。 */
  verifyIdentity?: () => boolean | Promise<boolean>;
  /** 可选技能名称；存在时按显式技能流程处理。 */
  skillName?: string;
}

/** 会话的非根选项；扩展配置时与 SessionConfig 的显式根联合组合，不能隐式推导工作区。 */
export interface SessionOptions {
  /** 宿主显式技能配置；缺省不扫描home，项目根需独立信任。 */
  skills?: SkillOptions;
  /** 持久会话身份；有版本化 Store 时须与头部一致，日志实例身份保持独立。 */
  conversationId?: string;
  tokenEstimator?: TokenEstimator;
  /** 无 Git 工作树时随 run_started 记录的分支回退值。 */
  gitBranch?: string;
  /** 主任务默认模型绑定；恢复历史及未显式选择角色时使用。 */
  defaultProfile: ModelProfile;
  /** 与 defaultProfile 匹配的协议适配器。 */
  defaultProvider: ModelProvider;
  /** 消息级落盘通道；支持状态能力的 Store 额外启用持久压缩与交互终态。 */
  store?: MessageStore;
  /** 默认命令执行目录绝对路径，必须位于 workspaceRoot 内部；缺省为 workspaceRoot。 */
  executionCwd?: string;
  systemPrompt?: string;
  maxSteps?: number;
  logger?: (msg: string) => void;
  eventLogger?: EventLogger;
  loggingDirectory?: string;
  /** 初始权限模式，缺省 Approval；仅空闲时可切换。 */
  mode?: SessionMode;
  permissionRules?: readonly PermissionRule[];
  approvalChannel?: ApprovalChannel;
  /** 项目根路径；缺省为 workspaceRoot。 */
  projectRoot?: string;
  /** 兼容别名：执行目录。 */
  cwd?: string;
  userInstructionsPath?: string;
  /** 未提供时使用默认日志 sink 的审计目录；init 时恢复不完整审计。 */
  auditRecoveryDirectory?: string;
  /** 接收普通运行日志失败的脱敏诊断；诊断失败也不得中断问答或替代审计。 */
  onDiagnostic?: (message: string) => void;
  /** 会话持有的沙箱实例；缺省基于 workspaceRoot 自动创建独占实例。 */
  sandbox?: PathSandbox;
  /** 宿主显式共享的写租约协调器；缺省为本会话独占实例，不隐含跨会话互斥。 */
  leaseCoordinator?: WorkspaceLeaseCoordinator;
  /** 父任务或任务树根 ID，用于多智能体任务层级限制与追踪。 */
  rootTaskId?: string;
  /** 当前子会话在代理树中的深度，根会话为 0。 */
  depth?: number;
  /** 当前子会话对应的 agentId。 */
  agentId?: string;
}

/** 显式工作区根至少提供其一；保留 rootDir-only 兼容输入，双字段物理冲突在构造时拒绝。 */
export type SessionConfig = SessionOptions &
  ({ workspaceRoot: string; rootDir?: string } | { workspaceRoot?: never; rootDir: string });

/** getStats 返回的统计快照；全部字段为独立副本，宿主修改不影响会话内部状态。 */
export interface SessionStats {
  conversationId?: string;
  /** 历史存在无 usage 的模型步骤时为 false，不将旧消耗伪装为精确零。 */
  usageKnown?: boolean;
  /** 摘要 attempt 的累计消耗；独立于主任务指标。 */
  summaryUsage?: Usage;
  summaryUsageKnown?: boolean;
  contextSnapshot?: ContextSnapshot;
  /** 累计用户任务次数，含恢复自持久状态的 run_started 记录。 */
  totalTurns: number;
  /** 主任务累计消耗；摘要消耗在 summaryUsage 单独统计。 */
  totalTokens: Usage;
  activeModel: string;
  loadedToolsCount: number;
  lastMetrics?: TurnMetrics;
  lastRunMetrics?: RunMetrics;
  /** 最近一次内部模型请求的窗口占用；无实测时仅提供窗口上限。 */
  contextUsage: ContextUsage;
}
