import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { CanonicalMessage } from '../types/index.js';
import { createMessageId, identifyHistory } from './history.js';
import { readJsonlLines, syncSessionDirectory } from './jsonl-lines.js';
import { SessionLock } from './session-lock.js';
import { type SessionHeader, type SessionRecord, SessionStore } from './session-store.js';

/** 会话桶的项目身份：会话按工作树根隔离存储在项目桶目录下。 */
export interface ProjectIdentity {
  /** 真实工作树根（非 Git 目录时为真实 cwd），作为会话归属与来源基准。 */
  projectRoot: string;
  /** 解析符号链接后的真实 cwd。 */
  cwd: string;
  /** 规范化根目录的 SHA-256，决定 ~/.kapibala/sessions 下的桶目录。 */
  projectKey: string;
  /** detached HEAD 或非 Git 目录时缺省。 */
  gitBranch?: string;
  /** true 表示 cwd 位于 Git 工作树内；同工作树子目录共用同一桶。 */
  gitWorktree?: boolean;
}

/** Windows 桶和头部使用相同大小写规范，POSIX 保持路径大小写语义。 */
function normalizedProjectRoot(root: string): string {
  return process.platform === 'win32' ? root.replaceAll('\\', '/').toLowerCase() : root;
}

/** 解析真实工作树根；同工作树子目录共用桶，非 Git 目录和不同 worktree 独立。不会改变 cwd。 */
export function resolveSessionProject(cwd: string): ProjectIdentity {
  const realCwd = fs.realpathSync.native(path.resolve(cwd));
  let root = realCwd;
  let gitBranch: string | undefined;
  let gitWorktree = false;
  try {
    root = fs.realpathSync.native(
      execFileSync('git', ['-C', realCwd, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim(),
    );
    gitWorktree = true;
    gitBranch =
      execFileSync('git', ['-C', realCwd, 'symbolic-ref', '--short', '-q', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || undefined;
  } catch {
    /* 非 Git 或 detached HEAD 保留已确定的工作树根。 */
  }
  const normalized = normalizedProjectRoot(root);
  return {
    projectRoot: root,
    cwd: realCwd,
    projectKey: createHash('sha256').update(normalized).digest('hex'),
    gitBranch,
    gitWorktree,
  };
}

/**
 * 会话 sidecar 缓存元数据；可随时从正文重建，校验失败即丢弃，不是恢复依据。
 * 正文 JSONL 始终是唯一真源。
 */
export interface SessionMetadata {
  schemaVersion: 1;
  conversationId: string;
  fileName: string;
  projectRoot: string;
  createdAt: number;
  /** 最后一次正文、用户 run 或 reset 的时间；usage 与标题不影响排序。 */
  lastActivityAt: number;
  messageCount: number;
  title: string;
  /** 用户显式重命名的标题；存在时 reset 不再回退为默认标题。 */
  customTitle?: string;
  gitBranch?: string;
  lastActivityGitBranch?: string;
  lastModelId?: string;
  /** 旧历史导入的幂等身份（来源路径 + 内容哈希）；重复导入据此跳过。 */
  importIdentity?: string;
  size: number;
  mtimeMs: number;
  /** 最后计入的记录 ID；与正文 stat 一同用于增量校验。 */
  revision: string;
}

/** 打开的会话句柄：持有单写者锁与 Store，宿主用毕必须 release。 */
export interface ManagedSession {
  conversationId: string;
  store: SessionStore;
  metadataPath: string;
  /** 可丢弃缓存的只读快照；缺失时为 undefined，不代表正文丢失。 */
  readonly metadata?: SessionMetadata;
  header: SessionHeader;
  /** 环境提示，不执行 checkout，也不把旧授权或模型配置带入当前运行。 */
  branchDrift?: { createdBranch?: string; currentBranch?: string };
  /** 释放单写者锁并移除句柄；宿主须先结束 AgentSession 的工具/摘要清理。 */
  release(): Promise<void>;
}

/** SessionManager 配置；cwd 决定项目桶，homeDirectory 便于测试隔离。 */
export interface SessionManagerOptions {
  cwd?: string;
  homeDirectory?: string;
  onDiagnostic?: (message: string) => void;
}

/** 将终端控制字符转成可见转义，并按 Unicode code point 限长。 */
export function sanitizeSessionTitle(title: string, maximum = 200): string {
  return Array.from(
    Array.from(title)
      .map((c) => {
        const code = c.codePointAt(0)!;
        return code < 32 ||
          (code >= 127 && code <= 159) ||
          (code >= 0x202a && code <= 0x202e) ||
          (code >= 0x2066 && code <= 0x2069)
          ? `\\u${code.toString(16).padStart(4, '0')}`
          : c;
      })
      .join(''),
  )
    .slice(0, maximum)
    .join('');
}

/** 按项目发现、创建和打开独立会话；缓存可丢弃，JSONL 是唯一恢复依据。 */
export class SessionManager {
  readonly project: ProjectIdentity;
  readonly directory: string;
  private readonly handles = new Map<string, ManagedSession>();
  private readonly diagnostic?: (message: string) => void;

  constructor(options: SessionManagerOptions = {}) {
    this.project = resolveSessionProject(options.cwd ?? process.cwd());
    this.directory = path.join(
      options.homeDirectory ?? os.homedir(),
      '.kapibala',
      'sessions',
      this.project.projectKey,
    );
    this.diagnostic = options.onDiagnostic;
    fs.mkdirSync(this.directory, { recursive: true });
  }

  /** 默认新建独立空会话，写入头部并持有单写者锁；不读取其它正文。 */
  async create(): Promise<ManagedSession> {
    const conversationId = createMessageId();
    const file = path.join(this.directory, `${Date.now()}_${conversationId}.jsonl`);
    const lock = await SessionLock.acquire(this.lockPath(conversationId));
    try {
      const store = await SessionStore.create(file, {
        conversationId,
        projectRoot: this.project.projectRoot,
        initialCwd: this.project.cwd,
        gitBranch: this.project.gitBranch,
      });
      return await this.attach(store, lock);
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  /** 每页 20 项按正文活动排序；有效 sidecar 只读元数据，不读取完整 JSONL。 */
  async list(
    page = 1,
  ): Promise<{ items: SessionMetadata[]; total: number; page: number; pages: number }> {
    if (!Number.isSafeInteger(page) || page < 1)
      throw new Error('History page must be a positive integer');
    const all = await this.allMetadata();
    return {
      items: all.slice((page - 1) * 20, page * 20),
      total: all.length,
      page,
      pages: Math.max(1, Math.ceil(all.length / 20)),
    };
  }

  /** 一次扫描建立排序目录，分页和继续最近会话共用；有效缓存不读取正文。 */
  private async allMetadata(): Promise<SessionMetadata[]> {
    const all: SessionMetadata[] = [];
    for (const fileName of fs
      .readdirSync(this.directory)
      .filter((name) => name.endsWith('.jsonl'))) {
      const file = path.join(this.directory, fileName);
      try {
        let meta = this.readMetadata(file);
        if (!meta) {
          // 浏览重建不能修复/改写正文，也不能取得其它进程写锁。
          const records = this.readDiscoveryRecords(file);
          meta = this.buildMetadata(file, records);
          try {
            this.writeMetadata(file, meta);
          } catch {
            this.report('Session metadata cache could not be rebuilt');
          }
        }
        all.push(meta);
      } catch {
        this.report(`Cannot discover session: ${fileName}`);
      }
    }
    all.sort(
      (a, b) =>
        b.lastActivityAt - a.lastActivityAt || b.conversationId.localeCompare(a.conversationId),
    );
    return all;
  }

  /** 打开完整 ID 或唯一前缀；跨桶、缺失与歧义均失败，同一 Manager 已持有的目标直接返回。 */
  async open(id: string): Promise<ManagedSession> {
    if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Session not found');
    const all = fs
      .readdirSync(this.directory)
      .filter((name) => /^\d+_[a-zA-Z0-9-]+\.jsonl$/.test(name))
      .map((fileName) => ({
        fileName,
        conversationId: fileName.slice(fileName.indexOf('_') + 1, -6),
      }));
    const exact = all.find((m) => m.conversationId === id);
    const matches = exact ? [exact] : all.filter((m) => m.conversationId.startsWith(id));
    if (!matches.length) throw new Error(`Session not found: ${id}`);
    if (matches.length !== 1) throw new Error(`Ambiguous session prefix: ${id}`);
    const meta = matches[0];
    const existing = this.handles.get(meta.conversationId);
    if (existing) return existing;
    const lock = await SessionLock.acquire(this.lockPath(meta.conversationId));
    try {
      const headerLines = this.readDiscoveryRecords(path.join(this.directory, meta.fileName));
      let header: SessionHeader;
      try {
        header = headerLines.next().value!.payload as unknown as SessionHeader;
      } finally {
        headerLines.return(undefined);
      }
      if (
        header.conversationId !== meta.conversationId ||
        normalizedProjectRoot(header.projectRoot) !==
          normalizedProjectRoot(this.project.projectRoot)
      )
        throw new Error('Foreign session identity');
      const store = await SessionStore.open(path.join(this.directory, meta.fileName));
      if ((await store.loadState()).header.conversationId !== meta.conversationId)
        throw new Error('Session identity mismatch');
      await store.load();
      return await this.attach(store, lock);
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  /** 继续最近有正文的会话；没有历史才新建，显式打开失败绝不回退为空会话。 */
  async continueRecent(): Promise<ManagedSession> {
    const latest = (await this.allMetadata()).find((m) => m.messageCount > 0);
    if (latest) return this.open(latest.conversationId);
    this.report('No previous session with content; created a new session');
    return this.create();
  }

  /** 标题作为独立耐久记录；标题或浏览不改变正文活动排序。 */
  async rename(id: string, title: string): Promise<void> {
    if (!title.trim()) throw new Error('Session title cannot be empty');
    const handle = await this.open(id);
    await handle.store.appendRecord('title', { title: sanitizeSessionTitle(title) });
  }

  /** 等候所有存储队列后释放句柄；宿主必须先结束 AgentSession 的工具/摘要清理。 */
  async close(): Promise<void> {
    for (const handle of [...this.handles.values()]) await handle.release();
  }

  /**
   * 只发现 cwd 和工作树根的旧文件；来源快照 hash 幂等，完整临时文件 fsync 后独占安装。
   * 保留源文件，安装身份写入头部，缓存丢失或进程退出后仍不会重复导入。
   */
  async importLegacy(): Promise<string[]> {
    const imported: string[] = [];
    const sources = new Set(
      [this.project.cwd, this.project.projectRoot].map((root) =>
        path.join(root, '.kapibala', 'history.jsonl'),
      ),
    );
    for (const source of sources) {
      if (!fs.existsSync(source)) continue;
      const before = fs.statSync(source);
      const bytes = fs.readFileSync(source);
      const identity = createHash('sha256')
        .update(fs.realpathSync.native(source))
        .update('\0')
        .update(bytes)
        .digest('hex');
      const importLock = await SessionLock.acquire(
        path.join(this.directory, `import-${identity}.lock`),
      );
      let temp: string | undefined;
      try {
        if ((await this.allMetadata()).some((m) => m.importIdentity === identity)) continue;
        const lines = bytes
          .toString('utf8')
          .split('\n')
          .filter((line) => line.trim());
        const raw = lines.map((line) => {
          const r = JSON.parse(line);
          if (
            !['user', 'assistant', 'tool', 'system'].includes(r.role) ||
            !Array.isArray(r.content)
          )
            throw new Error('Invalid legacy history');
          return {
            role: r.role,
            content: r.content,
            timestamp: r.ts,
            id: r.id,
            interactionId: r.interactionId,
            state: r.state,
          } as CanonicalMessage;
        });
        if (!raw.length) continue;
        const id = createMessageId();
        const target = path.join(this.directory, `${Date.now()}_${id}.jsonl`);
        temp = `${target}.tmp-${createMessageId()}`;
        const store = await SessionStore.create(temp, {
          conversationId: id,
          projectRoot: this.project.projectRoot,
          initialCwd: this.project.cwd,
          gitBranch: this.project.gitBranch,
          importIdentity: identity,
        });
        await store.appendRecord('legacy_import', { source, identity });
        await store.appendRecord('title', { title: '旧历史导入' });
        for (const message of identifyHistory(raw, identity)) await store.append(message);
        await store.load();
        const after = fs.statSync(source);
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          !fs.readFileSync(source).equals(bytes)
        ) {
          this.report('Legacy history is changing; import postponed');
          continue;
        }
        fs.linkSync(temp, target);
        syncSessionDirectory(this.directory);
        try {
          this.writeMetadata(target, this.buildMetadata(target, await store.readRecords()));
        } catch {
          this.report('Imported session metadata update failed');
        }
        imported.push(id);
      } catch (error) {
        this.report(
          `Legacy import failed: ${error instanceof Error ? error.message : 'unknown error'}`,
        );
      } finally {
        if (temp && fs.existsSync(temp)) fs.unlinkSync(temp);
        await importLock.release();
      }
    }
    return imported;
  }

  /** 绑定写后缓存与锁生命周期；正文优先，缓存失败不使保存成功的消息消失。 */
  private async attach(store: SessionStore, lock: SessionLock): Promise<ManagedSession> {
    const state = await store.loadState();
    const header = state.header;
    try {
      this.writeMetadata(
        store.filePath,
        this.buildMetadata(store.filePath, await store.readRecords()),
      );
    } catch {
      this.report('Session metadata cache update failed');
    }
    store.setAppendObserver(
      (record) => {
        // 此时正文已变化，缓存仍可用于增量更新，不能用旧 stat 判断为无效。
        const previous = JSON.parse(
          fs.readFileSync(this.metadataPath(store.filePath), 'utf8'),
        ) as SessionMetadata;
        if (
          previous.conversationId !== header.conversationId ||
          previous.revision !== record.parentId
        )
          throw new Error('Metadata source mismatch');
        this.applyRecord(previous, record);
        const stat = fs.statSync(store.filePath);
        this.writeMetadata(store.filePath, {
          ...previous,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          revision: record.recordId,
        });
      },
      (message) => this.report(message),
    );
    const manager = this;
    const handle: ManagedSession = {
      conversationId: header.conversationId,
      store,
      header,
      metadataPath: this.metadataPath(store.filePath),
      get metadata() {
        return manager.readMetadata(store.filePath);
      },
      branchDrift:
        header.gitBranch !== this.project.gitBranch
          ? { createdBranch: header.gitBranch, currentBranch: this.project.gitBranch }
          : undefined,
      release: async () => {
        try {
          await store.readRecords();
        } catch (error) {
          // 回读失败（磁盘故障、正文尾部残片）不得阻止锁释放，否则活进程内该会话
          // 既不能续写也不能再打开；数据事实以已 fsync 的正文为准，异常只做诊断。
          this.report(
            `Session ${header.conversationId} read-back during release failed: ${(error as Error).message}`,
          );
        } finally {
          await lock.release();
          this.handles.delete(header.conversationId);
        }
      },
    };
    this.handles.set(header.conversationId, handle);
    return handle;
  }

  /** 缓存通过文件名、身份、统计与正文 stat 校验；失败交由正文重建。 */
  private readMetadata(file: string): SessionMetadata | undefined {
    try {
      const meta = JSON.parse(fs.readFileSync(this.metadataPath(file), 'utf8')) as SessionMetadata;
      const stat = fs.statSync(file);
      if (
        meta.schemaVersion === 1 &&
        meta.fileName === path.basename(file) &&
        typeof meta.conversationId === 'string' &&
        path.basename(file).endsWith(`_${meta.conversationId}.jsonl`) &&
        normalizedProjectRoot(meta.projectRoot) ===
          normalizedProjectRoot(this.project.projectRoot) &&
        typeof meta.title === 'string' &&
        Number.isFinite(meta.createdAt) &&
        Number.isFinite(meta.lastActivityAt) &&
        Number.isSafeInteger(meta.messageCount) &&
        meta.messageCount >= 0 &&
        typeof meta.revision === 'string' &&
        meta.size === stat.size &&
        meta.mtimeMs === stat.mtimeMs
      )
        return meta;
    } catch {
      /* 缓存不是唯一真源。 */
    }
    return undefined;
  }

  /** 浏览仅解析完整记录；严格打开由 SessionStore 验证，浏览不能改写残片。 */
  private *readDiscoveryRecords(file: string): Generator<SessionRecord> {
    const iterator = readJsonlLines(file);
    let first = true;
    let blankSeen = false;
    for (const line of iterator) {
      if (!line.text.trim()) {
        blankSeen = true;
        continue;
      }
      if (blankSeen) throw new Error('Session corrupt');
      let record: SessionRecord;
      try {
        record = JSON.parse(line.text);
      } catch {
        if (first || Array.from(iterator).some((next) => next.text.trim()))
          throw new Error('Session corrupt');
        return;
      }
      if (record.schemaVersion !== 1 || (first && record.type !== 'header'))
        throw new Error('Unsupported session schema');
      first = false;
      yield record;
    }
    if (first) throw new Error('Session corrupt header');
  }

  /** 从正文重建元数据，标题和上下文事件不改变内容活动时间。 */
  private buildMetadata(file: string, records: Iterable<SessionRecord>): SessionMetadata {
    const iterator = records[Symbol.iterator]();
    try {
      const first = iterator.next();
      if (first.done) throw new Error('Session corrupt header');
      const header = first.value.payload as unknown as SessionHeader;
      if (
        normalizedProjectRoot(header.projectRoot) !==
          normalizedProjectRoot(this.project.projectRoot) ||
        !path.basename(file).endsWith(`_${header.conversationId}.jsonl`)
      )
        throw new Error('Foreign session identity');
      const stat = fs.statSync(file);
      const metadata: SessionMetadata = {
        schemaVersion: 1,
        conversationId: header.conversationId,
        fileName: path.basename(file),
        projectRoot: header.projectRoot,
        createdAt: header.createdAt ?? first.value.timestamp,
        lastActivityAt: header.createdAt ?? first.value.timestamp,
        messageCount: 0,
        title: '新会话',
        gitBranch: header.gitBranch,
        lastActivityGitBranch: header.gitBranch,
        importIdentity: header.importIdentity,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        revision: first.value.recordId,
      };
      while (true) {
        const next = iterator.next();
        if (next.done) break;
        this.applyRecord(metadata, next.value);
        metadata.revision = next.value.recordId;
      }
      return metadata;
    } finally {
      iterator.return?.();
    }
  }

  /** 只由正文、用户 run 与 reset 更新活动；usage、标题、摘要均不能把浏览对象置顶。 */
  private applyRecord(meta: SessionMetadata, record: SessionRecord): void {
    if (record.type === 'message') {
      meta.messageCount++;
      meta.lastActivityAt = record.timestamp;
      if (!meta.customTitle && meta.title === '新会话' && record.payload.role === 'user') {
        const content = record.payload.content as CanonicalMessage['content'];
        const first = content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim();
        if (first) meta.title = sanitizeSessionTitle(first, 80);
      }
    } else if (record.type === 'title') {
      meta.customTitle = sanitizeSessionTitle(String(record.payload.title));
      meta.title = meta.customTitle;
    } else if (record.type === 'run_started') {
      meta.lastActivityAt = record.timestamp;
      meta.lastActivityGitBranch = record.payload.gitBranch as string | undefined;
      meta.lastModelId = record.payload.modelId as string | undefined;
    } else if (record.type === 'reset') {
      meta.messageCount = 0;
      meta.lastActivityAt = record.timestamp;
      if (!meta.customTitle) meta.title = '新会话';
    }
  }

  /** 临时 sidecar 完整写入后替换，可重建缓存不承担正文提交职责。 */
  private writeMetadata(file: string, meta: SessionMetadata): void {
    const target = this.metadataPath(file);
    const temp = `${target}.tmp-${createMessageId()}`;
    try {
      fs.writeFileSync(temp, JSON.stringify(meta), { flag: 'wx' });
      fs.renameSync(temp, target);
    } finally {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
    }
  }

  private metadataPath(file: string): string {
    const id = path.basename(file, '.jsonl').split('_').at(-1)!;
    return path.join(path.dirname(file), `${id}.meta.json`);
  }
  private lockPath(id: string): string {
    return path.join(this.directory, `${id}.lock`);
  }
  private report(message: string): void {
    try {
      this.diagnostic?.(message);
    } catch {
      /* 诊断不得改变存储语义。 */
    }
  }
}
