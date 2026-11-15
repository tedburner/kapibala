import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../src/main/url.js';

describe('URL 同源比较规范化', () => {
  it('8.3 短名的 ~ 与 pathToFileURL 的 %7E 编码规范化后相等（CI Windows 挂死根因）', () => {
    // Node 把 ~ 编码成 %7E，Chromium 帧 URL 保留字面 ~；两侧必须落到同一字面。
    const shortName =
      'C:/Users/RUNNER~1/AppData/Local/Temp/kpbl-installed/app.asar/out/renderer/index.html';
    const fromNode = pathToFileURL(shortName).href;
    const fromChromium = `file:///${shortName}`;
    expect(fromNode).toContain('%7E');
    expect(fromChromium).toContain('~');
    expect(normalizeUrl(fromNode)).toBe(normalizeUrl(fromChromium));
  });

  it('带查询参数的完整页面 URL 两侧规范化后仍相等，mode 参数原样保留', () => {
    const nodeSide = `${pathToFileURL('C:/x/KPBL83~1/app/out/renderer/index.html').href}?mode=light`;
    const chromiumSide = 'file:///C:/x/KPBL83~1/app/out/renderer/index.html?mode=light';
    expect(normalizeUrl(nodeSide)).toBe(normalizeUrl(chromiumSide));
    expect(normalizeUrl(nodeSide)).toContain('?mode=light');
  });

  it('只解码未保留字符；保留字符的编码不还原，避免放宽路径结构判定', () => {
    expect(normalizeUrl('file:///C:/a%2Fb/index.html')).toBe('file:///C:/a%2Fb/index.html');
    expect(normalizeUrl('file:///C:/a%3Fb/index.html')).toBe('file:///C:/a%3Fb/index.html');
    expect(normalizeUrl('file:///C:/a%20b/index.html')).toBe('file:///C:/a%20b/index.html');
    // 未保留字符全集：字母、数字、- . _ ~
    expect(normalizeUrl('file:///C:/%61%32%2D%2E%5F%7E')).toBe('file:///C:/a2-._~');
  });

  it('保留字符的百分号编码统一大写，大小写差异不再造成字面不等', () => {
    expect(normalizeUrl('file:///C:/a%2fb%3ac')).toBe('file:///C:/a%2Fb%3Ac');
  });

  it('无编码 URL 原样返回；http 开发地址不受影响', () => {
    expect(normalizeUrl('file:///C:/plain/index.html?mode=dark')).toBe(
      'file:///C:/plain/index.html?mode=dark',
    );
    expect(normalizeUrl('http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173/');
  });
});
