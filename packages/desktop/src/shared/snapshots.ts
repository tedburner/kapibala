import type { PresentationState } from '@kiturone/kapibala-host/view-model';
import {
  LIMITS,
  NOTIFICATION,
  type Notification,
  PresentationStateSchema,
  encodedBytes,
} from './contracts.js';

type Chunk = Extract<Notification, { type: 'presentation.chunk' }>;
/** 按真实 UTF-8 边界分块；不截断中文/emoji，也不把编码字节预算误当作字符预算。 */
export function* snapshotChunks(
  scope: { workspaceId: string; sessionId: string; subscriptionId: string },
  snapshotId: string,
  state: PresentationState,
): Generator<Chunk> {
  const source = new TextEncoder().encode(JSON.stringify(PresentationStateSchema.parse(state)));
  if (source.length > LIMITS.snapshot) throw new Error('SNAPSHOT_TOO_LARGE');
  const parts: string[] = [];
  for (let start = 0; start < source.length; ) {
    let end = Math.min(start + LIMITS.chunk, source.length);
    while (end < source.length && (source[end] & 0xc0) === 0x80) end--;
    parts.push(new TextDecoder().decode(source.subarray(start, end)));
    start = end;
  }
  for (let index = 0; index < parts.length; index++)
    yield {
      ...scope,
      type: 'presentation.chunk',
      snapshotId,
      index,
      count: parts.length,
      totalBytes: source.length,
      sequence: state.sequence,
      data: parts[index],
    };
}

/** 暂存一份有界快照；完整校验成功才返回可安装状态，失败不留下半份展示。 */
export class SnapshotAssembler {
  private pending?: { first: Chunk; parts: string[]; bytes: number };
  /** 接收 ACK 应在本方法校验通过后发送；安装确认由调用方在状态替换后单独发送。 */
  accept(raw: unknown): PresentationState | undefined {
    try {
      return this.acceptValidated(raw);
    } catch (error) {
      this.reset();
      throw error;
    }
  }
  private acceptValidated(raw: unknown): PresentationState | undefined {
    const parsed = NOTIFICATION.parse(raw);
    if (parsed.type !== 'presentation.chunk') throw new Error('INVALID_CHUNK');
    const chunk = parsed;
    if (chunk.index === 0) {
      if (this.pending) throw new Error('SNAPSHOT_OVERLAP');
      this.pending = { first: chunk, parts: [], bytes: 0 };
    }
    const current = this.pending;
    if (
      !current ||
      chunk.index !== current.parts.length ||
      chunk.snapshotId !== current.first.snapshotId ||
      chunk.subscriptionId !== current.first.subscriptionId ||
      chunk.workspaceId !== current.first.workspaceId ||
      chunk.sessionId !== current.first.sessionId ||
      chunk.count !== current.first.count ||
      chunk.sequence !== current.first.sequence ||
      chunk.totalBytes !== current.first.totalBytes
    ) {
      this.reset();
      throw new Error('INVALID_CHUNK_ORDER');
    }
    const bytes = encodedBytes(chunk.data);
    if (
      bytes > LIMITS.chunk ||
      current.bytes + bytes > chunk.totalBytes ||
      current.bytes + bytes > LIMITS.snapshot
    ) {
      this.reset();
      throw new Error('SNAPSHOT_TOO_LARGE');
    }
    current.parts.push(chunk.data);
    current.bytes += bytes;
    if (current.parts.length !== chunk.count) return;
    this.pending = undefined;
    if (current.bytes !== chunk.totalBytes) throw new Error('SNAPSHOT_LENGTH_MISMATCH');
    const state = PresentationStateSchema.parse(JSON.parse(current.parts.join('')));
    if (state.sequence !== chunk.sequence) throw new Error('SNAPSHOT_IDENTITY_MISMATCH');
    return state;
  }
  /** 控制连接或订阅变化后丢弃旧暂存，不对失败快照自动无限重试。 */
  reset(): void {
    this.pending = undefined;
  }
}
