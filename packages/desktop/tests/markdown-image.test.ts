import { describe, expect, it } from 'vitest';
import { classifyImageSource } from '../src/renderer/markdown-image-model.js';

describe('正文图片地址分类', () => {
  it('远程 http(s) 与 base64 图片直接渲染', () => {
    expect(classifyImageSource('https://example.com/a.png')).toEqual({
      kind: 'render',
      url: 'https://example.com/a.png',
    });
    expect(classifyImageSource('http://127.0.0.1:8080/a.png?x=1')).toEqual({
      kind: 'render',
      url: 'http://127.0.0.1:8080/a.png?x=1',
    });
    const data = 'data:image/svg+xml;base64,PHN2Zy8+';
    expect(classifyImageSource(data)).toEqual({ kind: 'render', url: data });
  });

  it('本地图片路径（绝对/相对/file://）走主进程读取通道', () => {
    expect(classifyImageSource('/tmp/preview.png')).toEqual({
      kind: 'local',
      path: '/tmp/preview.png',
    });
    expect(classifyImageSource('./pelican-car.svg')).toEqual({
      kind: 'local',
      path: './pelican-car.svg',
    });
    expect(classifyImageSource('../img/photo.JPEG')).toEqual({
      kind: 'local',
      path: '../img/photo.JPEG',
    });
    expect(classifyImageSource('C:\\img\\a.png')).toEqual({
      kind: 'local',
      path: 'C:\\img\\a.png',
    });
    expect(classifyImageSource('shot.webp?v=2#top')).toEqual({
      kind: 'local',
      path: 'shot.webp?v=2#top',
    });
    expect(classifyImageSource('file:///tmp/a.gif')).toEqual({ kind: 'local', path: '/tmp/a.gif' });
    expect(classifyImageSource('file:///C:/out/plot.png')).toEqual({
      kind: 'local',
      path: 'C:/out/plot.png',
    });
  });

  it('非图片扩展的本地地址仍退化为本地占位，不做无谓读取', () => {
    for (const src of ['/tmp/notes.txt', './a.md', 'file:///etc/hosts'])
      expect(classifyImageSource(src)).toEqual({ kind: 'placeholder', reason: 'local' });
  });

  it('空地址、非图片 data 与可执行协议一律按不安全处理', () => {
    for (const src of [
      undefined,
      '',
      'javascript:alert(1)',
      'data:text/html;base64,PGI+',
      'ftp://h/a.png',
    ])
      expect(classifyImageSource(src)).toEqual({ kind: 'placeholder', reason: 'unsafe' });
  });
});
