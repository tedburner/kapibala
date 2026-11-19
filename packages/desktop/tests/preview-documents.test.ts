import { describe, expect, it } from 'vitest';
import { PreviewDocuments } from '../src/main/preview-documents.js';
import { HTML_PREVIEW_LIMIT } from '../src/shared/preview.js';

describe('预览文档登记表', () => {
  it('登记后可凭 token 回读，未知 token 返回 undefined', () => {
    const documents = new PreviewDocuments();
    const token = documents.publish('<p>x</p>');
    expect(documents.read(token)).toBe('<p>x</p>');
    expect(documents.read('missing')).toBeUndefined();
  });

  it('超过单份上限直接拒绝，不截断后登记', () => {
    const documents = new PreviewDocuments();
    expect(() => documents.publish('x'.repeat(HTML_PREVIEW_LIMIT + 1))).toThrow(
      'PREVIEW_TOO_LARGE',
    );
    expect(() => documents.publish('x'.repeat(HTML_PREVIEW_LIMIT))).not.toThrow();
  });

  it('文档数量超限时按登记顺序淘汰最早的文档，新的仍可读', () => {
    const documents = new PreviewDocuments();
    const tokens = Array.from({ length: 17 }, (_, index) => documents.publish(`<p>${index}</p>`));
    expect(documents.read(tokens[0])).toBeUndefined();
    expect(documents.read(tokens[16])).toBe('<p>16</p>');
  });

  it('总量超限时继续淘汰，直到当前文档能放下', () => {
    const documents = new PreviewDocuments();
    const biggest = 'x'.repeat(HTML_PREVIEW_LIMIT);
    const tokens = Array.from({ length: 9 }, () => documents.publish(biggest));
    // 8 MiB 总量上限只容得下 8 份 1 MiB 文档，第 9 份登记后第 1 份必须已淘汰。
    expect(documents.read(tokens[0])).toBeUndefined();
    expect(documents.read(tokens[8])).toBe(biggest);
  });
});
