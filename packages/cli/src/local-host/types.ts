import type { ApprovalChannel, SessionEvent } from '@kiturone/kapibala';
import type { WatchView } from '@kiturone/kapibala-host/internal';
import type { JsonValue } from '@kiturone/kapibala-host/protocol';
import type { ViewEvidence } from '@kiturone/kapibala-host/view-model';

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

/** 每次打开会话都持有独立资源；dispose 失败不得释放底层存储锁。 */
export interface SessionResources {
  conversationId: string;
  history(): JsonValue[];
  run(input: string, signal: AbortSignal): AsyncIterable<SessionEvent>;
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
}

/** 宿主注入给会话资源工厂的运行期协同钩子（空闲门与自动续跑接管）。 */
export interface ResourceFactoryHooks {
  isHostIdle?(): boolean;
  onAutoResume?(input: string, signal: AbortSignal): Promise<void>;
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
