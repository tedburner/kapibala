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
  /**
   * 只读豁免根提供者：返回 harness 受管的只读目录（如本会话的 tool-results 桶）。
   * 仅对显式 read 模式的 resolveSafePath 生效，write/edit 永远不豁免；
   * 每次校验时重新求值，以兼容会话恢复后 conversationId 变化的场景。
   * 豁免根按 realpath 比对物理路径，符号链接穿透依然 fail-closed。
   */
  readOnlyExemptions?: () => readonly string[];
  /**
   * 额外的硬禁区（workspace 相对路径或目录前缀），与内置清单取并集，只能收紧不能放宽。
   * 仅对 write/edit 生效；命中时直接抛 `PERMISSION_DENIED`，不进入审批。
   */
  protectedPaths?: readonly string[];
}

function tryNativeRealpath(target: string): string | undefined {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return undefined;
  }
}

/**
 * 把路径分隔符统一为 `/`、去掉前导 `./`，并剥除 NTFS 数据流后缀（`::$DATA` 等）及每段尾随空白与点
 * （防御 Windows Win32 默认流后缀与尾随空白/点落盘归一绕过）。
 */
function normalizeRelative(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .map((segment, index) => {
      if (segment === '.' || segment === '..') return segment;
      const withoutDrive =
        index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : segment.replace(/:.*$/, '');
      return withoutDrive.replace(/[ .]+$/, '');
    })
    .join('/');
}

/** 检测路径是否携带非盘符冒号（Windows NTFS 备用/默认数据流，如 `.env::$DATA`）。 */
function hasNtfsStreamSuffix(rawPath: string): boolean {
  const withoutDrive = rawPath.replace(/^[A-Za-z]:(?=[\\/]|$)/, '');
  return withoutDrive.includes(':');
}

/**
 * 内置硬禁区判定（workspace 相对路径）：写入这些位置会让后续操作获得代码执行或规则扩权能力。
 *
 * 边界：
 * - `.git/hooks`、`.git/config`、`.git/modules` 写入可劫持下一次 git 操作；
 * - `.env` / `.env.*` 是密钥载体，但 `.env.example` / `.env.sample` / `.env.template` 不含密钥，明确豁免；
 * - `.envrc` 由 direnv 进入目录即自动执行，写入等于埋下任意命令执行点，与 `.git/hooks` 同威胁级；
 * - `.kapibala/**` 含规则与 MCP 配置，写入等于自我提权；
 * - 比较时统一小写并按 `/` 归一，Windows 大小写变体同样命中。
 */
export function isProtectedWorkspacePath(relativePath: string): boolean {
  const normalized = normalizeRelative(relativePath).toLowerCase();
  // 嵌套仓库（子模块、vendor 目录）同样可以被 `cd sub && git commit` 触发，按路径段匹配。
  const matches = (segment: string): boolean =>
    normalized === segment ||
    normalized.startsWith(`${segment}/`) ||
    normalized.includes(`/${segment}/`);
  if (matches('.git/hooks')) return true;
  if (normalized === '.git/config' || normalized.endsWith('/.git/config')) return true;
  if (matches('.git/modules')) return true;
  if (
    normalized === '.kapibala' ||
    normalized.startsWith('.kapibala/') ||
    normalized.includes('/.kapibala/')
  )
    return true;
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  if (base === '.env') return true;
  if (base.startsWith('.env.') && !/^\.env\.(example|sample|template)$/.test(base)) return true;
  // direnv 对 `.envrc` 是「进入目录即执行」，无需任何用户动作，因此与 hooks 同级硬拒。
  if (base === '.envrc') return true;
  return false;
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
  private readonly readOnlyExemptions?: () => readonly string[];
  private readonly protectedPaths: readonly string[];
  private cachedRealRootDir?: string;

  constructor(config: SandboxConfig) {
    const raw = config.workspaceRoot ?? config.rootDir;
    if (!raw) {
      throw new ToolError('Sandbox workspace root is required');
    }
    this.workspaceRoot = toNativePhysicalPath(raw);
    this.rootDir = this.workspaceRoot;
    this.allowSymlinks = config.allowSymlinks ?? false;
    this.readOnlyExemptions = config.readOnlyExemptions;
    this.protectedPaths = (config.protectedPaths ?? []).map((entry) => normalizeRelative(entry));
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
   * 1. read 模式先尝试只读豁免根：物理路径落在豁免根内即放行（仅 harness 受管目录）
   * 2. 解析相对路径为相对于 workspaceRoot 的绝对路径
   * 3. 词法检查：`..` 归一化后必须仍在 workspaceRoot 内
   * 4. 物理检查：解析符号链接与短名后的真实物理路径必须仍在 workspaceRoot 内
   *
   * @param options.mode 缺省 'write'：工作区外的路径一律拒绝；'read' 才允许豁免根放行。
   *   只读豁免先于工作区检查执行，因此豁免根可以位于 workspaceRoot 之外。
   */
  resolveSafePath(targetPath: string, options?: { mode?: 'read' | 'write' }): string {
    if (!targetPath || typeof targetPath !== 'string') {
      throw new ToolError('Invalid path: path must be a non-empty string');
    }

    if (hasNtfsStreamSuffix(targetPath)) {
      throw new ToolError(
        `Access denied: NTFS data stream syntax in '${targetPath}' cannot be accessed`,
        'PERMISSION_DENIED',
      );
    }

    // 处理绝对路径或相对路径（相对路径以 workspaceRoot 为基准）
    const resolvedPath = path.isAbsolute(targetPath)
      ? path.resolve(targetPath)
      : path.resolve(this.workspaceRoot, targetPath);

    if (options?.mode === 'read' && this.readOnlyExemptions) {
      const physicalPath = this.toPhysicalPath(resolvedPath);
      for (const exemption of this.readOnlyExemptions()) {
        const realRoot = tryNativeRealpath(exemption);
        if (realRoot && isPathInside(realRoot, physicalPath)) return resolvedPath;
      }
    }

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

    // 硬禁区：write/edit 命中直接拒绝，不进入审批；read 保持可读（诊断需要）。
    if (options?.mode !== 'read') {
      const relative = normalizeRelative(path.relative(this.realRootDir, physicalPath));
      if (this.isProtected(relative)) {
        throw new ToolError(
          `Access denied: protected path '${relative}' cannot be modified`,
          'PERMISSION_DENIED',
        );
      }
    }

    return resolvedPath;
  }

  /** 内置清单与附加前缀取并集；附加项按目录前缀匹配，不接受通配符。 */
  private isProtected(relativePath: string): boolean {
    if (isProtectedWorkspacePath(relativePath)) return true;
    const normalized = relativePath.toLowerCase();
    return this.protectedPaths.some((entry) => {
      const prefix = entry.toLowerCase();
      return normalized === prefix || normalized.startsWith(`${prefix}/`);
    });
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
