import type { ViewMessage, ViewNotice, ViewOperation, ViewTodoState } from './types.js';

/** 外部代理传输通道类型（纯展示枚举，0 Node 依赖）。 */
export type ViewExternalTransport = 'acp' | 'claude-cli' | 'codex-app-server' | 'pi-rpc';

/** 外部代理会话生命周期状态。 */
export type ViewExternalSessionStatus =
  | 'starting'
  | 'idle'
  | 'running'
  | 'waiting_approval'
  | 'cancelling'
  | 'ended'
  | 'failed';

/** 外部代理暴露的单个配置候选项（模型、模式或推理档位）。 */
export interface ViewExternalConfigChoice {
  readonly value: string;
  readonly name: string;
  readonly description?: string;
  readonly group?: string;
}

/** 外部代理可切换的配置项语义类别。 */
export type ViewExternalConfigCategory = 'model' | 'mode' | 'thought_level';

/** 外部代理暴露的单个可切换配置项（兼容 ACP `configOptions` 与旧式 `models` / `modes`）。 */
export interface ViewExternalConfigOption {
  readonly id: string;
  readonly name: string;
  readonly category: ViewExternalConfigCategory;
  readonly currentValue?: string;
  readonly options: readonly ViewExternalConfigChoice[];
}

/** 设置页或 CLI 执行外部代理单次握手探测后的只读状态摘要。 */
export interface ViewExternalHarnessProbe {
  readonly available: boolean;
  readonly status:
    | 'ready'
    | 'auth_unverified'
    | 'needs_login'
    | 'not_installed'
    | 'invalid_shim'
    | 'handshake_failed';
  readonly agentName?: string;
  readonly version?: string;
  readonly loadSupported: boolean;
  readonly reason?: string;
  readonly loginHint?: string;
  readonly installHint?: string;
  /** 探测握手附带拿到的可选模型/模式/推理档位目录。 */
  readonly configOptions?: readonly ViewExternalConfigOption[];
}

/** 面向桌面设置页与 CLI `/external harnesses` 的外部代理展示项（不含任何环境变量值）。 */
export interface ViewExternalHarness {
  readonly id: string;
  readonly name: string;
  readonly transport: ViewExternalTransport;
  readonly command: string;
  readonly args: readonly string[];
  readonly envFrom: readonly string[];
  readonly builtin: boolean;
  readonly registryId?: string;
  /** 内置代理若存在用户增量路径/参数覆写则为 `true`，用于控制「恢复默认」按钮显隐。 */
  readonly hasOverride: boolean;
  readonly enabled: boolean;
  /** 若刚在设置页执行过连接检测，附带最新探测结论。 */
  readonly probe?: ViewExternalHarnessProbe;
  /** 本地按配置指纹缓存的可用模型/模式/推理档位清单，供新对话选择器零冷启展示。 */
  readonly cachedConfigOptions?: readonly ViewExternalConfigOption[];
}

/** 官方 ACP Registry 静态模板的纯展示投影。 */
export interface ViewExternalTemplate {
  readonly registryId: string;
  readonly name: string;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly envFrom?: readonly string[];
  readonly installHint: string;
  readonly loginHint?: string;
  readonly website?: string;
}

/** 侧栏列表与头部横幅共用的外部代理会话摘要。 */
export interface ViewExternalSession {
  readonly id: string;
  readonly harnessId: string;
  readonly harnessName: string;
  readonly transport: ViewExternalTransport;
  readonly workspaceRoot: string;
  readonly title: string;
  readonly status: ViewExternalSessionStatus;
  /** 会话创建时记录的底层恢复能力事实。 */
  readonly resumable: boolean;
  /** 综合当前进程在场性、`resumable` 门禁与 `configDigest` 连续性后的实时可续聊判定；`false` 时输入框锁定为只读归档态。 */
  readonly canContinue: boolean;
  /** 本地 `snapshots/` 是否存有可供离线阅读的展示归档。 */
  readonly hasArchive: boolean;
  readonly pendingApprovalCount: number;
  readonly modelLabel?: string;
  readonly modeLabel?: string;
  readonly thoughtLevelLabel?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastError?: string;
}

/** 外部代理人工审批请求卡片投影；完整保留代理提供的原始选项列表（如 `allow_session`）。 */
export interface ViewExternalApproval {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolTitle: string;
  readonly target?: string;
  readonly warning?: string;
  readonly options: readonly {
    readonly optionId: string;
    readonly label: string;
    readonly kind: string;
  }[];
  readonly expiresAt: number;
}

/**
 * 单个外部代理会话的完整只读展示快照。
 *
 * 复用设计：`messages` 与 `plan` 直接复用本地会话的 `ViewMessage` 与 `ViewTodoState`，
 * 渲染层无需维护第二套 Markdown、工具卡或任务进度组件。
 */
export interface ViewExternalSnapshot {
  readonly session: ViewExternalSession;
  readonly sequence: number;
  /** 若实时投影或历史只读归档因超过条数或单帧 680KiB 安全预算发生过裁剪则为 `true`。 */
  readonly truncatedArchive?: boolean;
  readonly messages: readonly ViewMessage[];
  readonly operation?: ViewOperation;
  readonly approvals: readonly ViewExternalApproval[];
  readonly plan?: ViewTodoState;
  readonly notices: readonly ViewNotice[];
  /** 当前会话实时可切换的模型、模式与推理档位目录（仅当底层代理提供时存在）。 */
  readonly configOptions?: readonly ViewExternalConfigOption[];
}
