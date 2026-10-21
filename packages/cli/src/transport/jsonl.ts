import { TextDecoder } from 'node:util';
import {
  DEFAULT_LIMITS,
  type WireError,
  type WireMessage,
  parseWireMessage,
} from '../protocol/index.js';

/** 帧边界完整但内容非法的输入；回调方应回复标准 JSON-RPC 错误并继续读取。 */
export interface InvalidFrame {
  /** 协议层给出的 JSON-RPC 错误码与安全消息，不含原始输入。 */
  error: WireError;
  /** 已解码的原始文本，仅供调用方提取请求 id；不得直接写日志。 */
  raw: string;
}

/**
 * 按字节限制单帧再解码，UTF-8 错误不替换为乱码；只把 LF 当作帧分隔符。
 * 内容错误（非法 JSON / schema 不符）只影响该帧：提供回调时交给调用方回复错误，
 * 未提供回调时抛出但不终止解码器；超帧预算、UTF-8 解码失败与 EOF 半帧才不可恢复。
 */
export class JsonlDecoder {
  private buffer?: Buffer;
  private bytes = 0;
  private ended = false;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  constructor(private readonly maxFrameBytes: number = DEFAULT_LIMITS.maxFrameBytes) {
    if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1)
      throw new Error('Invalid frame budget');
  }

  /** 一次输入可以产出多帧，限制针对帧而非网络拼包大小；存储不持有大输入的底层视图。 */
  push(
    chunk: Uint8Array,
    consume?: (message: WireMessage) => void,
    onInvalidFrame?: (frame: InvalidFrame) => void,
  ): WireMessage[] {
    if (this.ended) throw new Error('JSONL decoder is closed');
    const results: WireMessage[] = [];
    let contentFailure = false;
    try {
      let start = 0;
      for (let end = 0; end <= chunk.length; end++) {
        if (end !== chunk.length && chunk[end] !== 10) continue;
        const piece = chunk.subarray(start, end);
        if (this.bytes + piece.length > this.maxFrameBytes)
          throw new Error('JSONL frame budget exceeded');
        if (piece.length) {
          this.buffer ??= Buffer.allocUnsafe(this.maxFrameBytes);
          this.buffer.set(piece, this.bytes);
          this.bytes += piece.length;
        }
        if (end < chunk.length) {
          let frame = this.buffer?.subarray(0, this.bytes) ?? Buffer.alloc(0);
          this.bytes = 0;
          if (frame.at(-1) === 13) frame = frame.subarray(0, -1);
          // TextDecoder 的 fatal 模式保证无效 UTF-8 在此抛出并进入不可恢复分支。
          const text = this.decoder.decode(frame);
          const parsed = parseWireMessage(text);
          if (!parsed.ok) {
            if (onInvalidFrame) {
              onInvalidFrame({ error: parsed.error, raw: text });
            } else {
              contentFailure = true;
              throw new Error(`Invalid JSONL message: ${parsed.error.message}`);
            }
          } else if (consume) {
            consume(parsed.value);
          } else {
            results.push(parsed.value);
          }
        }
        start = end + 1;
      }
      return results;
    } catch (error) {
      if (!contentFailure) {
        this.ended = true;
        this.buffer = undefined;
        this.bytes = 0;
      }
      throw error;
    }
  }

  /** 终止不接受无 LF 的尾部；成功结束和失败结束都释放缓冲。 */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    const partial = this.bytes > 0;
    this.buffer = undefined;
    this.bytes = 0;
    if (partial) throw new Error('Unfinished JSONL frame at EOF');
  }
}
