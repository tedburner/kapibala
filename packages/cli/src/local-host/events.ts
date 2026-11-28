import { Buffer } from 'node:buffer';
import {
  DEFAULT_LIMITS,
  type EventPayloads,
  type WireEvent,
  validateEvent,
} from '@kiturone/kapibala-host/protocol';

/** 发布输入不接受外部 sequence，避免调用者伪造流身份与水位。 */
export type EventChange = {
  [E in keyof EventPayloads]: { type: E; payload: EventPayloads[E]; runId?: string };
}[keyof EventPayloads];

const RETRY_EVENT_TYPES = new Set<WireEvent['type']>(['stream_reset', 'retry_scheduled']);

/** 判定事件是否属于仅向声明 `'retry'` 能力的客户端下发的重试扩展帧。 */
export function isRetryWireEvent(event: Pick<WireEvent, 'type'>): boolean {
  return RETRY_EVENT_TYPES.has(event.type);
}

/**
 * 单会话实时事件扇出与双轨水位；不保留可重放事件，重连一律通过快照重建。
 *
 * 兼容性保证：
 * - `sequence` 统计全量事件（供协商了 `'retry'` 能力的连接使用）；
 * - `baseSequence` 仅统计非 `'retry'` 事件（供未声明 `'retry'` 的连接使用），
 *   确保过滤掉 `stream_reset` / `retry_scheduled` 后旧客户端收到的 `seq` 严格连续无缺口。
 */
export class SessionEventFeed {
  private readonly subscribers = new Map<(event: WireEvent) => void, { includeRetry: boolean }>();
  private sequence = 0;
  private baseSequence = 0;

  constructor(
    readonly serverInstanceId: string,
    readonly sessionId: string,
    readonly streamEpoch: string,
  ) {}

  /** 全量事件最高水位；在发布校验通过后递增。 */
  get highWaterMark(): number {
    return this.sequence;
  }

  /** 按连接是否启用 `'retry'` 能力读取对应连续序号水位。 */
  highWaterMarkFor(includeRetry: boolean): number {
    return includeRetry ? this.sequence : this.baseSequence;
  }

  /** JSON 克隆隔离调用者后续修改；每个订阅者获得与其能力匹配的独立序号帧。 */
  publish(change: EventChange): WireEvent {
    const candidate = {
      ...change,
      serverInstanceId: this.serverInstanceId,
      sessionId: this.sessionId,
      streamEpoch: this.streamEpoch,
      seq: this.sequence + 1,
    };
    const validated = validateEvent(candidate);
    if (!validated.ok) throw new Error('Invalid public event');
    const encoded = JSON.stringify(validated.value);
    const bytes = Buffer.byteLength(encoded);
    if (bytes > DEFAULT_LIMITS.maxFrameBytes - 128)
      throw new Error('Event requires bounded projection');
    this.sequence++;
    const isRetry = isRetryWireEvent(validated.value);
    if (!isRetry) this.baseSequence++;
    const baseEncoded =
      !isRetry && this.baseSequence !== this.sequence
        ? JSON.stringify({ ...validated.value, seq: this.baseSequence })
        : encoded;
    for (const [subscriber, options] of [...this.subscribers.entries()]) {
      if (isRetry && !options.includeRetry) continue;
      try {
        subscriber(JSON.parse(options.includeRetry ? encoded : baseEncoded));
      } catch {
        /* 观察者不能破坏事件的单调性。 */
      }
    }
    return JSON.parse(encoded);
  }

  /** 返回幂等取消句柄；`includeRetry = false` 时屏蔽重试帧并映射连续基线序号。 */
  subscribe(
    listener: (event: WireEvent) => void,
    options?: { includeRetry?: boolean },
  ): () => void {
    this.subscribers.set(listener, { includeRetry: options?.includeRetry ?? true });
    return () => {
      this.subscribers.delete(listener);
    };
  }
}
