import type { EventEmitter } from 'node:events';
import { writeSync } from 'node:fs';

/** 终端模式守卫的注入边界；输入/写屏仍由渲染器独占，守卫只登记与恢复模式。 */
export interface TerminalModeGuardOptions {
  input: { isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => unknown };
  output: { isTTY?: boolean; fd?: number; write: (chunk: string) => unknown };
  /** 默认使用当前进程；注入独立事件源可验证致命退出而不改变真实终端。 */
  lifecycle?: Pick<EventEmitter, 'on' | 'off'>;
  /** 致命退出不能等待异步流刷出；真实 TTY 缺省通过文件描述符同步恢复。 */
  writeSync?: (chunk: string) => unknown;
}

/**
 * 持有本实例的备用屏、光标与粘贴模式；不接管 stdin，也不把 SIGINT 任务取消当作退出。
 * 正常关闭必须由宿主先等待工具/存储清理并停止渲染；致命钩子仅尽力同步恢复终端，
 * 不吞掉异常、不改变进程退出状态，也不保证不可捕获终止下的恢复。
 */
export class TerminalModeGuard {
  private active = false;
  private pasteEnabled = false;
  private readonly originalRaw: boolean;
  private readonly lifecycle: Pick<EventEmitter, 'on' | 'off'>;
  private readonly syncWrite: (chunk: string) => unknown;
  private readonly onFatalExit = () => this.restore();

  constructor(private readonly options: TerminalModeGuardOptions) {
    this.originalRaw = Boolean(options.input.isRaw);
    this.lifecycle = options.lifecycle ?? process;
    this.syncWrite =
      options.writeSync ??
      ((chunk) => {
        if (options.output.fd !== undefined) writeSync(options.output.fd, chunk);
        else options.output.write(chunk);
      });
  }

  /** 在首次写屏前登记恢复钩子；非 TTY 副作用前失败，重复进入同一活动实例不重复切屏。 */
  enter(): void {
    if (this.active) return;
    if (!this.options.input.isTTY || !this.options.output.isTTY) {
      throw new Error('完整终端视图需要 stdin 与 stdout 均为 TTY');
    }
    this.active = true;
    this.lifecycle.on('exit', this.onFatalExit);
    this.lifecycle.on('uncaughtExceptionMonitor', this.onFatalExit);
    try {
      this.options.output.write('\x1b[?1049h\x1b[?25l');
    } catch (error) {
      this.restore();
      throw error;
    }
  }

  /** 仅对已取得的终端启用粘贴标记；实际内容解析归属唯一输入适配器。 */
  enableBracketedPaste(): void {
    if (!this.active || this.pasteEnabled) return;
    this.pasteEnabled = true;
    try {
      this.options.output.write('\x1b[?2004h');
    } catch (error) {
      this.restore();
      throw error;
    }
  }

  /**
   * 同步、幂等、尽力恢复已持有模式及进入前 raw 状态，并解除本实例的钩子。
   * 句柄断开不能再次抛错导致清理递归；调用方不得在恢复后继续向旧视窗绘制。
   */
  restore(): void {
    if (!this.active) return;
    this.active = false;
    this.lifecycle.off('exit', this.onFatalExit);
    this.lifecycle.off('uncaughtExceptionMonitor', this.onFatalExit);
    const reset = `${this.pasteEnabled ? '\x1b[?2004l' : ''}\x1b[?1049l\x1b[?25h`;
    this.pasteEnabled = false;
    try {
      this.syncWrite(reset);
    } catch {
      // 致命退出或终端断开时只尽力恢复，不覆盖原错误或重新抛出。
    }
    try {
      if (Boolean(this.options.input.isRaw) !== this.originalRaw) {
        this.options.input.setRawMode?.(this.originalRaw);
      }
    } catch {
      // 输入句柄可能已关闭；输出恢复与监听释放仍已独立完成。
    }
  }
}
