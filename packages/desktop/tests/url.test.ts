import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { normalizeMainFrameUrl, normalizeUrl } from '../src/main/url.js';

// pathToFileURL 只按当前平台语义解析绝对路径：POSIX 上 'C:/…' 是相对路径，会被拼上 cwd。
// 夹具路径按平台选择；Chromium 侧字面 URL 的前缀随之对齐（Windows 三斜杠，POSIX 路径自带首斜杠）。
const win32 = process.platform === 'win32';
const filePrefix = win32 ? 'file:///' : 'file://';

describe('URL 同源比较规范化', () => {
  it('8.3 短名的 ~ 与 pathToFileURL 的 %7E 编码规范化后相等（CI Windows 挂死根因）', () => {
    // Node 把 ~ 编码成 %7E，Chromium 帧 URL 保留字面 ~；两侧必须落到同一字面。
    const shortName = win32
      ? 'C:/Users/RUNNER~1/AppData/Local/Temp/kpbl-installed/app.asar/out/renderer/index.html'
      : '/tmp/kpbl~1/app.asar/out/renderer/index.html';
    const fromNode = pathToFileURL(shortName).href;
    const fromChromium = `${filePrefix}${shortName}`;
    expect(fromNode).toContain('%7E');
    expect(fromChromium).toContain('~');
    expect(normalizeUrl(fromNode)).toBe(normalizeUrl(fromChromium));
  });

  it('带查询参数的完整页面 URL 两侧规范化后仍相等，mode 参数原样保留', () => {
    const pagePath = win32
      ? 'C:/x/KPBL83~1/app/out/renderer/index.html'
      : '/tmp/KPBL83~1/app/out/renderer/index.html';
    const nodeSide = `${pathToFileURL(pagePath).href}?mode=light`;
    const chromiumSide = `${filePrefix}${pagePath}?mode=light`;
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

  it('normalizeMainFrameUrl 剥离页内 #fragment 后保留查询串与 8.3 短名归一', () => {
    expect(normalizeMainFrameUrl('file:///C:/KPBL83%7E1/index.html?mode=dark#details')).toBe(
      normalizeUrl('file:///C:/KPBL83~1/index.html?mode=dark'),
    );
    expect(normalizeMainFrameUrl('http://127.0.0.1:5173/?mode=light#user-content-fn-1')).toBe(
      'http://127.0.0.1:5173/?mode=light',
    );
  });
});
