import { Buffer } from 'node:buffer';
import {
  DEFAULT_LIMITS,
  type EventPayloads,
  type WireEvent,
  validateEvent,
} from '../protocol/index.js';

/** 发布输入不接受外部 sequence，避免调用者伪造流身份与水位。 */
export type EventChange = {
  [E in keyof EventPayloads]: { type: E; payload: EventPayloads[E]; runId?: string };
}[keyof EventPayloads];

/**
 * 单会话实时事件扇出与水位；不保留可重放事件，重连一律通过快照重建。
 * 订阅、快照水位捕获须由宿主在同一同步段内完成；慢订阅者由传输层断开，
 * 观察者异常不改变已发布事件或其他订阅者。
 */
export class SessionEventFeed {
  private readonly subscribers = new Set<(event: WireEvent) => void>();
  private sequence = 0;

  constructor(
    readonly serverInstanceId: string,
    readonly sessionId: string,
    readonly streamEpoch: string,
  ) {}

  /** 水位在发布时递增，任何无效投影均在递增前失败。 */
  get highWaterMark(): number {
    return this.sequence;
  }

  /** JSON 克隆隔离调用者后续修改；每个订阅者获得独立数据。 */
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
    const event = JSON.parse(encoded) as WireEvent;
    for (const subscriber of [...this.subscribers]) {
      try {
        subscriber(JSON.parse(encoded));
      } catch {
        /* 观察者不能破坏事件的单调性。 */
      }
    }
    return JSON.parse(encoded);
  }

  /** 返回幂等取消句柄；调用者关闭连接时必须解绑。 */
  subscribe(listener: (event: WireEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }
}
