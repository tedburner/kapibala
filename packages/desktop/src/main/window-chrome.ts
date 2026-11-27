import type { BrowserWindowConstructorOptions, TitleBarOverlay } from 'electron';

export type DisplayMode = 'light' | 'dark';

/** 与 `theme-kapibala.css` `--kapibala-titlebar-height` 同源的 46px 顶栏高度。 */
export const TITLEBAR_HEIGHT = 46;

/** 主进程窗口底色与沉浸式标题栏覆盖层底色，与渲染层 `bg-kumo-base` 严格同值以避免首帧或切主题露白边。 */
export const WINDOW_SURFACES: Readonly<Record<DisplayMode, string>> = {
  light: '#FFFFFF',
  dark: '#181818',
};

const WINDOW_SYMBOLS: Readonly<Record<DisplayMode, string>> = {
  light: '#1F1F1F',
  dark: '#EDEDED',
};

/**
 * 构造 Windows 沉浸式 `titleBarOverlay` 参数：将系统原生最小化/最大化/关闭按钮融入 46px 应用顶栏，
 * 随亮暗主题实时同步背景与图标前景色。
 */
export function titleBarOverlayOptions(mode: DisplayMode): TitleBarOverlay {
  return {
    color: WINDOW_SURFACES[mode],
    symbolColor: WINDOW_SYMBOLS[mode],
    height: TITLEBAR_HEIGHT,
  };
}

export interface WindowChromeResolution {
  browserWindow: Pick<
    BrowserWindowConstructorOptions,
    'autoHideMenuBar' | 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'
  >;
  /** 是否在创建窗口后显式隐藏窗口内菜单栏（保留应用级 Menu 以继续支持快捷键与 macOS 顶栏菜单）。 */
  hideMenuBar: boolean;
}

/**
 * 按操作系统与亮暗模式解析主窗口边框与菜单栏收敛策略：
 * - `darwin`：`hiddenInset` + 红绿灯内嵌，保留 macOS 屏幕顶栏应用菜单；
 * - `win32`：`hidden` + `titleBarOverlay` 单层沉浸顶栏，彻底消除「原生标题栏 + Win32 菜单栏 + 侧栏头」三层堆叠；
 * - `linux`：隐藏冗余的窗口内 GTK 菜单栏，但保留窗口管理器原生标题栏，确保 X11/Wayland/平铺 WM 与无头 Xvfb 均具备可靠窗口控制按钮。
 */
export function resolveWindowChromeOptions(
  platform: NodeJS.Platform,
  mode: DisplayMode,
): WindowChromeResolution {
  if (platform === 'darwin') {
    return {
      browserWindow: {
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 16, y: 15 },
      },
      hideMenuBar: false,
    };
  }
  if (platform === 'win32') {
    return {
      browserWindow: {
        autoHideMenuBar: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: titleBarOverlayOptions(mode),
      },
      hideMenuBar: true,
    };
  }
  return {
    browserWindow: {
      autoHideMenuBar: true,
    },
    hideMenuBar: true,
  };
}
