/** 桌面客户端界面语言偏好：`'system'` 动态映射系统语言，显式语言优先固定使用。 */
export type DesktopLocalePreference = 'system' | 'zh-CN' | 'en';

/** 解析后的实际生效界面语言（主进程原生菜单/通知与渲染层全界面同源）。 */
export type ResolvedDesktopLocale = 'zh-CN' | 'en';

/** 历史会话与消息活动时间戳的展示格式。 */
export type TimeFormatPreference = 'system' | 'relative' | '24h' | '12h';

/** 输入坞键盘发送快捷键偏好。 */
export type SendShortcutPreference = 'enter' | 'mod-enter';

/** 首选交互式终端 Shell 枚举（跨平台合集，运行时按平台筛选可见项）。 */
export type PreferredShellPreference =
  | 'auto'
  | 'pwsh'
  | 'powershell'
  | 'cmd'
  | 'git-bash'
  | 'zsh'
  | 'bash'
  | 'fish'
  | 'sh';

/** 桌面客户端排版与字号本地偏好；字号上下限由校验层强夹紧以守护最小窗口不溢出。 */
export interface DesktopTypographyPreferences {
  readonly uiFontFamily: string;
  readonly codeFontFamily: string;
  readonly chatFontSize: number;
  readonly terminalFontSize: number;
  readonly codeLigatures: boolean;
}

/** 桌面客户端常规交互与显示偏好。 */
export interface DesktopGeneralPreferences {
  readonly timeFormat: TimeFormatPreference;
  readonly sendShortcut: SendShortcutPreference;
  readonly codeWordWrap: boolean;
  readonly desktopNotifications: boolean;
  readonly preferredShell: PreferredShellPreference;
}

/** 桌面客户端高风险/高频操作二次确认开关。 */
export interface DesktopConfirmationPreferences {
  readonly deleteSession: boolean;
  readonly archiveSession: boolean;
  readonly closeActiveTerminal: boolean;
}

/** `preferences.update` 支持的增量补丁结构；各子对象均可局部提交。 */
export interface DesktopPreferencesPatch {
  readonly theme?: 'light' | 'dark' | 'system';
  readonly locale?: DesktopLocalePreference;
  readonly typography?: Partial<DesktopTypographyPreferences>;
  readonly general?: Partial<DesktopGeneralPreferences>;
  readonly confirmations?: Partial<DesktopConfirmationPreferences>;
  readonly resetGeneral?: boolean;
}

/** 桌面常规偏好的只读默认值集合（供主进程 Schema 与渲染层 Store 共享单一基线）。 */
export const DEFAULT_LOCALE_PREFERENCE: DesktopLocalePreference = 'system';

/** 桌面排版与字号默认基线。 */
export const DEFAULT_TYPOGRAPHY_PREFERENCES: DesktopTypographyPreferences = Object.freeze({
  uiFontFamily: 'system',
  codeFontFamily: 'system',
  chatFontSize: 15,
  terminalFontSize: 13,
  codeLigatures: false,
});

/** 桌面交互与显示默认基线。 */
export const DEFAULT_GENERAL_PREFERENCES: DesktopGeneralPreferences = Object.freeze({
  timeFormat: 'relative',
  sendShortcut: 'enter',
  codeWordWrap: false,
  desktopNotifications: true,
  preferredShell: 'auto',
});

/** 桌面操作二次确认默认基线：不可逆删除与关闭运行中终端默认开启，可逆归档默认免打扰。 */
export const DEFAULT_CONFIRMATION_PREFERENCES: DesktopConfirmationPreferences = Object.freeze({
  deleteSession: true,
  archiveSession: false,
  closeActiveTerminal: true,
});
