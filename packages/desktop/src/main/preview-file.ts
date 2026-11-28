import fs from 'node:fs';
import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { IMAGE_MIME_BY_EXTENSION, IMAGE_PREVIEW_LIMIT } from '../shared/preview.js';

/** Git `.git` 双向回链文本文件读取硬上限（64 KiB），防止伪造超大文件拖慢主进程。 */
const MAX_GIT_LINK_BYTES = 64 * 1024;

/** 统一 Windows 盘符为大写，消除祖先回溯与真实路径盘符大小写差异。 */
function normalizeDrive(target: string): string {
  return process.platform === 'win32' && /^[a-z]:[\\/]/i.test(target)
    ? `${target[0]!.toUpperCase()}${target.slice(1)}`
    : target;
}

/** 物理路径等值比较；Windows 下按大小写不敏感比对。 */
function samePhysicalPath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** realpath 归一；目标尚不存在时回溯到最近已存在祖先展开符号链接，确保先判物理边界再判存在。 */
function canonicalize(target: string): string {
  try {
    return normalizeDrive(fs.realpathSync.native(target));
  } catch {
    const parent = dirname(target);
    if (parent === target) return normalizeDrive(target);
    return join(canonicalize(parent), basename(target));
  }
}

/** 目标是否位于根本身或根之内；Windows 下 `path.relative` 已按大小写不敏感比较。 */
function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * 仅当目标是常规文件（拒绝目录与符号链接）且字节数不超过 `maxBytes` 时读取单行文本，否则返回 `null`。
 */
function readBoundedSingleLineRegularFile(
  filePath: string,
  maxBytes = MAX_GIT_LINK_BYTES,
): string | null {
  const st = fs.lstatSync(filePath);
  if (!st.isFile() || st.size > maxBytes) return null;
  const buf = fs.readFileSync(filePath);
  if (buf.length > maxBytes || buf.includes(0)) return null;
  const raw = buf.toString('utf8').replace(/\r?\n$/, '');
  if (!raw || raw.includes('\n') || raw.includes('\r')) return null;
  return raw;
}

/**
 * 纯 Node 四步 `.git` 双向回链物理校验（零执行域依赖，基于 `fs.realpathSync.native` 失败闭合）：
 * 1. 定位包含 `candidatePath` 的 `<homeDirectory>/.kapibala/worktrees/<bucket>/<repo>` 根，并拒绝工作树内部嵌套的 `.kapibala` 或 `.git` 子路径；
 * 2. 核验 `<wtRoot>/.git` 为常规单行文件（≤ 64 KiB）且格式为 `gitdir: <adminDir>`；
 * 3. 核验规范化 `<adminDir>` 恰为已登记工作区 `<mainRepo>/.git/worktrees/<entry>` 的直接子目录；
 * 4. 核验 `<adminDir>/gitdir` 反向精确指回 `<wtRoot>/.git`，且 `<adminDir>/commondir` 精确指向 `<mainRepo>/.git`。
 */
export function isVerifiedManagedWorktreeOfAllowedWorkspace(
  candidatePath: string,
  canonicalWorkspaces: readonly string[],
  homeDirectory: string,
): boolean {
  try {
    if (!candidatePath || !homeDirectory || canonicalWorkspaces.length === 0) return false;
    const rawWorktreesRoot = resolve(homeDirectory, '.kapibala', 'worktrees');
    if (!fs.existsSync(rawWorktreesRoot) || !fs.lstatSync(rawWorktreesRoot).isDirectory()) {
      return false;
    }
    const worktreesRoot = normalizeDrive(fs.realpathSync.native(rawWorktreesRoot));
    const normalizedCandidate = canonicalize(resolve(candidatePath));
    if (
      samePhysicalPath(worktreesRoot, normalizedCandidate) ||
      !within(worktreesRoot, normalizedCandidate)
    ) {
      return false;
    }

    const relToWorktrees = relative(worktreesRoot, normalizedCandidate);
    const parts = relToWorktrees.split(/[\\/]+/).filter(Boolean);
    if (parts.length < 2) return false;

    // 拒绝读取受管工作树内部嵌套的 .kapibala 或 .git 敏感目录
    const subParts = parts.slice(2);
    if (
      subParts.some((seg) => {
        const lower = seg.toLowerCase();
        return lower === '.kapibala' || lower === '.git';
      })
    ) {
      return false;
    }

    const rawWtRoot = join(worktreesRoot, parts[0]!, parts[1]!);
    if (!fs.lstatSync(rawWtRoot).isDirectory()) return false;
    const canonicalWtRoot = normalizeDrive(fs.realpathSync.native(rawWtRoot));
    if (
      !samePhysicalPath(canonicalWtRoot, rawWtRoot) ||
      !within(canonicalWtRoot, normalizedCandidate)
    ) {
      return false;
    }

    // 步骤 2：校验 <wtRoot>/.git 常规文件与 gitdir: 指针
    const wtDotGit = join(canonicalWtRoot, '.git');
    const dotGitLine = readBoundedSingleLineRegularFile(wtDotGit);
    if (!dotGitLine) return false;
    const match = /^gitdir:[ \t]*(.+)$/.exec(dotGitLine);
    const rawAdminDir = match?.[1]?.trim();
    if (!rawAdminDir) return false;

    // 步骤 3：校验规范化 <adminDir> 为已登记 <mainRepo>/.git/worktrees/<entry>
    const resolvedAdminDir = resolve(canonicalWtRoot, rawAdminDir);
    if (!fs.lstatSync(resolvedAdminDir).isDirectory()) return false;
    const canonicalAdminDir = normalizeDrive(fs.realpathSync.native(resolvedAdminDir));

    const parentWorktreesDir = dirname(canonicalAdminDir);
    const entryName = basename(canonicalAdminDir);
    if (!entryName || entryName === '.' || entryName === '..') return false;
    if (basename(parentWorktreesDir).toLowerCase() !== 'worktrees') return false;
    const candidateMainGitDir = dirname(parentWorktreesDir);
    if (basename(candidateMainGitDir).toLowerCase() !== '.git') return false;
    const candidateMainRepo = dirname(candidateMainGitDir);

    const matchedWorkspace = canonicalWorkspaces.find((wsRoot) =>
      samePhysicalPath(normalizeDrive(wsRoot), candidateMainRepo),
    );
    if (!matchedWorkspace) return false;

    const wsGitDir = join(matchedWorkspace, '.git');
    if (!fs.lstatSync(wsGitDir).isDirectory()) return false;
    const canonicalMainGitDir = normalizeDrive(fs.realpathSync.native(wsGitDir));
    if (!samePhysicalPath(canonicalMainGitDir, candidateMainGitDir)) return false;

    const canonicalAdminRoot = normalizeDrive(
      fs.realpathSync.native(join(canonicalMainGitDir, 'worktrees')),
    );
    const relAdmin = relative(canonicalAdminRoot, canonicalAdminDir);
    if (
      !relAdmin ||
      relAdmin === '.' ||
      relAdmin.startsWith('..') ||
      isAbsolute(relAdmin) ||
      relAdmin.includes('/') ||
      relAdmin.includes('\\')
    ) {
      return false;
    }

    // 步骤 4：校验 <adminDir>/gitdir 与 <adminDir>/commondir 双向回链
    const backlinkLine = readBoundedSingleLineRegularFile(join(canonicalAdminDir, 'gitdir'));
    if (!backlinkLine) return false;
    const canonicalBacklink = normalizeDrive(
      fs.realpathSync.native(resolve(canonicalAdminDir, backlinkLine.trim())),
    );
    if (!samePhysicalPath(canonicalBacklink, wtDotGit)) return false;

    const commondirLine = readBoundedSingleLineRegularFile(join(canonicalAdminDir, 'commondir'));
    if (!commondirLine) return false;
    const canonicalCommondir = normalizeDrive(
      fs.realpathSync.native(resolve(canonicalAdminDir, commondirLine.trim())),
    );
    if (!samePhysicalPath(canonicalCommondir, canonicalMainGitDir)) return false;

    return true;
  } catch {
    return false;
  }
}

/** 本地图片预览允许根校验参数。 */
export interface PreviewBoundaryOptions {
  /** 主进程已登记的工作区物理根集合。 */
  readonly workspaceRoots: readonly string[];
  /** 用户主目录；`~/.kapibala` 除已登记默认空间与通过四步验真的受管工作树外整根排除。 */
  readonly homeDirectory: string;
  /** OS 临时目录；仅测试可覆盖，生产缺省 `os.tmpdir()`。 */
  readonly tempRoot?: string;
}

/**
 * 校验本地图片目标（或相对路径解析根）是否落在受控允许根内（已登记工作区、通过四步双向验真的受管 Git Worktree、OS 临时目录），
 * 并硬排除 `~/.kapibala` 凭据与会话区。
 *
 * 例外：`~/.kapibala` 下仅放行两类受控子目录：① 主进程已显式登记的默认空间 `~/.kapibala/workspaces/default`；
 * ② 归属已登记工作区且通过四步 `.git` 双向物理回链验真的受管工作树 `~/.kapibala/worktrees/<bucket>/<repo>`（不含其内嵌套 `.kapibala` / `.git`）。
 */
export function isAllowedLocalPreviewPath(
  target: string,
  options: PreviewBoundaryOptions,
): boolean {
  const realTarget = canonicalize(resolve(target));
  const canonicalWorkspaces = options.workspaceRoots.map((root) => canonicalize(resolve(root)));
  const kapibalaRoot = canonicalize(join(options.homeDirectory, '.kapibala'));
  const defaultWorkspaceRoot = canonicalize(
    join(options.homeDirectory, '.kapibala', 'workspaces', 'default'),
  );
  if (within(kapibalaRoot, realTarget)) {
    const defaultRegistered = canonicalWorkspaces.some((root) =>
      within(defaultWorkspaceRoot, root),
    );
    if (defaultRegistered && within(defaultWorkspaceRoot, realTarget)) {
      return true;
    }
    return isVerifiedManagedWorktreeOfAllowedWorkspace(
      realTarget,
      canonicalWorkspaces,
      options.homeDirectory,
    );
  }
  const allowedRoots = [...canonicalWorkspaces, canonicalize(options.tempRoot ?? os.tmpdir())];
  return allowedRoots.some((root) => within(root, realTarget));
}

/**
 * 本地图片预览的主进程读取层。
 *
 * 渲染进程没有磁盘读取通道，Markdown 正文里的本地图片（模型用 write_file / shell
 * 产出的 png、svg 等）只能由主进程整读后编码为 data URL 回传。这里集中全部策略：
 * 扩展名白名单、大小上限与路径归一，IPC 入口只做来源校验后委托本模块。
 */

/** Markdown 图片地址按扩展名判断能否走本地预览；不读取磁盘，也不猜测内容类型。 */
export function isLocalImagePath(value: string): boolean {
  const extension = extname(value.split(/[?#]/)[0] ?? '').toLowerCase();
  return extension !== '' && extension.slice(1) in IMAGE_MIME_BY_EXTENSION;
}

/**
 * 把 Markdown 图片地址归一为可读的本地路径。
 *
 * 支持 file:// URL、绝对路径与相对路径三类；相对路径必须给出工作区根才能解析。
 * 查询串（`a.png?v=2`）在此剥除；Windows 的 file:///C:/ 形式按盘符路径还原。
 * 无法安全落地（缺根、跨盘宿主、非图片扩展）返回 undefined，由调用方维持占位。
 */
export function resolveLocalImagePath(src: string, root: string | undefined): string | undefined {
  const value = src.trim();
  if (!value || !isLocalImagePath(value)) return undefined;
  if (/^file:\/\//i.test(value)) {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      return undefined;
    }
    // 非本机宿主的 file URL 不在本进程可读范围内，一律拒绝。
    if (parsed.host && parsed.host !== 'localhost') return undefined;
    let pathname = decodeURIComponent(parsed.pathname);
    // Windows 的 file:///C:/... pathname 带前导斜杠，还原成真实盘符路径。
    if (/^\/[a-zA-Z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
    return isAbsolute(pathname) ? resolve(pathname) : undefined;
  }
  if (isAbsolute(value)) return resolve(value);
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return undefined;
  if (!root) return undefined;
  return resolve(root, value);
}

/**
 * 读取本地图片并编码为 data URL。
 *
 * 只接受 {@link IMAGE_MIME_BY_EXTENSION} 白名单扩展；超过 {@link IMAGE_PREVIEW_LIMIT}
 * 抛 `PREVIEW_TOO_LARGE`，不存在的路径与目录读取错误原样上抛，由 IPC 层转成
 * 渲染层可展示的降级占位。SVG 经 data URL 进 `<img>` 时 SMIL/CSS 动画照常播放，
 * 脚本天然不执行。
 */
export async function readImageDataUrl(path: string): Promise<string> {
  const mime = IMAGE_MIME_BY_EXTENSION[extname(path).slice(1).toLowerCase()];
  if (!mime) throw new Error('PREVIEW_UNSUPPORTED');
  const stats = await stat(path);
  if (!stats.isFile()) throw new Error('PREVIEW_UNSUPPORTED');
  if (stats.size > IMAGE_PREVIEW_LIMIT) throw new Error('PREVIEW_TOO_LARGE');
  const handle = await open(path, 'r');
  try {
    const cap = IMAGE_PREVIEW_LIMIT + 1;
    const buffer = Buffer.allocUnsafe(Math.min(Math.max(stats.size + 1, 1), cap));
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > IMAGE_PREVIEW_LIMIT) throw new Error('PREVIEW_TOO_LARGE');
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: trailing } = await handle.read(extra, 0, 1, offset);
    if (offset + trailing > IMAGE_PREVIEW_LIMIT) throw new Error('PREVIEW_TOO_LARGE');
    return `data:${mime};base64,${buffer.subarray(0, offset).toString('base64')}`;
  } finally {
    await handle.close();
  }
}
