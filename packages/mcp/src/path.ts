/**
 * @fileoverview MCP 物理路径解析、Windows 保留设备名防御与可执行目标复核
 *
 * 约束、边界与为什么：
 * 1. Windows 原生真实路径（Native Physical Path）：
 *    Windows 8.3 短名会导致路径匹配或项目信任失配，统一使用 `fs.realpathSync.native`
 *    解析规范化长路径，杜绝符号链接或短名绕过沙箱或信任判定。
 * 2. Windows 保留设备名严格拒绝：
 *    DOS / Windows 系统保留设备名（CON, PRN, AUX, NUL, COM1-9, LPT1-9 及其带任意扩展名形式）
 *    若作为路径或文件名打开，会导致进程死锁、挂起或不可预测的内核拒绝。在解析 command 与 cwd 时
 *    全面拦截，违规立即拒绝。
 * 3. cwd 声明根确定性解析：
 *    项目配置的相对 cwd 必须基于 native 项目根解析；用户全局配置的相对 cwd 必须基于全局配置目录解析；
 *    缺省 cwd 统一采用当前项目根。
 * 4. 授权前后目标防漂移：
 *    命令在审批前解析为绝对物理路径与内容指纹；审批后启动前必须再次复核，若文件被篡改或漂移，
 *    阻断启动并记录 MCP_TARGET_CHANGED。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Windows 系统保留设备名（不区分大小写，支持裸名及带扩展名形式）。 */
const WINDOWS_RESERVED_DEVICE_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/**
 * 检查路径的任一部分是否命中了 Windows 保留设备名。
 *
 * 保证：
 * - 对整个路径分段检查，只要任一目录名或文件名命中即返回 true；
 * - 拦截带扩展名的变体（如 `NUL.txt`、`con.exe`、`aux.js`）。
 */
export function isWindowsReservedDeviceName(filePathOrName: string): boolean {
  if (!filePathOrName || typeof filePathOrName !== 'string') return false;
  const normalized = filePathOrName.replace(/[\\/]+/g, '/');
  const segments = normalized.split('/').filter(Boolean);

  for (const seg of segments) {
    // 剔除驱动器盘符（如 "C:"）
    const cleanSeg = seg.replace(/^[a-zA-Z]:$/, '');
    if (!cleanSeg) continue;

    // 检查裸名
    const lower = cleanSeg.toLowerCase();
    if (WINDOWS_RESERVED_DEVICE_NAMES.has(lower)) {
      return true;
    }
    // 检查去后缀后的主文件名（如 "con.exe" -> "con"）
    const dotIndex = lower.indexOf('.');
    if (dotIndex > 0) {
      const base = lower.slice(0, dotIndex);
      if (WINDOWS_RESERVED_DEVICE_NAMES.has(base)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 将路径转换为 native 物理长路径。
 *
 * 若路径存在，使用 `fs.realpathSync.native` 展开所有软链接与 8.3 短名；
 * 若路径不存在，回溯到最近存在的祖先目录取 native 路径后再拼接剩余子路径。
 */
export function toNativePhysicalPath(targetPath: string): string {
  const resolved = path.resolve(targetPath);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // 路径可能尚未创建，向上一级回溯
    const parent = path.dirname(resolved);
    if (parent === resolved) return resolved;
    const nativeParent = toNativePhysicalPath(parent);
    return path.join(nativeParent, path.basename(resolved));
  }
}

/**
 * 解析服务的规范工作目录（cwd）。
 *
 * 规则：
 * - 若 cwd 未提供，默认使用项目根目录的 native 物理路径；
 * - 若 cwd 为相对路径：来自项目配置以 projectRoot 为根，来自全局配置以 globalConfigDir 为根；
 * - 检查拒绝 Windows 保留设备名；
 * - 检查最终目录必须实际存在且为目录。
 */
export function resolveServerCwd(
  cwd: string | undefined,
  source: 'global' | 'project',
  projectRoot: string,
  globalConfigDir: string,
): { cwd: string; error?: string } {
  let rawCwd: string;
  if (!cwd || !cwd.trim()) {
    rawCwd = projectRoot;
  } else if (path.isAbsolute(cwd)) {
    rawCwd = cwd;
  } else {
    const baseDir = source === 'project' ? projectRoot : globalConfigDir;
    rawCwd = path.resolve(baseDir, cwd);
  }

  if (isWindowsReservedDeviceName(rawCwd)) {
    return {
      cwd: rawCwd,
      error: `Configured cwd '${rawCwd}' contains forbidden Windows reserved device name`,
    };
  }

  const nativeCwd = toNativePhysicalPath(rawCwd);
  try {
    const stat = fs.statSync(nativeCwd);
    if (!stat.isDirectory()) {
      return { cwd: nativeCwd, error: `Configured cwd '${nativeCwd}' is not a directory` };
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { cwd: nativeCwd, error: `Configured cwd '${nativeCwd}' does not exist: ${msg}` };
  }

  return { cwd: nativeCwd };
}

/**
 * 可执行目标信息，用于启动审批与执行前复核防漂移。
 */
export interface CommandTargetInfo {
  /** 命令原始字面量。 */
  rawCommand: string;
  /** 解析后的实际可执行文件绝对物理路径。 */
  executablePath: string;
  /** 可执行文件大小。 */
  size: number;
  /** 可执行文件最后修改时间毫秒戳。 */
  mtimeMs: number;
  /** 可选绑定的脚本内容 SHA-256 摘要（若直接执行或通过解释器执行本地脚本）。 */
  scriptDigest?: string;
  /** 关联绑定的本地脚本物理路径。 */
  scriptPath?: string;
}

/**
 * 在受控 PATH 中查找命令的可执行文件实际物理路径。
 */
export function findExecutableInPath(
  command: string,
  cwd: string,
  envPath?: string,
): string | undefined {
  if (isWindowsReservedDeviceName(command)) return undefined;

  // 如果包含路径分隔符，直接当作相对或绝对路径探测
  if (command.includes('/') || command.includes('\\')) {
    const candidate = path.resolve(cwd, command);
    if (isWindowsReservedDeviceName(candidate)) return undefined;
    try {
      const nativeCandidate = toNativePhysicalPath(candidate);
      const stat = fs.statSync(nativeCandidate);
      if (stat.isFile()) return nativeCandidate;
    } catch {
      // 在 Windows 下补后缀测试
      if (process.platform === 'win32' && !path.extname(candidate)) {
        for (const ext of ['.exe', '.cmd', '.bat']) {
          try {
            const withExt = toNativePhysicalPath(candidate + ext);
            if (fs.statSync(withExt).isFile()) return withExt;
          } catch {
            /* continue */
          }
        }
      }
    }
    return undefined;
  }

  // 裸命令：遍历受控 PATH
  const searchPath = envPath ?? process.env.PATH ?? '';
  const dirs = searchPath.split(path.delimiter).filter(Boolean);

  const extensions =
    process.platform === 'win32'
      ? (process.env.PATHEXT?.toLowerCase().split(';') ?? ['.exe', '.cmd', '.bat'])
      : [''];

  for (const dir of dirs) {
    for (const ext of extensions) {
      const full = path.join(dir, command + (path.extname(command) ? '' : ext));
      if (isWindowsReservedDeviceName(full)) continue;
      try {
        const nativeFull = toNativePhysicalPath(full);
        const stat = fs.statSync(nativeFull);
        if (stat.isFile()) return nativeFull;
      } catch {
        /* not found in this directory */
      }
    }
  }

  return undefined;
}

/**
 * 解析命令目标信息与关联脚本摘要。
 *
 * @param command 启动命令。
 * @param args 命令行参数。
 * @param cwd 解析后的工作目录。
 * @param envPath 可选 PATH 环境变量。
 */
export function resolveCommandTarget(
  command: string,
  cwd: string,
  args: string[] = [],
  envPath?: string,
): { target?: CommandTargetInfo; error?: string } {
  if (isWindowsReservedDeviceName(command)) {
    return {
      error: `Command '${command}' contains forbidden Windows reserved device name`,
    };
  }

  const executablePath = findExecutableInPath(command, cwd, envPath);
  if (!executablePath) {
    return {
      error: `Executable '${command}' could not be resolved in PATH or filesystem`,
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(executablePath);
  } catch (err) {
    return { error: `Failed to stat executable '${executablePath}': ${String(err)}` };
  }

  let scriptDigest: string | undefined;
  let scriptPath: string | undefined;

  // 探测关联脚本：如果第一个参数是本地存在的文件（如 node ./server.js）
  const candidateScript = args[0];
  if (candidateScript && typeof candidateScript === 'string' && !candidateScript.startsWith('-')) {
    const resolvedScript = path.resolve(cwd, candidateScript);
    if (!isWindowsReservedDeviceName(resolvedScript) && fs.existsSync(resolvedScript)) {
      try {
        const nativeScript = toNativePhysicalPath(resolvedScript);
        const scriptStat = fs.statSync(nativeScript);
        if (scriptStat.isFile()) {
          const content = fs.readFileSync(nativeScript);
          scriptDigest = createHash('sha256').update(content).digest('hex');
          scriptPath = nativeScript;
        }
      } catch {
        /* Ignore non-readable script */
      }
    }
  }

  return {
    target: {
      rawCommand: command,
      executablePath,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      scriptDigest,
      scriptPath,
    },
  };
}

/**
 * 授权后复核命令目标防漂移。
 *
 * 检查：
 * 1. 可执行文件物理路径是否存在；
 * 2. 可执行文件的 mtime 和 size 是否未变；
 * 3. 若绑定了本地脚本，脚本的内容摘要是否严格一致。
 *
 * 任何变化返回 `{ valid: false, reason: ... }`，调用方阻断启动。
 */
export function verifyCommandTarget(recorded: CommandTargetInfo): {
  valid: boolean;
  reason?: string;
} {
  try {
    const currentStat = fs.statSync(recorded.executablePath);
    if (currentStat.size !== recorded.size || currentStat.mtimeMs !== recorded.mtimeMs) {
      return {
        valid: false,
        reason: `Executable '${recorded.executablePath}' has been modified since approval (size/mtime drifted)`,
      };
    }
  } catch (err: unknown) {
    return {
      valid: false,
      reason: `Executable '${recorded.executablePath}' is no longer accessible: ${String(err)}`,
    };
  }

  if (recorded.scriptPath && recorded.scriptDigest) {
    try {
      const currentContent = fs.readFileSync(recorded.scriptPath);
      const currentDigest = createHash('sha256').update(currentContent).digest('hex');
      if (currentDigest !== recorded.scriptDigest) {
        return {
          valid: false,
          reason: `Associated script '${recorded.scriptPath}' content digest changed after approval`,
        };
      }
    } catch (err: unknown) {
      return {
        valid: false,
        reason: `Associated script '${recorded.scriptPath}' is no longer readable: ${String(err)}`,
      };
    }
  }

  return { valid: true };
}
