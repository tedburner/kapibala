import { Readable } from 'node:stream';
import { TerminalInputFramer, type TerminalInputFramerOptions } from './input-framer.js';

/** 实际 TTY 的最小读取边界；不允许其他读取器与本适配器同时消费原始流。 */
export interface TerminalInputSource extends Readable {
  isTTY?: boolean;
  isRaw?: boolean;
  setRawMode(enabled: boolean): unknown;
  ref?(): unknown;
  unref?(): unknown;
}

/** 粘贴与错误走编辑动作/诊断端口，不经过 Ink 的快捷键解释。 */
export interface TerminalInputStreamOptions extends TerminalInputFramerOptions {
  onPaste(text: string): void;
  onDiscard?(reason: string): void;
}

/**
 * 给 Ink 提供单一读取链：真实 TTY → 有界拼包 → Ink，粘贴单独交编辑器。
 * 使用对象流保持完整按键的读取边界；只在 Ink 请求 raw mode 时绑定真实输入，
 * 停用/EOF/销毁均解绑并清除残余输入。终端进入前 raw 状态由模式守卫恢复。
 */
export class TerminalInputStream extends Readable {
  private framer: TerminalInputFramer | undefined;
  private readonly onReadable = () => {
    while (this.framer) {
      const chunk: string | Buffer | null = this.source.read();
      if (chunk === null) break;
      this.framer.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'));
    }
  };
  private readonly onEnd = () => {
    this.setRawMode(false);
    this.push(null);
  };
  private readonly onSourceError = (error: Error) => this.destroy(error);

  constructor(
    private readonly source: TerminalInputSource,
    private readonly options: TerminalInputStreamOptions,
  ) {
    super({ objectMode: true });
  }

  /** 对外呈现真实终端能力，不通过伪造 TTY 绕过非交互保护。 */
  get isTTY(): boolean {
    return Boolean(this.source.isTTY);
  }

  /** 原始状态以真实输入句柄为准，供模式守卫记录和恢复。 */
  get isRaw(): boolean {
    return Boolean(this.source.isRaw);
  }

  /** Ink 决定读取时机；数据由唯一真实流监听器推送，不额外发起 read 循环。 */
  override _read(): void {}

  /**
   * 启停唯一原始读取器；停用先解绑和清空输入再还原 raw，重复调用不增加监听。
   * raw mode 启动失败直接抛出，由宿主停止渲染并通过模式守卫清理。
   */
  setRawMode(enabled: boolean): this {
    if (enabled) {
      if (this.framer || this.destroyed) return this;
      this.source.setEncoding('utf8');
      this.source.setRawMode(true);
      this.framer = new TerminalInputFramer((frame) => {
        if (frame.kind === 'key') this.push(frame.text);
        else if (frame.kind === 'paste') this.options.onPaste(frame.text);
        else this.options.onDiscard?.(frame.reason);
      }, this.options);
      this.source.on('readable', this.onReadable);
      this.source.on('end', this.onEnd);
      this.source.on('error', this.onSourceError);
    } else {
      const active = this.framer;
      this.framer = undefined;
      active?.close();
      this.source.off('readable', this.onReadable);
      this.source.off('end', this.onEnd);
      this.source.off('error', this.onSourceError);
      // Ink 关闭读取后，未消费的帧不能在下一次问答/审批启用时被当作新输入。
      while (super.read() !== null) {
        /* 丢弃旧所有者的缓存帧。 */
      }
      if (active) this.source.setRawMode(false);
    }
    return this;
  }

  /** 保留 Ink 对进程存活的既有管理，不再注册独立的全局输入所有者。 */
  ref(): this {
    this.source.ref?.();
    return this;
  }

  /** 解除真实输入对事件循环的引用，不关闭调用方持有的 stdin。 */
  unref(): this {
    this.source.unref?.();
    return this;
  }

  /** 销毁仅解绑本实例，不能关闭全局 stdin；清理错误交回流的既有错误通道。 */
  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    try {
      this.setRawMode(false);
      callback(error);
    } catch (cleanupError) {
      callback(error ?? (cleanupError as Error));
    }
  }
}
