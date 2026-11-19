/**
 * HTML 预览的跨进程契约。
 *
 * 主进程用这里的策略与上限下发沙箱文档并校验 IPC 入参，渲染层用同一份策略
 * 给预览文档注入 meta —— 两侧各写一份必然漂移，预览就会「界面看着受限、实际没限」。
 */

/** 预览文档专用协议；注册为 standard + secure，才能被 CSP 的 scheme 源与沙箱 iframe 接受。 */
export const PREVIEW_SCHEME = 'kpbl-preview';

/** 预览文档的固定来源；每次预览的随机 token 作为路径段。 */
export const PREVIEW_ORIGIN = `${PREVIEW_SCHEME}://preview`;

/**
 * 单份预览允许的最大字符数。
 *
 * 超过上限直接拒绝预览，不截断后渲染：截断的 HTML 会以「能打开但行为不对」的
 * 方式误导用户。
 */
export const HTML_PREVIEW_LIMIT = 1024 * 1024;

/**
 * 本地图片预览支持扩展名 → MIME 的固定映射；Markdown 本地图片与主进程读取共用。
 *
 * 只收静态图片格式：SVG 的 SMIL/CSS 动画在 `<img>` 与沙箱 iframe 里都能播放，
 * 但脚本类内容（不在此列）按不可信输入一律拒绝。
 */
export const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
};

/**
 * 单张本地图片预览允许的最大字节数。
 *
 * 主进程整读文件后编码为 data URL（base64 约 1.37 倍膨胀），超限直接拒绝，
 * 不缩略降采样——预览通道不做有损转换，超大图交给系统看图器。
 */
export const IMAGE_PREVIEW_LIMIT = 8 * 1024 * 1024;

/** 按扩展名查询图片 MIME；大小写不敏感，未知扩展返回 undefined。 */
export function imageMimeByExtension(value: string): string | undefined {
  return IMAGE_MIME_BY_EXTENSION[value.replace(/^\./, '').toLowerCase()];
}

/**
 * 预览文档的限制策略：断网、禁外链资源、禁表单与嵌套帧。
 *
 * 预览内容来自模型输出，按不可信页面处理；沙箱去掉 allow-same-origin 后文档
 * 已拿不到父页面对象，这里再阻止它把网络当外发通道。
 */
export const PREVIEW_POLICY = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');
