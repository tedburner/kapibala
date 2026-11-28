import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { SessionWorktreeBinding } from '@kiturone/kapibala';
import { isProcessAlive } from '@kiturone/kapibala-mcp';
import type {
  ViewDiffSummary,
  ViewExternalSessionStatus,
  ViewMessage,
  ViewNotice,
  ViewTodoState,
} from '../../view-model/index.js';
import { redactViewMessage } from '../public-projection.js';
import { redactText } from '../redaction.js';
import { normalizeProjectRoot } from '../resource/mcp-approval.js';
import { getExternalStateDirPath } from './config.js';
import {
  ExternalHarnessError,
  type ExternalTransportKind,
  isReservedObjectPropertyName,
  isValidNativeSessionId,
} from './types.js';

/** 外部代理会话登记簿文件名（`~/.kapibala/external/sessions.json`）。 */
export const EXTERNAL_SESSIONS_FILE_NAME = 'sessions.json';
/** 外部代理有界只读展示快照子目录名（`~/.kapibala/external/snapshots/`）。 */
export const EXTERNAL_SNAPSHOTS_DIR_NAME = 'snapshots';
/** 全局允许保留的外部会话记录上限；满额新增时优先自动淘汰最早终态记录，全为活跃态时才拒绝。 */
export const MAX_RETAINED_EXTERNAL_SESSIONS = 50;
/** 单会话只读展示快照的最大保留消息条数（控制 JSON 节点数安全低于 Wire 10 万节点上限）。 */
export const MAX_EXTERNAL_ARCHIVE_MESSAGES = 160;
/** 单会话只读展示快照的最大字节上限（680 KiB，确保单帧包裹后恒低于桌面 IPC 与 Wire 1 MiB 帧上限）。 */
export const MAX_EXTERNAL_ARCHIVE_BYTES = 680 * 1024;

/** 持久化在 `sessions.json` 中的单条外部会话元数据记录。 */
export interface ExternalSessionRecord {
  readonly id: string;
  readonly harnessId: string;
  readonly harnessName: string;
  readonly transport: ExternalTransportKind;
  /** 外部代理进程实际执行的 `cwd`（绑定受管工作树时为 `worktree.worktreePath`，否则同 `projectRoot`）。 */
  readonly workspaceRoot: string;
  /** 会话归属的主项目物理根（决定空间列表过滤与项目信任锚点；历史记录未存该字段时回退 `workspaceRoot`）。 */
  readonly projectRoot?: string;
  /** 会话绑定的受管 Git Worktree 元数据。 */
  readonly worktree?: SessionWorktreeBinding;
  /** 累计 Shadow Git 检查点增删行数摘要（用于侧栏与头部 `+A -D` 展示）。 */
  readonly diffSummary?: ViewDiffSummary;
  /** 已发起的外部轮次计数（保证重启或归档裁剪后检查点 `ordinal` 仍严格单调递增）。 */
  readonly turnCount?: number;
  /** 创建会话时的 `computeHarnessConfigDigest`；配置漂移后禁止盲目原地续聊。 */
  readonly configDigest: string;
  readonly title: string;
  /** 用户在 `openSession` 时显式传入自定义标题则为 `true`，避免首轮消息覆盖自定义标题。 */
  readonly customTitle?: boolean;
  readonly status: ViewExternalSessionStatus;
  readonly nativeSessionId?: string;
  readonly resumable: boolean;
  readonly modelLabel?: string;
  readonly modeLabel?: string;
  readonly thoughtLevelLabel?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastError?: string;
  /** 活跃子进程的宿主身份；同进程内不同服务实例也必须分别认领。 */
  readonly owner?: { readonly pid: number; readonly id: string };
}

/** 持久化在 `snapshots/<sha256(id)>.json` 中的有界脱敏只读展示归档。 */
export interface ExternalSessionArchive {
  readonly version: 1;
  readonly sessionId: string;
  readonly truncated: boolean;
  readonly updatedAt: number;
  readonly messages: readonly ViewMessage[];
  readonly plan?: ViewTodoState;
  readonly notices?: readonly ViewNotice[];
}

const LOCK_RETRY_ATTEMPTS = 12;
const LOCK_RETRY_DELAY_MS = 15;
const RENAME_RETRY_ATTEMPTS = 3;
const SharedWaitCell = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms: number): void {
  Atomics.wait(SharedWaitCell, 0, 0, ms);
}

/** 截断字符串且避免切裂 UTF-16 高低代理对，防止 `JSON.stringify` 产出孤立代理字符。 */
function sliceUtf16Safe(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  if (maxUnits <= 0) return '';
  let end = maxUnits;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) {
    end -= 1;
  }
  return text.slice(0, end);
}

function renameWithWindowsRetry(tempPath: string, targetPath: string): void {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        process.platform === 'win32' &&
        (code === 'EPERM' || code === 'EACCES') &&
        attempt < RENAME_RETRY_ATTEMPTS
      ) {
        sleepSync(LOCK_RETRY_DELAY_MS);
        continue;
      }
      throw err;
    }
  }
}

function isLiveStatus(status: ViewExternalSessionStatus): boolean {
  return (
    status === 'starting' ||
    status === 'idle' ||
    status === 'running' ||
    status === 'waiting_approval' ||
    status === 'cancelling'
  );
}

/**
 * 外部会话元数据登记簿与有界只读展示快照存储。
 *
 * 隔离与安全不变量：
 * - 所有文件严格落在 `~/.kapibala/external/`（目录 `0700`、文件 `0600`），与 Core `SessionManager` 零交集；
 * - 内部记录表统一采用无原型字典（`Object.create(null)` + `Object.hasOwn`），阻断 `constructor` 等原型键污染；
 * - 读时将缺少归属或宿主已退出的非终态视作 `'ended'`；写时在锁内核验归属并保存归一结果；
 * - 快照文件名采用 `sha256(sessionId).json`，落盘前统一脱敏并强制钳制在 680KiB 单帧安全预算以内。
 */
export class ExternalSessionRegistry {
  readonly sessionsFilePath: string;
  readonly snapshotsDirPath: string;
  private readonly owner = { pid: process.pid, id: randomUUID() };

  constructor(options: { readonly homeDir?: string } = {}) {
    const baseDir = getExternalStateDirPath(options.homeDir);
    this.sessionsFilePath = path.join(baseDir, EXTERNAL_SESSIONS_FILE_NAME);
    this.snapshotsDirPath = path.join(baseDir, EXTERNAL_SNAPSHOTS_DIR_NAME);
  }

  /** 按更新时间倒序列出全部（或指定主项目根下的）外部会话记录；受管工作树会话按 `projectRoot` 归属。 */
  listRecords(projectRoot?: string): ExternalSessionRecord[] {
    const targetNorm = projectRoot ? normalizeProjectRoot(projectRoot) : undefined;
    return Object.values(this.readRecordsMap())
      .filter((rec) =>
        targetNorm
          ? normalizeProjectRoot(
              rec.projectRoot ?? rec.worktree?.projectRoot ?? rec.workspaceRoot,
            ) === targetNorm
          : true,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  /** 按精确 ID 读取单条外部会话记录（阻断原型属性命中）。 */
  getRecord(id: string): ExternalSessionRecord | undefined {
    if (!id || isReservedObjectPropertyName(id)) return undefined;
    const records = this.readRecordsMap();
    return Object.hasOwn(records, id) ? records[id] : undefined;
  }

  /**
   * 新增或更新外部会话记录。活跃状态在锁内认领，其他存活宿主持有时拒绝写入。
   *
   * 容量回收策略：当全局已满 50 条记录且新增会话时，自动淘汰更新时间最早的终态（`ended` / `failed`）记录及其快照，
   * 避免历史已移除工作区的旧记录占满配额导致当前工作区死锁；仅当 50 条全为活跃会话时抛 `EXTERNAL_CAPACITY`。
   */
  upsertRecord(record: ExternalSessionRecord, resume = false): ExternalSessionRecord {
    if (!record.id || isReservedObjectPropertyName(record.id)) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `非法的外部会话 ID：${record.id}`);
    }
    const evictedIds: string[] = [];
    const saved = this.mutateRecords((records) => {
      const existing = records[record.id];
      this.assertWritable(existing);
      if (resume && !existing) {
        throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', '外部会话已被删除');
      }
      if (!existing) {
        while (Object.keys(records).length >= MAX_RETAINED_EXTERNAL_SESSIONS) {
          const oldestTerminal = Object.values(records)
            .filter((item) => !isLiveStatus(item.status))
            .sort((a, b) => a.updatedAt - b.updatedAt || a.createdAt - b.createdAt)[0];
          if (!oldestTerminal) {
            throw new ExternalHarnessError(
              'EXTERNAL_CAPACITY',
              `外部会话记录已达上限（${MAX_RETAINED_EXTERNAL_SESSIONS} 条），请先关闭或删除已结束的外部会话`,
            );
          }
          delete records[oldestTerminal.id];
          evictedIds.push(oldestTerminal.id);
        }
      }
      const next = {
        ...(resume ? existing! : record),
        status: record.status,
        updatedAt: record.updatedAt,
        owner: isLiveStatus(record.status) ? this.owner : undefined,
      };
      records[record.id] = next;
      return next;
    });
    for (const evictedId of evictedIds) {
      try {
        fs.unlinkSync(this.archivePathOf(evictedId));
      } catch {
        /* ignore missing archive */
      }
    }
    return saved;
  }

  /** 删除指定外部会话记录并同步清理对应的只读展示快照文件。 */
  deleteRecord(id: string): boolean {
    if (!id || isReservedObjectPropertyName(id)) return false;
    const removed = this.mutateRecords((records) => {
      if (!Object.hasOwn(records, id)) return false;
      this.assertWritable(records[id]);
      delete records[id];
      return true;
    });
    const archiveFile = this.archivePathOf(id);
    if (removed) {
      try {
        fs.unlinkSync(archiveFile);
      } catch {
        /* 快照不存在时忽略 */
      }
    }
    return removed;
  }

  /** 判断指定会话是否存在本地只读展示快照文件。 */
  hasArchive(sessionId: string): boolean {
    if (!sessionId || isReservedObjectPropertyName(sessionId)) return false;
    try {
      return fs.statSync(this.archivePathOf(sessionId)).isFile();
    } catch {
      return false;
    }
  }

  /** 读取指定会话的本地只读展示快照；缺失或损坏时返回 `undefined`。 */
  readArchive(sessionId: string): ExternalSessionArchive | undefined {
    if (!sessionId || isReservedObjectPropertyName(sessionId)) return undefined;
    let raw: string;
    try {
      raw = fs.readFileSync(this.archivePathOf(sessionId), 'utf8');
    } catch {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<ExternalSessionArchive>;
      if (parsed.version !== 1 || !Array.isArray(parsed.messages)) return undefined;
      return {
        version: 1,
        sessionId,
        truncated: Boolean(parsed.truncated),
        updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        messages: parsed.messages,
        ...(parsed.plan ? { plan: parsed.plan } : {}),
        ...(Array.isArray(parsed.notices) ? { notices: parsed.notices } : {}),
      };
    } catch {
      return undefined;
    }
  }

  /**
   * 原子写入有界脱敏只读展示快照（仅在每轮结算与会话关闭时调用）。
   *
   * 保护规则：
   * - 若传入空消息数组且磁盘已有非空快照，直接跳过以防启动失败或异常收口抹掉历史输出；
   * - 超出 160 条消息或 680 KiB 字节上限时从头部裁剪最旧消息并置 `truncated: true`。
   */
  saveArchive(
    sessionId: string,
    payload: {
      readonly messages: readonly ViewMessage[];
      readonly plan?: ViewTodoState;
      readonly notices?: readonly ViewNotice[];
      readonly alreadyTruncated?: boolean;
    },
    secrets: readonly string[] = [],
  ): void {
    if (!sessionId || isReservedObjectPropertyName(sessionId)) return;
    const filePath = this.archivePathOf(sessionId);
    if (payload.messages.length === 0 && this.hasArchive(sessionId)) {
      const existing = this.readArchive(sessionId);
      if (existing && existing.messages.length > 0) {
        return;
      }
    }

    const redactFn = (text: string): string => redactText(text, secrets);
    let redactedMessages = payload.messages.map((msg) => redactViewMessage(msg, redactFn));
    let truncated = Boolean(payload.alreadyTruncated);

    if (redactedMessages.length > MAX_EXTERNAL_ARCHIVE_MESSAGES) {
      redactedMessages = redactedMessages.slice(
        redactedMessages.length - MAX_EXTERNAL_ARCHIVE_MESSAGES,
      );
      truncated = true;
    }

    let redactedPlan: ViewTodoState | undefined = payload.plan
      ? {
          ...payload.plan,
          items: payload.plan.items.slice(0, 100).map((item) => ({
            ...item,
            id: sliceUtf16Safe(item.id, 256),
            title: sliceUtf16Safe(redactFn(item.title), 500),
          })),
        }
      : undefined;

    let redactedNotices: ViewNotice[] | undefined = payload.notices?.length
      ? payload.notices.slice(-20).map((n) => ({
          ...n,
          id: sliceUtf16Safe(n.id, 128),
          text: sliceUtf16Safe(redactFn(n.text), 500),
        }))
      : undefined;

    const serialize = (msgs: readonly ViewMessage[], isTruncated: boolean): string =>
      `${JSON.stringify({
        version: 1,
        sessionId,
        truncated: isTruncated,
        updatedAt: Date.now(),
        messages: msgs,
        ...(redactedPlan ? { plan: redactedPlan } : {}),
        ...(redactedNotices ? { notices: redactedNotices } : {}),
      })}\n`;

    let content = serialize(redactedMessages, truncated);
    while (
      Buffer.byteLength(content, 'utf8') > MAX_EXTERNAL_ARCHIVE_BYTES &&
      redactedMessages.length > 1
    ) {
      const dropCount = Math.max(1, Math.floor(redactedMessages.length * 0.1));
      redactedMessages = redactedMessages.slice(dropCount);
      truncated = true;
      content = serialize(redactedMessages, true);
    }

    // 若极端情况下单条超大消息（含多字节中文/Emoji）仍超过 680 KiB，递减块预算循环截断直至严格低于上限。
    if (
      Buffer.byteLength(content, 'utf8') > MAX_EXTERNAL_ARCHIVE_BYTES &&
      redactedMessages.length === 1
    ) {
      const only = redactedMessages[0]!;
      const keptBlocks = only.blocks.slice(-64);
      let budgetUnits = 420 * 1024;
      while (
        Buffer.byteLength(content, 'utf8') > MAX_EXTERNAL_ARCHIVE_BYTES &&
        budgetUnits >= 1024
      ) {
        const maxCharsPerBlock = Math.max(
          256,
          Math.floor(budgetUnits / Math.max(1, keptBlocks.length)),
        );
        redactedMessages = [
          {
            ...only,
            blocks: keptBlocks.map((b) => ({
              ...b,
              text: sliceUtf16Safe(b.text, maxCharsPerBlock),
              ...(b.tool
                ? {
                    tool: {
                      ...b.tool,
                      input: sliceUtf16Safe(b.tool.input, Math.min(maxCharsPerBlock, 16 * 1024)),
                      ...(b.tool.result
                        ? { result: sliceUtf16Safe(b.tool.result, maxCharsPerBlock) }
                        : {}),
                    },
                  }
                : {}),
            })),
          },
        ];
        truncated = true;
        content = serialize(redactedMessages, true);
        budgetUnits = Math.floor(budgetUnits / 2);
      }
    }

    if (Buffer.byteLength(content, 'utf8') > MAX_EXTERNAL_ARCHIVE_BYTES) {
      redactedNotices = undefined;
      redactedPlan = undefined;
      redactedMessages = [];
      truncated = true;
      content = serialize([], true);
    }

    fs.mkdirSync(this.snapshotsDirPath, { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      renameWithWindowsRetry(tempPath, filePath);
    } catch (err) {
      try {
        fs.unlinkSync(tempPath);
      } catch {
        /* ignore */
      }
      throw err;
    }
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* ignore on Windows */
    }
  }

  private archivePathOf(sessionId: string): string {
    const digest = createHash('sha256').update(sessionId).digest('hex');
    return path.join(this.snapshotsDirPath, `${digest}.json`);
  }

  /** 在登记簿写锁内拒绝更新或删除其他宿主持有的活跃会话。 */
  private assertWritable(record: ExternalSessionRecord | undefined): void {
    if (record?.owner && record.owner.id !== this.owner.id) {
      throw new ExternalHarnessError('EXTERNAL_SESSION_BUSY', '外部会话由另一个宿主持有');
    }
  }

  private readRecordsMap(): Record<string, ExternalSessionRecord> {
    const emptyMap = (): Record<string, ExternalSessionRecord> =>
      Object.create(null) as Record<string, ExternalSessionRecord>;
    let raw: string;
    try {
      raw = fs.readFileSync(this.sessionsFilePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyMap();
      throw err;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_CORRUPT',
        `外部会话登记簿 ${this.sessionsFilePath} JSON 损坏`,
        { cause },
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_CORRUPT',
        `外部会话登记簿 ${this.sessionsFilePath} 顶层结构非法`,
      );
    }
    const container = parsed as { version?: unknown; sessions?: unknown };
    if (
      container.version !== 1 ||
      !container.sessions ||
      typeof container.sessions !== 'object' ||
      Array.isArray(container.sessions)
    ) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_CORRUPT',
        `外部会话登记簿 ${this.sessionsFilePath} 版本或 sessions 字段损坏`,
      );
    }
    const map = emptyMap();
    for (const [id, rawItem] of Object.entries(container.sessions as Record<string, unknown>)) {
      if (!id || isReservedObjectPropertyName(id)) continue;
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
      const item = rawItem as Partial<ExternalSessionRecord>;
      if (
        typeof item.id !== 'string' ||
        item.id !== id ||
        isReservedObjectPropertyName(item.id) ||
        typeof item.harnessId !== 'string' ||
        typeof item.harnessName !== 'string' ||
        typeof item.transport !== 'string' ||
        typeof item.workspaceRoot !== 'string' ||
        typeof item.configDigest !== 'string' ||
        typeof item.title !== 'string' ||
        typeof item.status !== 'string'
      ) {
        continue;
      }
      const validNativeId = isValidNativeSessionId(item.nativeSessionId)
        ? item.nativeSessionId.trim()
        : undefined;
      const owner = item.owner;
      const live = isLiveStatus(item.status as ViewExternalSessionStatus);
      // 旧登记簿没有归属字段；无归属的历史按原有启动恢复语义归档。
      const activeOwner =
        live && typeof owner?.id === 'string' && isProcessAlive(owner.pid) ? owner : undefined;
      map[id] = {
        ...(item as ExternalSessionRecord),
        ...(live && !activeOwner ? { status: 'ended' } : {}),
        owner: activeOwner,
        nativeSessionId: validNativeId,
        resumable: Boolean(item.resumable && validNativeId),
      };
    }
    return map;
  }

  private acquireLockFd(lockPath: string): number {
    for (let attempt = 1; ; attempt++) {
      try {
        return fs.openSync(lockPath, 'wx', 0o600);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw err;
        }
        // 检查锁持有进程是否已死亡或为崩溃遗留超过 5 秒的空锁文件，安全清理后立即重试
        try {
          const rawText = fs.readFileSync(lockPath, 'utf8');
          if (!rawText.trim()) {
            const st = fs.statSync(lockPath);
            if (Date.now() - st.mtimeMs > 5_000) {
              fs.unlinkSync(lockPath);
              continue;
            }
          } else {
            const rawLock = JSON.parse(rawText) as {
              pid?: unknown;
            };
            if (
              typeof rawLock.pid === 'number' &&
              Number.isSafeInteger(rawLock.pid) &&
              rawLock.pid > 0 &&
              !isProcessAlive(rawLock.pid)
            ) {
              fs.unlinkSync(lockPath);
              continue;
            }
          }
        } catch {
          /* 锁文件正由其他进程写入或刚释放，进入短退避重试 */
        }
        if (attempt >= LOCK_RETRY_ATTEMPTS) {
          throw new ExternalHarnessError(
            'EXTERNAL_CONFIG_BUSY',
            `外部会话登记簿正在被其他进程写入（${lockPath}）`,
          );
        }
        sleepSync(LOCK_RETRY_DELAY_MS);
      }
    }
  }

  private mutateRecords<T>(mutate: (records: Record<string, ExternalSessionRecord>) => T): T {
    fs.mkdirSync(path.dirname(this.sessionsFilePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.sessionsFilePath}.lock`;
    const owner = randomUUID();
    const fd = this.acquireLockFd(lockPath);

    try {
      fs.writeFileSync(fd, JSON.stringify({ owner, pid: process.pid }));
      const records = this.readRecordsMap();
      const result = mutate(records);
      const plainSessions: Record<string, ExternalSessionRecord> = {};
      for (const [k, v] of Object.entries(records)) {
        if (!k || isReservedObjectPropertyName(k)) continue;
        plainSessions[k] = v;
      }
      const content = `${JSON.stringify({ version: 1, sessions: plainSessions }, null, 2)}\n`;
      const tempPath = `${this.sessionsFilePath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        renameWithWindowsRetry(tempPath, this.sessionsFilePath);
      } catch (writeErr) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* ignore */
        }
        throw writeErr;
      }
      try {
        fs.chmodSync(this.sessionsFilePath, 0o600);
      } catch {
        /* ignore on Windows */
      }
      return result;
    } finally {
      fs.closeSync(fd);
      try {
        if (JSON.parse(fs.readFileSync(lockPath, 'utf8')).owner === owner) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        /* 保留无法确认所有者的锁现场 */
      }
    }
  }
}
