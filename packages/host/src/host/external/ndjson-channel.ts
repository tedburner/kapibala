import type { Readable, Writable } from 'node:stream';
import { TextDecoder } from 'node:util';
import { redactCommonSecrets, sanitizeDisplayText } from '../redaction.js';
import { sanitizeUntrustedOutput } from '../ui/text-safety.js';
import { ExternalHarnessError } from './types.js';

/** 单条 NDJSON 帧硬上限（8 MiB）。 */
export const DEFAULT_EXTERNAL_MAX_FRAME_BYTES = 8 * 1024 * 1024;
/** 超过 64 KiB 的大帧在 `JSON.parse` 前主动让出一次事件循环，防卡顿渲染/IPC 转发。 */
const LARGE_FRAME_YIELD_BYTES = 64 * 1024;
/** 握手完成前允许容忍的非 JSON stdout 累计字节上限（64 KiB）。 */
const PRE_HANDSHAKE_MAX_NON_JSON_BYTES = 64 * 1024;
/** 握手完成前允许容忍的非 JSON stdout 累计行数上限（100 行）。 */
const PRE_HANDSHAKE_MAX_NON_JSON_LINES = 100;
/** 初始行拼接缓冲区容量（4 KiB），按需倍增至 `maxFrameBytes`，避免空闲会话常驻分配 8 MiB。 */
const INITIAL_BUFFER_CAPACITY = 4 * 1024;

/** JSON-RPC 请求 ID 类型（兼容数值或字符串 ID）。 */
export type JsonRpcRequestId = string | number;

/** 服务端发往客户端的双向请求回调返回值；抛出带 `code` 的对象时按该 JSON-RPC 错误码回复。 */
export type IncomingRpcRequestHandler = (
  id: JsonRpcRequestId,
  method: string,
  params: unknown,
) => Promise<unknown> | unknown;

/** `NdjsonChannel` 构造配置。 */
export interface NdjsonChannelOptions {
  readonly maxFrameBytes?: number;
  readonly onRequest?: IncomingRpcRequestHandler;
  readonly onNotification?: (method: string, params: unknown) => void;
  /** 非 JSON-RPC 形态的结构化 JSON 行回调（供 Claude `stream-json` 等纯事件流协议消费）。 */
  readonly onMessage?: (payload: Record<string, unknown>) => void;
  /** 收到非 JSON 启动横幅时的脱敏诊断回调。 */
  readonly onNonJsonLine?: (redactedLine: string) => void;
  /** 帧超限、非 JSON 洪泛熔断或无效 UTF-8 等不可恢复通道故障回调。 */
  readonly onFatalError?: (error: ExternalHarnessError) => void;
}

/** 单次 `request` 调用的可选控制项。 */
export interface NdjsonRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** 为 `true` 时不附带 `"jsonrpc": "2.0"` 字段（供 Codex `app-server` JSON-RPC lite 使用）。 */
  readonly omitJsonRpcVersion?: boolean;
}

interface PendingRpcCall {
  readonly method: string;
  readonly resolve: (value: any) => void;
  readonly reject: (reason: unknown) => void;
  readonly cleanup: () => void;
}

/**
 * 外部代理双向 NDJSON 行通道。
 *
 * 解决的四类跨 CLI 实战边界：
 * 1. **非 JSON 横幅容错 + TUI 误配快败熔断**：容忍 CLI 启动打印的版本提示，但握手前超 100 行或 64KiB 立即报 `EXTERNAL_NON_JSON_FLOOD`；
 * 2. **大帧串行让出队列**：`>= 64KiB` 大帧让出事件循环时，后续小帧排在同一 FIFO 队列之后，杜绝 `session/prompt` 结算响应超车大体积 `tool_call_update`；
 * 3. **多协议同源承载**：同时兼容标准 JSON-RPC 2.0（ACP）、无 `jsonrpc` 字段的 JSON-RPC lite（Codex）以及纯 JSON 事件流（Claude `stream-json`）；
 * 4. **默认拒绝反向工具**：未注册 `onRequest` 或处理函数未覆盖的方法自动回复 `-32601 Method not found`。
 */
export class NdjsonChannel {
  private readonly maxFrameBytes: number;
  private readonly decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  private buffer = Buffer.allocUnsafe(INITIAL_BUFFER_CAPACITY);
  private bufferedBytes = 0;
  private nextRequestId = 1;
  private handshakeCompleted = false;
  private nonJsonBytes = 0;
  private nonJsonLines = 0;
  private readonly nonJsonSamples: string[] = [];
  private closed = false;
  private fatalError?: ExternalHarnessError;
  private readonly pending = new Map<JsonRpcRequestId, PendingRpcCall>();
  private readonly frameQueue: Buffer[] = [];
  private pumping = false;

  constructor(
    private readonly readable: Readable,
    private readonly writable: Writable,
    private readonly options: NdjsonChannelOptions = {},
  ) {
    this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_EXTERNAL_MAX_FRAME_BYTES;
    if (!Number.isSafeInteger(this.maxFrameBytes) || this.maxFrameBytes < 64) {
      throw new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', '无效的 NDJSON 帧大小上限');
    }

    this.readable.on('data', this.handleData);
    this.readable.on('end', this.handleEnd);
    this.readable.on('error', this.handleStreamError);
  }

  /** 标记协议首轮握手已成功，解除启动期 100 行 / 64KiB 非 JSON 熔断阈值限制。 */
  markHandshakeCompleted(): void {
    this.handshakeCompleted = true;
  }

  /** 获取最近捕获的脱敏非 JSON 输出样本（最多保留 5 行，供握手失败诊断展示）。 */
  getNonJsonSamples(): readonly string[] {
    return this.nonJsonSamples;
  }

  /** 向子进程 stdin 写入单行 JSON 帧。 */
  send(payload: Record<string, unknown>): void {
    if (this.closed) {
      throw (
        this.fatalError ??
        new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', '外部代理通信通道已关闭')
      );
    }
    this.writable.write(`${JSON.stringify(payload)}\n`);
  }

  /** 发送单向 JSON-RPC 通知（无 `id`，不等待响应）。 */
  notify(
    method: string,
    params?: unknown,
    options?: { readonly omitJsonRpcVersion?: boolean },
  ): void {
    const frame: Record<string, unknown> = options?.omitJsonRpcVersion
      ? { method }
      : { jsonrpc: '2.0', method };
    if (params !== undefined) {
      frame.params = params;
    }
    this.send(frame);
  }

  /** 发送 JSON-RPC 请求并按 `id` 关联响应；支持超时与 `AbortSignal` 取消。 */
  request<T = unknown>(
    method: string,
    params?: unknown,
    options: NdjsonRequestOptions = {},
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(
        this.fatalError ??
          new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', '外部代理通信通道已关闭'),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(new ExternalHarnessError('EXTERNAL_ABORTED', `请求 ${method} 已取消`));
    }

    const id = this.nextRequestId++;
    const frame: Record<string, unknown> = options.omitJsonRpcVersion
      ? { id, method }
      : { jsonrpc: '2.0', id, method };
    if (params !== undefined) {
      frame.params = params;
    }

    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = (): void => {
        this.pending.delete(id);
        cleanup();
        reject(new ExternalHarnessError('EXTERNAL_ABORTED', `请求 ${method} 已取消`));
      };
      const cleanup = (): void => {
        if (timer !== undefined) clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        timer = setTimeout(() => {
          this.pending.delete(id);
          cleanup();
          reject(
            new ExternalHarnessError(
              'EXTERNAL_TIMEOUT',
              `等待外部代理响应 ${method} 超时（${options.timeoutMs}ms）`,
            ),
          );
        }, options.timeoutMs);
        timer.unref?.();
      }

      options.signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(id, { method, resolve, reject, cleanup });

      try {
        this.send(frame);
      } catch (err) {
        this.pending.delete(id);
        cleanup();
        reject(err);
      }
    });
  }

  /** 关闭通道并拒绝所有在途请求。 */
  close(reason?: ExternalHarnessError): void {
    if (this.closed) return;
    this.closed = true;
    this.readable.off('data', this.handleData);
    this.readable.off('end', this.handleEnd);
    this.readable.off('error', this.handleStreamError);
    this.frameQueue.length = 0;
    this.bufferedBytes = 0;

    const rejection =
      reason ??
      this.fatalError ??
      new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', '外部代理进程连接已断开');

    for (const [id, call] of this.pending) {
      this.pending.delete(id);
      call.cleanup();
      call.reject(rejection);
    }
  }

  private readonly handleData = (chunk: Buffer | Uint8Array): void => {
    if (this.closed) return;
    let start = 0;
    for (let index = 0; index <= chunk.length; index++) {
      if (index !== chunk.length && chunk[index] !== 10) continue;
      const piece = chunk.subarray(start, index);
      if (this.bufferedBytes + piece.length > this.maxFrameBytes) {
        this.failChannel(
          new ExternalHarnessError(
            'EXTERNAL_FRAME_LIMIT',
            `外部代理单行输出超过帧上限（${this.maxFrameBytes} 字节）`,
          ),
        );
        return;
      }
      if (piece.length > 0) {
        this.appendBuffer(piece);
      }
      if (index < chunk.length) {
        let endOffset = this.bufferedBytes;
        if (endOffset > 0 && this.buffer[endOffset - 1] === 13) {
          endOffset -= 1;
        }
        const rawFrame = Buffer.from(this.buffer.subarray(0, endOffset));
        this.bufferedBytes = 0;
        this.frameQueue.push(rawFrame);
      }
      start = index + 1;
    }

    if (this.frameQueue.length > 0 && !this.pumping) {
      void this.pumpFrames();
    }
  };

  private readonly handleEnd = (): void => {
    if (this.closed) return;
    if (this.bufferedBytes > 0) {
      // 管道 EOF 时若残余半截行，仍放入队列按常规 JSON / 横幅规则走完最后一次消费再关闭。
      let endOffset = this.bufferedBytes;
      if (endOffset > 0 && this.buffer[endOffset - 1] === 13) {
        endOffset -= 1;
      }
      this.frameQueue.push(Buffer.from(this.buffer.subarray(0, endOffset)));
      this.bufferedBytes = 0;
    }
    void this.drainAndCloseOnEof();
  };

  private readonly handleStreamError = (err: Error): void => {
    this.failChannel(
      new ExternalHarnessError(
        'EXTERNAL_PROTOCOL_ERROR',
        `外部代理标准输出管道异常：${redactCommonSecrets(err.message)}`,
        { cause: err },
      ),
    );
  };

  private async drainAndCloseOnEof(): Promise<void> {
    if (this.frameQueue.length > 0 && !this.pumping) {
      await this.pumpFrames();
    } else {
      while (this.pumping) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    }
    this.close(
      new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', '外部代理标准输出已结束（EOF）'),
    );
  }

  private appendBuffer(piece: Uint8Array): void {
    const required = this.bufferedBytes + piece.length;
    if (required > this.buffer.length) {
      let nextCapacity = this.buffer.length;
      while (nextCapacity < required) {
        nextCapacity = Math.min(this.maxFrameBytes, nextCapacity * 2);
      }
      const grown = Buffer.allocUnsafe(nextCapacity);
      this.buffer.copy(grown, 0, 0, this.bufferedBytes);
      this.buffer = grown;
    }
    Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength).copy(
      this.buffer,
      this.bufferedBytes,
    );
    this.bufferedBytes += piece.length;
  }

  private async pumpFrames(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (!this.closed && this.frameQueue.length > 0) {
        const frame = this.frameQueue.shift()!;
        if (frame.length === 0) continue;
        if (frame.length >= LARGE_FRAME_YIELD_BYTES) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (this.closed) return;
        }
        this.processSingleFrame(frame);
      }
    } finally {
      this.pumping = false;
    }
  }

  private processSingleFrame(frame: Buffer): void {
    let text: string;
    try {
      text = this.decoder.decode(frame);
    } catch (cause) {
      this.failChannel(
        new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', '外部代理输出包含非法 UTF-8 字节序列', {
          cause,
        }),
      );
      return;
    }

    const trimmed = text.trim();
    if (!trimmed) return;

    let parsed: unknown;
    if (trimmed.startsWith('{')) {
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        parsed = undefined;
      }
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.handleNonJsonFrame(trimmed, frame.length);
      return;
    }

    this.dispatchObject(parsed as Record<string, unknown>);
  }

  private handleNonJsonFrame(rawText: string, byteLength: number): void {
    const safeLine = sanitizeDisplayText(
      redactCommonSecrets(sanitizeUntrustedOutput(rawText)),
      240,
    );
    if (safeLine) {
      if (this.nonJsonSamples.length < 5) {
        this.nonJsonSamples.push(safeLine);
      }
      this.options.onNonJsonLine?.(safeLine);
    }

    if (!this.handshakeCompleted) {
      this.nonJsonLines += 1;
      this.nonJsonBytes += byteLength;
      if (
        this.nonJsonLines > PRE_HANDSHAKE_MAX_NON_JSON_LINES ||
        this.nonJsonBytes > PRE_HANDSHAKE_MAX_NON_JSON_BYTES
      ) {
        this.failChannel(
          new ExternalHarnessError(
            'EXTERNAL_NON_JSON_FLOOD',
            '外部代理在握手完成前持续输出非 JSON 文本，疑似误配了交互式终端命令而非协议模式',
          ),
        );
      }
    }
  }

  private dispatchObject(obj: Record<string, unknown>): void {
    const hasId = typeof obj.id === 'string' || typeof obj.id === 'number';
    const hasMethod = typeof obj.method === 'string';

    // 1. 服务端请求（同时携带 id 与 method）
    if (hasId && hasMethod) {
      void this.handleIncomingRequest(
        obj.id as JsonRpcRequestId,
        obj.method as string,
        obj.params,
        obj.jsonrpc === '2.0',
      );
      return;
    }

    // 2. 客户端在途请求的响应（携带 id，且含 result 或 error）
    if (hasId && ('result' in obj || 'error' in obj)) {
      const pending = this.pending.get(obj.id as JsonRpcRequestId);
      if (!pending) return;
      this.pending.delete(obj.id as JsonRpcRequestId);
      pending.cleanup();
      if (obj.error && typeof obj.error === 'object') {
        const rpcErr = obj.error as { code?: unknown; message?: unknown; data?: unknown };
        const codeNum = typeof rpcErr.code === 'number' ? rpcErr.code : -32603;
        const msg =
          typeof rpcErr.message === 'string'
            ? redactCommonSecrets(sanitizeUntrustedOutput(rpcErr.message))
            : 'Unknown RPC error';
        const wrapped = Object.assign(
          new ExternalHarnessError(
            'EXTERNAL_PROTOCOL_ERROR',
            `${pending.method} 失败 (${codeNum}): ${msg}`,
          ),
          { rpcCode: codeNum, rpcData: rpcErr.data },
        );
        pending.reject(wrapped);
      } else {
        pending.resolve(obj.result);
      }
      return;
    }

    // 3. 单向通知（携带 method、无 id）
    if (!hasId && hasMethod) {
      this.options.onNotification?.(obj.method as string, obj.params);
      return;
    }

    // 4. 非 JSON-RPC 形态的结构化事件对象（如 Claude stream-json）
    this.options.onMessage?.(obj);
  }

  private async handleIncomingRequest(
    id: JsonRpcRequestId,
    method: string,
    params: unknown,
    includeJsonRpcVersion: boolean,
  ): Promise<void> {
    const replyEnvelope = (body: Record<string, unknown>): void => {
      if (this.closed) return;
      try {
        this.send(includeJsonRpcVersion ? { jsonrpc: '2.0', id, ...body } : { id, ...body });
      } catch {
        /* ignore write failure during shutdown */
      }
    };

    if (!this.options.onRequest) {
      replyEnvelope({
        error: { code: -32601, message: `Method not found: ${method}` },
      });
      return;
    }

    try {
      const result = await this.options.onRequest(id, method, params);
      replyEnvelope({ result: result ?? null });
    } catch (err) {
      const customCode =
        err && typeof err === 'object' && typeof (err as { rpcCode?: unknown }).rpcCode === 'number'
          ? ((err as { rpcCode: number }).rpcCode ?? -32603)
          : -32603;
      const msg =
        err instanceof Error
          ? redactCommonSecrets(sanitizeUntrustedOutput(err.message))
          : 'Internal client handler error';
      replyEnvelope({
        error: { code: customCode, message: msg },
      });
    }
  }

  private failChannel(error: ExternalHarnessError): void {
    if (this.closed) return;
    this.fatalError = error;
    this.options.onFatalError?.(error);
    this.close(error);
  }
}
