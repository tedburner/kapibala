import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type {
  ViewExternalSessionStatus,
  ViewMessage,
  ViewNotice,
  ViewTodoState,
} from '../../view-model/index.js';
import { redactViewMessage } from '../public-projection.js';
import { redactText } from '../redaction.js';
import { normalizeProjectRoot } from '../resource/mcp-approval.js';
import { getExternalStateDirPath } from './config.js';
import { ExternalHarnessError, type ExternalTransportKind } from './types.js';

/** 外部代理会话登记簿文件名（`~/.kapibala/external/sessions.json`）。 */
export const EXTERNAL_SESSIONS_FILE_NAME = 'sessions.json';
/** 外部代理有界只读展示快照子目录名（`~/.kapibala/external/snapshots/`）。 */
export const EXTERNAL_SNAPSHOTS_DIR_NAME = 'snapshots';
/** 全局允许保留的外部会话记录上限（满额拒绝新建并提示手动清理已结束项，不自动淘汰活动会话）。 */
export const MAX_RETAINED_EXTERNAL_SESSIONS = 50;
/** 单会话只读展示快照的最大保留消息条数。 */
export const MAX_EXTERNAL_ARCHIVE_MESSAGES = 500;
/** 单会话只读展示快照的最大字节上限（2 MiB）。 */
export const MAX_EXTERNAL_ARCHIVE_BYTES = 2 * 1024 * 1024;

/** 持久化在 `sessions.json` 中的单条外部会话元数据记录。 */
export interface ExternalSessionRecord {
  readonly id: string;
  readonly harnessId: string;
  readonly harnessName: string;
  readonly transport: ExternalTransportKind;
  readonly workspaceRoot: string;
  /** 创建会话时的 `computeHarnessConfigDigest`；配置漂移后禁止盲目原地续聊。 */
  readonly configDigest: string;
  readonly title: string;
  readonly status: ViewExternalSessionStatus;
  readonly nativeSessionId?: string;
  readonly resumable: boolean;
  readonly modelLabel?: string;
  readonly modeLabel?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly lastError?: string;
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
 * - 宿主首次加载登记簿时，将上一次宿主退出遗留的非终态（`running` / `idle` 等）归一为 `'ended'`，不伪装存活子进程；
 * - 快照文件名采用 `sha256(sessionId).json`，落盘前统一脱敏，空消息列表绝不覆盖既有非空归档。
 */
export class ExternalSessionRegistry {
  readonly sessionsFilePath: string;
  readonly snapshotsDirPath: string;
  private startupNormalized = false;

  constructor(options: { readonly homeDir?: string } = {}) {
    const baseDir = getExternalStateDirPath(options.homeDir);
    this.sessionsFilePath = path.join(baseDir, EXTERNAL_SESSIONS_FILE_NAME);
    this.snapshotsDirPath = path.join(baseDir, EXTERNAL_SNAPSHOTS_DIR_NAME);
  }

  /** 按更新时间倒序列出全部（或指定工作区根下的）外部会话记录。 */
  listRecords(workspaceRoot?: string): ExternalSessionRecord[] {
    this.ensureStartupNormalized();
    const targetNorm = workspaceRoot ? normalizeProjectRoot(workspaceRoot) : undefined;
    return Object.values(this.readRecordsMap())
      .filter((rec) => (targetNorm ? normalizeProjectRoot(rec.workspaceRoot) === targetNorm : true))
      .sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt);
  }

  /** 按精确 ID 读取单条外部会话记录。 */
  getRecord(id: string): ExternalSessionRecord | undefined {
    this.ensureStartupNormalized();
    return this.readRecordsMap()[id];
  }

  /** 新增或更新外部会话记录；新增且总数超过 50 条时抛 `EXTERNAL_CAPACITY`。 */
  upsertRecord(record: ExternalSessionRecord): ExternalSessionRecord {
    this.ensureStartupNormalized();
    return this.mutateRecords((records) => {
      if (!records[record.id] && Object.keys(records).length >= MAX_RETAINED_EXTERNAL_SESSIONS) {
        throw new ExternalHarnessError(
          'EXTERNAL_CAPACITY',
          `外部会话记录已达上限（${MAX_RETAINED_EXTERNAL_SESSIONS} 条），请先删除已结束的外部会话`,
        );
      }
      records[record.id] = record;
      return record;
    });
  }

  /** 删除指定外部会话记录并同步清理对应的只读展示快照文件。 */
  deleteRecord(id: string): boolean {
    this.ensureStartupNormalized();
    const removed = this.mutateRecords((records) => {
      if (!records[id]) return false;
      delete records[id];
      return true;
    });
    const archiveFile = this.archivePathOf(id);
    try {
      fs.unlinkSync(archiveFile);
    } catch {
      /* 快照不存在时忽略 */
    }
    return removed;
  }

  /** 判断指定会话是否存在本地只读展示快照文件。 */
  hasArchive(sessionId: string): boolean {
    try {
      return fs.statSync(this.archivePathOf(sessionId)).isFile();
    } catch {
      return false;
    }
  }

  /** 读取指定会话的本地只读展示快照；缺失或损坏时返回 `undefined`。 */
  readArchive(sessionId: string): ExternalSessionArchive | undefined {
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
   * - 超出 500 条消息或 2 MiB 字节上限时从头部裁剪最旧消息并置 `truncated: true`。
   */
  saveArchive(
    sessionId: string,
    payload: {
      readonly messages: readonly ViewMessage[];
      readonly plan?: ViewTodoState;
      readonly notices?: readonly ViewNotice[];
    },
    secrets: readonly string[] = [],
  ): void {
    const filePath = this.archivePathOf(sessionId);
    if (payload.messages.length === 0 && this.hasArchive(sessionId)) {
      const existing = this.readArchive(sessionId);
      if (existing && existing.messages.length > 0) {
        return;
      }
    }

    const redactFn = (text: string): string => redactText(text, secrets);
    let redactedMessages = payload.messages.map((msg) => redactViewMessage(msg, redactFn));
    let truncated = false;

    if (redactedMessages.length > MAX_EXTERNAL_ARCHIVE_MESSAGES) {
      redactedMessages = redactedMessages.slice(
        redactedMessages.length - MAX_EXTERNAL_ARCHIVE_MESSAGES,
      );
      truncated = true;
    }

    const redactedPlan: ViewTodoState | undefined = payload.plan
      ? {
          ...payload.plan,
          items: payload.plan.items.map((item) => ({
            ...item,
            title: redactFn(item.title),
          })),
        }
      : undefined;

    const redactedNotices: ViewNotice[] | undefined = payload.notices?.length
      ? payload.notices.slice(-20).map((n) => ({
          ...n,
          text: redactFn(n.text),
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
      // 按批次或逐条剥除最旧消息直至满足 2 MiB 硬预算。
      const dropCount = Math.max(1, Math.floor(redactedMessages.length * 0.1));
      redactedMessages = redactedMessages.slice(dropCount);
      truncated = true;
      content = serialize(redactedMessages, true);
    }

    // 若极端情况下单条超大消息仍超过 2 MiB，截断该条消息内过长块文本保底落盘。
    if (
      Buffer.byteLength(content, 'utf8') > MAX_EXTERNAL_ARCHIVE_BYTES &&
      redactedMessages.length === 1
    ) {
      const only = redactedMessages[0]!;
      redactedMessages = [
        {
          ...only,
          blocks: only.blocks.map((b) => ({
            ...b,
            text: b.text.slice(0, 128 * 1024),
            ...(b.tool?.result
              ? { tool: { ...b.tool, result: b.tool.result.slice(0, 128 * 1024) } }
              : {}),
          })),
        },
      ];
      truncated = true;
      content = serialize(redactedMessages, true);
    }

    fs.mkdirSync(this.snapshotsDirPath, { recursive: true, mode: 0o700 });
    const tempPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      fs.renameSync(tempPath, filePath);
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

  private ensureStartupNormalized(): void {
    if (this.startupNormalized) return;
    this.startupNormalized = true;
    if (!fs.existsSync(this.sessionsFilePath)) return;
    try {
      this.mutateRecords((records) => {
        for (const [id, rec] of Object.entries(records)) {
          if (isLiveStatus(rec.status)) {
            records[id] = {
              ...rec,
              status: 'ended',
            };
          }
        }
      });
    } catch {
      /* 锁竞争或损坏留待显式读写处理 */
    }
  }

  private readRecordsMap(): Record<string, ExternalSessionRecord> {
    let raw: string;
    try {
      raw = fs.readFileSync(this.sessionsFilePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
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
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const container = parsed as { version?: unknown; sessions?: unknown };
    if (container.version !== 1 || !container.sessions || typeof container.sessions !== 'object') {
      return {};
    }
    const map: Record<string, ExternalSessionRecord> = {};
    for (const [id, rawItem] of Object.entries(container.sessions as Record<string, unknown>)) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
      const item = rawItem as Partial<ExternalSessionRecord>;
      if (
        typeof item.id !== 'string' ||
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
      map[id] = item as ExternalSessionRecord;
    }
    return map;
  }

  private mutateRecords<T>(mutate: (records: Record<string, ExternalSessionRecord>) => T): T {
    fs.mkdirSync(path.dirname(this.sessionsFilePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.sessionsFilePath}.lock`;
    const owner = randomUUID();
    let lockFd: number;
    try {
      lockFd = fs.openSync(lockPath, 'wx', 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new ExternalHarnessError(
          'EXTERNAL_CONFIG_BUSY',
          `外部会话登记簿锁 ${lockPath} 已被占用`,
        );
      }
      throw err;
    }

    try {
      fs.writeFileSync(lockFd, JSON.stringify({ owner, pid: process.pid }));
      const records = this.readRecordsMap();
      const result = mutate(records);
      const tempPath = `${this.sessionsFilePath}.${randomUUID()}.tmp`;
      const serialized = `${JSON.stringify({ version: 1, sessions: records }, null, 2)}\n`;
      try {
        fs.writeFileSync(tempPath, serialized, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(tempPath, this.sessionsFilePath);
      } catch (err) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* ignore */
        }
        throw err;
      }
      try {
        fs.chmodSync(this.sessionsFilePath, 0o600);
      } catch {
        /* ignore on Windows */
      }
      return result;
    } finally {
      fs.closeSync(lockFd);
      try {
        if ((JSON.parse(fs.readFileSync(lockPath, 'utf8')) as { owner?: string }).owner === owner) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        /* ignore */
      }
    }
  }
}
