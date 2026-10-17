/** 本地展示身份；viewEpoch 由宿主单调推进，不充当运行或远程授权标识。 */
export interface ViewIdentity {
  readonly conversationId: string;
  readonly branchId: string;
  readonly viewEpoch: number;
}

/** 展示运行阶段；只有宿主确认 finally 与执行门完成后才可回到 idle。 */
export type OperationPhase = 'idle' | 'running' | 'cancelling' | 'settling';

/** 结果与解锁分别记录，completed 不保证之后的存储清理也成功。 */
export type OperationResult = 'completed' | 'failed' | 'aborted';

/** 工具的公开执行事实；参数已脱敏，执行终态不等于整个操作已安全清理。 */
export interface ViewTool {
  readonly callId: string;
  readonly name: string;
  readonly invocation: string;
  readonly input: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  readonly result?: string;
  readonly durationMs?: number;
  readonly resultMessageId?: string;
  readonly elapsedMs?: number;
  readonly outputBytes?: number;
}

/** 纯语义块；公开原文由宿主白名单投影，不保存协议私有载荷、布局或 ANSI。 */
export interface ViewBlock {
  readonly id: string;
  readonly kind: 'text' | 'thinking' | 'tool';
  readonly text: string;
  readonly state: 'streaming' | 'completed' | 'interrupted';
  readonly revision: number;
  /** 仅工具块使用；不得装入原始入参对象或 Provider/传输层状态。 */
  readonly tool?: ViewTool;
}

/** 可重建展示消息；persisted 表示已观察的提交事实，临时片段不冒充落盘。 */
export interface ViewMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly state: 'streaming' | 'completed' | 'interrupted';
  readonly persisted: boolean;
  readonly blocks: readonly ViewBlock[];
}

/** 受控诊断展示；仅保存宿主已经脱敏的文字，不携带 Error/Provider 原始对象。 */
export interface ViewNotice {
  readonly id: string;
  readonly level: 'info' | 'warning' | 'error';
  readonly text: string;
}

/** 当前操作事实；ID 为宿主本地身份，不冒充 Core runId。 */
export interface ViewOperation {
  readonly id: string;
  readonly phase: OperationPhase;
  readonly result?: OperationResult;
}

/**
 * 不依赖终端/框架的只读展示快照；已提交历史与活跃片段分开，delta 不复制整份历史。
 * 折叠偏好仅属于当前视图，可在重新加载时丢弃，不能写回 canonical。
 */
export interface PresentationState {
  readonly identity: ViewIdentity;
  readonly sequence: number;
  readonly messages: readonly ViewMessage[];
  readonly pendingMessages: readonly ViewMessage[];
  /** 顺序独立于提交状态，中断片段不能排到下一轮用户消息之后。 */
  readonly order: readonly string[];
  readonly operation?: ViewOperation;
  readonly expanded: Readonly<Record<string, boolean>>;
  readonly notices: readonly ViewNotice[];
}

/** Host 适配后的语义变化；不接收 Core 类型，也不承担命令执行或权限裁决。 */
export type PresentationChange =
  | { readonly type: 'operation_started' }
  | { readonly type: 'cancellation_requested' }
  | { readonly type: 'operation_result'; readonly result: OperationResult }
  | { readonly type: 'operation_settled'; readonly result?: OperationResult }
  | {
      readonly type: 'append';
      readonly messageId: string;
      readonly blockId: string;
      readonly kind: 'text' | 'thinking';
      readonly text: string;
    }
  | { readonly type: 'block_stopped'; readonly blockId: string }
  | { readonly type: 'tool_changed'; readonly messageId: string; readonly block: ViewBlock }
  | {
      readonly type: 'message_committed';
      readonly message: ViewMessage;
      readonly provisionalId?: string;
      readonly aliases?: Readonly<Record<string, string>>;
    }
  | { readonly type: 'set_expanded'; readonly blockId: string; readonly expanded: boolean }
  | ({ readonly type: 'diagnostic' } & ViewNotice);

/** 有序事件包；宿主必须带当前会话/分支/视图与操作身份，旧代次不能写新视图。 */
export interface PresentationEvent extends ViewIdentity {
  readonly sequence: number;
  readonly operationId?: string;
  readonly change: PresentationChange;
}
