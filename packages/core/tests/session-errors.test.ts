import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionLock } from '../src/context/session-lock.js';
import { SessionManager } from '../src/context/session-manager.js';

describe('stable session error classifications', () => {
  it('classifies live locks, recovery and changed release ownership without parsing messages', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-error-'));
    try {
      const lockPath = path.join(root, 'lock');
      const lock = await SessionLock.acquire(lockPath);
      await expect(SessionLock.acquire(lockPath)).rejects.toMatchObject({ code: 'SESSION_LOCKED' });
      fs.mkdirSync(`${lockPath}.recovery`);
      fs.writeFileSync(
        path.join(`${lockPath}.recovery`, 'owner.json'),
        JSON.stringify({ nonce: 'recovery', pid: process.pid, createdAt: Date.now() }),
      );
      await expect(SessionLock.acquire(lockPath)).rejects.toMatchObject({
        code: 'SESSION_RECOVERY_IN_PROGRESS',
      });
      fs.rmSync(`${lockPath}.recovery`, { recursive: true });
      fs.writeFileSync(
        path.join(lockPath, 'owner.json'),
        JSON.stringify({ nonce: 'changed', pid: process.pid, createdAt: Date.now() }),
      );
      await expect(lock.release()).rejects.toMatchObject({ code: 'SESSION_LOCK_OWNER_CHANGED' });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('classifies missing sessions and invalid history pages at their source', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-error-manager-'));
    const manager = new SessionManager({ workspaceRoot: root, homeDirectory: root });
    try {
      await expect(manager.open('absent')).rejects.toMatchObject({ code: 'SESSION_NOT_FOUND' });
      await expect(manager.list(0)).rejects.toMatchObject({ code: 'HISTORY_PAGE_INVALID' });
    } finally {
      await manager.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('stale lock recovery with process identity', () => {
  function writeOwner(lockPath: string, owner: Record<string, unknown>): void {
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(owner));
  }

  /**
   * 探测钩子：真实实现依赖 `ps`/PowerShell，沙箱等受限环境会 spawn EPERM。
   * 测试注入确定的存活时长（毫秒），绕开平台命令的可得性问题。
   */
  function hookProbe(elapsed: () => number | undefined): () => void {
    const target = SessionLock as unknown as {
      probeElapsedMs: (pid: number) => Promise<number | undefined>;
    };
    const original = target.probeElapsedMs;
    target.probeElapsedMs = async () => elapsed();
    return () => {
      target.probeElapsedMs = original;
    };
  }

  it('recovers a lock whose pid was reused and keeps genuinely live locks', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-lock-id-'));
    // 注入「持有者只活了 5 秒」的探测结果，模拟 pid 被新进程复用。
    const restore = hookProbe(() => 5_000);
    try {
      const lockPath = path.join(root, 'lock');
      // pid 复用场景：pid 是本进程（探测存活），但记录的进程起点在一小时前——
      // 实际存活时长与记录起点对不上，判定原持有者已死，允许保守回收。
      writeOwner(lockPath, {
        nonce: 'ghost',
        pid: process.pid,
        createdAt: Date.now() - 3_600_000,
        startedAt: Date.now() - 3_600_000,
      });
      const lock = await SessionLock.acquire(lockPath);
      // 新写的锁必须携带 startedAt，供后续判定 pid 复用。
      const written = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as {
        startedAt?: number;
      };
      expect(Number.isFinite(written.startedAt)).toBe(true);
      await lock.release();

      // 真正存活的持有者（本进程、起点与探测吻合）依旧不可抢占。
      restore();
      const restoreLive = hookProbe(() => process.uptime() * 1000);
      try {
        writeOwner(lockPath, {
          nonce: 'live',
          pid: process.pid,
          createdAt: Date.now(),
          startedAt: Date.now() - process.uptime() * 1000,
        });
        await expect(SessionLock.acquire(lockPath)).rejects.toMatchObject({
          code: 'SESSION_LOCKED',
        });

        // 旧格式锁（无 startedAt）保持原语义：pid 存活 → 不回收。
        writeOwner(lockPath, { nonce: 'legacy', pid: process.pid, createdAt: Date.now() });
        await expect(SessionLock.acquire(lockPath)).rejects.toMatchObject({
          code: 'SESSION_LOCKED',
        });
      } finally {
        restoreLive();
      }
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('sweeps confirmed-dead and stale corrupt locks while keeping live ones', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-lock-sweep-'));
    // 探测按 pid 区分结果：ghost/live 都写本进程 pid，用 startedAt 与注入值的组合区分。
    // 这里统一注入「存活 5 秒」：ghost 锁（起点一小时前）判定死亡，live 锁（起点刚同步给 5 秒）判定存活。
    const restore = hookProbe(() => 5_000);
    try {
      const dead = path.join(root, 'bucket-a', 'dead.lock');
      writeOwner(dead, {
        nonce: 'd',
        pid: process.pid,
        createdAt: Date.now() - 3_600_000,
        startedAt: Date.now() - 3_600_000,
      });
      const live = path.join(root, 'bucket-a', 'live.lock');
      writeOwner(live, {
        nonce: 'l',
        pid: process.pid,
        createdAt: Date.now(),
        startedAt: Date.now() - 5_000,
      });
      const legacy = path.join(root, 'bucket-a', 'legacy.lock');
      writeOwner(legacy, { nonce: 'g', pid: process.pid, createdAt: Date.now() });
      const corrupt = path.join(root, 'bucket-b', 'corrupt.lock');
      writeOwner(corrupt, {});
      const fresh = path.join(root, 'bucket-b', 'fresh.lock');
      writeOwner(fresh, {});
      // 损坏锁只有超过宽限期才允许清扫；把 mtime 拨回两小时前模拟陈旧残留。
      const stale = new Date(Date.now() - 7_200_000);
      fs.utimesSync(corrupt, stale, stale);
      // recovery 目录由 acquire 自愈，不属于清扫范围。
      const recovery = path.join(root, 'bucket-a', 'x.lock.recovery');
      writeOwner(recovery, { nonce: 'r', pid: process.pid, createdAt: Date.now() });

      const removed = await SessionLock.sweepStaleDead(root);
      expect(removed).toBe(2);
      expect(fs.existsSync(dead)).toBe(false);
      expect(fs.existsSync(corrupt)).toBe(false);
      expect(fs.existsSync(live)).toBe(true);
      expect(fs.existsSync(legacy)).toBe(true);
      expect(fs.existsSync(fresh)).toBe(true);
      expect(fs.existsSync(recovery)).toBe(true);
    } finally {
      restore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
