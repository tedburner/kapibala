/**
 * @fileoverview MCP Stdio 进程有界 stderr 诊断尾部缓存
 *
 * 约束与边界：
 * 1. 严格限制 stderr 诊断保留上限为 8 KiB（8192 字节），防止异常子进程日志爆炸耗尽宿主内存；
 * 2. 采用环形切片策略，始终保留最近产生的错误输出；
 * 3. 诊断输出时剥离 ANSI 转义字符，确保日志与错误报告呈现纯净文本，禁止将 stderr 转为模型指令。
 */

/** 默认 stderr 尾部保留上限（8 KiB）。 */
export const DEFAULT_STDERR_TAIL_LIMIT_BYTES = 8192;

/**
 * ANSI 转义码匹配正则，用于诊断输出时的格式清理。
 */
const ESC = '\x1b';
const ANSI_REGEX = new RegExp(`${ESC}\\[[0-9;?]*[a-zA-Z]`, 'g');

/**
 * 有界 stderr 尾部缓存器。
 */
export class BoundedStderrBuffer {
  private chunks: Buffer[] = [];
  private totalBytes = 0;
  private readonly maxBytes: number;

  /**
   * 创建有界 stderr 尾部缓存器。
   *
   * @param maxBytes - 最大保留字节数，默认 8192 (8 KiB)。必须为正整数。
   */
  constructor(maxBytes: number = DEFAULT_STDERR_TAIL_LIMIT_BYTES) {
    this.maxBytes = Math.max(1, maxBytes);
  }

  private appendsInWindow = 0;
  private windowStart = Date.now();
  private static readonly MAX_APPENDS_PER_SEC = 500;

  /**
   * 追加一段标准错误输出字节流。
   * 包含每秒调用频次上限与超过单包容量时的就地切片，防止恶意子进程刷爆 CPU。
   *
   * @param chunk - 二进制 Buffer 或 UTF-8 字符串片段。
   */
  append(chunk: Buffer | string): void {
    const now = Date.now();
    if (now - this.windowStart > 1000) {
      this.windowStart = now;
      this.appendsInWindow = 0;
    }
    this.appendsInWindow += 1;
    if (this.appendsInWindow > BoundedStderrBuffer.MAX_APPENDS_PER_SEC) {
      return;
    }

    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
    if (buf.length === 0) return;

    if (buf.length > this.maxBytes) {
      buf = buf.subarray(buf.length - this.maxBytes);
      this.chunks = [];
      this.totalBytes = 0;
    }

    this.chunks.push(buf);
    this.totalBytes += buf.length;

    // 超过上限时淘汰头部较旧的数据块
    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      const first = this.chunks[0];
      const excess = this.totalBytes - this.maxBytes;
      if (first.length <= excess) {
        this.chunks.shift();
        this.totalBytes -= first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.totalBytes -= excess;
        break;
      }
    }
  }

  /**
   * 获取当前缓存的完整 UTF-8 错误文本。
   *
   * @param sanitizeAnsi - 是否自动剥离 ANSI 转义色彩码，默认 true。
   * @returns 纯净的尾部诊断文本。
   */
  getText(sanitizeAnsi = true): string {
    if (this.chunks.length === 0) return '';
    const text = Buffer.concat(this.chunks, this.totalBytes).toString('utf8');
    return sanitizeAnsi ? text.replace(ANSI_REGEX, '') : text;
  }

  /**
   * 当前缓存占用的实际字节数。
   */
  get byteLength(): number {
    return this.totalBytes;
  }

  /**
   * 清空所有缓存内容。
   */
  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }
}
