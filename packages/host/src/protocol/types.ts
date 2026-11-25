/** 仅包含 JSON 数据，不允许 Provider 实例、AbortSignal 或私有状态进入 wire。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/**
 * 初始化报价；凭证只用于本地认证，不得进入日志或历史。
 * `protocolVersion` 为整数代际，服务端严格相等校验；新增能力通过 `capabilities` 协商。
 * 旧 `{major, minMinor, maxMinor}` 形状已废弃：初始化参数白名单不接受它，
 * 旧客户端会在参数校验阶段得到 `INVALID_PARAMS`，必须升级客户端而不是降级协商。
 */
export type ProtocolOffer = {
  protocolVersion: number;
  clientName: string;
  capabilities: string[];
  token?: string;
};

/** 协议版本不跟随产品版本；只公布本次真正支持的能力。 */
export interface NegotiatedProtocol {
  protocolVersion: number;
  capabilities: string[];
}

/** 会话控制绑定到流与控制两种代际，旧连接不能借新会话继续写入。 */
export interface SessionControl {
  sessionId: string;
  streamEpoch: string;
  controlEpoch: string;
}

/** 五选一与 Core 保持语义一致；客户端不能通过批准回复改写执行参数。 */
export type ApprovalChoice =
  | 'allow_once'
  | 'allow_session'
  | 'deny_once'
  | 'deny_session'
  | 'cancel';

/** 审批展示数据不包含可回写的原始参数，执行身份由服务端保留。 */
export interface ApprovalPrompt extends SessionControl {
  approvalId: string;
  runId: string;
  toolName: string;
  target: string;
  sessionAllowed: boolean;
  expiresAt: number;
}

/** 快照中的待审批摘要；观察者可展示但不能代替控制者回复。 */
export type PendingApproval = {
  approvalId: string;
  toolName: string;
  target: string;
  expiresAt: number;
};

/** 监视列表项：只暴露展示所需字段，不携带轮询句柄或文件内容。 */
export interface WatchWireItem {
  watchId: string;
  /** 触发源类型；`process_exit` 自 v0.1.4 起摘除，不再出现在 wire 上。 */
  kind: 'file_change' | 'port_ready';
  target: string;
  state: 'armed' | 'fired' | 'timeout' | 'cancelled' | 'orphaned';
  armedAt: number;
  deadlineAt: number;
  closedAt: number | null;
  detail: string | null;
}

/** 会话看板单次写入事实；wire 上可空字段统一用 null，避免「缺失」与「0」混淆。 */
export interface EvidenceWireChange {
  path: string;
  callId: string;
  status: 'recorded' | 'truncated' | 'missing';
  additions: number | null;
  deletions: number | null;
}

/** 跨会话引用溯源；只带身份字段，不复制被引用正文。 */
export interface EvidenceWireReference {
  sessionId: string;
  recordId: string;
  role: 'user' | 'assistant' | 'branch_summary';
  timestamp: number;
  title: string | null;
}

/** 按 MCP 服务器聚合的调用计数。 */
export interface EvidenceWireMcpServer {
  server: string;
  calls: number;
  failed: number;
}

/** 父会话视角的委派状态；`ended` 表示父会话已收尾但子任务未终结。 */
export interface EvidenceWireDelegation {
  sessionId: string;
  title: string;
  taskName: string;
  state: 'running' | 'ended' | 'finished' | 'idle' | 'archived';
  summary: string | null;
  lastActivityAt: number;
}

/** `evidence/read` 的结果形状；协议层独立定义，避免依赖宿主展示类型。 */
export interface EvidenceWire {
  summary: {
    additions: number;
    deletions: number;
    truncatedFiles: number;
    missingFiles: number;
    references: number;
    mcpCalls: number;
    mcpFailures: number;
    runningDelegations: number;
  };
  changes: EvidenceWireChange[];
  references: EvidenceWireReference[];
  mcp: EvidenceWireMcpServer[];
  delegations: EvidenceWireDelegation[];
}

/** 外部代理探测结论的本地 wire 形状（可空事实统一用 `null` 表达）。 */
export interface ExternalProbeWire {
  available: boolean;
  status: 'ready' | 'needs_login' | 'not_installed' | 'invalid_shim' | 'handshake_failed';
  agentName: string | null;
  version: string | null;
  loadSupported: boolean;
  reason: string | null;
  loginHint: string | null;
  installHint: string | null;
}

/** 外部代理配置条目的 wire 形状（不含任何环境变量值）。 */
export interface ExternalHarnessWireItem {
  id: string;
  name: string;
  transport: 'acp' | 'claude-cli' | 'codex-app-server' | 'pi-rpc';
  command: string;
  args: string[];
  envFrom: string[];
  builtin: boolean;
  registryId: string | null;
  hasOverride: boolean;
  enabled: boolean;
  probe: ExternalProbeWire | null;
}

/** 官方 ACP Registry 静态模板的 wire 形状。 */
export interface ExternalTemplateWireItem {
  registryId: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  envFrom: string[];
  installHint: string;
  loginHint: string | null;
  website: string | null;
}

/** 外部代理会话列表项的 wire 形状。 */
export interface ExternalSessionWireItem {
  id: string;
  harnessId: string;
  harnessName: string;
  transport: 'acp' | 'claude-cli' | 'codex-app-server' | 'pi-rpc';
  workspaceRoot: string;
  title: string;
  status: 'starting' | 'idle' | 'running' | 'waiting_approval' | 'cancelling' | 'ended' | 'failed';
  resumable: boolean;
  canContinue: boolean;
  hasArchive: boolean;
  pendingApprovalCount: number;
  modelLabel: string | null;
  modeLabel: string | null;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

/** 外部代理人工审批卡片的 wire 形状。 */
export interface ExternalApprovalWireItem {
  approvalId: string;
  sessionId: string;
  toolCallId: string;
  toolTitle: string;
  target: string | null;
  warning: string | null;
  options: { optionId: string; label: string; kind: string }[];
  expiresAt: number;
}

/** 外部会话消息块的 wire 形状。 */
export interface ExternalBlockWire {
  id: string;
  kind: 'text' | 'thinking' | 'tool';
  text: string;
  state: 'streaming' | 'completed' | 'interrupted';
  revision: number;
  tool: {
    callId: string;
    name: string;
    displayName: string;
    invocation: string;
    verb: string | null;
    chip: string | null;
    mono: boolean;
    input: string;
    status: 'running' | 'succeeded' | 'failed' | 'interrupted';
    result: string | null;
  } | null;
}

/** 外部会话单条消息的 wire 形状。 */
export interface ExternalMessageWire {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  state: 'streaming' | 'completed' | 'interrupted';
  persisted: boolean;
  blocks: ExternalBlockWire[];
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null;
}

/** 外部代理完整展示快照的 wire 形状。 */
export interface ExternalSnapshotWire {
  session: ExternalSessionWireItem;
  sequence: number;
  truncatedArchive: boolean;
  messages: ExternalMessageWire[];
  approvals: ExternalApprovalWireItem[];
  plan: {
    items: {
      id: string;
      title: string;
      status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    }[];
    updatedAt: number | null;
    revision: number;
  } | null;
  notices: { id: string; level: 'info' | 'warning' | 'error'; text: string }[];
}

/** `external/event` 通知载荷（仅向声明 `'external-session'` 且已 `external/attach` 的连接下发）。 */
export interface ExternalWireEvent {
  sessionId: string;
  sequence: number;
  snapshot: ExternalSnapshotWire;
}

/** 请求参数目录；连接角色、会话权限和实际执行参数仍须由服务端复核。 */
export interface RequestParams {
  initialize: ProtocolOffer;
  ping: Record<string, never>;
  'session/list': { workspaceRoot: string; cursor?: string; limit?: number };
  'session/create': { workspaceRoot: string };
  'session/open': { workspaceRoot: string; conversationId: string };
  'session/attach': {
    sessionId: string;
    mode: 'control' | 'observe';
    serverInstanceId?: string;
  };
  'session/detach': { sessionId: string };
  'session/close': SessionControl;
  'session/snapshot': { sessionId: string; cursor?: string };
  'run/start': SessionControl & { clientOperationId: string; input: string };
  'run/cancel': SessionControl & { runId: string };
  'approval/request': ApprovalPrompt;
  'watch/list': { sessionId: string };
  'watch/cancel': SessionControl & { watchId: string };
  /** 会话看板只读聚合；与 watch/list 同门禁，必须先 attach 才能读取该会话证据。 */
  'evidence/read': { sessionId: string };
  'external/harnesses': Record<string, never>;
  'external/harnessSave': {
    id: string;
    builtin: boolean;
    name?: string;
    command?: string;
    args?: string[];
    envFrom?: string[];
    registryId?: string;
    enabled?: boolean;
  };
  'external/harnessReset': { id: string };
  'external/harnessToggle': { id: string; enabled: boolean };
  'external/harnessDelete': { id: string };
  'external/harnessTest': { id: string; workspaceRoot?: string };
  'external/list': { workspaceRoot: string };
  'external/open': { workspaceRoot: string; harnessId: string; title?: string };
  'external/attach': { sessionId: string };
  'external/detach': { sessionId: string };
  'external/snapshot': { sessionId: string };
  'external/prompt': { sessionId: string; text: string };
  'external/approve': {
    sessionId: string;
    approvalId: string;
    optionId?: string;
    cancel?: boolean;
  };
  'external/cancel': { sessionId: string };
  'external/close': { sessionId: string };
  'external/delete': { sessionId: string };
  'host/shutdown': Record<string, never>;
}

/** wire 方法名为稳定白名单，不能把任意 Slash 命令转换成 RPC。 */
export type WireMethod = keyof RequestParams;

/** 请求由方法名判别参数；c:/s: 命名空间隔离双向待响应队列。 */
export type WireRequest = {
  [M in WireMethod]: {
    jsonrpc: '2.0';
    id: string;
    method: M;
    params: RequestParams[M];
  };
}[WireMethod];

/** 错误详情仅暴露稳定分类，禁止携带原始输入、凭证与堆栈。 */
export interface WireError {
  code: number;
  message: string;
  data?: { code: string };
}

/** id=null 仅表示无法关联的解析/无效请求错误，成功响应必须有字符串 id。 */
export type WireResponse =
  | { jsonrpc: '2.0'; id: string; result: JsonValue }
  | { jsonrpc: '2.0'; id: string | null; error: WireError };

/** 事件有效载荷逐项白名单；未知/私有事件不能推进客户端游标。 */
export interface EventPayloads {
  text_delta: { text: string };
  thinking_delta: { text: string; blockId?: string };
  tool_start: { toolId: string; toolName: string; target: string };
  tool_progress: {
    toolId: string;
    toolName: string;
    elapsedMs: number;
    outputBytes: number;
  };
  tool_finish: { toolId: string; result: string; isError: boolean; truncated: boolean };
  run_started: { clientOperationId: string };
  run_settled: { outcome: 'completed' | 'failed' | 'cancelled' };
  approval_closed: { approvalId: string };
  diagnostic: { code: string; message: string };
}

/** 序号仅在同一 instance/session/streamEpoch 内比较，不是跨进程全局时钟。 */
export type WireEvent = {
  [E in keyof EventPayloads]: {
    serverInstanceId: string;
    sessionId: string;
    streamEpoch: string;
    seq: number;
    runId?: string;
    type: E;
    payload: EventPayloads[E];
  };
}[keyof EventPayloads];

/** 事件 notification 包含本地会话流与外部代理会话流两类受控入口，payload 仍按 Schema 白名单校验。 */
export type WireNotification =
  | {
      jsonrpc: '2.0';
      method: 'session/event';
      params: WireEvent;
    }
  | {
      jsonrpc: '2.0';
      method: 'external/event';
      params: ExternalWireEvent;
    };

/** 分帧器和客户端只消费已经过边界校验的消息。 */
export type WireMessage = WireRequest | WireResponse | WireNotification;

/** 校验失败以数据返回，避免边界异常意外落入宿主未处理异常路径。 */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: WireError };
