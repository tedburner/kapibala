import { imageMimeByExtension } from '../shared/preview.js';

/**
 * 消息内图片地址的分类规则。
 *
 * 远程 http(s) 与内联 data:image 直接渲染；本地图片（file://、绝对路径、相对路径，
 * 且扩展名在图片白名单内）归为 local，由组件经主进程读取通道回 data URL 后渲染；
 * 其余本地地址（非图片扩展、缺根的 file URL）维持占位，渲染进程自身始终不做磁盘
 * 读取。其它协议（javascript: 等）一律按不安全处理。分类只做字符串判定与路径
 * 归一，不发起任何 IO。
 */
export type ImageSource =
  | { kind: 'render'; url: string }
  | { kind: 'local'; path: string }
  | { kind: 'placeholder'; reason: 'local' | 'unsafe' };

/** file:// 的 pathname 还原为本地路径（Windows 的 file:///C:/... 需剥前导斜杠）。 */
function fromFileUrl(value: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  // 非本机宿主不在主进程可读范围内，按本地占位处理而非静默失败。
  if (parsed.host && parsed.host !== 'localhost') return undefined;
  let pathname = decodeURIComponent(parsed.pathname);
  if (/^\/[a-zA-Z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
  return pathname;
}

/** 按扩展名判断是否图片白名单成员；查询串（`a.png?v=2`）先剥除再判定。 */
function isImagePath(value: string): boolean {
  const extension = (value.split(/[?#]/)[0] ?? '').match(/\.([a-zA-Z0-9]+)$/)?.[1] ?? '';
  return imageMimeByExtension(extension) !== undefined;
}

/** 判断一张 Markdown 图片能否直接在正文里渲染。 */
export function classifyImageSource(src: string | undefined): ImageSource {
  const value = src?.trim() ?? '';
  if (!value) return { kind: 'placeholder', reason: 'unsafe' };
  if (/^https?:\/\//i.test(value)) return { kind: 'render', url: value };
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return { kind: 'render', url: value };
  if (/^file:\/\//i.test(value)) {
    const path = fromFileUrl(value);
    return path && isImagePath(path)
      ? { kind: 'local', path }
      : { kind: 'placeholder', reason: 'local' };
  }
  // 绝对路径（盘符或根前缀）、相对前缀与不含协议的裸相对路径都算本地地址。
  const isLocalShape =
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    !(/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(value) || value.includes('://'));
  if (!isLocalShape) return { kind: 'placeholder', reason: 'unsafe' };
  return isImagePath(value)
    ? { kind: 'local', path: value }
    : { kind: 'placeholder', reason: 'local' };
}
