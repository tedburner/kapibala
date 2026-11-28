import type { Notification, RunReceipt } from '../shared/contracts.js';
import { type ResolvedDesktopLocale, translateDesktop } from '../shared/i18n/index.js';

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
    private readonly enabled: () => boolean = () => true,
    private readonly locale: () => ResolvedDesktopLocale = () => 'zh-CN',
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
    this.dismiss(`watch:${sessionId}`);
    for (const [id, item] of this.pending)
      if (item.sessionId === sessionId) {
        this.pending.delete(id);
        this.dismiss(id);
      }
  }
  /** 清理指定外部会话的驻留系统通知并释放同会话去重槽位，使下一轮仍可正常提醒。 */
  dismissExternal(sessionId: string): void {
    this.dismiss(`ext:${sessionId}`);
    for (const item of [...this.seen]) {
      if (item.startsWith(`ext:${sessionId}:`)) {
        this.seen.delete(item);
      }
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
    const lang = this.locale();
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
          ? translateDesktop(lang, 'notice.runFailed')
          : run.result === 'aborted'
            ? translateDesktop(lang, 'notice.runAborted')
            : translateDesktop(lang, 'notice.runCompleted'),
        translateDesktop(lang, 'notice.runBody'),
        () => this.sessions.has(run.sessionId) && this.runs.get(run.sessionId)?.runId === run.runId,
      );
    } else if (event.type === 'watch.triggered') {
      // 用户主动取消不打扰；只有宿主侧判定的事件才提醒。
      if (event.state === 'cancelled') return;
      if (!this.sessions.has(event.sessionId)) return;
      const title =
        event.state === 'timeout'
          ? translateDesktop(lang, 'notice.watchTimeout')
          : event.state === 'orphaned'
            ? translateDesktop(lang, 'notice.watchOrphaned')
            : translateDesktop(lang, 'notice.watchFired');
      this.publish(
        `watch:${event.sessionId}`,
        `watch:${event.sessionId}:${event.watchId}`,
        title,
        translateDesktop(lang, 'notice.watchBody'),
        () => this.sessions.has(event.sessionId),
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
        translateDesktop(lang, 'notice.approvalTitle'),
        translateDesktop(lang, 'notice.approvalBody'),
        () =>
          this.sessions.has(event.sessionId) &&
          (this.pending.get(event.approvalId)?.expiresAt ?? 0) > Date.now(),
      );
    } else if (event.type === 'external.attention') {
      const title =
        event.kind === 'approval_requested'
          ? translateDesktop(lang, 'notice.extApproval', { name: event.harnessName })
          : event.kind === 'turn_failed'
            ? translateDesktop(lang, 'notice.extFailed', { name: event.harnessName })
            : translateDesktop(lang, 'notice.extCompleted', { name: event.harnessName });
      this.publish(
        `ext:${event.sessionId}`,
        `ext:${event.sessionId}:${event.kind}`,
        title,
        translateDesktop(lang, 'notice.extBody'),
        () => true,
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
    if (!this.enabled() || !this.background()) return;
    if (this.seen.has(identity)) return;
    this.seen.add(identity);
    if (this.seen.size > 1024) this.seen.delete(this.seen.values().next().value!);
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
