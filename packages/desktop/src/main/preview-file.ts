import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import { IMAGE_MIME_BY_EXTENSION, IMAGE_PREVIEW_LIMIT } from '../shared/preview.js';

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
  const buffer = await readFile(path);
  if (buffer.byteLength > IMAGE_PREVIEW_LIMIT) throw new Error('PREVIEW_TOO_LARGE');
  return `data:${mime};base64,${buffer.toString('base64')}`;
}
