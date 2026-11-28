/**
 * 会话级保活终端的分段回放缓冲与帧合批器。
 *
 * 设计取舍与边界：
 * - 为什么分段而非单字符串拼接：高吞吐输出（编译、测试日志）若每次 `slice(-MAX)` 会触发 V8 Rope 整段扁平化拷贝；
 *   采用分段数组追加是 O(1)，仅在丢弃最旧整段或分段数达到压实阈值（512 段）时摊还合并，常驻内存严格有界。
 * - 同时解决两类问题：① 伪终端刚拉起 10ms 内提示符先于渲染层订阅到达导致的「空白终端」竞态；
 *   ② 用户切换到其他会话再切回时，从宿主一次性水合最近终端输出而无需中断后台进程。
 */

/** 单个终端回放缓冲保留的字符软上限（丢弃最旧分段后仍不低于此水位）。 */
export const MAX_TERMINAL_REPLAY_CHARS = 200_000;

/** 分段数组压实阈值：交互式逐键输入会产生大量 1-2 字符小段，超限将前半段合并以消除对象头开销。 */
export const MAX_TERMINAL_REPLAY_CHUNKS = 512;

/** 默认 IPC 输出合批窗口（毫秒），对齐 60fps 单帧间隔以降低高频输出时的跨进程序列化压力。 */
export const DEFAULT_TERMINAL_BATCH_MS = 16;

/** 单次合批缓冲上限（字符）；达到上限立即冲刷，防止极端洪峰积压单帧体积。 */
export const MAX_TERMINAL_BATCH_CHARS = 65_536;

/** 分段回放缓冲可变状态；仅由宿主侧单线程事件循环读写。 */
export interface TerminalReplayBuffer {
  /** 按时间正序排列的输出片段。 */
  readonly chunks: string[];
  /** 当前所有片段的 UTF-16 码元总长。 */
  length: number;
}

/** 创建空的终端分段回放缓冲。 */
export function createTerminalReplayBuffer(): TerminalReplayBuffer {
  return { chunks: [], length: 0 };
}

/** 分段数超过阈值时将较旧的一半合并为单段，保持摊还 O(1) 追加复杂度。 */
function compactReplayChunks(buffer: TerminalReplayBuffer): void {
  if (buffer.chunks.length <= MAX_TERMINAL_REPLAY_CHUNKS) return;
  const mergeCount = Math.floor(buffer.chunks.length / 2);
  const merged = buffer.chunks.slice(0, mergeCount).join('');
  buffer.chunks.splice(0, mergeCount, merged);
}

/**
 * 追加一段 PTY 输出并裁剪超出上限的历史头部。
 *
 * 前置约束：`maxChars` 须为正整数；单段本身超出 `maxChars` 时退化为保留该段尾部 `maxChars` 字符，
 * 且若截断位置恰好劈开 UTF-16 代理对（低代理项开头），向前跳过半个孤立码元防止渲染乱码。
 */
export function appendTerminalReplay(
  buffer: TerminalReplayBuffer,
  data: string,
  maxChars: number = MAX_TERMINAL_REPLAY_CHARS,
): void {
  if (!data) return;
  buffer.chunks.push(data);
  buffer.length += data.length;

  while (buffer.chunks.length > 1) {
    const headLen = buffer.chunks[0]?.length ?? 0;
    if (buffer.length - headLen < maxChars) break;
    buffer.chunks.shift();
    buffer.length -= headLen;
  }

  if (buffer.chunks.length === 1 && buffer.length > maxChars) {
    const only = buffer.chunks[0] ?? '';
    let start = only.length - maxChars;
    const code = only.charCodeAt(start);
    if (code >= 0xdc00 && code <= 0xdfff && start + 1 <= only.length) {
      start += 1;
    }
    const sliced = only.slice(start);
    buffer.chunks[0] = sliced;
    buffer.length = sliced.length;
  }

  compactReplayChunks(buffer);
}

/** 清空回放缓冲（例如用户主动清屏重置终端时调用）。 */
export function clearTerminalReplay(buffer: TerminalReplayBuffer): void {
  buffer.chunks.length = 0;
  buffer.length = 0;
}

/** 单次会话终端快照（`snapshotSession`）跨全部子终端共享的 JSON 转义后 UTF-8 总字节预算（确保序列化总快照恒低于 512 KiB，杜绝触发 1 MiB `SNAPSHOT_TOO_LARGE`）。 */
export const MAX_SNAPSHOT_REPLAY_TOTAL_BYTES = 480_000;

/** 读取当前完整回放文本；仅在渲染层首次挂载或切回会话水合时调用，不在追加热路径拼接。 */
export function readTerminalReplayText(buffer: TerminalReplayBuffer): string {
  return buffer.chunks.join('');
}

/**
 * 按 `JSON.stringify` 转义后的 UTF-8 字节预算从尾部截取回放文本，严格对齐 Unicode 码点边界（绝不劈开 UTF-16 代理对）。
 *
 * 设计原因：终端输出富含 ANSI 控制序列（`\x1b` 在 JSON 中膨胀为 6 字节 `\\u001b`）与多字节中文/Emoji，
 * 单纯按字符数截断在 3 终端并发水合时仍可能突破 RPC 1 MiB 帧上限触发 `SNAPSHOT_TOO_LARGE`。
 */
export function sliceReplayTailByJsonBytes(text: string, maxJsonBytes: number): string {
  if (!text || maxJsonBytes <= 0) return '';
  const fullJsonBytes = Buffer.byteLength(JSON.stringify(text), 'utf8') - 2;
  if (fullJsonBytes <= maxJsonBytes) return text;

  let usedBytes = 0;
  let startIndex = text.length;
  for (let i = text.length - 1; i >= 0; i -= 1) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff && i > 0) {
      const high = text.charCodeAt(i - 1);
      if (high >= 0xd800 && high <= 0xdbff) {
        if (usedBytes + 4 > maxJsonBytes) break;
        usedBytes += 4;
        startIndex = i - 1;
        i -= 1;
        continue;
      }
    }
    let charJsonBytes: number;
    if (code >= 0xd800 && code <= 0xdfff) {
      charJsonBytes = 6;
    } else if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x0c ||
      code === 0x0a ||
      code === 0x0d ||
      code === 0x09
    ) {
      charJsonBytes = 2;
    } else if (code < 0x20) {
      charJsonBytes = 6;
    } else if (code < 0x80) {
      charJsonBytes = 1;
    } else if (code < 0x800) {
      charJsonBytes = 2;
    } else {
      charJsonBytes = 3;
    }
    if (usedBytes + charJsonBytes > maxJsonBytes) break;
    usedBytes += charJsonBytes;
    startIndex = i;
  }

  if (startIndex < text.length) {
    const first = text.charCodeAt(startIndex);
    if (first >= 0xdc00 && first <= 0xdfff) {
      startIndex += 1;
    }
  }
  let sliced = text.slice(startIndex);
  while (
    sliced.length > 0 &&
    Buffer.byteLength(JSON.stringify(sliced), 'utf8') - 2 > maxJsonBytes
  ) {
    const head = sliced.charCodeAt(0);
    const step = head >= 0xd800 && head <= 0xdbff && sliced.length > 1 ? 2 : 1;
    sliced = sliced.slice(step);
  }
  return sliced;
}

/** PTY 输出合批器句柄；进程退出或关闭前必须调用 `flush()` 保证尾帧不先于退出事件丢失。 */
export interface TerminalDataBatcher {
  push(chunk: string): void;
  flush(): void;
  dispose(): void;
}

/**
 * 创建有界时间窗与字节阈值的终端输出合批器。
 *
 * 失败边界：`dispose()` 会丢弃未发出的定时器但不会自动发空帧；正常退出路径应先 `flush()` 再发 exit 通知。
 */
export function createTerminalDataBatcher(
  emit: (batch: string) => void,
  intervalMs: number = DEFAULT_TERMINAL_BATCH_MS,
  maxBatchChars: number = MAX_TERMINAL_BATCH_CHARS,
): TerminalDataBatcher {
  let pending: string[] = [];
  let pendingChars = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const flush = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (disposed || pendingChars === 0) {
      pending = [];
      pendingChars = 0;
      return;
    }
    const payload = pending.join('');
    pending = [];
    pendingChars = 0;
    emit(payload);
  };

  return {
    push(chunk: string): void {
      if (disposed || !chunk) return;
      pending.push(chunk);
      pendingChars += chunk.length;
      if (pendingChars >= maxBatchChars) {
        flush();
        return;
      }
      if (timer === undefined) {
        timer = setTimeout(flush, intervalMs);
      }
    },
    flush,
    dispose(): void {
      disposed = true;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      pending = [];
      pendingChars = 0;
    },
  };
}
