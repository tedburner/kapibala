import type {
  ApprovalChannel,
  SessionApprovalCache,
} from '../../capabilities/security/approval.js';
import type { WorkspaceLeaseCoordinator } from '../../capabilities/security/lease.js';
import type { PermissionRule, SessionMode } from '../../capabilities/security/permissions.js';
import type { PathSandbox } from '../../capabilities/security/sandbox.js';
import type { Tool } from '../../capabilities/tools/index.js';
import type { ToolRegistry, ToolRegistrySnapshot } from '../../capabilities/tools/registry.js';
import type { HookRegistry } from '../../extensibility/hooks/registry.js';
import type { EventLogger } from '../../extensibility/logging/index.js';
import type { ToolResultBlock } from '../../types/index.js';

/** 宿主运行级硬限制；优先于模式、审批及缓存，文案和字段不得携带凭据。 */
export interface ToolHardDenial {
  code: string;
  message: string;
  retryPolicy: ToolResultBlock['retryPolicy'];
  fields?: Record<string, unknown>;
}

/** ToolExecutor 的构造项；审计写入需要 eventLogger 与 sessionId 同时提供，否则不产生审计。 */
export interface ExecutorOptions {
  /** 在最终参数上补充硬拒绝，不能把拒绝转为授权。 */
  hardDenial?: (tool: Tool, input: Record<string, unknown>) => ToolHardDenial | undefined;
  /** 结果钩子和执行审计完成后调用；用于在同批次下一调用前安装宿主收紧状态。 */
  onToolResult?: (
    tool: Tool,
    input: Record<string, unknown>,
    result: ToolResultBlock,
  ) => void | Promise<void>;
  tools: ToolRegistry | ToolRegistrySnapshot;
  hooks: HookRegistry;
  /** 显式工作区物理根路径，经 native realpath 规范化；缺省回退到 rootDir。 */
  workspaceRoot?: string;
  /** 显式命令执行工作目录绝对路径（位于 workspaceRoot 内部）；缺省回退到 rootDir。 */
  executionCwd?: string;
  /** 会话持有的 PathSandbox 独占实例；文件类工具优先使用此沙箱。 */
  sandbox?: PathSandbox;
  /** 共享工作区写租约协调器；并发写入互斥保护。 */
  leaseCoordinator?: WorkspaceLeaseCoordinator;
  /** 工具执行的绝对根目录；路径解析与审批均以此为基准。 */
  rootDir: string;
  /** 会话级取消信号；与 cancel() 的内部信号合并生效。 */
  signal?: AbortSignal;
  logger?: (msg: string) => void;
  /** 单次工具执行超时(毫秒)。异步挂起的工具超时后返回 isError 结果，避免永久卡死会话循环 */
  toolTimeoutMs?: number;
  eventLogger?: EventLogger;
  sessionId?: string;
  runId?: string;
  branchId?: string;
  rootTaskId?: string;
  depth?: number;
  agentId?: string;
  /** 固定模式或每次裁决时读取的取值函数；宿主可中途切换。 */
  mode?: SessionMode | (() => SessionMode);
  permissionRules?: readonly PermissionRule[];
  /** 审批入口；缺省视为非交互环境，需要询问的调用一律拒绝。 */
  approvalChannel?: ApprovalChannel;
  /** 会话内 allow_session / deny_session 审批缓存；缺省使用实例私有缓存。 */
  approvalCache?: SessionApprovalCache;
}

/** 单次工具执行默认超时（毫秒）；ExecutorOptions.toolTimeoutMs 未提供时生效。 */
export const DEFAULT_TOOL_TIMEOUT_MS = 120_000;
