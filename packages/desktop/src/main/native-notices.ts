import type { Notification, RunReceipt } from '../shared/contracts.js';

/** 原生通知只引用当前控制期的会话与运行身份；不包含历史、路径、工具参数或审批执行入口。 */
export class NativeNotices {
  private epoch = 0;
  private readonly sessions = new Set<string>();
  private readonly runs = new Map<string, RunReceipt>();
  private readonly seen = new Set<string>();
  private readonly pending = new Map<string, { sessionId: string; expiresAt: number }>();
  private readonly visible = new Map<string, () => void>();
  constructor(
    private readonly background: () => boolean,
    private readonly show: (title: string, body: string, click: () => void) => () => void,
    private readonly focus: () => void,
  ) {}
  /** 只登记 Main 已从 Host 获得的句柄；页面不能自行提供通知目标。 */
  open(sessionId: string): void {
    this.sessions.add(sessionId);
  }
  /** 释放句柄时同步撤销相关通知，保留历史不等于继续持有执行身份。 */
  close(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.runs.delete(sessionId);
    this.dismiss(`run:${sessionId}`);
    for (const [id, item] of this.pending)
      if (item.sessionId === sessionId) {
        this.pending.delete(id);
        this.dismiss(id);
      }
  }
  /** 新控制期或 Host 不可用时立即撤销旧回调；迟到点击不会重放任务或审批。 */
  reset(): void {
    this.epoch++;
    for (const close of this.visible.values()) close();
    this.visible.clear();
    this.sessions.clear();
    this.runs.clear();
    this.pending.clear();
    this.seen.clear();
  }
  /** 消费已校验的事实，不依赖 Renderer 正文订阅，最多保留 8 个运行和 128 个审批通知。 */
  observe(event: Notification): void {
    if (event.type === 'approval.closed') {
      this.pending.delete(event.approvalId);
      this.dismiss(event.approvalId);
      return;
    }
    if (event.type === 'run.changed') {
      const run = event.receipt;
      if (!this.sessions.has(run.sessionId)) return;
      this.runs.set(run.sessionId, run);
      const key = `run:${run.sessionId}`;
      if (run.phase !== 'idle') {
        this.dismiss(key);
        return;
      }
      this.publish(
        key,
        `${run.sessionId}:${run.runId}`,
        run.result === 'failed'
          ? '任务失败'
          : run.result === 'aborted'
            ? '任务已停止'
            : '任务已完成',
        '打开 Kapibala 查看运行结果。',
        () => this.sessions.has(run.sessionId) && this.runs.get(run.sessionId)?.runId === run.runId,
      );
    } else if (event.type === 'approval.requested') {
      if (!this.sessions.has(event.sessionId) || event.expiresAt <= Date.now()) return;
      this.pending.set(event.approvalId, {
        sessionId: event.sessionId,
        expiresAt: event.expiresAt,
      });
      this.publish(
        event.approvalId,
        event.approvalId,
        '任务等待审批',
        '打开 Kapibala 查看并处理请求。',
        () =>
          this.sessions.has(event.sessionId) &&
          (this.pending.get(event.approvalId)?.expiresAt ?? 0) > Date.now(),
      );
    }
  }
  private publish(
    key: string,
    identity: string,
    title: string,
    body: string,
    valid: () => boolean,
  ): void {
    if (this.seen.has(identity)) return;
    this.seen.add(identity);
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
    if (!this.background()) return;
    const epoch = this.epoch;
    this.dismiss(key);
    this.visible.set(
      key,
      this.show(title, body, () => {
        if (this.epoch === epoch && valid()) this.focus();
      }),
    );
  }
  private dismiss(key: string): void {
    this.visible.get(key)?.();
    this.visible.delete(key);
  }
}
