import { randomUUID } from 'node:crypto';
import type { ApprovalChannel, ApprovalChoice, ApprovalRequest } from '@kiturone/kapibala';
import {
  APPROVAL_RESPONSE_SCHEMA,
  type ApprovalPrompt,
  DEFAULT_LIMITS,
  type PendingApproval,
  type SessionControl,
  isJsonData,
  matchesSchema,
} from '../protocol/index.js';

/** 宿主提供实际控制归属与安全展示；无法描述完整目标时必须返回 undefined。 */
export interface RpcApprovalOptions {
  identity(): (SessionControl & { runId: string }) | undefined;
  request(prompt: ApprovalPrompt, signal: AbortSignal): Promise<unknown>;
  describe(request: ApprovalRequest): string | undefined;
  closed?(approvalId: string): void;
}

/**
 * 只把展示目标与五选一决策跨进程传递；原始参数、执行身份和会话缓存留在 Core。
 * 即使对端忽略取消信号，超时/断线也能确定性收敛，旧控制代际回复永不生效。
 */
export class RpcApprovalChannel implements ApprovalChannel {
  private readonly pending = new Map<string, { cancel(): void; summary: PendingApproval }>();
  private disposed = false;
  constructor(private readonly options: RpcApprovalOptions) {}

  /** 返回快照可展示的待审批摘要；控制权与回复资格仍由既有校验决定。 */
  pendingApprovals(): PendingApproval[] {
    return [...this.pending.values()].map(({ summary }) => ({ ...summary }));
  }

  /** 任何关联、展示或传输失败均拒绝，不把异常转换成隐式允许。 */
  requestApproval(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalChoice> {
    if (this.disposed || signal?.aborted || this.pending.size >= DEFAULT_LIMITS.maxPendingApprovals)
      return Promise.resolve('cancel');
    let target: string | undefined;
    let identity: ReturnType<RpcApprovalOptions['identity']>;
    try {
      target = this.options.describe(request);
      const current = this.options.identity();
      identity = current ? { ...current } : undefined;
    } catch {
      return Promise.resolve('cancel');
    }
    if (!target || !identity) return Promise.resolve('cancel');
    const snapshot = identity;
    const approvalId = randomUUID();
    const controller = new AbortController();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (choice: ApprovalChoice) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        this.pending.delete(approvalId);
        controller.abort();
        try {
          this.options.closed?.(approvalId);
        } catch {
          /* 观察失败不能改变审批结果。 */
        }
        resolve(choice);
      };
      const cancel = () => finish('cancel');
      const timer = setTimeout(cancel, DEFAULT_LIMITS.approvalTimeoutMs);
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) {
        cancel();
        return;
      }
      const prompt: ApprovalPrompt = {
        ...snapshot,
        approvalId,
        toolName: request.toolName,
        target,
        sessionAllowed: request.sessionAllowed,
        expiresAt: Date.now() + DEFAULT_LIMITS.approvalTimeoutMs,
      };
      this.pending.set(approvalId, {
        cancel,
        summary: {
          approvalId,
          toolName: prompt.toolName,
          target: prompt.target,
          expiresAt: prompt.expiresAt,
        },
      });
      Promise.resolve()
        .then(() => this.options.request(prompt, controller.signal))
        .then((reply) => {
          if (settled) return;
          const current = this.options.identity();
          if (
            !current ||
            Object.entries(snapshot).some(
              ([key, value]) => current[key as keyof typeof current] !== value,
            ) ||
            !isJsonData(reply) ||
            !matchesSchema(reply, APPROVAL_RESPONSE_SCHEMA)
          ) {
            cancel();
            return;
          }
          const choice = (reply as { choice: ApprovalChoice }).choice;
          finish(choice === 'allow_session' && !request.sessionAllowed ? 'cancel' : choice);
        })
        .catch(cancel);
    });
  }

  /** 撤销全部在途审批；重复调用幂等，关闭后不再创建新请求。 */
  dispose(): void {
    this.disposed = true;
    for (const { cancel } of [...this.pending.values()]) cancel();
  }
}
