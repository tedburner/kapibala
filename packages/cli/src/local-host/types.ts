import type { ApprovalChannel, SessionEvent } from '@kiturone/kapibala';
import type { JsonValue } from '../protocol/index.js';

/** 每次打开会话都持有独立资源；dispose 失败不得释放底层存储锁。 */
export interface SessionResources {
  conversationId: string;
  history(): JsonValue[];
  run(input: string, signal: AbortSignal): AsyncIterable<SessionEvent>;
  dispose(): Promise<void>;
  /** run 迭代结束后 Core 仍忙时返回 true；宿主据此拒绝新运行，但 close/shutdown 仍可重试。 */
  isBusy?(): boolean;
  /** 控制连接断开或显式取消时终止该容器内后台子代理，等待清理后才能接管。 */
  cancelChildren?(): Promise<void>;
  /** 替换当前会话已知凭证；历史、标题与审批展示共用，缺失时调用方仍须做通用模式脱敏。 */
  redact?(text: string): string;
}

/** 资源工厂必须复用当前宿主的写租约，审批代理可在连接变化时重定向。 */
export interface ResourceFactory {
  create(
    workspaceRoot: string,
    conversationId: string | undefined,
    approval: ApprovalChannel,
  ): Promise<SessionResources>;
}
