/** 仅包含 JSON 数据，不允许 Provider 实例、AbortSignal 或私有状态进入 wire。 */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** 初始化报价；凭证只用于本地认证，不得进入日志或历史。 */
export interface ProtocolOffer {
  major: number;
  minMinor: number;
  maxMinor: number;
  clientName: string;
  capabilities: string[];
  token?: string;
}

/** 协议版本不跟随产品版本；只公布本次真正支持的能力。 */
export interface NegotiatedProtocol {
  major: number;
  minor: number;
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

/** 事件 notification 只有一种方法入口，payload 仍按事件类型逐项校验。 */
export interface WireNotification {
  jsonrpc: '2.0';
  method: 'session/event';
  params: WireEvent;
}

/** 分帧器和客户端只消费已经过边界校验的消息。 */
export type WireMessage = WireRequest | WireResponse | WireNotification;

/** 校验失败以数据返回，避免边界异常意外落入宿主未处理异常路径。 */
export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: WireError };
