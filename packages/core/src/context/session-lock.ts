import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createSessionError } from '../errors/index.js';

const execFileAsync = promisify(execFile);

/** pid 复用误判的兜底容差：探测到的存活时长与记录的进程起点偏差超过该值才判定为复用。 */
const PID_REUSE_TOLERANCE_MS = 60_000;
/** owner.json 损坏/缺失的锁目录只有在落盘超过该时长后才允许清扫，给在途获取者留出写入窗口。 */
const UNREADABLE_LOCK_GRACE_MS = 60_000;

interface LockOwner {
  nonce: string;
  pid: number;
  createdAt: number;
  /**
   * 持有者进程的启动时刻（epoch ms，由创建时的 Date.now() - uptime 推得）。
   * 旧格式锁没有该字段；此时只能按 pid 探测，pid 复用会保守地视为存活。
   */
  startedAt?: number;
}

/** 基于目录独占创建的单写者锁；只有能确认死亡的进程才允许保守回收，不按年龄抢占。 */
export class SessionLock {
  private released = false;
  private constructor(
    readonly lockPath: string,
    private readonly owner: LockOwner,
  ) {}

  /** 获取写入权，存活、无权限探测、损坏 owner 或正在回收均明确失败。 */
  static async acquire(lockPath: string): Promise<SessionLock> {
    lockPath = path.resolve(lockPath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const recovery = `${lockPath}.recovery`;
    await SessionLock.ensureNoLiveRecovery(recovery);
    const owner: LockOwner = {
      nonce: randomUUID(),
      pid: process.pid,
      createdAt: Date.now(),
      // 自身进程起点由单调的 uptime 推得，比逐平台读取 ps 更稳定且跨平台一致。
      startedAt: Date.now() - process.uptime() * 1000,
    };
    // 本获取者是否独占创建了 lockPath 目录；失败自清时只有该事实允许删除目录。
    let createdDir = false;
    try {
      fs.mkdirSync(lockPath);
      createdDir = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stale = SessionLock.readOwner(lockPath);
      if (!stale || !(await SessionLock.isOwnerDead(stale)))
        throw createSessionError(
          'SESSION_LOCKED',
          `Session locked by a live or unknown owner${stale ? ` (pid=${stale.pid})` : ''}`,
        );
      try {
        fs.mkdirSync(recovery);
      } catch {
        throw createSessionError(
          'SESSION_RECOVERY_IN_PROGRESS',
          'Session locked: recovery in progress',
        );
      }
      try {
        // 恢复者身份立刻落盘：回收途中崩溃时，后续获取者可凭死亡身份清除残留，
        // 而不是把会话永久卡在 "recovery in progress"。
        fs.writeFileSync(path.join(recovery, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
        const current = SessionLock.readOwner(lockPath);
        if (
          current?.nonce !== stale.nonce ||
          current.pid !== stale.pid ||
          !(await SessionLock.isOwnerDead(current))
        ) {
          throw createSessionError('SESSION_LOCK_OWNER_CHANGED', 'Session locked: owner changed');
        }
        // 回收协调目录阻止新持有者安装；持有者在安装前后均检查它，避免移走新锁。
        const quarantine = `${lockPath}.stale-${randomUUID()}`;
        fs.renameSync(lockPath, quarantine);
        let freshDir = false;
        try {
          fs.mkdirSync(lockPath);
          freshDir = true;
          fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(owner), {
            flag: 'wx',
          });
        } catch (installError) {
          if (freshDir && SessionLock.readOwner(lockPath) === undefined) {
            try {
              fs.rmdirSync(lockPath);
            } catch {
              /* 清理失败不掩盖原始安装错误。 */
            }
          }
          // EEXIST = 并行者抢先重建了锁目录；以其实际 owner 给出一致的失败语义。
          if ((installError as NodeJS.ErrnoException).code === 'EEXIST') {
            const winner = SessionLock.readOwner(lockPath);
            throw createSessionError(
              'SESSION_LOCKED',
              `Session locked by a live or unknown owner${winner ? ` (pid=${winner.pid})` : ''}`,
            );
          }
          throw installError;
        }
        fs.rmSync(quarantine, { recursive: true });
      } finally {
        // force：并行获取者可能已抢先清掉本协调目录；新残留由下次获取清除。
        fs.rmSync(recovery, { recursive: true, force: true });
      }
      return new SessionLock(lockPath, owner);
    }
    try {
      await SessionLock.ensureNoLiveRecovery(recovery);
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
      await SessionLock.ensureNoLiveRecovery(recovery);
      return new SessionLock(lockPath, owner);
    } catch (error) {
      // 仅当本获取者独占创建且 owner 未归属他者时才自清，避免留下无主空锁目录。
      const current = SessionLock.readOwner(lockPath);
      if (createdDir && (current === undefined || current.nonce === owner.nonce)) {
        if (current) fs.unlinkSync(path.join(lockPath, 'owner.json'));
        try {
          fs.rmdirSync(lockPath);
        } catch {
          /* 目录非空等清理失败不掩盖原始错误。 */
        }
      }
      throw error;
    }
  }

  /** 仅释放本 nonce 的锁；调用者必须先等待在途工具、摘要及存储结束。 */
  async release(): Promise<void> {
    if (this.released) return;
    const current = SessionLock.readOwner(this.lockPath);
    if (current?.nonce !== this.owner.nonce || current.pid !== this.owner.pid)
      throw createSessionError('SESSION_LOCK_OWNER_CHANGED', 'Session lock owner changed');
    fs.unlinkSync(path.join(this.lockPath, 'owner.json'));
    fs.rmdirSync(this.lockPath);
    this.released = true;
  }

  /**
   * 保守清扫根目录下持有者已确认死亡的残留锁目录，返回清除数量。
   *
   * 边界与约束：
   * - 只处理以 `.lock` 结尾的目录；`.recovery` 残留由下次 acquire 自愈，不在清扫范围；
   * - 非 lock 目录按桶层级继续下钻（深度受限），lock 目录整体判定、不下钻；
   * - 持有者存活的锁一律不动，包括本进程自己的锁；
   * - owner.json 缺失或损坏的锁仅在目录落盘超过宽限期后清除：在途获取者建目录后
   *   数毫秒内就会写入 owner.json，宽限期内不动它们；
   * - 平台探测不可用（命令缺失、权限不足）时按存活处理，宁可不清扫；
   * - 遍历或探测的任何失败都不中断清扫，也不向外抛出。
   */
  static async sweepStaleDead(root: string): Promise<number> {
    let removed = 0;
    const visit = async (dir: string, depth: number): Promise<void> => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const full = path.join(dir, entry.name);
        if (!entry.name.endsWith('.lock')) {
          if (depth > 0) await visit(full, depth - 1);
          continue;
        }
        const owner = SessionLock.readOwner(full);
        if (owner) {
          if (!(await SessionLock.isOwnerDead(owner))) continue;
        } else {
          try {
            if (Date.now() - fs.statSync(full).mtimeMs < UNREADABLE_LOCK_GRACE_MS) continue;
          } catch {
            continue;
          }
        }
        try {
          fs.rmSync(full, { recursive: true });
          removed += 1;
        } catch {
          /* 清不掉的残留交给下次清扫或下一次 acquire 的保守回收。 */
        }
      }
    };
    try {
      if (!fs.existsSync(root)) return 0;
      await visit(root, 4);
    } catch {
      return removed;
    }
    return removed;
  }

  /** 只认格式完整的 owner；startedAt 字段非法时降级为旧格式（忽略该字段），不视为损坏。 */
  private static readOwner(lockPath: string): LockOwner | undefined {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8')) as
        | (LockOwner & { startedAt?: unknown })
        | undefined;
      if (
        owner &&
        typeof owner.nonce === 'string' &&
        Number.isSafeInteger(owner.pid) &&
        owner.pid > 0 &&
        Number.isFinite(owner.createdAt)
      ) {
        return {
          nonce: owner.nonce,
          pid: owner.pid,
          createdAt: owner.createdAt,
          startedAt:
            typeof owner.startedAt === 'number' && Number.isFinite(owner.startedAt)
              ? owner.startedAt
              : undefined,
        };
      }
    } catch {
      /* 未知持有者不可抢占。 */
    }
    return undefined;
  }

  /**
   * 判定锁持有者是否已死亡；只有「能证明死亡」才返回 true，任何不确定都按存活处理。
   *
   * 判定顺序：
   * 1. pid 探测返回 ESRCH —— 确定死亡；
   * 2. pid 存活且 owner 带 startedAt —— 探测该 pid 当前的存活时长，与「记录的进程
   *    起点到现在的时长」偏差超过容差即判定 pid 已被系统复用：复用意味着原持有者
   *    必然已死亡，锁可保守回收；
   * 3. 其余情况（旧格式锁、探测命令不可用、expected 为负的时钟异常）一律按存活处理。
   */
  private static async isOwnerDead(owner: LockOwner): Promise<boolean> {
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    if (owner.startedAt === undefined) return false;
    const expected = Date.now() - owner.startedAt;
    if (expected < 0) return false;
    const elapsed = await SessionLock.probeElapsedMs(owner.pid);
    if (elapsed === undefined) return false;
    return Math.abs(elapsed - expected) > PID_REUSE_TOLERANCE_MS;
  }

  /**
   * 探测指定 pid 的当前存活时长（毫秒）；探测不到或解析失败返回 undefined。
   *
   * 平台实现：darwin/Linux 用 `ps -o etime=`（`[dd-]hh:mm:ss`）；Windows 用
   * PowerShell 的 StartTime 差值（秒）。两者都是进程存活时长的单调度量，
   * 不依赖额外权限；进程消失或命令失败都归入「探测不可用」。
   */
  private static async probeElapsedMs(pid: number): Promise<number | undefined> {
    try {
      if (process.platform === 'win32') {
        const { stdout } = await execFileAsync(
          'powershell.exe',
          [
            '-NoProfile',
            '-Command',
            `[int]([DateTime]::Now - (Get-Process -Id ${pid}).StartTime).TotalSeconds`,
          ],
          { timeout: 10_000 },
        );
        const seconds = Number.parseFloat(stdout.trim());
        return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined;
      }
      const { stdout } = await execFileAsync('ps', ['-o', 'etime=', '-p', String(pid)], {
        timeout: 10_000,
      });
      return SessionLock.parseEtime(stdout.trim());
    } catch {
      return undefined;
    }
  }

  /** 解析 `ps etime` 输出（`ss` / `mm:ss` / `hh:mm:ss` / `dd-hh:mm:ss`）；非法输入返回 undefined。 */
  private static parseEtime(value: string): number | undefined {
    if (!value) return undefined;
    let days = 0;
    let clock = value;
    const dash = value.indexOf('-');
    if (dash > 0) {
      days = Number.parseInt(value.slice(0, dash), 10);
      if (!Number.isFinite(days)) return undefined;
      clock = value.slice(dash + 1);
    }
    const parts = clock.split(':');
    if (parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return undefined;
    const [ss = '0', mm = '0', hh = '0'] = parts.reverse();
    const total =
      days * 86_400_000 +
      Number.parseInt(hh, 10) * 3_600_000 +
      Number.parseInt(mm, 10) * 60_000 +
      Number.parseInt(ss, 10) * 1000;
    return Number.isFinite(total) ? total : undefined;
  }

  /**
   * 清除上次回收崩溃的残留：无身份标记或标记进程已死亡的 recovery 目录可安全移除；
   * 身份确认存活的回收进行中则保留。清不掉时视为回收进行中，由后续获取者再试。
   */
  private static async clearAbandonedRecovery(recovery: string): Promise<void> {
    if (!fs.existsSync(recovery)) return;
    const marker = SessionLock.readOwner(recovery);
    if (marker && !(await SessionLock.isOwnerDead(marker))) return;
    try {
      fs.rmSync(recovery, { recursive: true, force: true });
    } catch {
      /* 保留残留并在 existsSync 检查处明确失败。 */
    }
  }

  /** 无残留或残留进程已死亡时放行；确认存活的回收进行中则明确失败。 */
  private static async ensureNoLiveRecovery(recovery: string): Promise<void> {
    await SessionLock.clearAbandonedRecovery(recovery);
    if (fs.existsSync(recovery))
      throw createSessionError(
        'SESSION_RECOVERY_IN_PROGRESS',
        'Session locked: recovery in progress',
      );
  }
}
