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

/** 工具产物的只读投影；v1 只承载图片，路径由宿主按固定允许根确认存在且位于工作区或临时目录。 */
export interface ViewArtifact {
  readonly kind: 'image';
  /** 绝对路径；是否可预览由宿主 `preview-policy` 判定，渲染层不自行放行。 */
  readonly path: string;
  /** 小写扩展名（不含点）；MIME 白名单由宿主按扩展名解析。 */
  readonly ext: string;
  /**
   * 文件字节数；宿主 `stat` 观察到的事实，用于面板展示与超过预览上限时的降级判断。
   * 缺省表示宿主未取得大小，渲染层按普通图片尝试读取，不自行猜测。
   */
  readonly size?: number;
}

/** 任务状态；只表达计划状态，不承载执行结果与工具关联。`cancelled` 表示模型主动撤销。 */
export type ViewTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/** 一条任务项；id 由模型生成并在清单内唯一，宿主不落盘、不改写。 */
export interface ViewTodoItem {
  readonly id: string;
  readonly title: string;
  readonly status: ViewTodoStatus;
}

/** 任务清单只读投影；items 顺序即模型提交顺序，宿主不做二次排序。 */
export interface ViewTodoState {
  readonly items: readonly ViewTodoItem[];
  /** 最近一次成功更新的宿主观察时刻，仅用于展示。 */
  readonly updatedAt?: number;
  /** 每次成功更新递增；用于渲染层判断是否需要重绘，不参与权限或持久化。 */
  readonly revision: number;
}

/** 工具的公开执行事实；参数已脱敏，执行终态不等于整个操作已安全清理。 */
export interface ViewTool {
  readonly callId: string;
  readonly name: string;
  /**
   * 显示名（host 层 resolveToolDisplay 解析的中文短名 / MCP 归一名）；只影响 UI，
   * 不参与权限判定、不落盘、不进 Provider wire。CLI 与桌面端都渲染本字段，
   * 不再各自从原始 id 拼显示名。
   */
  readonly displayName: string;
  readonly invocation: string;
  /** 动作动词（U1.5）：宿主按「动词 + 对象」下发，渲染层不再从 invocation 猜测分词。 */
  readonly verb?: string;
  /** 唯一的关键对象 chip（路径 / 查询词 / 命令等）；缺省时渲染层退回 invocation。 */
  readonly chip?: string;
  /** chip 是否按等宽字体渲染（路径与命令类为 true）。 */
  readonly mono?: boolean;
  readonly input: string;
  readonly status: 'running' | 'succeeded' | 'failed' | 'interrupted';
  readonly result?: string;
  readonly durationMs?: number;
  readonly resultMessageId?: string;
  readonly elapsedMs?: number;
  readonly outputBytes?: number;
  /** 本次可预览产物；缺省表示该工具不投影产物（失败终态、非图片扩展一律不出现；SVG 纳入图片）。 */
  readonly artifacts?: readonly ViewArtifact[];
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
  /**
   * 技能信封文本块的来源技能名：宿主把显式技能正文附在用户消息里（`<skill_content>`
   * 包络），渲染层据此折叠为技能徽章而不是整段元数据与正文；普通文本块缺省。
   */
  readonly skillName?: string;
}

/** 单条助手消息的模型消耗；只用于展示，不参与权限、计费或持久化事实判定。 */
export interface ViewUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

/** 可重建展示消息；persisted 表示已观察的提交事实，临时片段不冒充落盘。 */
export interface ViewMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly state: 'streaming' | 'completed' | 'interrupted';
  readonly persisted: boolean;
  readonly blocks: readonly ViewBlock[];
  /** 该条助手消息对应的模型消耗；缺失表示旧记录未持久化 usage，渲染层不补零。 */
  readonly usage?: ViewUsage;
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
  /** 会话级任务清单；无成功 `todo_write` 历史时缺省，桌面 pill 与浮层据此隐藏。 */
  readonly todos?: ViewTodoState;
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
  /**
   * 整段历史被截断重建（例如重试上一轮后重新投影）：渲染层必须整体替换消息列表，
   * 不能沿用旧回答，也不能把它当作增量追加；`branchId` 存在时同步推进视图的活动分支身份。
   */
  | {
      readonly type: 'history_replaced';
      readonly messages: readonly ViewMessage[];
      readonly branchId?: string;
    }
  | { readonly type: 'set_expanded'; readonly blockId: string; readonly expanded: boolean }
  | { readonly type: 'todos_changed'; readonly todos?: ViewTodoState }
  | ({ readonly type: 'diagnostic' } & ViewNotice);

/** 有序事件包；宿主必须带当前会话/分支/视图与操作身份，旧代次不能写新视图。 */
export interface PresentationEvent extends ViewIdentity {
  readonly sequence: number;
  readonly operationId?: string;
  readonly change: PresentationChange;
}
