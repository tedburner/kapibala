import fs from 'node:fs';
import path from 'node:path';
import type { CanonicalMessage } from '../types/index.js';
import { type HistoryRepair, createMessageId, normalizeHistory } from './history.js';
import { readJsonlLines, syncSessionDirectory } from './jsonl-lines.js';
import type { MessageStore } from './store/index.js';

export const SESSION_SCHEMA_VERSION = 1;
export type SessionRecordType =
  | 'header'
  | 'message'
  | 'run_started'
  | 'run_finished'
  | 'message_state'
  | 'history_repair'
  | 'usage'
  | 'checkpoint'
  | 'context_pruned'
  | 'compaction_state'
  | 'title'
  | 'reset'
  | 'legacy_import';

export interface SessionHeader {
  conversationId: string;
  projectRoot: string;
  initialCwd: string;
  createdAt?: number;
  gitBranch?: string;
  importIdentity?: string;
}

export interface SessionRecord {
  schemaVersion: number;
  type: SessionRecordType;
  recordId: string;
  timestamp: number;
  parentId: string | null;
  payload: Record<string, unknown>;
}

export interface SessionState {
  header: SessionHeader;
  /** 最近 reset 之后的记录；包含正文及状态，不包含头部。 */
  records: SessionRecord[];
  /** 只随正文、修复与 reset 改变，不因 usage 或缓存写入失效。 */
  contentRevision: string;
}

/** MessageStore 的可选状态能力；旧 SDK Store 不需要实现，宿主据此降级持久压缩。 */
export interface StatefulMessageStore extends MessageStore {
  appendRecord(
    type: Exclude<SessionRecordType, 'header' | 'message'>,
    payload: Record<string, unknown>,
  ): Promise<SessionRecord>;
  loadState(): Promise<SessionState>;
}

const types = new Set<SessionRecordType>([
  'header',
  'message',
  'run_started',
  'run_finished',
  'message_state',
  'history_repair',
  'usage',
  'checkpoint',
  'context_pruned',
  'compaction_state',
  'title',
  'reset',
  'legacy_import',
]);

/** 判断 Store 是否支持版本化状态；不读取数据或改变旧 Store。 */
export function supportsSessionState(store: MessageStore): store is StatefulMessageStore {
  return (
    'appendRecord' in store &&
    typeof store.appendRecord === 'function' &&
    'loadState' in store &&
    typeof store.loadState === 'function'
  );
}

/**
 * 版本化消息与上下文状态的单文件存储。所有写入串行并 fsync，失败后拒绝继续写入。
 * 调用者须在打开前取得单写者锁；本类不允许静默跳过中部损坏或重复身份。
 */
export class SessionStore implements StatefulMessageStore {
  readonly filePath: string;
  private queue: Promise<unknown> = Promise.resolve();
  private records: SessionRecord[] = [];
  private observer?: (record: SessionRecord) => void;
  private onDiagnostic?: (message: string) => void;
  private stamp?: { size: number; mtimeMs: number; ino: number };

  private constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
  }

  /** 注册可重建缓存的写后通知；缓存失败只诊断，不撤销或毒化已 fsync 的正文。 */
  setAppendObserver(
    observer: (record: SessionRecord) => void,
    onDiagnostic?: (message: string) => void,
  ): void {
    this.observer = observer;
    this.onDiagnostic = onDiagnostic;
  }

  /** 以独占创建方式安装新头部，已有文件明确失败，绝不覆盖其它会话。 */
  static async create(filePath: string, header: SessionHeader): Promise<SessionStore> {
    const store = new SessionStore(filePath);
    fs.mkdirSync(path.dirname(store.filePath), { recursive: true });
    const record = store.makeRecord('header', {
      ...header,
      createdAt: header.createdAt ?? Date.now(),
    });
    const fd = fs.openSync(store.filePath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    syncSessionDirectory(path.dirname(store.filePath));
    store.records = [record];
    store.refreshStamp();
    return store;
  }

  /** 打开并验证已有会话；尾部残片先保存到隔离文件，中部损坏与未知版本拒绝恢复。 */
  static async open(filePath: string): Promise<SessionStore> {
    const store = new SessionStore(filePath);
    store.records = store.readFile(true);
    store.refreshStamp();
    return store;
  }

  /** 获取完整记录快照，等候已排队写入后读取；调用者不能借此修改内部记录。 */
  async readRecords(): Promise<SessionRecord[]> {
    // 写失败毒化只应拒绝后续追加；读取必须继续可用，否则释放锁前的回读会把
    // 瞬时存储故障放大成「锁无法释放、活进程内会话被永久占用」。
    await this.queue.catch(() => undefined);
    this.records = this.readFile(false);
    this.refreshStamp();
    return structuredClone(this.records);
  }

  /** 消息级持久化，补稳定身份并保留所有终态字段，成功后方可进入下一次写入。 */
  async append(message: CanonicalMessage): Promise<void> {
    const payload = { ...structuredClone(message), id: message.id ?? createMessageId() };
    await this.enqueue('message', payload);
    // 为已有 SDK 以同一对象进入内存历史的模式补身份；正文始终独立复制。
    message.id ??= payload.id;
  }

  /** 持久化状态记录，fsync 成功才返回；失败会毒化当前写者，要求重新验证后恢复。 */
  async appendRecord(
    type: Exclude<SessionRecordType, 'header' | 'message'>,
    payload: Record<string, unknown>,
  ): Promise<SessionRecord> {
    return this.enqueue(type, structuredClone(payload));
  }

  /** 重建 reset 后的状态；统计记录和检查点不会推进正文 revision。 */
  async loadState(): Promise<SessionState> {
    const all = await this.readRecords();
    const reset = all.map((r) => r.type).lastIndexOf('reset');
    const records = all.slice(Math.max(1, reset + 1));
    const content = all
      .filter((r) => ['message', 'history_repair', 'message_state', 'reset'].includes(r.type))
      .at(-1);
    return {
      header: structuredClone(all[0].payload) as unknown as SessionHeader,
      records,
      contentRevision: content?.recordId ?? all[0].recordId,
    };
  }

  /**
   * 恢复原始正文，并将幂等修复叠加到原工具事务；不合并连续消息，也不执行工具。
   * 缺失结果用 history_repair 落盘，独立于实际工具结果和正文，不伪造成功。
   */
  async load(): Promise<CanonicalMessage[]> {
    const state = await this.loadState();
    const raw = state.records
      .filter((r) => r.type === 'message')
      .map((r) => structuredClone(r.payload) as unknown as CanonicalMessage);
    for (const record of state.records.filter((r) => r.type === 'message_state')) {
      const message = raw.find((m) => m.id === record.payload.messageId);
      if (message) message.state = record.payload.state as CanonicalMessage['state'];
    }
    const repairs = state.records
      .filter((r) => r.type === 'history_repair')
      .map((r) => r.payload as unknown as HistoryRepair);
    const overlay = () => {
      const messages: CanonicalMessage[] = [];
      for (let i = 0; i < raw.length; i++) {
        const message = raw[i];
        messages.push(message);
        if (message.role !== 'assistant') continue;
        const associated = repairs.filter((r) => r.assistantId === message.id);
        if (!associated.length) continue;
        const realIds = new Set<string>();
        while (raw[i + 1]?.role === 'tool') {
          const tool = raw[++i];
          messages.push(tool);
          for (const b of tool.content) if (b.type === 'tool_result') realIds.add(b.toolUseId);
        }
        const missing = associated.filter((r) => !realIds.has(r.toolCallId));
        if (missing.length)
          messages.push({
            id: `repair-${message.id}`,
            role: 'tool',
            timestamp: message.timestamp,
            content: missing.map((r) => structuredClone(r.result)),
          });
      }
      return messages;
    };
    const normalized = normalizeHistory(overlay());
    for (const repair of normalized.repairs) {
      if (
        !repairs.some(
          (r) => r.assistantId === repair.assistantId && r.toolCallId === repair.toolCallId,
        )
      ) {
        await this.appendRecord('history_repair', { ...repair });
        repairs.push(repair);
      }
    }
    return overlay();
  }

  /** SDK 清空语义通过持久边界实现；此前摘要、剪裁及失败状态不再参与恢复。 */
  async clear(): Promise<void> {
    await this.appendRecord('reset', {});
  }

  /** 生成前驱关联的 Envelope，前驱仅表达追加次序，未来 DAG 不改变当前恢复规则。 */
  private makeRecord(type: SessionRecordType, payload: Record<string, unknown>): SessionRecord {
    return {
      schemaVersion: SESSION_SCHEMA_VERSION,
      type,
      recordId: createMessageId(),
      timestamp: Date.now(),
      parentId: this.records.at(-1)?.recordId ?? null,
      payload,
    };
  }

  /** 单写者队列不吞异常；后续写入依赖同一失败 Promise，防止继续污染正文。 */
  private enqueue(
    type: SessionRecordType,
    payload: Record<string, unknown>,
  ): Promise<SessionRecord> {
    const operation = this.queue.then(() => {
      if (
        type === 'message' &&
        this.records.some((r) => r.type === 'message' && r.payload.id === payload.id)
      ) {
        throw new Error(`Duplicate message ID: ${payload.id}`);
      }
      const stat = fs.statSync(this.filePath);
      if (
        !this.stamp ||
        stat.size !== this.stamp.size ||
        stat.mtimeMs !== this.stamp.mtimeMs ||
        stat.ino !== this.stamp.ino
      )
        throw new Error('Session changed outside this writer; reopen under a lock');
      const record = this.makeRecord(type, payload);
      const fd = fs.openSync(this.filePath, 'a');
      try {
        fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      this.records.push(record);
      this.refreshStamp();
      try {
        this.observer?.(structuredClone(record));
      } catch {
        try {
          this.onDiagnostic?.('Session metadata update failed; the durable record is preserved');
        } catch {
          /* 诊断不影响正文。 */
        }
      }
      return structuredClone(record);
    });
    this.queue = operation;
    return operation;
  }

  /** 保存当前写者的正文版本，拒绝未经锁保护的第二写者继续追加。 */
  private refreshStamp(): void {
    const stat = fs.statSync(this.filePath);
    this.stamp = { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
  }

  /** 校验每个完整记录，只有最后非空行的 JSON 残片可隔离，语义损坏绝不作为残片吞掉。 */
  private readFile(recover: boolean): SessionRecord[] {
    const iterator = readJsonlLines(this.filePath);
    let lastTerminated = true;
    let blankSeen = false;
    const records: SessionRecord[] = [];
    const identities = new Set<string>();
    const messages = new Set<string>();
    let i = -1;
    for (const line of iterator) {
      i++;
      lastTerminated = line.terminated;
      if (!line.text.trim()) {
        blankSeen = true;
        continue;
      }
      if (blankSeen) throw new Error(`Session corrupt at line ${i + 1}`);
      let record: SessionRecord;
      try {
        record = JSON.parse(line.text);
      } catch {
        if (!recover || !records.length || Array.from(iterator).some((next) => next.text.trim()))
          throw new Error(`Session corrupt at line ${i + 1}`);
        fs.writeFileSync(
          `${this.filePath}.corrupt-${createMessageId()}`,
          line.text + (line.terminated ? '\n' : ''),
          { flag: 'wx' },
        );
        const fd = fs.openSync(this.filePath, 'r+');
        try {
          fs.ftruncateSync(fd, line.offset);
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        break;
      }
      if (!record || record.schemaVersion !== SESSION_SCHEMA_VERSION)
        throw new Error('Unsupported session schema version');
      if (
        !types.has(record.type) ||
        typeof record.recordId !== 'string' ||
        !record.recordId ||
        !Number.isFinite(record.timestamp) ||
        !record.payload ||
        typeof record.payload !== 'object' ||
        Array.isArray(record.payload) ||
        (record.parentId !== null && typeof record.parentId !== 'string')
      )
        throw new Error(`Session corrupt at line ${i + 1}`);
      if (identities.has(record.recordId))
        throw new Error(`Duplicate record ID: ${record.recordId}`);
      if (record.parentId !== (records.at(-1)?.recordId ?? null))
        throw new Error(`Session corrupt parent at line ${i + 1}`);
      identities.add(record.recordId);
      if (record.type === 'message') {
        if (
          typeof record.payload.id !== 'string' ||
          !['user', 'assistant', 'system', 'tool'].includes(String(record.payload.role)) ||
          !Array.isArray(record.payload.content)
        )
          throw new Error(`Session corrupt message at line ${i + 1}`);
        if (messages.has(record.payload.id))
          throw new Error(`Duplicate message ID: ${record.payload.id}`);
        messages.add(record.payload.id);
      }
      if (record.type === 'header' && records.length)
        throw new Error('Session corrupt: repeated header');
      records.push(record);
    }
    if (
      records[0]?.type !== 'header' ||
      typeof records[0].payload.conversationId !== 'string' ||
      typeof records[0].payload.projectRoot !== 'string' ||
      typeof records[0].payload.initialCwd !== 'string'
    )
      throw new Error('Session corrupt header');
    if (recover && !lastTerminated && records.length === i + 1) {
      const fd = fs.openSync(this.filePath, 'a');
      try {
        fs.writeFileSync(fd, '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    return records;
  }
}
