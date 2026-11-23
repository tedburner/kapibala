import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isAllowedLocalPreviewPath,
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
    // 斜杠开头路径在 win32 归一到当前盘符根（Node 语义），期望值按平台推导。
    expect(resolveLocalImagePath('file:///tmp/a.png', undefined)).toBe(resolve('/tmp/a.png'));
    // 盘符路径只在 Windows 上可解析；posix 上无绝对语义，按拒绝处理。
    expect(resolveLocalImagePath('file:///C:/out/a.png', undefined)).toEqual(
      process.platform === 'win32' ? 'C:\\out\\a.png' : undefined,
    );
    expect(resolveLocalImagePath('file://server/share/a.png', undefined)).toBeUndefined();
  });

  it('绝对路径直接归一，相对路径必须给出工作区根', () => {
    expect(resolveLocalImagePath('/tmp/a.png', undefined)).toBe(resolve('/tmp/a.png'));
    expect(resolveLocalImagePath('out/a.png', '/ws')).toBe(resolve('/ws', 'out/a.png'));
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
    rmSync(directory, { recursive: true, force: true });
  });

  it('主进程边界仅放行已登记工作区与临时目录，且硬排除 ~/.kapibala 凭据区', () => {
    const base = mkdtempSync(join(tmpdir(), 'kpbl-preview-boundary-'));
    try {
      const home = join(base, 'home');
      const workspace = join(base, 'ws');
      const temp = join(base, 'tmp');
      const defaultWs = join(home, '.kapibala', 'workspaces', 'default');
      for (const dir of [home, workspace, temp, defaultWs]) mkdirSync(dir, { recursive: true });

      const options = { workspaceRoots: [workspace], homeDirectory: home, tempRoot: temp };
      expect(isAllowedLocalPreviewPath(join(workspace, 'a.png'), options)).toBe(true);
      expect(isAllowedLocalPreviewPath(join(temp, 't.png'), options)).toBe(true);
      expect(isAllowedLocalPreviewPath(join(home, 'outside.png'), options)).toBe(false);

      // 即使某个已登记工作区恰好包住 home，~/.kapibala 下的配置/会话也绝不可读。
      expect(
        isAllowedLocalPreviewPath(join(home, '.kapibala', 'secret.svg'), {
          workspaceRoots: [base],
          homeDirectory: home,
          tempRoot: temp,
        }),
      ).toBe(false);

      // 默认空间只有被主进程显式登记时才放行其子路径，~/.kapibala 其余子路径仍拒绝。
      expect(isAllowedLocalPreviewPath(join(defaultWs, 'chart.png'), options)).toBe(false);
      expect(
        isAllowedLocalPreviewPath(join(defaultWs, 'chart.png'), {
          workspaceRoots: [defaultWs],
          homeDirectory: home,
          tempRoot: temp,
        }),
      ).toBe(true);
      expect(
        isAllowedLocalPreviewPath(join(home, '.kapibala', 'settings.svg'), {
          workspaceRoots: [defaultWs],
          homeDirectory: home,
          tempRoot: temp,
        }),
      ).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
