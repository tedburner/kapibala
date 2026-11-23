import fs from 'node:fs';
import { open, stat } from 'node:fs/promises';
import os from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { IMAGE_MIME_BY_EXTENSION, IMAGE_PREVIEW_LIMIT } from '../shared/preview.js';

/** realpath 归一；目标尚不存在时回溯到最近已存在祖先展开符号链接，确保先判物理边界再判存在。 */
function canonicalize(target: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    const parent = dirname(target);
    if (parent === target) return target;
    return join(canonicalize(parent), basename(target));
  }
}

/** 目标是否位于根本身或根之内；Windows 下 `path.relative` 已按大小写不敏感比较。 */
function within(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/** 本地图片预览允许根校验参数。 */
export interface PreviewBoundaryOptions {
  /** 主进程已登记的工作区物理根集合。 */
  readonly workspaceRoots: readonly string[];
  /** 用户主目录；`~/.kapibala` 除已登记的默认空间子目录外整根排除。 */
  readonly homeDirectory: string;
  /** OS 临时目录；仅测试可覆盖，生产缺省 `os.tmpdir()`。 */
  readonly tempRoot?: string;
}

/**
 * 校验本地图片目标是否落在受控允许根内（已登记工作区 + OS 临时目录），并硬排除 `~/.kapibala` 凭据区。
 *
 * 例外：桌面默认空间位于 `~/.kapibala/workspaces/default`，仅当主进程已显式登记该默认空间时，
 * 允许读取其子目录内的图片；`~/.kapibala` 其余位置（如 `settings.json`、`sessions`、`mcp.json`）一律拒绝。
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
    return defaultRegistered && within(defaultWorkspaceRoot, realTarget);
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
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value)) return undefined;
  if (isAbsolute(value)) return resolve(value);
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
