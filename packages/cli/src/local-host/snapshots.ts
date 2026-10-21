import { randomUUID } from 'node:crypto';
import { DEFAULT_LIMITS, type JsonValue } from '../protocol/index.js';

/** 分块属于同一个不可变快照，cursor 是修订加位置，不能跨会话复用。 */
export interface SnapshotPage {
  chunk: string;
  cursor: string | null;
}

/** 每连接有界快照缓存；新快照使同会话旧游标失效，不静默截断历史或大消息。 */
export class SnapshotPager {
  private readonly snapshots = new Map<
    string,
    { revision: string; encoded: string; bytes: number }
  >();

  /** 捕获逻辑快照后只读取冻结字符串；总连接内存超限明确失败。 */
  capture(sessionId: string, snapshot: JsonValue): SnapshotPage {
    const encoded = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(encoded);
    const retained = [...this.snapshots.entries()].reduce(
      (sum, [key, value]) => sum + (key === sessionId ? 0 : value.bytes),
      0,
    );
    if (bytes + retained > DEFAULT_LIMITS.maxSnapshotBytes) throw new Error('RESOURCE_LIMIT');
    const revision = randomUUID();
    this.snapshots.set(sessionId, { revision, encoded, bytes });
    return this.read(sessionId, `${revision}:0`);
  }

  /** 单块最多 64Ki UTF-16 码元，二次 JSON 编码后仍远小于 1MiB 帧上限。 */
  read(sessionId: string, cursor: string): SnapshotPage {
    const snapshot = this.snapshots.get(sessionId);
    const match = /^([a-f0-9-]+):(\d+)$/.exec(cursor);
    const offset = match ? Number(match[2]) : -1;
    if (
      !snapshot ||
      !match ||
      match[1] !== snapshot.revision ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset >= snapshot.encoded.length
    )
      throw new Error('RESYNC_REQUIRED');
    const end = Math.min(offset + 65536, snapshot.encoded.length);
    return {
      chunk: snapshot.encoded.slice(offset, end),
      cursor: end < snapshot.encoded.length ? `${snapshot.revision}:${end}` : null,
    };
  }

  /** detach/close 后释放对应快照，连接断开后整个实例随宿主连接回收。 */
  forget(sessionId: string): void {
    this.snapshots.delete(sessionId);
  }
}
