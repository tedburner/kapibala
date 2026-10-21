import { DEFAULT_LIMITS } from '../protocol/index.js';
import type {
  ApprovalChoice,
  ApprovalPrompt,
  JsonValue,
  ProtocolOffer,
  RequestParams,
  WireEvent,
  WireMethod,
} from '../protocol/index.js';
import { RpcPeer } from '../transport/rpc.js';
import type { LocalTransport } from '../transport/types.js';

/** 客户端的人工审批入口；缺省拒绝，不能从模型输出自动推导允许。 */
export interface LocalClientOptions {
  approval?(request: ApprovalPrompt, signal: AbortSignal): Promise<ApprovalChoice>;
}

/** 客户端自身分配内存/并发的预算；服务端只能收紧，放大值视为不兼容。 */
const CRITICAL_LIMITS = [
  'maxFrameBytes',
  'maxInflightRequests',
  'maxSnapshotBytes',
  'maxSendQueueBytes',
] as const;

/**
 * 初始化响应必须覆盖客户端声明的全部能力，并给出可用的有界预算。
 * 只返回结构校验结果，错误消息固定为 PROTOCOL_MISMATCH，不回显对端内容。
 */
function isCompatibleInitialization(result: JsonValue, offer: ProtocolOffer): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false;
  const data = result as Record<string, unknown>;
  if (data.major !== 1 || data.minor !== 0) return false;
  if (typeof data.serverInstanceId !== 'string' || typeof data.clientId !== 'string') return false;
  const capabilities = data.capabilities;
  if (
    !Array.isArray(capabilities) ||
    capabilities.some((entry) => typeof entry !== 'string') ||
    !offer.capabilities.every((entry) => capabilities.includes(entry))
  )
    return false;
  const limits = data.limits;
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return false;
  const values = Object.entries(limits);
  if (!values.every(([, value]) => Number.isSafeInteger(value) && (value as number) > 0))
    return false;
  return CRITICAL_LIMITS.every((key) => {
    const value = (limits as Record<string, unknown>)[key];
    return typeof value === 'number' && value <= DEFAULT_LIMITS[key];
  });
}

/**
 * Node 本地客户端；导入不启动 CLI、不读取配置，连接必须由调用者显式提供。
 * 不在断线时自动重发写请求，事件缺号交给订阅者显式重新 attach。
 */
export class LocalClient {
  private readonly peer: RpcPeer;
  private readonly attaching = new Map<string, WireEvent[]>();
  private readonly approvalControllers = new Map<string, AbortController>();
  private readonly subscribers = new Set<(event: WireEvent) => void>();
  private readonly cursors = new Map<string, { epoch: string; instance: string; seq: number }>();
  private constructor(transport: LocalTransport, options: LocalClientOptions) {
    this.peer = new RpcPeer(transport, {
      prefix: 'c',
      request: async (request) => {
        if (request.method !== 'approval/request') throw new Error('UNAUTHORIZED');
        const controller = new AbortController();
        this.approvalControllers.set(request.params.approvalId, controller);
        try {
          return {
            choice: (await options.approval?.(request.params, controller.signal)) ?? 'cancel',
          };
        } finally {
          this.approvalControllers.delete(request.params.approvalId);
        }
      },
      event: (event) => {
        if (event.type === 'approval_closed')
          this.approvalControllers.get(event.payload.approvalId)?.abort();
        const buffered = this.attaching.get(event.sessionId);
        if (buffered) {
          if (Buffer.byteLength(JSON.stringify(buffered)) > DEFAULT_LIMITS.maxSnapshotBytes) {
            void this.close();
            return;
          }
          buffered.push(event);
          return;
        }
        this.applyEvent(event);
      },
    });
  }

  private applyEvent(event: WireEvent): void {
    const cursor = this.cursors.get(event.sessionId);
    if (
      !cursor ||
      cursor.epoch !== event.streamEpoch ||
      cursor.instance !== event.serverInstanceId ||
      event.seq <= cursor.seq
    )
      return;
    if (event.seq !== cursor.seq + 1) {
      this.cursors.delete(event.sessionId);
      void this.close();
      return;
    }
    cursor.seq = event.seq;
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch {
        /* 展示异常不改变 wire。 */
      }
    }
  }

  /** 对端 EOF 或连接失败时收敛，宿主据此结束等待终态而非永久挂起。 */
  get whenClosed(): Promise<void> {
    return this.peer.done;
  }

  /** 初始化失败回收所有请求和输入订阅；不执行任何会话操作。 */
  static async connect(
    transport: LocalTransport,
    offer: ProtocolOffer,
    options: LocalClientOptions = {},
  ): Promise<LocalClient> {
    const client = new LocalClient(transport, options);
    try {
      const result = await client.peer.call('initialize', offer);
      if (!isCompatibleInitialization(result, offer)) throw new Error('PROTOCOL_MISMATCH');
      return client;
    } catch (error) {
      await client.close();
      throw error;
    }
  }

  /** 显式 RPC，不将客户端超时解释为服务端未执行。 */
  async call<M extends WireMethod>(
    method: M,
    params: RequestParams[M],
    signal?: AbortSignal,
  ): Promise<JsonValue> {
    const attachingId =
      method === 'session/attach'
        ? (params as RequestParams['session/attach']).sessionId
        : undefined;
    if (attachingId) {
      if (this.attaching.has(attachingId)) throw new Error('SESSION_BUSY');
      this.attaching.set(attachingId, []);
    }
    let result: JsonValue;
    try {
      result = await this.peer.call(method, params, signal);
    } catch (error) {
      if (attachingId) this.attaching.delete(attachingId);
      throw error;
    }
    if (
      (method === 'session/attach' || method === 'session/snapshot') &&
      result &&
      typeof result === 'object' &&
      !Array.isArray(result) &&
      typeof result.chunk === 'string'
    ) {
      try {
        const sessionId = (params as RequestParams['session/snapshot']).sessionId;
        const metadata = result;
        let encoded = metadata.chunk as string;
        let cursor = metadata.cursor;
        const seen = new Set<string>();
        while (typeof cursor === 'string') {
          if (seen.has(cursor) || Buffer.byteLength(encoded) > DEFAULT_LIMITS.maxSnapshotBytes)
            throw new Error('RESYNC_REQUIRED');
          seen.add(cursor);
          const page = await this.peer.call('session/snapshot', { sessionId, cursor }, signal);
          if (
            !page ||
            typeof page !== 'object' ||
            Array.isArray(page) ||
            typeof page.chunk !== 'string'
          )
            throw new Error('Invalid snapshot page');
          encoded += page.chunk;
          cursor = page.cursor;
        }
        if (cursor !== null || Buffer.byteLength(encoded) > DEFAULT_LIMITS.maxSnapshotBytes)
          throw new Error('Invalid snapshot budget');
        const data = JSON.parse(encoded);
        if (!data || !Array.isArray(data.history) || !Array.isArray(data.live))
          throw new Error('Invalid snapshot data');
        result = { ...metadata, history: data.history, live: data.live, chunk: '', cursor: null };
      } catch (error) {
        if (attachingId) this.attaching.delete(attachingId);
        await this.close();
        throw error;
      }
    }
    if (
      method === 'session/attach' &&
      result &&
      typeof result === 'object' &&
      !Array.isArray(result)
    ) {
      if (
        typeof result.sessionId !== 'string' ||
        typeof result.streamEpoch !== 'string' ||
        typeof result.serverInstanceId !== 'string' ||
        typeof result.seq !== 'number' ||
        !Number.isSafeInteger(result.seq)
      )
        throw new Error('Invalid snapshot');
      this.cursors.set(result.sessionId, {
        epoch: result.streamEpoch,
        instance: result.serverInstanceId,
        seq: result.seq,
      });
    }
    if (attachingId) {
      const buffered = this.attaching.get(attachingId) ?? [];
      this.attaching.delete(attachingId);
      for (const event of buffered) this.applyEvent(event);
    }
    return result;
  }

  /** 只订阅公开事件；返回幂等解绑函数，不自动恢复控制权或任务。 */
  subscribe(listener: (event: WireEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** 释放关联请求、定时器和订阅，主动关闭不会尝试取消别的客户端任务。 */
  async close(): Promise<void> {
    for (const controller of this.approvalControllers.values()) controller.abort();
    this.approvalControllers.clear();
    this.attaching.clear();
    this.subscribers.clear();
    this.cursors.clear();
    await this.peer.close();
  }
}
