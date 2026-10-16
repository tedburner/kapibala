import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KapibalaError } from '../errors/index.js';
import type { CanonicalMessage } from '../types/index.js';
import { createMessageId, identifyHistory } from './history.js';
import { readJsonlLines, syncSessionDirectory } from './jsonl-lines.js';
import { SessionLock } from './session-lock.js';
import {
  MAIN_BRANCH_ID,
  SESSION_SCHEMA_VERSION_V1,
  SESSION_SCHEMA_VERSION_V2,
  type SessionHeader,
  type SessionRecord,
  SessionStore,
  assertClosedToolTransaction,
  isGlobalControlRecordType,
} from './session-store.js';
import { toNativePhysicalPath } from './workspace.js';

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
export function normalizedProjectRoot(root: string): string {
  return process.platform === 'win32' ? root.replaceAll('\\', '/').toLowerCase() : root;
}

/** 解析真实工作树根；同工作树子目录共用桶，非 Git 目录和不同 worktree 独立。不会改变 cwd。 */
export function resolveSessionProject(cwd: string): ProjectIdentity {
  const realCwd = toNativePhysicalPath(cwd);
  let root = realCwd;
  let gitBranch: string | undefined;
  let gitWorktree = false;
  try {
    root = toNativePhysicalPath(
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
  /** 元数据缓存格式版本（1 或 2）。 */
  schemaVersion: number;
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
  /** v1 副本升级的来源身份哈希。 */
  upgradeIdentity?: string;
  size: number;
  mtimeMs: number;
  /** 兼容字段：最后计入的记录 ID。 */
  revision: string;
  /** 会话文件使用的 Schema 版本（1 或 2）。 */
  sessionSchemaVersion?: number;
  /** 物理末记录 ID（与 revision 语义一致）。 */
  logRevision?: string;
  /** 内容正文 revision（仅正文/修复/reset 变化）。 */
  contentRevision?: string;
  /** 当前活动分支 ID（默认 'main'）。 */
  activeBranchId?: string;
  /** 当前活动分支叶子记录 ID。 */
  activeLeafId?: string | null;
  /** 会话是否已归档。 */
  archived?: boolean;
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

/** SessionManager 配置；workspaceRoot/projectRoot/cwd 决定项目桶，homeDirectory 便于测试隔离。 */
export interface SessionManagerOptions {
  /** 显式工作区物理根路径。 */
  workspaceRoot?: string;
  /** 显式项目根路径。 */
  projectRoot?: string;
  /** 执行或参考目录；若未提供工作区根，以此解析项目工作树。 */
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
    const rootCandidate = options.workspaceRoot ?? options.projectRoot ?? options.cwd;
    if (!rootCandidate) {
      throw new KapibalaError('Workspace root is required for SessionManager', {
        code: 'WORKSPACE_ROOT_REQUIRED',
        safeMessage: '必须显式指定工作区根路径或项目目录',
      });
    }
    this.project = resolveSessionProject(rootCandidate);
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

  /** 每页 20 项按正文活动排序；有效 sidecar 只读元数据，不读取完整 JSONL。默认排除已归档会话。 */
  async list(
    page = 1,
    options?: { includeArchived?: boolean },
  ): Promise<{ items: SessionMetadata[]; total: number; page: number; pages: number }> {
    if (!Number.isSafeInteger(page) || page < 1)
      throw new Error('History page must be a positive integer');
    const all = await this.allMetadata();
    const filtered = options?.includeArchived ? all : all.filter((m) => !m.archived);
    return {
      items: filtered.slice((page - 1) * 20, page * 20),
      total: filtered.length,
      page,
      pages: Math.max(1, Math.ceil(filtered.length / 20)),
    };
  }

  /** 解析完整 ID 或唯一前缀对应的会话文件与 ID。 */
  private resolveSession(id: string): { fileName: string; conversationId: string } {
    if (!id || !/^[a-zA-Z0-9-]+$/.test(id)) throw new Error('Session not found');
    const all = fs
      .readdirSync(this.directory)
      .filter((name) => /^\d+_[a-zA-Z0-9-]+\.jsonl$/.test(name))
      .map((fileName) => ({
        fileName,
        conversationId: fileName.slice(fileName.indexOf('_') + 1, -6),
      }));
    const exact = all.find((m) => m.conversationId === id || m.fileName === id);
    const matches = exact ? [exact] : all.filter((m) => m.conversationId.startsWith(id));
    if (!matches.length) throw new Error(`Session not found: ${id}`);
    if (matches.length !== 1) throw new Error(`Ambiguous session prefix: ${id}`);
    return matches[0];
  }

  /**
   * 逻辑归档指定会话。
   *
   * 约束：
   * - 必须取得会话独占锁；
   * - 若会话当前正处于活动打开状态，拒绝归档并抛出 SESSION_IN_USE；
   * - 向会话正文追加 archive_state { archived: true } 并刷新 sidecar 缓存。
   */
  async archiveSession(id: string): Promise<void> {
    const { fileName, conversationId } = this.resolveSession(id);
    if (this.handles.has(conversationId)) {
      throw new KapibalaError('Session is currently active or in use, cannot archive', {
        code: 'SESSION_IN_USE',
        safeMessage: '会话正在使用中，无法归档',
      });
    }

    const targetFile = path.join(this.directory, fileName);
    const lock = await SessionLock.acquire(this.lockPath(conversationId));
    try {
      const store = await SessionStore.open(targetFile);
      if (store.isReadOnly()) {
        throw new KapibalaError('Cannot archive legacy v1 session', {
          code: 'LEGACY_SESSION_READ_ONLY',
          safeMessage: '无法变更只读历史会话的归档状态',
        });
      }
      await store.setArchiveState(true);
      const records = await store.readRecords();
      const meta = this.buildMetadata(targetFile, records);
      meta.archived = true;
      this.writeMetadata(targetFile, meta);
    } finally {
      await lock.release();
    }
  }

  /**
   * 恢复已逻辑归档的会话。
   */
  async restoreSession(id: string): Promise<void> {
    const { fileName, conversationId } = this.resolveSession(id);
    const targetFile = path.join(this.directory, fileName);
    const lock = await SessionLock.acquire(this.lockPath(conversationId));
    try {
      const store = await SessionStore.open(targetFile);
      if (store.isReadOnly()) {
        throw new KapibalaError('Cannot restore legacy v1 session', {
          code: 'LEGACY_SESSION_READ_ONLY',
          safeMessage: '无法变更只读历史会话的归档状态',
        });
      }
      await store.setArchiveState(false);
      const records = await store.readRecords();
      const meta = this.buildMetadata(targetFile, records);
      meta.archived = false;
      this.writeMetadata(targetFile, meta);
    } finally {
      await lock.release();
    }
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

  /**
   * 打开完整 ID 或唯一前缀；跨桶、缺失与歧义均失败，同一 Manager 已持有的目标直接返回。
   *
   * @param id 完整会话 ID 或唯一前缀
   * @param options 可选参数，autoUpgradeLegacy 为 true 时若目标为 v1 旧会话则自动创建/复用 v2 副本以支持无感续写
   */
  async open(id: string, options?: { autoUpgradeLegacy?: boolean }): Promise<ManagedSession> {
    const meta = this.resolveSession(id);
    const shouldUpgrade = options?.autoUpgradeLegacy ?? true;
    const existing = this.handles.get(meta.conversationId);
    if (existing) {
      if (!shouldUpgrade || existing.store.getSchemaVersion() !== SESSION_SCHEMA_VERSION_V1) {
        return existing;
      }
    }
    if (shouldUpgrade) {
      const probeLines = this.readDiscoveryRecords(path.join(this.directory, meta.fileName));
      let isV1 = false;
      try {
        const probeRecord = probeLines.next().value;
        if (probeRecord && probeRecord.schemaVersion === SESSION_SCHEMA_VERSION_V1) {
          isV1 = true;
        }
      } finally {
        probeLines.return(undefined);
      }
      if (isV1) {
        return this.upgradeLegacyV1Session(meta.conversationId);
      }
    }
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
  async continueRecent(options?: { autoUpgradeLegacy?: boolean }): Promise<ManagedSession> {
    const latest = (await this.allMetadata()).find((m) => m.messageCount > 0);
    if (latest)
      return this.open(latest.conversationId, {
        autoUpgradeLegacy: options?.autoUpgradeLegacy ?? true,
      });
    this.report('No previous session with content; created a new session');
    return this.create();
  }

  /** 标题作为独立耐久记录；标题或浏览不改变正文活动排序。 */
  async rename(id: string, title: string): Promise<void> {
    if (!title.trim()) throw new Error('Session title cannot be empty');
    const handle = await this.open(id, { autoUpgradeLegacy: true });
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

  /**
   * 将旧版 v1 会话升级为独立的 v2 会话副本。
   *
   * 保证与约束：
   * - 原 v1 会话文件保持只读且绝不进行原地修改；
   * - 升级生成全新独立会话文件，Header 中记录 upgradeIdentity；
   * - 幂等：若同一 v1 文件已升级过，直接返回已有 v2 会话句柄，不重复生成副本；
   * - 升级过程使用单写者锁保护临时文件，原子发布；
   * - 失败时不污染目标桶目录。
   *
   * @param idOrFileName 原会话 conversationId 或文件名（如 `xxx.jsonl`）
   * @returns 升级后的独立 v2 会话句柄（持有写者锁）
   */
  async upgradeLegacyV1Session(idOrFileName: string): Promise<ManagedSession> {
    if (!idOrFileName) throw new Error('Session ID or file name is required');
    let sourceFileName: string;
    if (idOrFileName.endsWith('.jsonl')) {
      sourceFileName = path.basename(idOrFileName);
    } else {
      const all = fs
        .readdirSync(this.directory)
        .filter((name) => /^\d+_[a-zA-Z0-9-]+\.jsonl$/.test(name))
        .map((fileName) => ({
          fileName,
          conversationId: fileName.slice(fileName.indexOf('_') + 1, -6),
        }));
      const exact = all.find((m) => m.conversationId === idOrFileName);
      const matches = exact
        ? [exact]
        : all.filter((m) => m.conversationId.startsWith(idOrFileName));
      if (!matches.length) throw new Error(`Session not found: ${idOrFileName}`);
      if (matches.length !== 1) throw new Error(`Ambiguous session prefix: ${idOrFileName}`);
      sourceFileName = matches[0].fileName;
    }

    const sourcePath = path.join(this.directory, sourceFileName);
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`Session not found: ${idOrFileName}`);
    }

    const nativeSource = toNativePhysicalPath(sourcePath);
    const beforeStat = fs.statSync(nativeSource);
    const bytes = fs.readFileSync(nativeSource);
    const upgradeIdentity = createHash('sha256')
      .update(nativeSource)
      .update('\0')
      .update(bytes)
      .digest('hex');

    // 幂等快速检查：如果已有 v2 会话副本，直接打开返回
    const existingMeta = (await this.allMetadata()).find(
      (m) => m.upgradeIdentity === upgradeIdentity,
    );
    if (existingMeta) {
      return this.open(existingMeta.conversationId);
    }

    const upgradeLock = await SessionLock.acquire(
      path.join(this.directory, `upgrade-${upgradeIdentity}.lock`),
    );
    let tempPath: string | undefined;
    try {
      // 二次检查（防止并发升级）
      const doubleCheck = (await this.allMetadata()).find(
        (m) => m.upgradeIdentity === upgradeIdentity,
      );
      if (doubleCheck) {
        return this.open(doubleCheck.conversationId);
      }

      const sourceStore = await SessionStore.open(nativeSource);
      if (sourceStore.getSchemaVersion() !== SESSION_SCHEMA_VERSION_V1) {
        const state = await sourceStore.loadState();
        return this.open(state.header.conversationId);
      }

      const oldRecords = await sourceStore.readRecords();
      if (!oldRecords.length || oldRecords[0].type !== 'header') {
        throw new Error('Session corrupt header');
      }

      const newConversationId = createMessageId();
      const targetFileName = `${Date.now()}_${newConversationId}.jsonl`;
      const targetPath = path.join(this.directory, targetFileName);
      tempPath = `${targetPath}.tmp-${createMessageId()}`;

      const v2Records: SessionRecord[] = [];
      const oldHeader = oldRecords[0].payload as unknown as SessionHeader;
      const newHeaderRecord: SessionRecord = {
        schemaVersion: SESSION_SCHEMA_VERSION_V2,
        type: 'header',
        recordId: oldRecords[0].recordId,
        timestamp: oldRecords[0].timestamp,
        seq: 0,
        prevRecordId: null,
        parentId: null,
        branchId: null,
        payload: {
          ...oldHeader,
          conversationId: newConversationId,
          parentSessionId: oldHeader.conversationId,
          upgradeIdentity,
        },
      };
      v2Records.push(newHeaderRecord);

      let lastBranchRecordId: string = newHeaderRecord.recordId;
      for (let i = 1; i < oldRecords.length; i++) {
        const rec = oldRecords[i];
        const prevRec = v2Records[i - 1];
        const isControl = isGlobalControlRecordType(rec.type);

        let parentId: string | null = null;
        let branchId: string | null = null;
        if (!isControl) {
          branchId = MAIN_BRANCH_ID;
          parentId = lastBranchRecordId;
          lastBranchRecordId = rec.recordId;
        }

        v2Records.push({
          schemaVersion: SESSION_SCHEMA_VERSION_V2,
          type: rec.type,
          recordId: rec.recordId,
          timestamp: rec.timestamp,
          seq: i,
          prevRecordId: prevRec.recordId,
          parentId,
          branchId,
          payload: structuredClone(rec.payload),
        });
      }

      const fd = fs.openSync(tempPath, 'wx', 0o600);
      try {
        for (const record of v2Records) {
          fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      // 复核源文件未在升级过程中被篡改
      const afterStat = fs.statSync(nativeSource);
      if (
        beforeStat.size !== afterStat.size ||
        beforeStat.mtimeMs !== afterStat.mtimeMs ||
        !fs.readFileSync(nativeSource).equals(bytes)
      ) {
        throw new Error('Source legacy session changed during upgrade; retry aborted');
      }

      fs.renameSync(tempPath, targetPath);
      syncSessionDirectory(this.directory);

      return await this.open(newConversationId);
    } finally {
      if (tempPath && fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* 忽略清理错误 */
        }
      }
      await upgradeLock.release();
    }
  }

  /**
   * 从当前会话的指定路径（指定分支或切点）导出生成全新的独立会话文件。
   *
   * 保证与约束：
   * - 新会话拥有全新独立的 conversationId；
   * - Header 记录 parentSessionId 与 forkPointRecordId；
   * - 仅复制导出路径上的必需状态，映射为新会话的 main 分支并重排连续 seq/prevRecordId；
   * - 拒绝半事务分叉：切点若为未闭合工具调用的 assistant 消息，立即报错；
   * - 历史 usage 标为导入来源（importedFromFork: true），不重复计入新会话执行费用；
   * - 临时文件写入、fsync 后原子发布，同步目录；
   * - 导出失败绝不污染或修改源会话。
   *
   * @param options 导出配置
   * @returns 新独立会话句柄（持有写者锁）
   */
  async forkSession(options: {
    sourceSessionId: string;
    branchId?: string;
    forkPointRecordId?: string;
  }): Promise<ManagedSession> {
    const { sourceSessionId, branchId: optionBranchId, forkPointRecordId } = options;
    const { conversationId: resolvedConversationId } = this.resolveSession(sourceSessionId);
    const wasAlreadyOpen = this.handles.has(resolvedConversationId);
    const source = await this.open(sourceSessionId);
    let tempPath: string | undefined;
    try {
      const allRecords = await source.store.readRecords();
      if (!allRecords.length || allRecords[0].type !== 'header') {
        throw new Error('Session corrupt header');
      }

      const branchId = optionBranchId ?? source.store.getActiveBranchId();
      const branchLeaves = source.store.getBranchLeaves();
      const actualForkPointId =
        forkPointRecordId ?? branchLeaves.get(branchId) ?? allRecords[0].recordId;

      const recordMap = new Map<string, SessionRecord>();
      for (const r of allRecords) {
        recordMap.set(r.recordId, r);
      }

      const forkRecord = recordMap.get(actualForkPointId);
      if (!forkRecord) {
        throw new Error(`Fork point record not found: ${actualForkPointId}`);
      }

      // 拒绝未闭合工具事务分叉
      assertClosedToolTransaction(allRecords, actualForkPointId);

      // 沿 parentId 回溯收集分支因果链
      const chainRecordIds = new Set<string>();
      let currId: string | null = actualForkPointId;
      while (currId) {
        chainRecordIds.add(currId);
        const rec = recordMap.get(currId);
        if (!rec) {
          throw new Error(`Broken causal chain: record ${currId} not found`);
        }
        currId = rec.parentId;
      }

      // 确定切点在物理序列中的位置
      const cutoffIndex = allRecords.findIndex((r) => r.recordId === actualForkPointId);
      const relevantRecords = allRecords.slice(1, cutoffIndex + 1);

      // 筛选在新会话中导出的记录：因果链上的记录，以及切点之前的 title 与 usage 全局记录
      const selectedSourceRecords = relevantRecords.filter((rec) => {
        if (chainRecordIds.has(rec.recordId)) return true;
        if (rec.type === 'title' || rec.type === 'usage') return true;
        return false;
      });

      const newConversationId = createMessageId();
      const targetFileName = `${Date.now()}_${newConversationId}.jsonl`;
      const targetPath = path.join(this.directory, targetFileName);
      tempPath = `${targetPath}.tmp-${createMessageId()}`;

      const v2Records: SessionRecord[] = [];
      const oldHeader = allRecords[0].payload as unknown as SessionHeader;
      const newHeaderRecord: SessionRecord = {
        schemaVersion: SESSION_SCHEMA_VERSION_V2,
        type: 'header',
        recordId: allRecords[0].recordId,
        timestamp: Date.now(),
        seq: 0,
        prevRecordId: null,
        parentId: null,
        branchId: null,
        payload: {
          ...oldHeader,
          conversationId: newConversationId,
          parentSessionId: oldHeader.conversationId,
          forkPointRecordId: actualForkPointId,
          upgradeIdentity: undefined,
        },
      };
      v2Records.push(newHeaderRecord);

      let lastBranchRecordId: string = newHeaderRecord.recordId;
      for (let i = 0; i < selectedSourceRecords.length; i++) {
        const rec = selectedSourceRecords[i];
        const prevRec = v2Records.at(-1)!;
        const isControl = isGlobalControlRecordType(rec.type);

        let parentId: string | null = null;
        let branchId: string | null = null;
        if (!isControl) {
          branchId = MAIN_BRANCH_ID;
          parentId = lastBranchRecordId;
          lastBranchRecordId = rec.recordId;
        }

        const payload = structuredClone(rec.payload);
        if (rec.type === 'usage') {
          payload.importedFromFork = true;
        }

        v2Records.push({
          schemaVersion: SESSION_SCHEMA_VERSION_V2,
          type: rec.type,
          recordId: rec.recordId,
          timestamp: rec.timestamp,
          seq: v2Records.length,
          prevRecordId: prevRec.recordId,
          parentId,
          branchId,
          payload,
        });
      }

      const fd = fs.openSync(tempPath, 'wx', 0o600);
      try {
        for (const record of v2Records) {
          fs.writeFileSync(fd, `${JSON.stringify(record)}\n`);
        }
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }

      fs.renameSync(tempPath, targetPath);
      syncSessionDirectory(this.directory);

      return await this.open(newConversationId);
    } finally {
      if (tempPath && fs.existsSync(tempPath)) {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          /* 忽略清理错误 */
        }
      }
      if (!wasAlreadyOpen) {
        await source.release();
      }
    }
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
        const currentPrev = record.prevRecordId ?? record.parentId;
        if (
          previous.conversationId !== header.conversationId ||
          (currentPrev !== null && currentPrev !== (previous.logRevision ?? previous.revision))
        )
          throw new Error('Metadata source mismatch');
        this.applyRecord(previous, record);
        const stat = fs.statSync(store.filePath);
        previous.activeBranchId = store.getActiveBranchId();
        previous.activeLeafId = store.getBranchLeaves().get(previous.activeBranchId) ?? null;
        this.writeMetadata(store.filePath, {
          ...previous,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          revision: record.recordId,
          logRevision: record.recordId,
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
        (meta.schemaVersion === 1 || meta.schemaVersion === 2) &&
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
      if (
        (record.schemaVersion !== SESSION_SCHEMA_VERSION_V1 &&
          record.schemaVersion !== SESSION_SCHEMA_VERSION_V2) ||
        (first && record.type !== 'header')
      )
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
        schemaVersion: 2,
        sessionSchemaVersion: first.value.schemaVersion,
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
        upgradeIdentity: header.upgradeIdentity,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        revision: first.value.recordId,
        logRevision: first.value.recordId,
        contentRevision: first.value.recordId,
        activeBranchId: MAIN_BRANCH_ID,
        activeLeafId: first.value.recordId,
        archived: false,
      };
      const branchLeaves = new Map<string, string>();
      branchLeaves.set(MAIN_BRANCH_ID, first.value.recordId);
      while (true) {
        const next = iterator.next();
        if (next.done) break;
        this.applyRecord(metadata, next.value, branchLeaves);
        metadata.revision = next.value.recordId;
        metadata.logRevision = next.value.recordId;
      }
      metadata.activeLeafId = branchLeaves.get(metadata.activeBranchId ?? MAIN_BRANCH_ID) ?? null;
      return metadata;
    } finally {
      iterator.return?.();
    }
  }

  /** 只由正文、用户 run 与 reset 更新活动；usage、标题、摘要均不能把浏览对象置顶。 */
  private applyRecord(
    meta: SessionMetadata,
    record: SessionRecord,
    branchLeaves?: Map<string, string>,
  ): void {
    if (record.type === 'message') {
      meta.messageCount++;
      meta.lastActivityAt = record.timestamp;
      meta.contentRevision = record.recordId;
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
      meta.contentRevision = record.recordId;
      if (!meta.customTitle) meta.title = '新会话';
    } else if (
      record.type === 'history_repair' ||
      record.type === 'message_state' ||
      record.type === 'branch_summary'
    ) {
      meta.contentRevision = record.recordId;
    } else if (record.type === 'branch_created') {
      const bId = record.payload.branchId as string;
      const baseId = record.payload.baseRecordId as string;
      if (bId && baseId && branchLeaves) {
        branchLeaves.set(bId, baseId);
      }
    } else if (record.type === 'branch_selected') {
      const bId = record.payload.branchId as string;
      if (bId) meta.activeBranchId = bId;
    } else if (record.type === 'archive_state') {
      meta.archived = Boolean(record.payload.archived);
    }

    if (branchLeaves && !isGlobalControlRecordType(record.type)) {
      const bId = record.branchId ?? meta.activeBranchId ?? MAIN_BRANCH_ID;
      branchLeaves.set(bId, record.recordId);
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
