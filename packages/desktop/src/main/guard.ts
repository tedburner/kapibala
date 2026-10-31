import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** guard 只记录需要人工核查的执行身份，不含会话正文、命令或凭证。 */
export interface GuardRecord {
  hostInstanceId: string;
  startedAt: number;
  workspaces: { id: string; root: string }[];
}

/** Main 持有的异常退出栅栏；文件损坏和清理失败均阻断，不能按 PID 或超时抢占。 */
export class HostGuard {
  private readonly file: string;
  private owner?: string;
  constructor(userData: string) {
    this.file = path.join(userData, 'host-guard.json');
  }

  /** 缺失才视为空闲；无法读取或非法内容也必须走人工恢复。 */
  inspect(): { blocked: boolean; record?: GuardRecord } {
    if (!fs.existsSync(this.file)) return { blocked: false };
    try {
      const record = JSON.parse(fs.readFileSync(this.file, 'utf8')) as GuardRecord;
      if (
        !record ||
        typeof record.hostInstanceId !== 'string' ||
        !Number.isFinite(record.startedAt) ||
        !Array.isArray(record.workspaces) ||
        record.workspaces.some(
          (item) => typeof item.id !== 'string' || typeof item.root !== 'string',
        )
      )
        return { blocked: true };
      return { blocked: true, record };
    } catch {
      return { blocked: true };
    }
  }

  /** 必须在启动 Host 前独占建立；已有 guard 绝不覆盖。 */
  begin(hostInstanceId: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(
        this.file,
        JSON.stringify({ hostInstanceId, startedAt: Date.now(), workspaces: [] }),
        { flag: 'wx', mode: 0o600 },
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('RECOVERY_REQUIRED');
      throw error;
    }
    this.owner = hostInstanceId;
  }

  /** 空间执行前先更新 guard；失败不得继续派发执行。 */
  register(workspace: { id: string; root: string }): void {
    const record = this.owned();
    if (!record.workspaces.some((item) => item.id === workspace.id))
      record.workspaces.push(workspace);
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(record), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }

  /** 只接受当前 Host 的完整清理确认与正常退出，不能仅凭进程退出清除。 */
  complete(facts: { hostInstanceId: string; cleaned: boolean; exitCode: number }): void {
    if (!facts.cleaned || facts.exitCode !== 0) throw new Error('CLEANUP_UNCONFIRMED');
    if (this.owned().hostInstanceId !== facts.hostInstanceId)
      throw new Error('GUARD_OWNER_MISMATCH');
    fs.unlinkSync(this.file);
    this.owner = undefined;
  }

  /** 人工核验后才移走遗留栅栏；调用方必须保证旧 Host 已退出。 */
  recover(facts: { confirmed: boolean; oldHostExited: boolean }): void {
    if (!facts.confirmed || !facts.oldHostExited) throw new Error('RECOVERY_REQUIRED');
    if (fs.existsSync(this.file))
      fs.renameSync(this.file, `${this.file}.recovered-${randomUUID()}`);
    this.owner = undefined;
  }

  private owned(): GuardRecord {
    const { record } = this.inspect();
    if (!record || !this.owner || record.hostInstanceId !== this.owner)
      throw new Error('GUARD_OWNER_MISMATCH');
    return record;
  }
}
