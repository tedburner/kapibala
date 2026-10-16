/**
 * @fileoverview 工作区物理身份解析、路径规范化与目录边界校验。
 *
 * 约束、边界与为什么：
 * 1. 绝对路径与 native 规范化：
 *    Core 处于 Headless 环境，禁止依赖隐式进程工作目录（process.cwd 机制）或 process.chdir 进行相对路径解析。
 *    所有工作区与执行目录参数必须由宿主提供绝对路径，并通过 fs.realpathSync.native 展开符号链接与 Windows 8.3 短名。
 * 2. Windows 盘符与大小写统一：
 *    Windows 文件系统大小写不敏感且保留驱动器盘符。在 Windows 下统一盘符大写（如 "c:\" -> "C:\"），
 *    身份哈希计算使用正斜杠且全小写；POSIX 下保持原始大小写与斜杠。
 * 3. 工作区越界防御（WORKSPACE_ESCAPE）：
 *    执行目录 executionCwd 必须严格位于 workspaceRoot 内部或与其相同，杜绝利用上层目录跳转越过工作区边界。
 * 4. 别名与冲突检测：
 *    rootDir / cwd 作为兼容别名；若与 workspaceRoot / executionCwd 同时提供且物理路径不一致，必须立即显式报错。
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { KapibalaError } from '../errors/index.js';

/**
 * 规范化 Windows 驱动器盘符为大写。
 * 非 Windows 路径或非驱动器盘符路径原样返回。
 */
export function normalizeDriveLetter(p: string): string {
  if (process.platform === 'win32' && /^[a-zA-Z]:[\\/]/.test(p)) {
    return p.charAt(0).toUpperCase() + p.slice(1);
  }
  return p;
}

/**
 * 将绝对路径转换为操作系统原生物理长路径。
 *
 * 保证：
 * - 必须接收绝对路径，否则抛出 CONFIG_INVALID；
 * - 若路径存在，使用 fs.realpathSync.native 展开所有软链接与 Windows 8.3 短名；
 * - 若路径尚不存在，回溯到最近存在的祖先目录取 native 物理路径后再拼接剩余子路径；
 * - Windows 下统一规范驱动器盘符为大写。
 *
 * 何时失败：
 * - 传入相对路径时抛出 CONFIG_INVALID。
 */
export function toNativePhysicalPath(absolutePath: string): string {
  if (!absolutePath || typeof absolutePath !== 'string') {
    throw new KapibalaError('Path must be a non-empty string', {
      code: 'CONFIG_INVALID',
      safeMessage: '路径参数不能为空',
    });
  }
  if (!path.isAbsolute(absolutePath)) {
    throw new KapibalaError(`Path must be absolute, received: "${absolutePath}"`, {
      code: 'CONFIG_INVALID',
      safeMessage: '必须提供绝对物理路径',
    });
  }
  const normalized = path.normalize(absolutePath);
  try {
    const real = fs.realpathSync.native(normalized);
    return normalizeDriveLetter(real);
  } catch {
    const parent = path.dirname(normalized);
    if (parent === normalized) return normalizeDriveLetter(normalized);
    const nativeParent = toNativePhysicalPath(parent);
    return path.join(nativeParent, path.basename(normalized));
  }
}

/**
 * 判定两个路径在物理上是否指向同一位置。
 *
 * 保证：
 * - 展开物理路径后进行对比；
 * - Windows 下忽略大小写与斜杠差异，POSIX 下严格区分大小写。
 */
export function isSamePath(pathA: string, pathB: string): boolean {
  const nativeA = toNativePhysicalPath(pathA);
  const nativeB = toNativePhysicalPath(pathB);
  if (process.platform === 'win32') {
    return (
      nativeA.toLowerCase().replaceAll('/', '\\') === nativeB.toLowerCase().replaceAll('/', '\\')
    );
  }
  return nativeA === nativeB;
}

/**
 * 检查 target 物理路径是否位于 base 物理路径内部（或两者相同）。
 *
 * 保证：
 * - 跨盘符（Windows）或父路径逃逸（..）判定为 false；
 * - Windows 下路径对比不区分大小写。
 *
 * 不做什么：
 * - 不检查路径是否实际在文件系统上存在（仅做纯路径层级边界判定）。
 */
export function isPathInside(base: string, target: string): boolean {
  const nativeBase = toNativePhysicalPath(base);
  const nativeTarget = toNativePhysicalPath(target);
  const rel =
    process.platform === 'win32'
      ? path.win32.relative(nativeBase, nativeTarget)
      : path.posix.relative(nativeBase, nativeTarget);
  if (rel === '') return true;
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;
  return true;
}

/**
 * 计算规范化项目身份哈希（projectKey）。
 *
 * 保证：
 * - Windows 下统一使用小写与正斜杠，使不同大小写或短名别名映射到相同 projectKey；
 * - 输出 SHA-256 十六进制摘要，与 SessionManager 存储分桶完全同源。
 */
export function computeProjectKey(canonicalProjectRoot: string): string {
  const normalized =
    process.platform === 'win32'
      ? canonicalProjectRoot.replaceAll('\\', '/').toLowerCase()
      : canonicalProjectRoot;
  return createHash('sha256').update(normalized).digest('hex');
}

/** 供 resolveWorkspaceContext 消费的工作区解析输入。 */
export interface WorkspaceResolutionInput {
  /** 显式工作区物理根路径。 */
  workspaceRoot?: string;
  /** 兼容别名：工具执行与会话基目录。 */
  rootDir?: string;
  /** 显式命令执行目录（必须位于 workspaceRoot 内部）。 */
  executionCwd?: string;
  /** 兼容别名：执行目录。 */
  cwd?: string;
  /** 显式项目根路径；缺省与 workspaceRoot 相同。 */
  projectRoot?: string;
}

/** 规范化后的工作区上下文。 */
export interface WorkspaceContext {
  /** 规范化后的工作区绝对物理根路径。 */
  readonly workspaceRoot: string;
  /** 规范化后的默认命令执行绝对物理路径。 */
  readonly executionCwd: string;
  /** 规范化后的项目根绝对物理路径。 */
  readonly projectRoot: string;
  /** 确定性的项目身份哈希。 */
  readonly projectKey: string;
}

/**
 * 解析并验证工作区上下文。
 *
 * 保证：
 * - 校验 workspaceRoot 与 rootDir 必有其一，缺失时抛出 WORKSPACE_ROOT_REQUIRED；
 * - 若两者皆提供且物理路径不一致，抛出 CONFIG_INVALID；
 * - executionCwd / cwd 冲突时抛出 CONFIG_INVALID；
 * - executionCwd 必须位于 workspaceRoot 内部，越界时抛出 WORKSPACE_ESCAPE；
 * - 所有输出路径均为 native 规范化绝对路径，不依赖隐式 process.cwd 寻址。
 *
 * 何时失败：
 * - 缺少工作区根（WORKSPACE_ROOT_REQUIRED）；
 * - 路径为非绝对路径或别名冲突（CONFIG_INVALID）；
 * - 执行目录越界（WORKSPACE_ESCAPE）。
 */
export function resolveWorkspaceContext(input: WorkspaceResolutionInput): WorkspaceContext {
  const rawWorkspace = input.workspaceRoot ?? input.rootDir;
  if (!rawWorkspace) {
    throw new KapibalaError('Workspace root is required', {
      code: 'WORKSPACE_ROOT_REQUIRED',
      safeMessage: '必须显式指定工作区根路径',
    });
  }
  if (!path.isAbsolute(rawWorkspace)) {
    throw new KapibalaError(`Workspace root must be an absolute path: "${rawWorkspace}"`, {
      code: 'CONFIG_INVALID',
      safeMessage: '工作区根路径必须为绝对路径',
    });
  }
  if (input.workspaceRoot && input.rootDir && !isSamePath(input.workspaceRoot, input.rootDir)) {
    throw new KapibalaError(
      `workspaceRoot ("${input.workspaceRoot}") and rootDir ("${input.rootDir}") conflict`,
      {
        code: 'CONFIG_INVALID',
        safeMessage: 'workspaceRoot 与 rootDir 别名指向不同物理路径',
      },
    );
  }
  const canonicalWorkspace = toNativePhysicalPath(rawWorkspace);

  // 处理 executionCwd / cwd
  if (input.executionCwd && !path.isAbsolute(input.executionCwd)) {
    throw new KapibalaError(`executionCwd must be an absolute path: "${input.executionCwd}"`, {
      code: 'CONFIG_INVALID',
      safeMessage: '执行目录必须为绝对路径',
    });
  }
  if (input.cwd && !path.isAbsolute(input.cwd)) {
    throw new KapibalaError(`cwd must be an absolute path: "${input.cwd}"`, {
      code: 'CONFIG_INVALID',
      safeMessage: 'cwd 别名必须为绝对路径',
    });
  }
  if (input.executionCwd && input.cwd && !isSamePath(input.executionCwd, input.cwd)) {
    throw new KapibalaError(
      `executionCwd ("${input.executionCwd}") and cwd ("${input.cwd}") conflict`,
      {
        code: 'CONFIG_INVALID',
        safeMessage: 'executionCwd 与 cwd 别名指向不同物理路径',
      },
    );
  }
  const rawCwd = input.executionCwd ?? input.cwd ?? canonicalWorkspace;
  const canonicalCwd = toNativePhysicalPath(rawCwd);

  if (!isPathInside(canonicalWorkspace, canonicalCwd)) {
    throw new KapibalaError(
      `executionCwd must be within workspaceRoot: "${canonicalCwd}" is outside "${canonicalWorkspace}"`,
      {
        code: 'WORKSPACE_ESCAPE',
        safeMessage: '执行目录越出工作区根范围',
      },
    );
  }

  // 处理 projectRoot
  if (input.projectRoot && !path.isAbsolute(input.projectRoot)) {
    throw new KapibalaError(`projectRoot must be an absolute path: "${input.projectRoot}"`, {
      code: 'CONFIG_INVALID',
      safeMessage: '项目根路径必须为绝对路径',
    });
  }
  const canonicalProjectRoot = input.projectRoot
    ? toNativePhysicalPath(input.projectRoot)
    : canonicalWorkspace;

  const projectKey = computeProjectKey(canonicalProjectRoot);

  return {
    workspaceRoot: canonicalWorkspace,
    executionCwd: canonicalCwd,
    projectRoot: canonicalProjectRoot,
    projectKey,
  };
}
