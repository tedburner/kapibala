import type { ManagedSession, SessionManager } from '@kiturone/kapibala';

/** 启动参数互斥与缺值校验，必须在创建会话或配置向导之前执行。 */
export function validateSessionStartup(options: { continue?: boolean; resume?: string }): void {
  if (options.continue && options.resume !== undefined)
    throw new Error('--continue 与 --resume 不能同时指定');
  if (options.resume !== undefined && !options.resume.trim())
    throw new Error('--resume 需要会话 ID 或唯一前缀');
}

/** 默认隔离新建；显式恢复失败不替换为空会话，继续最近会话由 Core 确定有内容的目标。 */
export async function openStartupSession(
  manager: SessionManager,
  options: { continue?: boolean; resume?: string },
): Promise<ManagedSession> {
  validateSessionStartup(options);
  if (options.resume !== undefined) return manager.open(options.resume);
  if (options.continue) return manager.continueRecent();
  return manager.create();
}
