import { toWireErrorCode } from '../protocol/index.js';
import {
  DEFAULT_LIMITS,
  type JsonValue,
  type ProtocolLimits,
  type RequestParams,
  type WireEvent,
  type WireMethod,
  type WireRequest,
  type WireResult,
  validateMethodResult,
  validateRequest,
  validateResponse,
} from '../protocol/index.js';
import type { LocalTransport } from './types.js';

/** 双向请求的宿主回调；业务失败只返回白名单分类，不传递原始 Error。 */
export interface RpcPeerOptions {
  prefix: 'c' | 's';
  request?(request: WireRequest): Promise<JsonValue>;
  event?(event: WireEvent): void;
  closed?(): Promise<void>;
  responded?(request: WireRequest): void;
}

/** 有界双向关联器；读取永不等待业务请求或输出 drain，避免审批与取消互锁。 */
export class RpcPeer {
  readonly done: Promise<void>;
  private serial = 0;
  private stopped = false;
  private limits: ProtocolLimits = DEFAULT_LIMITS;
  private closing?: Promise<void>;
  private inflight = 0;
  private readonly incoming = new Set<string>();
  private readonly pending = new Map<
    string,
    {
      request: WireRequest;
      resolve: (value: JsonValue) => void;
      reject: (error: Error) => void;
      clean: () => void;
    }
  >();

  constructor(
    readonly transport: LocalTransport,
    private readonly options: RpcPeerOptions,
  ) {
    this.done = this.read();
    void this.done.catch(() => {});
  }

  /** 每个请求独立超时与取消；终止后清除定时器，迟到响应不再改变结果。 */
  call<M extends WireMethod, P extends RequestParams[M]>(
    method: M,
    params: P,
    signal?: AbortSignal,
  ): Promise<WireResult<M, P>> {
    if (this.stopped || signal?.aborted) return Promise.reject(new Error('RPC closed'));
    if (this.pending.size >= this.limits.maxInflightRequests)
      return Promise.reject(new Error('RESOURCE_LIMIT'));
    const id = `${this.options.prefix}:${++this.serial}`;
    const checked = validateRequest({ jsonrpc: '2.0', id, method, params });
    if (!checked.ok) return Promise.reject(new Error('INVALID_PARAMS'));
    const request = JSON.parse(JSON.stringify(checked.value)) as WireRequest;
    return new Promise((resolve, reject) => {
      const cancel = () => {
        const entry = this.pending.get(id);
        if (entry) {
          this.pending.delete(id);
          entry.clean();
          reject(new Error('RPC closed or timed out'));
        }
      };
      const timer = setTimeout(
        cancel,
        method === 'approval/request'
          ? this.limits.approvalTimeoutMs
          : method === 'initialize'
            ? this.limits.initializationTimeoutMs
            : 30_000,
      );
      this.pending.set(id, {
        request,
        resolve: (value) => resolve(value as WireResult<M, P>),
        reject,
        clean: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
        },
      });
      signal?.addEventListener('abort', cancel, { once: true });
      void this.transport.send(request).catch(() => cancel());
    });
  }

  /** 握手完成后同步应用预算；底层不能更新时连接失败，不能继续沿用默认值。 */
  setLimits(limits: ProtocolLimits): void {
    if (this.stopped || typeof this.transport.setLimits !== 'function')
      throw new Error('PROTOCOL_MISMATCH');
    this.transport.setLimits(limits);
    this.limits = limits;
    if (
      this.pending.size > limits.maxInflightRequests ||
      this.inflight > limits.maxInflightRequests
    )
      throw new Error('RESOURCE_LIMIT');
  }

  /** 读取回调可同步拒绝所有在途操作并发起关闭；不等待自身读取任务，避免重入死锁。 */
  abort(error: Error): void {
    this.stopPending(error);
    this.closing ??= Promise.resolve().then(() => this.transport.close());
    void this.closing.catch(() => {});
  }

  /** 通知发送失败时关闭慢连接，不无限堆积 Promise 或丢弃事件后继续假装连续。 */
  notify(event: WireEvent): void {
    if (this.stopped) return;
    void this.transport
      .send({ jsonrpc: '2.0', method: 'session/event', params: event })
      .catch(() => this.close());
  }

  private async read(): Promise<void> {
    try {
      for await (const message of this.transport.messages) {
        if ('method' in message) {
          if (message.method === 'session/event') {
            this.options.event?.(message.params);
            continue;
          }
          if (this.incoming.has(message.id)) {
            await this.closeTransport();
            break;
          }
          this.incoming.add(message.id);
          if (++this.inflight > this.limits.maxInflightRequests) {
            await this.closeTransport();
            break;
          }
          void this.dispatch(message)
            .catch(() => this.closeTransport())
            .finally(() => {
              this.inflight--;
              this.incoming.delete(message.id);
            });
        } else {
          if (message.id === null) continue;
          const pending = this.pending.get(message.id);
          if (!pending) continue;
          this.pending.delete(message.id);
          pending.clean();
          const response = validateResponse(message, pending.request.method);
          if (!response.ok) pending.reject(new Error('Invalid response'));
          else if ('error' in response.value)
            pending.reject(new Error(response.value.error.data?.code ?? 'RPC_FAILED'));
          else {
            const result = validateMethodResult(
              pending.request.method,
              pending.request.params,
              response.value.result,
            );
            if (!result.ok) {
              pending.reject(new Error('Invalid method result'));
              this.abort(new Error('PROTOCOL_MISMATCH'));
            } else pending.resolve(result.value as JsonValue);
          }
        }
      }
    } finally {
      this.stopPending();
      await this.options.closed?.();
    }
  }

  private async dispatch(request: WireRequest): Promise<void> {
    try {
      if (!this.options.request) throw new Error('UNAUTHORIZED');
      const result = await this.options.request(request);
      if (!validateMethodResult(request.method, request.params, result).ok)
        throw new Error('INTERNAL_ERROR');
      await this.transport.send({ jsonrpc: '2.0', id: request.id, result });
      this.options.responded?.(request);
    } catch (error) {
      if (this.stopped) return;
      const code = toWireErrorCode(error);
      await this.transport.send({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: 'Request failed', data: { code } },
      });
    }
  }

  private stopPending(error = new Error('RPC closed')): void {
    this.stopped = true;
    for (const entry of this.pending.values()) {
      entry.clean();
      entry.reject(error);
    }
    this.pending.clear();
  }
  private async closeTransport(): Promise<void> {
    this.abort(new Error('RPC closed'));
    await this.closing;
  }

  /** 从读取回调之外关闭；不会关闭传输外部拥有的进程或 stdout。 */
  async close(): Promise<void> {
    await this.closeTransport();
    await this.done.catch(() => {});
  }
}
