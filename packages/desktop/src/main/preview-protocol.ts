import { protocol } from 'electron';
import { PREVIEW_ORIGIN, PREVIEW_POLICY, PREVIEW_SCHEME } from '../shared/preview.js';
import type { PreviewDocuments } from './preview-documents.js';

/**
 * 声明预览协议为 standard + secure。
 *
 * 必须在 app ready 之前调用；普通（非 standard）协议拿不到独立来源，CSP 的
 * scheme 源也匹配不到它，沙箱 iframe 会被页面策略拦住。
 */
export function registerPreviewScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true } },
  ]);
}

/**
 * 安装预览协议处理器：按 token 回读登记内容，并把限制策略放在响应头上。
 *
 * 响应头 CSP 是该文档自己的策略容器，不会像 blob:/srcdoc: 那样继承主页面策略；
 * meta 里再注入一份相同策略作为纵深防御。未知 token 一律 404，不回显错误细节。
 */
export function installPreviewProtocol(documents: PreviewDocuments): void {
  protocol.handle(PREVIEW_SCHEME, (request) => {
    const token = new URL(request.url).pathname.replace(/^\//, '');
    const html = documents.read(token);
    if (html === undefined) return new Response('', { status: 404 });
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': PREVIEW_POLICY,
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
      },
    });
  });
}

/** 由 token 拼出预览地址；来源固定，token 仅作为路径段。 */
export function previewUrl(token: string): string {
  return `${PREVIEW_ORIGIN}/${token}`;
}
