import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from '../errors/index.js';

export interface SandboxConfig {
  rootDir: string;
  /**
   * v0.0.1 恒为严格模式：任何解析后落在 rootDir 之外的物理路径一律拒绝，
   * 不存在 fail-open 开关。该字段为 v0.0.2 权限引擎预留，当前不改变校验行为。
   */
  allowSymlinks?: boolean;
}

function tryRealpath(target: string): string | undefined {
  try {
    return fs.realpathSync(target);
  } catch {
    return undefined;
  }
}

export class PathSandbox {
  readonly rootDir: string;
  readonly allowSymlinks: boolean;
  private cachedRealRootDir?: string;

  constructor(config: SandboxConfig) {
    this.rootDir = path.resolve(config.rootDir);
    this.allowSymlinks = config.allowSymlinks ?? false;
  }

  /**
   * rootDir 的物理路径。rootDir 自身可能是一个符号链接(如 macOS 的 /var → /private/var)，
   * 必须先归一化，否则物理路径与 rootDir 比较时会产生误判。
   */
  private get realRootDir(): string {
    if (this.cachedRealRootDir === undefined) {
      this.cachedRealRootDir = tryRealpath(this.rootDir) ?? this.rootDir;
    }
    return this.cachedRealRootDir;
  }

  /**
   * 检查并解析安全路径
   * 1. 解析相对路径为相对于 rootDir 的绝对路径
   * 2. 词法检查：`..` 归一化后必须仍在 rootDir 内
   * 3. 物理检查：解析符号链接后的真实路径必须仍在 rootDir 内
   */
  resolveSafePath(targetPath: string): string {
    if (!targetPath || typeof targetPath !== 'string') {
      throw new ToolError('Invalid path: path must be a non-empty string');
    }

    // 处理绝对路径或相对路径
    const resolvedPath = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.rootDir, targetPath);

    // 词法检查：规范化相对路径判定
    const relative = path.relative(this.rootDir, resolvedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new ToolError(
        `Access denied: path '${targetPath}' escapes root directory '${this.rootDir}'`,
      );
    }

    // 物理检查：必须对"目标尚不存在"的路径同样生效
    const physicalPath = this.toPhysicalPath(resolvedPath);
    const physicalRelative = path.relative(this.realRootDir, physicalPath);
    if (physicalRelative.startsWith('..') || path.isAbsolute(physicalRelative)) {
      throw new ToolError(
        `Access denied: path '${targetPath}' resolves outside root directory '${this.rootDir}' (via symlink)`,
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
        const real = tryRealpath(probe);
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
