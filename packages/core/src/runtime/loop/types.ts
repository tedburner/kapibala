import type { PermissionRule, SessionMode } from '../../capabilities/security/permissions.js';
import type { ToolRegistry, ToolRegistrySnapshot } from '../../capabilities/tools/registry.js';
import type { HookRegistry } from '../../extensibility/hooks/registry.js';
import type { EventLogger } from '../../extensibility/logging/index.js';
import type { ModelProvider } from '../../models/index.js';
import type { PrimaryModelRole } from '../../models/router.js';
import type {
  CanonicalMessage,
  ModelRequest,
  RequestPreparation,
  Usage,
} from '../../types/index.js';
import type { ToolExecutor } from '../executor/index.js';

/** 循环宿主配置；请求投影与在途预算只操作临时视图，历史仍按完整工具事务追加。 */
export interface AgentLoopOptions {
  /** 本次交互身份，内部步骤仍独立编号。 */
  interactionId?: string;
  /** 仅用于诊断、用量归因与脱敏说明，不参与请求构造。 */
  modelId?: string;
  modelRole?: PrimaryModelRole;
  /** 请求视图投影：只允许变换克隆出的请求消息，不得改动真实历史。 */
  projectHistory?: (history: readonly CanonicalMessage[]) => CanonicalMessage[];
  /** 请求准备契约；可在请求前产出事件，并在上下文溢出时参与一次预算重试。 */
  prepareRequest?: RequestPreparation;
  /** 每次收到 usage 后回调；attemptId 标识 run:step:attempt，便于按尝试归因。 */
  onUsage?: (request: ModelRequest, usage: Usage, attemptId: string) => Promise<void>;
  /** 在途批次预算视图；含当前 assistant 和已完成结果，不能作为落盘或授权依据，闭合后清空；回调不得抛错。 */
  onToolBatchUpdate?: (messages: readonly CanonicalMessage[]) => void;
  provider: ModelProvider;
  executor: ToolExecutor;
  tools: ToolRegistry | ToolRegistrySnapshot;
  hooks: HookRegistry;
  systemPrompt?: string;
  /** 单次 run 的最大 turn 数，耗尽时以 error 事件收尾；缺省 20。 */
  maxSteps?: number;
  /** 连续工具失败达到该阈值即熔断终止本轮 run；缺省 3。 */
  maxConsecutiveErrors?: number;
  signal?: AbortSignal;
  eventLogger?: EventLogger;
  sessionId?: string;
  runId?: string;
  /** 每轮开始时读取；工具可见性与权限模式可随宿主状态变化。 */
  getMode?: () => SessionMode;
  permissionRules?: readonly PermissionRule[];
}
