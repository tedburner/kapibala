import fs from 'node:fs';
import path from 'node:path';
import { isPathInside, toNativePhysicalPath } from '../../context/workspace.js';
import { ToolError } from '../../errors/index.js';

export { isPathInside, toNativePhysicalPath };

/** 路径沙箱配置；workspaceRoot 是所有文件访问的词法与物理边界。 */
export interface SandboxConfig {
  /** 显式工作区物理根路径。 */
  workspaceRoot?: string;
  /** 兼容别名：等同于 workspaceRoot。 */
  rootDir?: string;
  /**
   * 严格模式：任何解析后落在 workspaceRoot 之外的物理路径一律拒绝，
   * 不存在 fail-open 开关。
   */
  allowSymlinks?: boolean;
}

function tryNativeRealpath(target: string): string | undefined {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return undefined;
  }
}

/**
 * 把文件访问限制在 workspaceRoot 内：先做词法归一化检查，再展开符号链接与 Windows 短名做物理检查，两层都通过才放行。
 * 由 AgentSession 会话持有独立实例，避免全局单例缓存串扰。
 */
export class PathSandbox {
  /** 显式工作区绝对物理根路径。 */
  readonly workspaceRoot: string;
  /** 兼容别名：等同于 workspaceRoot。 */
  readonly rootDir: string;
  readonly allowSymlinks: boolean;
  private cachedRealRootDir?: string;

  constructor(config: SandboxConfig) {
    const raw = config.workspaceRoot ?? config.rootDir;
    if (!raw) {
      throw new ToolError('Sandbox workspace root is required');
    }
    this.workspaceRoot = toNativePhysicalPath(raw);
    this.rootDir = this.workspaceRoot;
    this.allowSymlinks = config.allowSymlinks ?? false;
  }

  /**
   * workspaceRoot 的物理路径。经过 toNativePhysicalPath 展开符号链接与 8.3 短名。
   */
  private get realRootDir(): string {
    if (this.cachedRealRootDir === undefined) {
      this.cachedRealRootDir = tryNativeRealpath(this.workspaceRoot) ?? this.workspaceRoot;
    }
    return this.cachedRealRootDir;
  }

  /**
   * 检查并解析安全路径
   * 1. 解析相对路径为相对于 workspaceRoot 的绝对路径
   * 2. 词法检查：`..` 归一化后必须仍在 workspaceRoot 内
   * 3. 物理检查：解析符号链接与短名后的真实物理路径必须仍在 workspaceRoot 内
   */
  resolveSafePath(targetPath: string): string {
    if (!targetPath || typeof targetPath !== 'string') {
      throw new ToolError('Invalid path: path must be a non-empty string');
    }

    // 处理绝对路径或相对路径（相对路径以 workspaceRoot 为基准）
    const resolvedPath = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.workspaceRoot, targetPath);

    // 词法检查：规范化相对路径判定
    if (!isPathInside(this.workspaceRoot, resolvedPath)) {
      throw new ToolError(
        `Access denied: path '${targetPath}' escapes root directory '${this.workspaceRoot}'`,
      );
    }

    // 物理检查：必须对"目标尚不存在"的路径同样生效
    const physicalPath = this.toPhysicalPath(resolvedPath);
    if (!isPathInside(this.realRootDir, physicalPath)) {
      throw new ToolError(
        `Access denied: path '${targetPath}' resolves outside root directory '${this.workspaceRoot}' (via symlink)`,
      );
    }

    return resolvedPath;
  }

  /**
   * 把词法路径映射为物理路径。
   *
   * 关键点在于**向上回溯到最近一个真实存在的祖先**再取 realpath，然后把尚未存在的尾段拼回去：
   * - 目标已存在 → 直接 realpath，符号链接立刻被展开；
   * - 目标不存在(典型场景：write_file 新建文件) → 若只看目标本身，所有校验都会被跳过，
   *   于是 `write_file('linkDir/new.txt')` 可以借道指向外部的 linkDir 越界写入。
   *   回溯到 linkDir 取 realpath 即可识破这种穿透。
   */
  private toPhysicalPath(resolvedPath: string): string {
    const pendingSegments: string[] = [];
    let probe = resolvedPath;

    while (true) {
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(probe);
      } catch {
        stat = undefined;
      }

      if (stat) {
        // 用 realpath 展开符号链接；悬挂符号链接(目标不存在)会在这里失败，
        // 而 writeFileSync 这类调用会顺着它在外部落盘，因此必须直接拒绝。
        const real = tryNativeRealpath(probe);
        if (real === undefined) {
          throw new ToolError(
            `Access denied: cannot resolve real path for '${resolvedPath}' (broken or unresolvable symlink)`,
          );
        }
        return pendingSegments.length > 0 ? path.join(real, ...pendingSegments) : real;
      }

      const parent = path.dirname(probe);
      if (parent === probe) {
        // 已回溯到文件系统根仍不存在，退化为词法路径(由上层词法检查兜底)
        return resolvedPath;
      }
      pendingSegments.unshift(path.basename(probe));
      probe = parent;
    }
  }
}
