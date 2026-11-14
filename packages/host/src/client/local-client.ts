import { DEFAULT_LIMITS, PROTOCOL_VERSION, validateSnapshotBody } from '../protocol/index.js';
import type {
  ApprovalChoice,
  ApprovalPrompt,
  ClientResult,
  ClientSnapshot,
  ProtocolLimits,
  ProtocolOffer,
  RequestParams,
  RequestResults,
  SnapshotPage,
  WireEvent,
  WireMethod,
  WireSnapshot,
} from '../protocol/index.js';
import { RpcPeer } from '../transport/rpc.js';
import type { LocalTransport } from '../transport/types.js';

/** 客户端人工审批入口；缺省取消，不能从模型输出自动推导允许。 */
export interface LocalClientOptions {
  approval?(request: ApprovalPrompt, signal: AbortSignal): Promise<ApprovalChoice>;
}

const limitKeys = Object.keys(DEFAULT_LIMITS) as (keyof ProtocolLimits)[];
/** 服务端可收紧任一预算，但不能放大客户端声明的硬上限；非法字段由结果 Schema 拒绝。 */
function negotiateLimits(
  result: RequestResults['initialize'],
  offer: ProtocolOffer,
): ProtocolLimits {
  if (
    result.major !== PROTOCOL_VERSION.major ||
    result.minor < offer.minMinor ||
    result.minor > offer.maxMinor ||
    result.minor > PROTOCOL_VERSION.minor ||
    !offer.capabilities.every((value) => result.capabilities.includes(value)) ||
    limitKeys.some((key) => result.limits[key] > DEFAULT_LIMITS[key])
  )
    throw new Error('PROTOCOL_MISMATCH');
  return Object.freeze(
    Object.fromEntries(limitKeys.map((key) => [key, result.limits[key]])) as ProtocolLimits,
  );
}
interface Attaching {
  events: WireEvent[];
  bytes: number;
}
interface Cursor {
  session: string;
  epoch: string;
  instance: string;
  seq: number;
}

/**
 * 显式 Node 客户端；缺号与 attach 失败使整个连接失效，所有会话必须新建连接后重新 attach。
 * 不自动恢复控制权、不重发写请求；协商预算同时驱动传输、RPC、分块与审批。
 */
export class LocalClient {
  private readonly peer: RpcPeer;
  private readonly attaching = new Map<string, Attaching>();
  private readonly approvalControllers = new Map<
    string,
    { controller: AbortController; sessionId: string }
  >();
  private readonly subscribers = new Set<(event: WireEvent) => void>();
  private readonly cursors = new Map<string, Cursor>();
  private limits: ProtocolLimits = DEFAULT_LIMITS;
  private snapshotBytes = 0;
  private failure?: Error;

  private constructor(transport: LocalTransport, options: LocalClientOptions) {
    this.peer = new RpcPeer(transport, {
      prefix: 'c',
      request: async (request) => {
        if (request.method !== 'approval/request' || this.failure) throw new Error('UNAUTHORIZED');
        const prompt = request.params;
        if (
          this.approvalControllers.has(prompt.approvalId) ||
          [...this.approvalControllers.values()].filter(
            (entry) => entry.sessionId === prompt.sessionId,
          ).length >= this.limits.maxPendingApprovals
        )
          throw new Error('RESOURCE_LIMIT');
        const controller = new AbortController();
        this.approvalControllers.set(prompt.approvalId, {
          controller,
          sessionId: prompt.sessionId,
        });
        const timeout = Math.max(
          0,
          Math.min(this.limits.approvalTimeoutMs, prompt.expiresAt - Date.now()),
        );
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: () => void = () => {};
        const cancelled = new Promise<ApprovalChoice>((resolve) => {
          onAbort = () => resolve('cancel');
          controller.signal.addEventListener('abort', onAbort, { once: true });
          timer = setTimeout(() => controller.abort(), timeout);
        });
        try {
          if (timeout === 0) controller.abort();
          const choice = await Promise.race([
            Promise.resolve().then(() =>
              controller.signal.aborted
                ? ('cancel' as const)
                : (options.approval?.(prompt, controller.signal) ?? 'cancel'),
            ),
            cancelled,
          ]);
          return { choice };
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener('abort', onAbort);
          this.approvalControllers.delete(prompt.approvalId);
        }
      },
      event: (event) => {
        if (this.failure) return;
        if (event.type === 'approval_closed')
          this.approvalControllers.get(event.payload.approvalId)?.controller.abort();
        const buffer = this.attaching.get(event.sessionId);
        if (buffer) {
          try {
            const bytes = Buffer.byteLength(JSON.stringify(event)) + 1;
            this.reserve(bytes);
            buffer.bytes += bytes;
            buffer.events.push(event);
          } catch (error) {
            this.invalidate(error);
          }
          return;
        }
        const cursor = this.cursors.get(event.sessionId);
        if (!cursor || !this.belongs(event, cursor) || event.seq <= cursor.seq) return;
        if (event.seq !== cursor.seq + 1) {
          this.invalidate(new Error('RESYNC_REQUIRED'));
          return;
        }
        cursor.seq = event.seq;
        this.publish(event);
      },
      closed: async () => {
        this.invalidate(new Error('RPC closed'));
      },
    });
  }

  private belongs(event: WireEvent, cursor: Cursor): boolean {
    return (
      event.sessionId === cursor.session &&
      event.streamEpoch === cursor.epoch &&
      event.serverInstanceId === cursor.instance
    );
  }
  private publish(event: WireEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        /* 展示异常不改变协议状态。 */
      }
    }
  }
  private reserve(bytes: number): void {
    if (this.snapshotBytes + bytes > this.limits.maxSnapshotBytes)
      throw new Error('RESOURCE_LIMIT');
    this.snapshotBytes += bytes;
  }
  private invalidate(error: unknown): void {
    this.failure ??= error instanceof Error ? error : new Error('PROTOCOL_MISMATCH');
    for (const entry of this.approvalControllers.values()) entry.controller.abort();
    this.approvalControllers.clear();
    this.attaching.clear();
    this.cursors.clear();
    this.subscribers.clear();
    this.snapshotBytes = 0;
    this.peer?.abort(this.failure);
  }
  private check(signal?: AbortSignal): void {
    if (this.failure) throw this.failure;
    if (signal?.aborted) throw new Error('RPC cancelled');
  }

  /** EOF 或失败时收敛；取消请求的返回不等于会话存储锁释放。 */
  get whenClosed(): Promise<void> {
    return this.peer.done;
  }

  /** 握手失败释放整个连接；成功前不允许业务请求，预算在所有消费点实际生效。 */
  static async connect(
    transport: LocalTransport,
    offer: ProtocolOffer,
    options: LocalClientOptions = {},
  ): Promise<LocalClient> {
    const client = new LocalClient(transport, options);
    try {
      const result = await client.peer.call('initialize', offer);
      client.check();
      client.limits = negotiateLimits(result, offer);
      client.peer.setLimits(client.limits);
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  /** 按原请求返回结果；显式 cursor 为原始续块，无 cursor 为完整快照，失败不安装半份状态。 */
  async call<M extends WireMethod, P extends RequestParams[M]>(
    method: M,
    params: P,
    signal?: AbortSignal,
  ): Promise<ClientResult<M, P>> {
    this.check(signal);
    const sessionId = (params as { sessionId?: string }).sessionId;
    const isAttach = method === 'session/attach';
    const assemble =
      isAttach ||
      (method === 'session/snapshot' &&
        (params as RequestParams['session/snapshot']).cursor === undefined);
    let buffer: Attaching | undefined;
    let assemblingBytes = 0;
    if (isAttach) {
      if (this.attaching.has(sessionId!)) throw new Error('SESSION_BUSY');
      buffer = { events: [], bytes: 0 };
      this.attaching.set(sessionId!, buffer);
    }
    try {
      const raw = await this.peer.call(method, params, signal);
      this.check(signal);
      if (!assemble) return raw as ClientResult<M, P>;
      const metadata = raw as WireSnapshot;
      const expectedInstance = (params as { serverInstanceId?: string }).serverInstanceId;
      if (
        metadata.sessionId !== sessionId ||
        (expectedInstance !== undefined && metadata.serverInstanceId !== expectedInstance)
      )
        throw new Error('RESYNC_REQUIRED');
      let encoded = '';
      let highSurrogate = false;
      const append = (chunk: string) => {
        const first = chunk.charCodeAt(0);
        const bytes =
          Buffer.byteLength(chunk) - (highSurrogate && first >= 0xdc00 && first <= 0xdfff ? 2 : 0);
        this.reserve(bytes);
        assemblingBytes += bytes;
        encoded += chunk;
        if (chunk.length) {
          const last = chunk.charCodeAt(chunk.length - 1);
          highSurrogate = last >= 0xd800 && last <= 0xdbff;
        }
      };
      append(metadata.chunk);
      let cursor = metadata.cursor;
      const seen = new Set<string>();
      while (cursor !== null) {
        if (seen.has(cursor)) throw new Error('RESYNC_REQUIRED');
        seen.add(cursor);
        const page: SnapshotPage = await this.peer.call(
          'session/snapshot',
          { sessionId: sessionId!, cursor },
          signal,
        );
        this.check(signal);
        append(page.chunk);
        cursor = page.cursor;
      }
      const body: unknown = JSON.parse(encoded);
      if (
        !validateSnapshotBody(body) ||
        !body.live.every(
          (event) =>
            event.sessionId === metadata.sessionId &&
            event.streamEpoch === metadata.streamEpoch &&
            event.serverInstanceId === metadata.serverInstanceId,
        )
      )
        throw new Error('Invalid snapshot data');
      const flow: Cursor = {
        session: metadata.sessionId,
        epoch: metadata.streamEpoch,
        instance: metadata.serverInstanceId,
        seq: metadata.seq,
      };
      const replay: WireEvent[] = [];
      if (buffer) {
        for (const event of buffer.events) {
          if (!this.belongs(event, flow) || event.seq <= flow.seq) continue;
          if (event.seq !== flow.seq + 1) throw new Error('RESYNC_REQUIRED');
          flow.seq = event.seq;
          replay.push(event);
        }
      }
      this.check(signal);
      const result: ClientSnapshot = { ...metadata, ...body, chunk: '', cursor: null };
      if (isAttach) {
        this.cursors.set(sessionId!, flow);
        this.attaching.delete(sessionId!);
      }
      // 验证完成后在一个同步段发布；任何缺口都在此前失败，不产生部分回放。
      for (const event of replay) this.publish(event);
      return result as ClientResult<M, P>;
    } catch (error) {
      if (assemble) {
        this.invalidate(error);
        await this.peer.close();
      }
      throw error;
    } finally {
      if (buffer) this.attaching.delete(sessionId!);
      this.snapshotBytes = Math.max(0, this.snapshotBytes - assemblingBytes - (buffer?.bytes ?? 0));
    }
  }

  /** 订阅仅接收已经校验的事件；返回幂等解绑函数，不自动重连。 */
  subscribe(listener: (event: WireEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** 关闭所有请求、审批回调与临时快照；底层读取回调通过 abort 发起关闭，避免等待自身。 */
  async close(): Promise<void> {
    this.invalidate(new Error('RPC closed'));
    await this.peer.close();
  }
}
