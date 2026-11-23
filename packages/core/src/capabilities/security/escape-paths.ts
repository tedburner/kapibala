import fs from 'node:fs';
import path from 'node:path';
import { ToolError } from '../../errors/index.js';
import { PathSandbox } from './sandbox.js';

/**
 * 剥除每个路径段的 NTFS 数据流后缀（如 `::$DATA`）与末尾空白/点（保留 `.` 与 `..` 段本身）：
 * Windows Win32 API 在创建文件时会把默认数据流后缀与尾随空格/点落到同一文件身份，
 * 词法归一化先行折叠才能让新建文件的敏感路径判定与落盘真实身份一致。
 */
export function normalizePathSegments(relativePath: string): string {
  return relativePath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('/')
    .map((segment, index) => {
      if (segment === '.' || segment === '..') return segment;
      const withoutStream =
        index === 0 && /^[A-Za-z]:$/.test(segment) ? segment : segment.replace(/:.*$/, '');
      return withoutStream.replace(/[ .]+$/, '');
    })
    .join('/');
}

/**
 * 「escape 类」敏感路径清单：向这些位置写入等于取得 CI 执行权
 * 或完成凭据注入，属「跨边界」行为而非普通工作区写入。
 *
 * 与硬禁区（`sandbox.ts` 的 `isProtectedWorkspacePath`）刻意区分：
 * - 硬禁区命中 → 三档一致直接 `deny`，不进入审批（写入即不可逆提权）；
 * - 本清单命中 → 风险类别升为 `escape`，Auto / Approval 一律询问，FullAccess 放行并审计。
 *
 * 边界：纯函数、只做词法匹配，不读取文件系统；按 `/` 归一、剥段尾空白/点并统一小写，
 * Windows 大小写与尾随点/空格变体及嵌套目录（如 `sub/.npmrc`）同样命中——宁可多问一次，不可漏判。
 */
export function isEscapeClassPath(relativePath: string): boolean {
  const normalized = normalizePathSegments(relativePath).toLowerCase();
  // `.github/workflows/**`：写入即定义 CI 流程，推送后获得远程代码执行面。
  if (
    normalized === '.github/workflows' ||
    normalized.startsWith('.github/workflows/') ||
    normalized.includes('/.github/workflows/')
  )
    return true;
  // 凭据与注册表配置按 basename 匹配（与 `.env` 同口径，任意目录深度）。
  const base = normalized.slice(normalized.lastIndexOf('/') + 1);
  return base === '.npmrc' || base === '.netrc' || base === '.git-credentials';
}

/** 向上回溯最近已存在祖先展开 native realpath，识破指向敏感目录的符号链接写入。 */
function resolveAncestorRealpath(resolvedPath: string): string {
  const pending: string[] = [];
  let probe = resolvedPath;
  for (;;) {
    try {
      const real = fs.realpathSync.native(probe);
      return pending.length > 0 ? path.join(real, ...pending) : real;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return resolvedPath;
      pending.unshift(path.basename(probe));
      probe = parent;
    }
  }
}

/**
 * 对声明 `fs:write` 且带 `path` 入参的文件写工具做审批前目标分级：
 * - 命中硬禁区（含附加 `protectedPaths`）→ 返回 `protectedTarget`，让策略在三档一致直接 `deny`（不产生审批请求）；
 * - 命中 escape 清单（`.github/workflows/**`、`.npmrc`、`.netrc`、`.git-credentials`）
 *   → 返回 `requiresAsk: true`，阻止 Auto 模式免审自动放行（FullAccess 仍放行并审计）。
 * - 工作区越界保持由工具内 `PathSandbox.resolveSafePath` 原样拦截，不改变既有错误码与提示。
 */
export function inspectFileWriteTarget(
  targetPath: string,
  rootDir: string,
  sandbox?: PathSandbox,
): { protectedTarget?: string; requiresAsk?: boolean } {
  if (!targetPath || typeof targetPath !== 'string') return {};
  const effectiveSandbox = sandbox ?? new PathSandbox({ workspaceRoot: rootDir });
  try {
    const safePath = effectiveSandbox.resolveSafePath(targetPath);
    const realRoot = resolveAncestorRealpath(effectiveSandbox.workspaceRoot);
    const realTarget = resolveAncestorRealpath(safePath);
    const relative = path.relative(realRoot, realTarget);
    if (isEscapeClassPath(relative)) return { requiresAsk: true };
    return {};
  } catch (error) {
    if (error instanceof ToolError && error.code === 'PERMISSION_DENIED') {
      return { protectedTarget: normalizePathSegments(targetPath) || targetPath };
    }
    return {};
  }
}
