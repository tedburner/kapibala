/**
 * @fileoverview 受管 Git Worktree 四步 `.git` 双向回链同步验真（零子进程开销，失败闭合）。
 *
 * 安全背景：
 * - 当会话挂载在 `~/.kapibala/worktrees/<bucket>/<repo>` 时，宿主需判定该目录是否可安全继承已信任主仓
 *   `projectRoot` 的执行信任；
 * - 若仅做单向文本匹配，攻击者可在某目录伪造 `.git` 文本文件 `gitdir: <trustedRepo>/.git/worktrees/x`
 *   骗取项目信任；因此必须使用 `fs.realpathSync.native` 完成主仓与工作树之间的四步双向闭环核验。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isPathInside, isSamePath, normalizeDriveLetter } from '@kiturone/kapibala';
import { MAX_GIT_LINK_READ_BYTES } from './types.js';

/** `verifyManagedWorktreeLink` 验真输入。 */
export interface VerifyManagedWorktreeLinkInput {
  /** 受管工作树总根目录（如 `~/.kapibala/worktrees`）。 */
  readonly worktreesRoot: string;
  /** 已识别的主项目物理根路径。 */
  readonly projectRoot: string;
  /** 待校验的工作树目录路径。 */
  readonly worktreePath: string;
}

/**
 * 仅当目标是常规文件（非目录、非符号链接）且字节数不超过 `maxBytes` 时读取单行文本，否则返回 `null`。
 */
function readBoundedSingleLineRegularFile(
  filePath: string,
  maxBytes = MAX_GIT_LINK_READ_BYTES,
): string | null {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.size > maxBytes) {
    return null;
  }
  const buf = fs.readFileSync(filePath);
  if (buf.length > maxBytes || buf.includes(0)) {
    return null;
  }
  const raw = buf.toString('utf8').replace(/\r?\n$/, '');
  if (!raw || raw.includes('\n') || raw.includes('\r')) {
    return null;
  }
  return raw;
}

/**
 * 执行受管 Git Worktree 的四步 `.git` 双向回链物理校验。
 *
 * 四步闭环规则（全部基于 `fs.realpathSync.native`，0 子进程）：
 * 1. `worktreePath` 严格位于规范化 `worktreesRoot` 内部，且 `<worktreePath>/.git` 为常规文件（≤ 64 KiB）；
 * 2. 解析 `gitdir: <adminDir>`，校验规范化 `<adminDir>` 恰为 `<canonicalProjectRoot>/.git/worktrees/<entry>` 直接子目录；
 * 3. 读取常规文件 `<adminDir>/gitdir`，校验其规范化路径精确指回 `<canonicalWorktreePath>/.git`；
 * 4. 读取常规文件 `<adminDir>/commondir`，校验 `path.resolve(adminDir, commondir)` 的规范化路径精确等于 `<canonicalProjectRoot>/.git`。
 *
 * 失败边界：任何文件系统异常、符号链接伪装、大小超限或路径失配均闭合返回 `false`。
 */
export function verifyManagedWorktreeLink(input: VerifyManagedWorktreeLinkInput): boolean {
  try {
    if (!input.worktreesRoot || !input.projectRoot || !input.worktreePath) {
      return false;
    }

    const canonicalWorktreesRoot = normalizeDriveLetter(
      fs.realpathSync.native(path.resolve(input.worktreesRoot)),
    );
    const canonicalProjectRoot = normalizeDriveLetter(
      fs.realpathSync.native(path.resolve(input.projectRoot)),
    );
    const canonicalWorktreePath = normalizeDriveLetter(
      fs.realpathSync.native(path.resolve(input.worktreePath)),
    );

    // 步骤 1：worktreePath 必须严格位于 worktreesRoot 子树下，且 .git 必须是普通文件而非目录或软链。
    if (
      isSamePath(canonicalWorktreesRoot, canonicalWorktreePath) ||
      !isPathInside(canonicalWorktreesRoot, canonicalWorktreePath)
    ) {
      return false;
    }

    const worktreeDotGitPath = path.join(canonicalWorktreePath, '.git');
    const dotGitLine = readBoundedSingleLineRegularFile(worktreeDotGitPath);
    if (!dotGitLine) {
      return false;
    }

    // 步骤 2：解析 `gitdir: <adminDir>` 并确认其位于 `<projectRoot>/.git/worktrees/<entry>`。
    const match = /^gitdir:[ \t]*(.+)$/.exec(dotGitLine);
    if (!match || !match[1]) {
      return false;
    }
    const rawAdminDir = match[1].trim();
    if (!rawAdminDir) {
      return false;
    }

    const projectGitCandidate = path.join(canonicalProjectRoot, '.git');
    if (!fs.lstatSync(projectGitCandidate).isDirectory()) {
      return false;
    }
    const canonicalProjectGitDir = normalizeDriveLetter(
      fs.realpathSync.native(projectGitCandidate),
    );
    const canonicalWorktreesAdminRoot = normalizeDriveLetter(
      fs.realpathSync.native(path.join(canonicalProjectGitDir, 'worktrees')),
    );

    const resolvedAdminDir = path.resolve(canonicalWorktreePath, rawAdminDir);
    const canonicalAdminDir = normalizeDriveLetter(fs.realpathSync.native(resolvedAdminDir));

    const relAdmin =
      process.platform === 'win32'
        ? path.win32.relative(canonicalWorktreesAdminRoot, canonicalAdminDir)
        : path.posix.relative(canonicalWorktreesAdminRoot, canonicalAdminDir);
    if (
      !relAdmin ||
      relAdmin === '.' ||
      relAdmin.startsWith('..') ||
      path.isAbsolute(relAdmin) ||
      relAdmin.includes('/') ||
      relAdmin.includes('\\')
    ) {
      return false;
    }

    // 步骤 3：核验 `<adminDir>/gitdir` 反向精确指回 `<canonicalWorktreePath>/.git`。
    const adminBacklinkLine = readBoundedSingleLineRegularFile(
      path.join(canonicalAdminDir, 'gitdir'),
    );
    if (!adminBacklinkLine) {
      return false;
    }
    const resolvedBacklink = path.resolve(canonicalAdminDir, adminBacklinkLine.trim());
    const canonicalBacklink = normalizeDriveLetter(fs.realpathSync.native(resolvedBacklink));
    if (!isSamePath(canonicalBacklink, worktreeDotGitPath)) {
      return false;
    }

    // 步骤 4：核验 `<adminDir>/commondir` 精确指向 `<canonicalProjectRoot>/.git`。
    const commonDirLine = readBoundedSingleLineRegularFile(
      path.join(canonicalAdminDir, 'commondir'),
    );
    if (!commonDirLine) {
      return false;
    }
    const resolvedCommonDir = path.resolve(canonicalAdminDir, commonDirLine.trim());
    const canonicalCommonDir = normalizeDriveLetter(fs.realpathSync.native(resolvedCommonDir));
    if (!isSamePath(canonicalCommonDir, canonicalProjectGitDir)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
