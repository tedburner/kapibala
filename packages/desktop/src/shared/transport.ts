import { z } from 'zod';
import { LIMITS, encodedBytes } from './contracts.js';

const frameSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('ack'),
      hostInstanceId: z.string(),
      controlEpoch: z.number().int(),
      lane: z.enum(['data', 'control']),
      sequence: z.number().int().nonnegative(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('payload'),
      hostInstanceId: z.string(),
      controlEpoch: z.number().int(),
      lane: z.enum(['data', 'control']),
      sequence: z.number().int().positive(),
      body: z.unknown(),
    })
    .strict(),
]);
/** 每一跳各自持有的控制身份，旧连接消息不释放当前额度或改变状态。 */
export interface ControlIdentity {
  hostInstanceId: string;
  controlEpoch: number;
}
/** 正文和控制各有独立序号、队列和接收串行链，停止不会排在快照后面。 */
export type Lane = 'data' | 'control';
interface Pending {
  bytes: number;
  resolve(): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}
interface LaneState {
  sent: number;
  received: number;
  acked: number;
  bytes: number;
  incoming: number;
  pending: Map<number, Pending>;
  chain: Promise<void>;
}
const laneState = (): LaneState => ({
  sent: 0,
  received: 0,
  acked: 0,
  bytes: 0,
  incoming: 0,
  pending: new Map(),
  chain: Promise.resolve(),
});

/** 有界 JSON 传输；postMessage 没有背压，额度仅由当前代次的连续接收 ACK 释放。 */
export class BoundedPeer {
  private readonly lanes = { data: laneState(), control: laneState() };
  private closed = false;
  constructor(
    private readonly identity: ControlIdentity,
    private readonly post: (frame: string) => void,
    private readonly consume: (body: unknown, lane: Lane) => void | Promise<void>,
    private readonly onClose: (reason: string) => void = () => {},
  ) {}

  /** 额度不足立即拒绝，不在内存堆积任意多个发送请求；快照生产者逐块等待 ACK。 */
  send(body: unknown, lane: Lane = 'data'): Promise<void> {
    if (this.closed) return Promise.reject(new Error('CONTROL_CLOSED'));
    const state = this.lanes[lane];
    const frame = JSON.stringify({
      ...this.identity,
      kind: 'payload',
      lane,
      sequence: state.sent + 1,
      body,
    });
    const bytes = encodedBytes(frame);
    const window = lane === 'data' ? LIMITS.dataWindow : LIMITS.controlWindow;
    if (
      bytes > (lane === 'data' ? LIMITS.frame : LIMITS.controlWindow) ||
      state.bytes + bytes > window
    )
      return Promise.reject(new Error('OUTPUT_CONGESTED'));
    const sequence = ++state.sent;
    state.bytes += bytes;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => this.close('ACK_TIMEOUT'), LIMITS.requestTimeout);
      state.pending.set(sequence, { bytes, resolve, reject, timer });
      try {
        this.post(frame);
      } catch {
        this.close('POST_FAILED');
      }
    });
  }

  /** 仅接受有界字符串；当前代次乱序或非法 ACK 关闭通道，旧代次直接丢弃。 */
  async receive(raw: unknown): Promise<void> {
    if (this.closed) return;
    try {
      if (typeof raw !== 'string' || encodedBytes(raw) > LIMITS.frame)
        throw new Error('INVALID_FRAME');
      const frame = frameSchema.parse(JSON.parse(raw));
      if (
        frame.hostInstanceId !== this.identity.hostInstanceId ||
        frame.controlEpoch !== this.identity.controlEpoch
      )
        return;
      const state = this.lanes[frame.lane];
      if (frame.kind === 'ack') {
        if (frame.sequence < state.acked || frame.sequence > state.sent)
          throw new Error('INVALID_ACK');
        for (const [sequence, pending] of state.pending) {
          if (sequence > frame.sequence) break;
          state.pending.delete(sequence);
          state.bytes -= pending.bytes;
          clearTimeout(pending.timer);
          pending.resolve();
        }
        state.acked = frame.sequence;
        return;
      }
      const bytes = encodedBytes(raw);
      const window = frame.lane === 'data' ? LIMITS.dataWindow : LIMITS.controlWindow;
      if (
        frame.sequence !== state.received + 1 ||
        state.incoming + bytes > window ||
        (frame.lane === 'control' && bytes > LIMITS.controlWindow)
      )
        throw new Error('INVALID_SEQUENCE');
      state.received = frame.sequence;
      state.incoming += bytes;
      state.chain = state.chain
        .then(async () => {
          if (this.closed) return;
          await this.consume(frame.body, frame.lane);
          state.incoming -= bytes;
          if (!this.closed)
            this.post(
              JSON.stringify({
                ...this.identity,
                kind: 'ack',
                lane: frame.lane,
                sequence: frame.sequence,
              }),
            );
        })
        .catch(() => this.close('INVALID_PAYLOAD'));
      await state.chain;
    } catch (error) {
      this.close(
        error instanceof Error && ['INVALID_ACK', 'INVALID_SEQUENCE'].includes(error.message)
          ? error.message
          : 'INVALID_FRAME',
      );
    }
  }

  /** 用于验证或诊断的数字事实，不输出队列中的正文或凭证。 */
  pendingBytes(lane: Lane): number {
    return this.lanes[lane].bytes;
  }

  /** 幂等结束全部待发承诺；调用方在此回调中撤销审批并等待实际工具清理。 */
  close(reason = 'CONTROL_CLOSED'): void {
    if (this.closed) return;
    this.closed = true;
    for (const state of Object.values(this.lanes)) {
      for (const pending of state.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error(reason));
      }
      state.pending.clear();
      state.bytes = 0;
    }
    this.onClose(reason);
  }
}
