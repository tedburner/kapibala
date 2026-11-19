import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isLocalImagePath,
  readImageDataUrl,
  resolveLocalImagePath,
} from '../src/main/preview-file.js';

describe('本地图片路径解析', () => {
  it('按扩展名白名单识别，查询串先剥除', () => {
    expect(isLocalImagePath('a.png')).toBe(true);
    expect(isLocalImagePath('b.svg?v=2')).toBe(true);
    expect(isLocalImagePath('c.txt')).toBe(false);
    expect(isLocalImagePath('noext')).toBe(false);
  });

  it('file URL 还原本机路径，Windows 盘符剥前导斜杠，外部宿主拒绝', () => {
    expect(resolveLocalImagePath('file:///tmp/a.png', undefined)).toBe('/tmp/a.png');
    // 盘符路径只在 Windows 上可解析；posix 上无绝对语义，按拒绝处理。
    expect(resolveLocalImagePath('file:///C:/out/a.png', undefined)).toEqual(
      process.platform === 'win32' ? 'C:\\out\\a.png' : undefined,
    );
    expect(resolveLocalImagePath('file://server/share/a.png', undefined)).toBeUndefined();
  });

  it('绝对路径直接归一，相对路径必须给出工作区根', () => {
    expect(resolveLocalImagePath('/tmp/a.png', undefined)).toBe('/tmp/a.png');
    expect(resolveLocalImagePath('out/a.png', '/ws')).toBe('/ws/out/a.png');
    expect(resolveLocalImagePath('out/a.png', undefined)).toBeUndefined();
    // 带协议的非 file 地址（http 之外的任意 scheme）与未知扩展一律拒绝。
    expect(resolveLocalImagePath('javascript:a.png', '/ws')).toBeUndefined();
    expect(resolveLocalImagePath('notes.txt', '/ws')).toBeUndefined();
  });
});

describe('本地图片读取', () => {
  it('存在的图片编码为对应 MIME 的 data URL，超限拒绝', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kpbl-preview-'));
    const file = join(directory, 'a.gif');
    writeFileSync(file, Buffer.from('GIF89a'));
    const url = await readImageDataUrl(file);
    expect(url).toBe('data:image/gif;base64,R0lGODlh');
    await expect(readImageDataUrl(join(directory, 'missing.png'))).rejects.toThrow();
    await expect(readImageDataUrl(join(directory, 'notes.txt'))).rejects.toThrow(
      'PREVIEW_UNSUPPORTED',
    );
  });
});
