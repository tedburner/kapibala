import { describe, expect, it } from 'vitest';
import { encodePngFramesToIco, resolveWindowsAppId } from '../src/main/win-icon.js';

describe('Windows 任务栏图标与 AppUserModelID 辅助', () => {
  it('按标准 Vista+ PNG-in-ICO 容器封装多尺寸图标帧（256px 宽高字节写 0）', () => {
    const fakePng16 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const fakePng256 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 6, 7, 8, 9]);

    const ico = encodePngFramesToIco([
      { size: 16, png: fakePng16 },
      { size: 256, png: fakePng256 },
    ]);

    // ICONDIR 头部：reserved=0, type=1(ICO), count=2
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBe(2);

    // 第 1 帧目录项（offset 6..21）：16x16
    expect(ico.readUInt8(6)).toBe(16);
    expect(ico.readUInt8(7)).toBe(16);
    expect(ico.readUInt16LE(10)).toBe(1);
    expect(ico.readUInt16LE(12)).toBe(32);
    expect(ico.readUInt32LE(14)).toBe(fakePng16.length);
    const offset0 = ico.readUInt32LE(18);
    expect(offset0).toBe(6 + 2 * 16);

    // 第 2 帧目录项（offset 22..37）：256x256 必须编码为 0
    expect(ico.readUInt8(22)).toBe(0);
    expect(ico.readUInt8(23)).toBe(0);
    expect(ico.readUInt32LE(30)).toBe(fakePng256.length);
    const offset1 = ico.readUInt32LE(34);
    expect(offset1).toBe(offset0 + fakePng16.length);

    expect(ico.subarray(offset0, offset0 + fakePng16.length).equals(fakePng16)).toBe(true);
    expect(ico.subarray(offset1, offset1 + fakePng256.length).equals(fakePng256)).toBe(true);
  });

  it('区分正式包、测试隔离与本地开发的 Windows AppUserModelID，避免与原生 Electron 串组', () => {
    expect(resolveWindowsAppId({ isPackaged: true, isTestIsolation: false })).toBe(
      'dev.kapibala.desktop',
    );
    expect(resolveWindowsAppId({ isPackaged: false, isTestIsolation: true })).toBe(
      'dev.kapibala.desktop.test',
    );
    expect(resolveWindowsAppId({ isPackaged: false, isTestIsolation: false })).toBe(
      'dev.kapibala.desktop.dev',
    );
  });
});
