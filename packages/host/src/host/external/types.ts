import { KapibalaError } from '@kiturone/kapibala';
import type { ViewMessage, ViewTodoItem, ViewTool, ViewUsage } from '../../view-model/index.js';

/**
 * 外部代理子系统的稳定机器错误码。
 *
 * 设计取舍：与协议层整数错误码解耦，供宿主服务层、设置页探针与 CLI 诊断按明确原因分支展示中文修复指引。
 */
export type ExternalErrorCode =
  | 'EXTERNAL_INVALID_COMMAND'
  | 'EXTERNAL_COMMAND_NOT_FOUND'
  | 'EXTERNAL_UNSUPPORTED_SHIM'
  | 'EXTERNAL_NODE_NOT_FOUND'
  | 'EXTERNAL_FRAME_LIMIT'
  | 'EXTERNAL_NON_JSON_FLOOD'
  | 'EXTERNAL_PROTOCOL_ERROR'
  | 'EXTERNAL_AUTH_REQUIRED'
  | 'EXTERNAL_TIMEOUT'
  | 'EXTERNAL_ABORTED'
  | 'EXTERNAL_CONFIG_BUSY'
  | 'EXTERNAL_CONFIG_CORRUPT'
  | 'EXTERNAL_CONFIG_INVALID'
  | 'EXTERNAL_CAPACITY'
  | 'EXTERNAL_WORKSPACE_BUSY'
  | 'EXTERNAL_SESSION_BUSY'
  | 'EXTERNAL_UNTRUSTED_WORKSPACE';

/**
 * 外部代理错误：继承 `KapibalaError` 以保持全仓错误基类统一，额外携带可选的终端登录或安装提示命令。
 *
 * 安全边界：`safeMessage` 与 `message` 在构造前均须避免拼入原始环境变量值或未脱敏标准错误全文。
 */
export class ExternalHarnessError extends KapibalaError {
  override readonly code: ExternalErrorCode;
  readonly loginHint?: string;
  readonly installHint?: string;

  constructor(
    code: ExternalErrorCode,
    message: string,
    options?: {
      retryPolicy?: 'never' | 'immediate' | 'backoff' | 'after_user_action';
      safeMessage?: string;
      loginHint?: string;
      installHint?: string;
      cause?: unknown;
    },
  ) {
    super(message, {
      code,
      retryPolicy: options?.retryPolicy ?? 'never',
      safeMessage: options?.safeMessage ?? message,
    });
    this.name = 'ExternalHarnessError';
    this.code = code;
    this.loginHint = options?.loginHint;
    this.installHint = options?.installHint;
    if (options?.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

/** 外部代理底层传输协议；第三方自定义命令固定走 `'acp'`，Claude / Codex 原生直连走专用驱动。 */
export type ExternalTransportKind = 'acp' | 'claude-cli' | 'codex-app-server';

/**
 * 一条可启动的外部代理定义。
 *
 * 前置约束：
 * - `command` 与 `args` 只存字面量，严禁经 shell 拼接或内嵌明文 API Key；
 * - 第三方凭据统一走外部 CLI 自有登录态或 `envFrom` 环境变量名白名单转发（只落盘变量名，不落盘密钥值）。
 */
export interface ExternalHarnessDefinition {
  readonly id: string;
  readonly name: string;
  readonly transport: ExternalTransportKind;
  readonly command: string;
  /** 逐项字面参数数组；全程以数组直传系统调用，不经过 shell 词法切分。 */
  readonly args: readonly string[];
  /** 可选显式 Flavor 标识；缺省时 `acp` 驱动按可执行文件名与握手 `agentInfo.name` 自动匹配。 */
  readonly flavor?: string;
  /** 若由官方 ACP Registry 模板创建，记录模板 id 以便设置页回显安装或登录指引。 */
  readonly registryId?: string;
  /** 非敏感运行环境变量（如特性开关）；配置校验层拦截控制字符与敏感凭据键名。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 从宿主环境按名透传的变量名白名单（如 `DEEPSEEK_API_KEY`）；宿主缺失时不阻断启动以兼容 CLI 本地登录态。 */
  readonly envFrom?: readonly string[];
  readonly builtin?: boolean;
  readonly enabled: boolean;
}

/** 设置页与 CLI `/external harness test` 的探测结论分类。 */
export type ExternalInspectStatus =
  | 'ready'
  | 'needs_login'
  | 'not_installed'
  | 'invalid_shim'
  | 'handshake_failed';

/**
 * 外部代理单次非破坏性握手探测结果。
 *
 * 边界：探测子进程在拿到协议握手与可选认证结论后立即走两段式回收，不创建持久会话。
 */
export interface ExternalInspectResult {
  readonly available: boolean;
  readonly agentName?: string;
  readonly version?: string;
  readonly loadSupported: boolean;
  readonly status: ExternalInspectStatus;
  readonly reason?: string;
  readonly loginHint?: string;
  readonly installHint?: string;
}

/** 外部代理原样透传的审批选项；保留 `allow_session` 等扩展 `kind`，不与本地权限模式混同。 */
export interface ExternalApprovalOption {
  readonly optionId: string;
  readonly label: string;
  readonly kind: string;
}

/** 用户或超时守卫对外部审批请求的最终裁决；断连与超时统一走 `cancelled`。 */
export type ExternalApprovalDecision =
  | { readonly outcome: 'selected'; readonly optionId: string }
  | { readonly outcome: 'cancelled' };

/**
 * 三套底层传输驱动统一产出的协议中立事件流。
 *
 * 隔离不变量：任何 ACP / Claude `stream-json` / Codex `app-server` 原始线帧均在驱动内部消化，
 * 不得越过此联合类型泄漏到 `ExternalSessionService` 或 UI 视图模型。
 */
export type ExternalEvent =
  | { readonly type: 'user_delta'; readonly text: string; readonly replay?: boolean }
  | { readonly type: 'text_delta'; readonly text: string; readonly replay?: boolean }
  | { readonly type: 'thought_delta'; readonly text: string; readonly replay?: boolean }
  | { readonly type: 'tool_upsert'; readonly tool: ViewTool; readonly replay?: boolean }
  | { readonly type: 'plan_updated'; readonly items: readonly ViewTodoItem[] }
  | {
      readonly type: 'config_updated';
      readonly modelLabel?: string;
      readonly modeLabel?: string;
    }
  | {
      readonly type: 'approval_requested';
      readonly requestId: string;
      readonly toolCallId: string;
      readonly toolTitle: string;
      readonly target?: string;
      readonly warning?: string;
      readonly options: readonly ExternalApprovalOption[];
      readonly respond: (decision: ExternalApprovalDecision) => void;
    }
  | {
      readonly type: 'diagnostic';
      readonly level: 'info' | 'warning' | 'error';
      readonly text: string;
    }
  | {
      readonly type: 'closed';
      readonly code: number | null;
      readonly signal: NodeJS.Signals | null;
      readonly stderrTail?: string;
    };

/** 单轮外部代理 Prompt 的完成终态。 */
export interface ExternalTurnResult {
  readonly stopReason: 'completed' | 'cancelled';
  readonly usage?: ViewUsage;
}

/** 已打开的外部代理单会话子进程句柄；每个可写外部会话独占一个底层子进程。 */
export interface ExternalDriverSessionHandle {
  readonly pid: number | undefined;
  prompt(text: string, signal?: AbortSignal): Promise<ExternalTurnResult>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

/** `ExternalHarnessDriver.open` 成功握手后的返回载荷。 */
export interface ExternalDriverOpenResult {
  readonly handle: ExternalDriverSessionHandle;
  readonly nativeSessionId?: string;
  /** 仅当通过四项持久身份门禁且底层会话实际支持权威恢复时为 `true`。 */
  readonly resumable: boolean;
  readonly modelLabel?: string;
  readonly modeLabel?: string;
  /** `session/load` 等恢复握手期间由外部代理权威重放出的历史消息。 */
  readonly replayedMessages?: readonly ViewMessage[];
}

/**
 * 协议无关的外部代理驱动统一接口。
 *
 * `acp-stdio`、`claude-cli` 与 `codex-app-server` 均实现本接口，供上层会话服务零分支调度。
 */
export interface ExternalHarnessDriver {
  readonly transport: ExternalTransportKind;
  inspect(
    def: ExternalHarnessDefinition,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ExternalInspectResult>;
  open(input: {
    def: ExternalHarnessDefinition;
    workspaceRoot: string;
    nativeSessionId?: string;
    onEvent: (event: ExternalEvent) => void;
    signal?: AbortSignal;
  }): Promise<ExternalDriverOpenResult>;
}
