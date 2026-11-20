import { HTML_PREVIEW_LIMIT, PREVIEW_POLICY } from '../shared/preview.js';

export { HTML_PREVIEW_LIMIT };

/**
 * HTML 预览的纯数据层：受限 CSP 注入与写文件工具入参提取。
 *
 * 渲染层只负责把这里给出的字符串交给主进程发布；任何策略判断（能不能预览、
 * 注入什么限制）都留在本模块，便于单测覆盖，不在 React 组件里另写一份。
 * 内容本身由主进程以独立来源提供，因此这里的 meta 只是纵深防御，不承担
 * 「不继承页面策略」的职责（blob:/srcdoc 做不到那一点）。
 */

/**
 * 预览头部：CSP 之后追加 target 为 _blank 的 base。
 *
 * 沙箱没有 allow-popups，链接点击会被直接拦下；这样点击模型输出里的链接不会把
 * 预览导航到外部页面，也不会绕开应用的外链处理。
 */
const PREVIEW_HEAD = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_POLICY}" /><base target="_blank" />`;

/**
 * 把模型输出的 HTML（或 SVG 裸片段）包成可交给预览协议的文档。
 *
 * 已有 `<head>` 时插在其后，只有 `<html>` 时补一个 head，裸片段（含 SVG 根元素）
 * 则包成完整文档；三种情况都保证 CSP 位于文档解析早期，不会出现先加载资源再
 * 受限制的窗口期。
 */
export function htmlPreviewSource(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) {
    const index = head.index + head[0].length;
    return `${html.slice(0, index)}${PREVIEW_HEAD}${html.slice(index)}`;
  }
  const root = /<html[^>]*>/i.exec(html);
  if (root) {
    const index = root.index + root[0].length;
    return `${html.slice(0, index)}<head>${PREVIEW_HEAD}</head>${html.slice(index)}`;
  }
  return `<!doctype html><html><head>${PREVIEW_HEAD}</head><body>${html}</body></html>`;
}

/**
 * 仅按扩展名识别可预览的文本类目标；不读取磁盘，也不猜测 MIME。
 *
 * html/htm 走完整 HTML 文档预览；svg 是合法的 HTML 内联元素，经裸片段分支
 * 包成完整文档后 SMIL 动画照常播放，与 html 共用同一份 CSP 限制。
 */
export function isTextPreviewPath(value: string): boolean {
  return /\.(html?|svg)$/i.test(value.trim());
}

/** 按预览目标类型取 iframe 的无障碍标题；title 是桌面 e2e 的选择器契约。 */
export function textPreviewLabel(value: string): string {
  return /\.svg$/i.test(value.trim()) ? 'SVG 文件预览' : 'HTML 文件预览';
}

/**
 * 从工具调用入参里提取可预览的文档。
 *
 * 只认内置 `write_file`：其它工具的参数形状没有稳定契约，误判会把任意文本塞进 iframe。
 * 入参是宿主已脱敏的 JSON 文本，解析失败、路径不是 html/htm/svg 或内容超过
 * {@link HTML_PREVIEW_LIMIT} 时一律返回 undefined，由调用方隐藏预览入口。
 */
export function toolPreview(
  name: string,
  input: string,
  limit: number = HTML_PREVIEW_LIMIT,
): { html: string; label: string } | undefined {
  if (name !== 'write_file' || !input) return undefined;
  // JSON 转义最坏情况约两倍于原文，先按宽松系数挡掉明显超限的入参，避免整段解析。
  if (input.length > limit * 4) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  const path = record.path;
  const content = record.content;
  if (typeof path !== 'string' || typeof content !== 'string') return undefined;
  if (!isTextPreviewPath(path) || content.length > limit) return undefined;
  return { html: content, label: textPreviewLabel(path) };
}
