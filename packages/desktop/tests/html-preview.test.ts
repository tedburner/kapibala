import { describe, expect, it } from 'vitest';
import {
  HTML_PREVIEW_LIMIT,
  htmlPreviewSource,
  isTextPreviewPath,
  textPreviewLabel,
  toolPreview,
} from '../src/renderer/html-preview-model.js';

describe('HTML 预览文档', () => {
  it('已有 head 时把 CSP 与 base 插在 head 之后，正文保持原样', () => {
    const html = '<!doctype html><html><head><title>x</title></head><body>hello</body></html>';
    const source = htmlPreviewSource(html);
    expect(source.indexOf('Content-Security-Policy')).toBeGreaterThan(source.indexOf('<head>'));
    expect(source).toContain('<body>hello</body>');
    expect(source.startsWith('<!doctype html>')).toBe(true);
  });

  it('只有 html 根时补一个 head，不重复创建文档结构', () => {
    const source = htmlPreviewSource('<html lang="zh"><body>hi</body></html>');
    expect(source).toContain('<head><meta http-equiv="Content-Security-Policy"');
    expect(source).toContain('<body>hi</body>');
    expect(source.match(/<html/g)).toHaveLength(1);
  });

  it('裸片段包成完整文档并保留原文', () => {
    const source = htmlPreviewSource('<svg><circle r="4" /></svg>');
    expect(source.startsWith('<!doctype html>')).toBe(true);
    expect(source).toContain('<svg><circle r="4" /></svg>');
  });

  it('注入策略断开网络、外链资源与表单，避免预览把数据发出去', () => {
    const source = htmlPreviewSource('<p>x</p>');
    for (const directive of [
      "default-src 'none'",
      "connect-src 'none'",
      "form-action 'none'",
      "frame-src 'none'",
      'img-src data: blob:',
    ])
      expect(source).toContain(directive);
  });
});

describe('写文件入参提取', () => {
  it('只在 write_file 且目标扩展名是 html/htm/svg 时返回内容与对应标题', () => {
    const input = JSON.stringify({ path: 'demo/index.html', content: '<p>x</p>' });
    expect(toolPreview('write_file', input)).toEqual({
      html: '<p>x</p>',
      label: 'HTML 文件预览',
    });
    expect(toolPreview('write_file', JSON.stringify({ path: 'a.HTM', content: 'x' }))).toEqual({
      html: 'x',
      label: 'HTML 文件预览',
    });
    expect(toolPreview('write_file', JSON.stringify({ path: 'a.SVG', content: '<svg/>' }))).toEqual(
      { html: '<svg/>', label: 'SVG 文件预览' },
    );
    expect(
      toolPreview('write_file', JSON.stringify({ path: 'a.md', content: 'x' })),
    ).toBeUndefined();
    expect(toolPreview('edit_file', input)).toBeUndefined();
  });

  it('坏 JSON、非对象或缺少字段时不猜测，直接不给入口', () => {
    expect(toolPreview('write_file', '')).toBeUndefined();
    expect(toolPreview('write_file', '{oops')).toBeUndefined();
    expect(toolPreview('write_file', '"text"')).toBeUndefined();
    expect(toolPreview('write_file', JSON.stringify({ path: 'a.html' }))).toBeUndefined();
    expect(toolPreview('write_file', JSON.stringify({ content: '<p>x</p>' }))).toBeUndefined();
  });

  it('超过预览上限不截断后预览，直接隐藏入口', () => {
    const content = 'x'.repeat(HTML_PREVIEW_LIMIT + 1);
    expect(
      toolPreview('write_file', JSON.stringify({ path: 'big.html', content })),
    ).toBeUndefined();
  });

  it('扩展名识别忽略大小写与首尾空白', () => {
    expect(isTextPreviewPath(' a/b.HTML ')).toBe(true);
    expect(isTextPreviewPath('a/b.htm')).toBe(true);
    expect(isTextPreviewPath('icon.SVG')).toBe(true);
    expect(isTextPreviewPath('a/b.html.txt')).toBe(false);
  });

  it('标题按扩展名区分 HTML 与 SVG（title 是 e2e 的选择器契约）', () => {
    expect(textPreviewLabel('a.html')).toBe('HTML 文件预览');
    expect(textPreviewLabel('b.svg')).toBe('SVG 文件预览');
  });
});
