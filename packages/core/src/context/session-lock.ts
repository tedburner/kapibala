import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

interface LockOwner {
  nonce: string;
  pid: number;
  createdAt: number;
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
    SessionLock.ensureNoLiveRecovery(recovery);
    const owner: LockOwner = { nonce: randomUUID(), pid: process.pid, createdAt: Date.now() };
    // 本获取者是否独占创建了 lockPath 目录；失败自清时只有该事实允许删除目录。
    let createdDir = false;
    try {
      fs.mkdirSync(lockPath);
      createdDir = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const stale = SessionLock.readOwner(lockPath);
      if (!stale || !SessionLock.isDead(stale.pid))
        throw new Error(
          `Session locked by a live or unknown owner${stale ? ` (pid=${stale.pid})` : ''}`,
        );
      try {
        fs.mkdirSync(recovery);
      } catch {
        throw new Error('Session locked: recovery in progress');
      }
      try {
        // 恢复者身份立刻落盘：回收途中崩溃时，后续获取者可凭死亡身份清除残留，
        // 而不是把会话永久卡在 "recovery in progress"。
        fs.writeFileSync(path.join(recovery, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
        const current = SessionLock.readOwner(lockPath);
        if (
          current?.nonce !== stale.nonce ||
          current.pid !== stale.pid ||
          !SessionLock.isDead(current.pid)
        ) {
          throw new Error('Session locked: owner changed');
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
            throw new Error(
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
      SessionLock.ensureNoLiveRecovery(recovery);
      fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify(owner), { flag: 'wx' });
      SessionLock.ensureNoLiveRecovery(recovery);
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
      throw new Error('Session lock owner changed');
    fs.unlinkSync(path.join(this.lockPath, 'owner.json'));
    fs.rmdirSync(this.lockPath);
    this.released = true;
  }

  /** 只认格式完整的 owner，缺失与损坏时保持锁而非猜测安全。 */
  private static readOwner(lockPath: string): LockOwner | undefined {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
      if (
        typeof owner.nonce === 'string' &&
        Number.isSafeInteger(owner.pid) &&
        owner.pid > 0 &&
        Number.isFinite(owner.createdAt)
      )
        return owner;
    } catch {
      /* 未知持有者不可抢占。 */
    }
    return undefined;
  }

  /**
   * 清除上次回收崩溃的残留：无身份标记或标记进程已死亡的 recovery 目录可安全移除；
   * 身份确认存活的回收进行中则保留。清不掉时视为回收进行中，由后续获取者再试。
   */
  private static clearAbandonedRecovery(recovery: string): void {
    if (!fs.existsSync(recovery)) return;
    const marker = SessionLock.readOwner(recovery);
    if (marker && !SessionLock.isDead(marker.pid)) return;
    try {
      fs.rmSync(recovery, { recursive: true, force: true });
    } catch {
      /* 保留残留并在 existsSync 检查处明确失败。 */
    }
  }

  /** 无残留或残留进程已死亡时放行；确认存活的回收进行中则明确失败。 */
  private static ensureNoLiveRecovery(recovery: string): void {
    SessionLock.clearAbandonedRecovery(recovery);
    if (fs.existsSync(recovery)) throw new Error('Session locked: recovery in progress');
  }

  /** 仅 ESRCH 表示确定死亡；PID 复用或 EPERM 均保持原锁。 */
  private static isDead(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
  }
}
