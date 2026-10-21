import { toWireErrorCode } from '../protocol/index.js';
import {
  DEFAULT_LIMITS,
  type JsonValue,
  type RequestParams,
  type WireEvent,
  type WireMethod,
  type WireRequest,
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
  private inflight = 0;
  private readonly incoming = new Set<string>();
  private readonly pending = new Map<
    string,
    {
      method: WireMethod;
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
  call<M extends WireMethod>(
    method: M,
    params: RequestParams[M],
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    if (this.stopped || signal?.aborted) return Promise.reject(new Error('RPC closed'));
    if (this.pending.size >= DEFAULT_LIMITS.maxInflightRequests)
      return Promise.reject(new Error('RESOURCE_LIMIT'));
    const id = `${this.options.prefix}:${++this.serial}`;
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
        method === 'approval/request' ? DEFAULT_LIMITS.approvalTimeoutMs : 30_000,
      );
      this.pending.set(id, {
        method,
        resolve,
        reject,
        clean: () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', cancel);
        },
      });
      signal?.addEventListener('abort', cancel, { once: true });
      const request = { jsonrpc: '2.0', id, method, params } as WireRequest;
      void this.transport.send(request).catch(() => cancel());
    });
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
          if (++this.inflight > DEFAULT_LIMITS.maxInflightRequests) {
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
          const response = validateResponse(message, pending.method);
          if (!response.ok) pending.reject(new Error('Invalid response'));
          else if ('error' in response.value)
            pending.reject(new Error(response.value.error.data?.code ?? 'RPC_FAILED'));
          else pending.resolve(response.value.result);
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

  private stopPending(): void {
    this.stopped = true;
    for (const entry of this.pending.values()) {
      entry.clean();
      entry.reject(new Error('RPC closed'));
    }
    this.pending.clear();
  }
  private async closeTransport(): Promise<void> {
    this.stopPending();
    await this.transport.close();
  }

  /** 从读取回调之外关闭；不会关闭传输外部拥有的进程或 stdout。 */
  async close(): Promise<void> {
    await this.closeTransport();
    await this.done.catch(() => {});
  }
}
