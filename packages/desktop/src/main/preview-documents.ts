import { randomUUID } from 'node:crypto';
import { HTML_PREVIEW_LIMIT } from '../shared/preview.js';

/** 同时保留的预览文档数上限；预览面板通常只有一两个，超出说明历史被反复点开。 */
const MAX_DOCUMENTS = 16;

/** 预览文档总量上限（字符）；超出后按登记顺序淘汰最早的文档。 */
const MAX_TOTAL = 8 * 1024 * 1024;

/**
 * 主进程内的预览文档登记表。
 *
 * 渲染层不直接持有 iframe 地址：先登记内容换取随机 token，再由预览协议按 token
 * 回读。这样文档与主页面是不同来源，不会继承页面的 CSP（blob:/srcdoc 会继承，
 * 模型输出里的内联脚本会被页面的 script-src 一并封掉），同时也能按总量淘汰，
 * 避免历史里点开大量预览后内存只增不减。
 *
 * 已加载的文档被淘汰不影响正在展示的 iframe；只有在淘汰后才首次加载的地址会 404。
 */
export class PreviewDocuments {
  private readonly documents = new Map<string, string>();
  private total = 0;

  /** 登记一份预览内容并返回 token；超过单份上限直接拒绝，不做截断。 */
  publish(html: string): string {
    if (html.length > HTML_PREVIEW_LIMIT) throw new Error('PREVIEW_TOO_LARGE');
    while (
      this.documents.size >= MAX_DOCUMENTS ||
      (this.total + html.length > MAX_TOTAL && this.documents.size > 0)
    ) {
      const oldest = this.documents.keys().next();
      if (oldest.done) break;
      this.drop(oldest.value);
    }
    const token = randomUUID();
    this.documents.set(token, html);
    this.total += html.length;
    return token;
  }

  /** 按 token 回读内容；未知或已被淘汰的 token 返回 undefined，由协议层回 404。 */
  read(token: string): string | undefined {
    return this.documents.get(token);
  }

  private drop(token: string): void {
    const html = this.documents.get(token);
    if (html === undefined) return;
    this.documents.delete(token);
    this.total -= html.length;
  }
}
