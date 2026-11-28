/**
 * @fileoverview 受管 Git Worktree 元数据登记簿（`~/.kapibala/worktrees/registry.json`）原子持久化存储。
 *
 * 隔离与一致性约束：
 * - 内部统一采用无原型字典（`Object.create(null)` + `Object.hasOwn`），防止原型链属性键污染；
 * - 写入经跨进程 `SessionLock`（`registry.json.lock`）串行化并采用同目录临时文件 + 原子 `renameSync` 落盘；
 * - 查询项目工作树时统一基于 `isSamePath` 对比物理 `projectRoot`，兼容 Windows 盘符大小写与短长名。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionLock, isSamePath, toNativePhysicalPath } from '@kiturone/kapibala';
import { WORKTREE_REGISTRY_FILE_NAME, WorktreeError, type WorktreeRecord } from './types.js';

interface RegistryFileFormat {
  readonly version: 1;
  readonly records: Record<string, WorktreeRecord>;
}

const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const LOCK_WAIT_MS = 20;
const LOCK_TIMEOUT_MS = 10_000;

function renameWithRetry(tempPath: string, targetPath: string): void {
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tempPath, targetPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (
        process.platform === 'win32' &&
        (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY') &&
        attempt < 4
      ) {
        Atomics.wait(waitCell, 0, 0, 20);
        continue;
      }
      throw err;
    }
  }
}

/**
 * 管理 `~/.kapibala/worktrees/registry.json` 读写与原子事务的登记簿存储。
 */
export class WorktreeRegistry {
  private readonly homeDirOverride?: string;

  constructor(options: { readonly homeDir?: string } = {}) {
    this.homeDirOverride = options.homeDir;
  }

  /** 返回受管工作树根目录 `~/.kapibala/worktrees`。 */
  get worktreesRoot(): string {
    const home = this.homeDirOverride ?? os.homedir();
    return path.join(home, '.kapibala', 'worktrees');
  }

  /** 返回登记簿文件路径 `~/.kapibala/worktrees/registry.json`。 */
  get registryFilePath(): string {
    return path.join(this.worktreesRoot, WORKTREE_REGISTRY_FILE_NAME);
  }

  /** 按创建时间倒序列出全部或指定 `projectRoot` 下的受管工作树记录。 */
  list(projectRoot?: string): WorktreeRecord[] {
    const canonicalProject = projectRoot
      ? toNativePhysicalPath(path.resolve(projectRoot))
      : undefined;
    const map = this.readRecordsMap();
    return Object.values(map)
      .filter((rec) => (canonicalProject ? isSamePath(rec.projectRoot, canonicalProject) : true))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  /** 按精确 `id` 查找单条受管工作树记录。 */
  get(id: string): WorktreeRecord | undefined {
    if (!id || RESERVED_KEYS.has(id)) return undefined;
    const map = this.readRecordsMap();
    return Object.hasOwn(map, id) ? map[id] : undefined;
  }

  /** 按工作树物理目录查找匹配的受管工作树记录。 */
  findByWorktreePath(worktreePath: string): WorktreeRecord | undefined {
    let canonical: string;
    try {
      canonical = toNativePhysicalPath(path.resolve(worktreePath));
    } catch {
      return undefined;
    }
    for (const rec of Object.values(this.readRecordsMap())) {
      try {
        if (isSamePath(rec.worktreePath, canonical)) {
          return rec;
        }
      } catch {
        /* 忽略无效历史条目。 */
      }
    }
    return undefined;
  }

  /** 在跨进程锁内新增或更新单条记录。 */
  async upsert(record: WorktreeRecord): Promise<void> {
    if (!record.id || RESERVED_KEYS.has(record.id)) {
      throw new WorktreeError('WORKTREE_GIT_FAILED', `Invalid worktree id: ${record.id}`);
    }
    await this.mutate((map) => {
      map[record.id] = record;
    });
  }

  /** 在跨进程锁内删除指定 `id` 记录（幂等）。 */
  async delete(id: string): Promise<boolean> {
    if (!id || RESERVED_KEYS.has(id)) return false;
    return this.mutate((map) => {
      if (!Object.hasOwn(map, id)) return false;
      delete map[id];
      return true;
    });
  }

  /** 在跨进程锁内批量修改记录表并原子写回。 */
  async mutate<T>(mutator: (records: Record<string, WorktreeRecord>) => T): Promise<T> {
    fs.mkdirSync(this.worktreesRoot, { recursive: true, mode: 0o700 });
    const lockPath = `${this.registryFilePath}.lock`;
    const lock = await acquireRegistryLock(lockPath);
    try {
      const map = this.readRecordsMap();
      const result = mutator(map);
      this.writeRecordsMap(map);
      return result;
    } finally {
      await lock.release();
    }
  }

  private readRecordsMap(): Record<string, WorktreeRecord> {
    const map: Record<string, WorktreeRecord> = Object.create(null);
    if (!fs.existsSync(this.registryFilePath)) {
      return map;
    }
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.registryFilePath, 'utf8'),
      ) as Partial<RegistryFileFormat>;
      if (!raw || typeof raw !== 'object' || !raw.records || typeof raw.records !== 'object') {
        return map;
      }
      for (const [id, value] of Object.entries(raw.records)) {
        if (!id || RESERVED_KEYS.has(id)) continue;
        if (isValidWorktreeRecord(value)) {
          map[id] = value;
        }
      }
    } catch {
      /* 损坏文件降级为空表，避免阻断新建或清理操作。 */
    }
    return map;
  }

  private writeRecordsMap(records: Record<string, WorktreeRecord>): void {
    fs.mkdirSync(this.worktreesRoot, { recursive: true, mode: 0o700 });
    const tempPath = `${this.registryFilePath}.tmp-${process.pid}-${Date.now()}`;
    const payload: RegistryFileFormat = { version: 1, records };
    fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    renameWithRetry(tempPath, this.registryFilePath);
  }
}

function isValidWorktreeRecord(value: unknown): value is WorktreeRecord {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    typeof rec.id === 'string' &&
    typeof rec.bucket === 'string' &&
    typeof rec.projectRoot === 'string' &&
    typeof rec.worktreePath === 'string' &&
    typeof rec.branch === 'string' &&
    typeof rec.baseRef === 'string' &&
    typeof rec.baseCommit === 'string' &&
    typeof rec.createdAt === 'number' &&
    typeof rec.updatedAt === 'number'
  );
}

async function acquireRegistryLock(lockPath: string): Promise<SessionLock> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      return await SessionLock.acquire(lockPath);
    } catch (err) {
      const code = (err as { code?: string }).code;
      const retryable =
        code === 'SESSION_LOCKED' ||
        code === 'SESSION_RECOVERY_IN_PROGRESS' ||
        code === 'SESSION_LOCK_OWNER_CHANGED';
      if (!retryable || Date.now() >= deadline) {
        throw new WorktreeError(
          'WORKTREE_BUSY',
          `Timed out acquiring worktree registry lock: ${(err as Error).message}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
    }
  }
}
