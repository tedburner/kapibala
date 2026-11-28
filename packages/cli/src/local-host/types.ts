import type { ApprovalChannel, SessionEvent, SessionWorktreeBinding } from '@kiturone/kapibala';
import type {
  ReferenceSelection,
  RestoreCheckpointResult,
  WatchView,
} from '@kiturone/kapibala-host/internal';
import type { JsonValue } from '@kiturone/kapibala-host/protocol';
import type {
  ViewCheckpointItem,
  ViewEvidence,
  ViewFileDiff,
  ViewWorktreeSummary,
} from '@kiturone/kapibala-host/view-model';

/**
 * 会话级监视门面；缺省表示该宿主没有布置触发源。协议层行为（server.ts watch/*）：
 * watch/list 在宿主未提供时返回空列表（`watches?.list() ?? []`），watch/cancel 直接抛
 * INVALID_REQUEST——不存在「假装已取消」的成功路径。默认 `createResourceFactory`
 * 经 `createManagedSessionResources` 在单写者会话锁内完整布置监视触发源并注入本门面。
 */
export interface SessionWatchControl {
  list(): WatchView[];
  cancel(watchId: string): Promise<void>;
}

/** 单轮本地会话运行附加选项（按当前控制连接协商能力动态收放流中重试）。 */
export interface SessionRunOptions {
  /** 是否允许在模型已吐出部分流式增量后执行 `stream_reset` 流中重置重试；未声明 `'retry'` 能力的连接必须传 `false`。 */
  readonly allowMidStreamRetry?: boolean;
}

/** 每次打开会话都持有独立资源；dispose 失败不得释放底层存储锁。 */
export interface SessionResources {
  conversationId: string;
  history(): JsonValue[];
  run(
    input: string,
    signal: AbortSignal,
    references?: readonly ReferenceSelection[],
    options?: SessionRunOptions,
  ): AsyncIterable<SessionEvent>;
  dispose(): Promise<void>;
  /** 会话级监视的只读列表与取消入口；不提供时协议层明确拒绝而不是假装成功。 */
  watches?: SessionWatchControl;
  /** 会话看板只读聚合；不提供时协议层明确拒绝，而不是返回一份看似正常的空面板。 */
  evidence?(): Promise<ViewEvidence>;
  /** run 迭代结束后 Core 仍忙时返回 true；宿主据此拒绝新运行，但 close/shutdown 仍可重试。 */
  isBusy?(): boolean;
  /** 控制连接断开或显式取消时终止该容器内后台子代理，等待清理后才能接管。 */
  cancelChildren?(): Promise<void>;
  /** 替换当前会话已知凭证；历史、标题与审批展示共用，缺失时调用方仍须做通用模式脱敏。 */
  redact?(text: string): string;
  /** 列举当前本地会话的轮次级 Shadow Git 检查点；未配置时缺省。 */
  checkpoints?(): Promise<ViewCheckpointItem[]>;
  /** 查询当前本地会话单轮或跨轮聚合的真实文件 Diff 明细。 */
  checkpointDiff?(options?: {
    readonly ordinal?: number;
    readonly fromOrdinal?: number;
    readonly toOrdinal?: number;
    readonly includeLiveWorktree?: boolean;
  }): Promise<{
    readonly available: boolean;
    readonly files: readonly ViewFileDiff[];
    readonly additions: number;
    readonly deletions: number;
    readonly truncated: boolean;
  }>;
  /** 将当前本地会话在 `targetOrdinal` 之后修改的归因磁盘文件还原到指定水位。 */
  restoreCheckpoint?(targetOrdinal: number, force?: boolean): Promise<RestoreCheckpointResult>;
  /** 返回当前本地会话绑定的受管 Git Worktree 摘要（运行在主工作区时为 `undefined`）。 */
  worktree?(): ViewWorktreeSummary | undefined;
}

/** 宿主注入给会话资源工厂的运行期协同钩子（空闲门、自动续跑接管与可选新建工作树绑定）。 */
export interface ResourceFactoryHooks {
  isHostIdle?(): boolean;
  onAutoResume?(input: string, signal: AbortSignal): Promise<void>;
  /** 新建会话时显式绑定的受管 Git Worktree 元数据。 */
  worktree?: SessionWorktreeBinding;
}

/** 资源工厂必须复用当前宿主的写租约，审批代理可在连接变化时重定向。 */
export interface ResourceFactory {
  create(
    workspaceRoot: string,
    conversationId: string | undefined,
    approval: ApprovalChannel,
    hooks?: ResourceFactoryHooks,
  ): Promise<SessionResources>;
}
