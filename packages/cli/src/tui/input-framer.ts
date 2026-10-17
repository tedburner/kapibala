/** 拼包结果；粘贴必须直接进入编辑器，禁止再作为按键送入 Ink 或审批分派。 */
export type TerminalInputFrame =
  | { kind: 'key'; text: string }
  | { kind: 'paste'; text: string }
  | { kind: 'discarded'; reason: 'incomplete-sequence' | 'invalid-sequence' | 'paste-too-large' };

/** 输入前置适配限制；只延迟未完成的转义序列，不为普通输入增加等待窗口。 */
export interface TerminalInputFramerOptions {
  escapeWaitMs?: number;
  maxSequenceBytes?: number;
  maxPasteBytes?: number;
}

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

/**
 * 补足 Ink 准入中观察到的跨事件循环转义分片与粘贴隔离缺口，不解码组合键含义。
 * 唯一上游读取器先向此对象送入 UTF-8 解码后的文本；完整 key 再交 Ink 解析，
 * paste 交独立编辑动作。超限或非法序列丢弃，不把控制字节重新解释为提交或批准。
 */
export class TerminalInputFramer {
  private closed = false;
  private sequence = '';
  private discardingSequence = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pasting = false;
  private pasteTail = '';
  private pasteChunks: string[] = [];
  private pasteBytes = 0;
  private pasteDiscarded = false;
  private readonly waitMs: number;
  private readonly maxSequence: number;
  private readonly maxPaste: number;

  constructor(
    private readonly emit: (frame: TerminalInputFrame) => void,
    options: TerminalInputFramerOptions = {},
  ) {
    this.waitMs = Math.max(10, Math.min(50, options.escapeWaitMs ?? 40));
    this.maxSequence = Math.max(8, options.maxSequenceBytes ?? 1024);
    this.maxPaste = Math.max(1, options.maxPasteBytes ?? 1024 * 1024);
  }

  /** 接收唯一读取链提供的完整 Unicode 文本；关闭后忽略迟到输入，不再触发回调。 */
  push(chunk: string): void {
    if (this.closed || !chunk) return;
    let offset = 0;
    while (offset < chunk.length && !this.closed) {
      if (this.pasting) {
        const combined = this.pasteTail + chunk.slice(offset);
        const end = combined.indexOf(PASTE_END);
        if (end >= 0) {
          this.appendPaste(combined.slice(0, end));
          const text = this.pasteChunks.join('');
          const discarded = this.pasteDiscarded;
          this.resetPaste();
          if (!discarded) this.emit({ kind: 'paste', text });
          chunk = combined.slice(end + PASTE_END.length);
          offset = 0;
          continue;
        }
        let suffix = Math.min(combined.length, PASTE_END.length - 1);
        while (suffix > 0 && !PASTE_END.startsWith(combined.slice(-suffix))) suffix--;
        this.appendPaste(suffix ? combined.slice(0, -suffix) : combined);
        this.pasteTail = suffix ? combined.slice(-suffix) : '';
        return;
      }

      const point = chunk.codePointAt(offset);
      if (point === undefined) return;
      const char = String.fromCodePoint(point);
      offset += char.length;
      if (this.sequence || this.discardingSequence) {
        this.continueSequence(char);
      } else if (char === '\x1b') {
        this.sequence = char;
        this.scheduleExpiry();
      } else if (point < 32 || point === 127) {
        this.emit({ kind: 'key', text: char });
      } else {
        const start = offset - char.length;
        while (offset < chunk.length) {
          const next = chunk.charCodeAt(offset);
          if (next < 32 || next === 127) break;
          offset++;
        }
        this.emit({ kind: 'key', text: chunk.slice(start, offset) });
      }
    }
  }

  /** 取消所有等待并擦除残余输入；不把部分序列或秘密粘贴移交给下一输入流程。 */
  close(): void {
    this.closed = true;
    this.clearTimer();
    this.sequence = '';
    this.discardingSequence = false;
    this.resetPaste();
  }

  /** 将完整控制序列交回 Ink；语法错误或超限后的结束字节只用于同步边界。 */
  private continueSequence(char: string): void {
    const code = char.codePointAt(0) ?? 0;
    if (this.discardingSequence) {
      if (code < 32 || (code >= 64 && code <= 126)) {
        this.discardingSequence = false;
        this.clearTimer();
      }
      return;
    }
    this.sequence += char;
    const prefix = this.sequence.slice(0, 2);
    const intermediate = code >= 32 && code <= 63;
    const final = code >= 64 && code <= 126;
    const introducer = this.sequence.length === 2 && (char === '[' || char === 'O');
    if (this.sequence.length > this.maxSequence || code < 32 || code === 127) {
      this.sequence = '';
      this.discardingSequence = intermediate;
      this.emit({ kind: 'discarded', reason: 'invalid-sequence' });
      if (this.discardingSequence) this.scheduleExpiry();
      else this.clearTimer();
      return;
    }
    if (introducer || ((prefix === '\x1b[' || prefix === '\x1bO') && intermediate)) {
      this.scheduleExpiry();
      return;
    }
    if ((prefix === '\x1b[' || prefix === '\x1bO') && !final) {
      this.sequence = '';
      this.clearTimer();
      this.emit({ kind: 'discarded', reason: 'invalid-sequence' });
      return;
    }
    const text = this.sequence;
    this.sequence = '';
    this.clearTimer();
    if (text === PASTE_START) {
      this.pasting = true;
    } else if (text !== PASTE_END) {
      this.emit({ kind: 'key', text });
    }
  }

  /** 有界保留粘贴源；超限后持续吞掉直到结束标记，避免后半段成为快捷键。 */
  private appendPaste(text: string): void {
    if (this.pasteDiscarded || !text) return;
    this.pasteBytes += Buffer.byteLength(text, 'utf8');
    if (this.pasteBytes > this.maxPaste) {
      this.pasteChunks = [];
      this.pasteDiscarded = true;
      this.emit({ kind: 'discarded', reason: 'paste-too-large' });
    } else {
      this.pasteChunks.push(text);
    }
  }

  private resetPaste(): void {
    this.pasting = false;
    this.pasteTail = '';
    this.pasteChunks = [];
    this.pasteBytes = 0;
    this.pasteDiscarded = false;
  }

  private clearTimer(): void {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** 只有独立 Escape 可在超时后成为按键，未完成 CSI 不重放为文本或提交。 */
  private scheduleExpiry(): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const text = this.sequence;
      const discarded = this.discardingSequence;
      this.sequence = '';
      this.discardingSequence = false;
      if (this.closed || discarded) return;
      if (text === '\x1b') this.emit({ kind: 'key', text });
      else this.emit({ kind: 'discarded', reason: 'incomplete-sequence' });
    }, this.waitMs);
    this.timer.unref?.();
  }
}
