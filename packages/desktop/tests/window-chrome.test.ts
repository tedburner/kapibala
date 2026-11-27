import { describe, expect, it } from 'vitest';
import { resolveWindowChromeOptions, titleBarOverlayOptions } from '../src/main/window-chrome.js';

describe('resolveWindowChromeOptions 跨平台顶栏与菜单栏收敛', () => {
  it('macOS 使用 hiddenInset 红绿灯沉浸标题栏，不隐藏系统顶栏菜单', () => {
    const opts = resolveWindowChromeOptions('darwin', 'light');
    expect(opts).toEqual({
      browserWindow: {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 15 },
      },
      hideMenuBar: false,
    });
  });

  it('Windows 使用 hidden + titleBarOverlay 单层沉浸顶栏并隐藏窗口内原生菜单栏', () => {
    const light = resolveWindowChromeOptions('win32', 'light');
    expect(light.hideMenuBar).toBe(true);
    expect(light.browserWindow).toEqual({
      autoHideMenuBar: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: titleBarOverlayOptions('light'),
    });
    expect(titleBarOverlayOptions('light')).toEqual({
      color: '#FFFFFF',
      symbolColor: '#1F1F1F',
      height: 46,
    });
    expect(titleBarOverlayOptions('dark')).toEqual({
      color: '#181818',
      symbolColor: '#EDEDED',
      height: 46,
    });
  });

  it('Linux 隐藏窗口内重复原生菜单栏但保留系统窗口管理器边框（兼容 X11/Wayland/Xvfb）', () => {
    const linux = resolveWindowChromeOptions('linux', 'dark');
    expect(linux).toEqual({
      browserWindow: {
        autoHideMenuBar: true,
      },
      hideMenuBar: true,
    });
  });
});
