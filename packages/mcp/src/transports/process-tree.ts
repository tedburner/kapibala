/**
 * @fileoverview 跨平台子进程树终止与回收工具
 *
 * 约束与边界：
 * 1. 必须彻底回收进程树（包含包装进程与其衍生的全部后代子孙进程），防止留下孤儿进程；
 * 2. Windows 平台采用原生 `taskkill.exe /PID <pid> /T /F`，POSIX 平台采用进程组负 PID 信号递送；
 * 3. 必须通过真实存活轮询核实进程是否已终止，严禁在未确认退出前虚假汇报完成；
 * 4. 超时未退出时返回 false，调用方依此判定清理失败并记录诊断。
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 探测指定 PID 对应的进程是否仍在运行。
 *
 * @param pid - 进程 PID。
 * @returns 进程当前存活返回 true，已退出或不存在返回 false。
 */
export function isProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH';
  }
}

/**
 * 获取 Windows 系统下的 taskkill.exe 绝对物理路径。
 *
 * @returns taskkill 可执行程序路径。
 */
export function getTaskkillPath(): string {
  if (process.platform !== 'win32') return 'taskkill';
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const candidate = path.join(systemRoot, 'System32', 'taskkill.exe');
  try {
    if (fs.existsSync(candidate)) return candidate;
  } catch {
    /* 回退到 PATH 搜索 */
  }
  return 'taskkill.exe';
}

/**
 * 进程树终止选项。
 */
export interface KillProcessTreeOptions {
  /** 等待进程完全退出的超时时间（毫秒），默认 3000ms。 */
  timeoutMs?: number;
  /** POSIX 平台首选递送的信号，默认 'SIGTERM'。 */
  signal?: 'SIGTERM' | 'SIGKILL';
  /** 是否在首选信号超时后自动升级为 SIGKILL 强杀，默认 true。 */
  upgradeToKill?: boolean;
}

/**
 * 在 POSIX 平台上枚举目标进程的所有孙子与后代进程 PID。
 *
 * 保证与约束：
 * - 优先尝试 pgrep -P <pid>；若 pgrep 不可用退化为 ps -o pid= --ppid <pid>；
 * - 广度优先递归遍历所有后代进程；
 * - 容忍命令执行失败，失败时返回空数组，不破坏主进程清理流程。
 *
 * @param rootPid - 祖先进程 PID。
 * @returns 全部发现的后代进程 PID 列表。
 */
export function getPosixDescendantPids(rootPid: number): number[] {
  if (process.platform === 'win32' || !Number.isSafeInteger(rootPid) || rootPid <= 0) {
    return [];
  }
  const descendants: number[] = [];
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    let output = '';
    try {
      const res = spawnSync('pgrep', ['-P', String(parent)], {
        encoding: 'utf-8',
        timeout: 1000,
      });
      if (res.stdout) output = res.stdout;
    } catch {
      /* ignore */
    }
    if (!output) {
      try {
        const res = spawnSync('ps', ['-o', 'pid=', '--ppid', String(parent)], {
          encoding: 'utf-8',
          timeout: 1000,
        });
        if (res.stdout) output = res.stdout;
      } catch {
        /* ignore */
      }
    }
    if (output) {
      const pids = output
        .split('\n')
        .map((s) => Number.parseInt(s.trim(), 10))
        .filter(
          (n) => Number.isSafeInteger(n) && n > 0 && n !== rootPid && !descendants.includes(n),
        );
      for (const child of pids) {
        descendants.push(child);
        queue.push(child);
      }
    }
  }
  return descendants;
}

/**
 * 终止指定 PID 及其全部子进程树，并等待其退出完成。
 *
 * @param pid - 目标进程 PID。
 * @param options - 终止配置选项。
 * @returns 成功彻底退出返回 true，超时后仍有进程残留存活返回 false。
 */
export async function killProcessTree(
  pid: number,
  options: KillProcessTreeOptions = {},
): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (!isProcessAlive(pid)) return true;

  const timeoutMs = options.timeoutMs ?? 3000;
  const signal = options.signal ?? 'SIGTERM';
  const upgradeToKill = options.upgradeToKill ?? true;

  if (process.platform === 'win32') {
    // Windows 下使用 taskkill.exe /T /F 强制终止整个进程树
    try {
      spawnSync(getTaskkillPath(), ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: Math.min(timeoutMs, 5000),
      });
    } catch {
      // 容忍 taskkill 调用异常，后续通过存活检测做最终确认
    }

    // 确认进程是否已退出
    return waitForProcessExit(pid, Math.min(timeoutMs, 2000));
  }

  // POSIX 平台处理：先枚举后代孙子进程，确保即使未设 detached 也能彻底回收进程树
  const descendants = getPosixDescendantPids(pid);

  try {
    // 优先尝试向进程组（负 PID）递送信号
    process.kill(-pid, signal);
  } catch {
    try {
      // 若进程不是进程组组长，退化为直接向该进程递送信号
      process.kill(pid, signal);
    } catch {
      /* 进程已提前退出 */
    }
  }
  // 向所有枚举到的后代孙进程发送信号
  for (const childPid of descendants) {
    try {
      process.kill(childPid, signal);
    } catch {
      /* 后代已提前退出 */
    }
  }

  // 等待优雅退出
  const gracefulWaitMs = upgradeToKill ? Math.min(timeoutMs / 2, 1000) : timeoutMs;
  const exited = await waitForProcessExit(pid, gracefulWaitMs);
  if (exited) {
    for (const childPid of descendants) {
      try {
        process.kill(childPid, 'SIGKILL');
      } catch {}
    }
    return true;
  }

  if (!upgradeToKill) return false;

  // 优雅退出超时，升级为 SIGKILL 强杀
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* 进程已退出 */
    }
  }
  for (const childPid of descendants) {
    try {
      process.kill(childPid, 'SIGKILL');
    } catch {}
  }

  return waitForProcessExit(pid, timeoutMs - gracefulWaitMs);
}

/**
 * 轮询等待进程完全退出。
 *
 * @param pid - 目标 PID。
 * @param timeoutMs - 最长等待超时时间（毫秒）。
 * @returns 进程已退出返回 true，超时仍存活返回 false。
 */
async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  while (Date.now() <= deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isProcessAlive(pid);
}
