import { EN_MESSAGES } from './en.js';
import {
  DEFAULT_CONFIRMATION_PREFERENCES,
  DEFAULT_GENERAL_PREFERENCES,
  DEFAULT_LOCALE_PREFERENCE,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  type DesktopConfirmationPreferences,
  type DesktopGeneralPreferences,
  type DesktopLocalePreference,
  type DesktopPreferencesPatch,
  type DesktopTypographyPreferences,
  type PreferredShellPreference,
  type ResolvedDesktopLocale,
  type SendShortcutPreference,
  type TimeFormatPreference,
} from './types.js';
import { type TranslationKey, ZH_CN_MESSAGES } from './zh-CN.js';

export {
  DEFAULT_CONFIRMATION_PREFERENCES,
  DEFAULT_GENERAL_PREFERENCES,
  DEFAULT_LOCALE_PREFERENCE,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  EN_MESSAGES,
  ZH_CN_MESSAGES,
  type DesktopConfirmationPreferences,
  type DesktopGeneralPreferences,
  type DesktopLocalePreference,
  type DesktopPreferencesPatch,
  type DesktopTypographyPreferences,
  type PreferredShellPreference,
  type ResolvedDesktopLocale,
  type SendShortcutPreference,
  type TimeFormatPreference,
  type TranslationKey,
};

const BASE_SANS_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';
const BASE_MONO_STACK =
  'ui-monospace, "SFMono-Regular", "SF Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace';

const SANS_PRESET_MAP: Readonly<Record<string, string>> = {
  system: BASE_SANS_STACK,
  inter: `"Inter", ${BASE_SANS_STACK}`,
  'noto-sans': `"Noto Sans SC", "Source Han Sans SC", "Noto Sans", ${BASE_SANS_STACK}`,
  serif: `"Songti SC", "STSong", "Noto Serif SC", Georgia, Cambria, serif`,
};

const MONO_PRESET_MAP: Readonly<Record<string, string>> = {
  system: BASE_MONO_STACK,
  'jetbrains-mono': `"JetBrains Mono", ${BASE_MONO_STACK}`,
  'cascadia-mono': `"Cascadia Mono", "Cascadia Code", ${BASE_MONO_STACK}`,
  'fira-code': `"Fira Code", ${BASE_MONO_STACK}`,
  'sf-mono': `"SF Mono", "SFMono-Regular", ${BASE_MONO_STACK}`,
};

/**
 * 将用户语言偏好与宿主系统语言解析为确定性的双语标识（`'zh-CN' | 'en'`）。
 *
 * 边界取舍：默认偏好为 `'system'`（`zh*` 映射简体中文，其余回退英文）；
 * 当 `KPBL_DESKTOP_E2E === '1'` 且处于 `'system'` 模式时固定解析为 `'zh-CN'`，守护跨区域 CI 中文选择器契约。
 */
export function resolveDesktopLocale(
  preference: DesktopLocalePreference = DEFAULT_LOCALE_PREFERENCE,
  systemLocale?: string | null,
): ResolvedDesktopLocale {
  if (preference === 'zh-CN' || preference === 'en') return preference;
  const e2eFlag = (
    globalThis as {
      readonly process?: { readonly env?: Readonly<Record<string, string | undefined>> };
    }
  ).process?.env?.KPBL_DESKTOP_E2E;
  if (e2eFlag === '1') return 'zh-CN';
  const normalized = (systemLocale ?? '').trim().toLowerCase();
  return normalized.startsWith('zh') ? 'zh-CN' : 'en';
}

/**
 * 纯函数双语词条查询与命名占位符（`{name}`）安全替换；未传入的参数保留空串而不抛异常。
 */
export function translateDesktop(
  locale: ResolvedDesktopLocale,
  key: TranslationKey,
  params?: Readonly<Record<string, string | number>>,
): string {
  const table = locale === 'en' ? EN_MESSAGES : ZH_CN_MESSAGES;
  const template: string = table[key] ?? ZH_CN_MESSAGES[key];
  if (!params) return template;
  return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, token: string) => {
    const val = params[token];
    return val === undefined ? '' : String(val);
  });
}

function sanitizeCustomFontName(raw: string): string {
  return raw
    .replace(/[;{}()[\]\\/"'`<>:\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * 解析安全的界面无衬线 CSS `font-family` 字符串；自定义字体名会剥离所有样式语法定界符防注入。
 */
export function resolveSansFontStack(uiFontFamily: string): string {
  const key = uiFontFamily.trim();
  if (!key || key === 'system') return BASE_SANS_STACK;
  const preset = SANS_PRESET_MAP[key];
  if (preset) return preset;
  const clean = sanitizeCustomFontName(key);
  return clean ? `"${clean}", ${BASE_SANS_STACK}` : BASE_SANS_STACK;
}

/**
 * 解析安全的代码与终端等宽 CSS `font-family` 字符串，保证缺失字形始终有平台原生等宽兜底。
 */
export function resolveMonoFontStack(codeFontFamily: string): string {
  const key = codeFontFamily.trim();
  if (!key || key === 'system') return BASE_MONO_STACK;
  const preset = MONO_PRESET_MAP[key];
  if (preset) return preset;
  const clean = sanitizeCustomFontName(key);
  return clean ? `"${clean}", ${BASE_MONO_STACK}` : BASE_MONO_STACK;
}

/** 夹紧对话阅读流字号至 `13..18` px 整数，防止极端数值破坏虚拟列表行高测量。 */
export function clampChatFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TYPOGRAPHY_PREFERENCES.chatFontSize;
  return Math.min(18, Math.max(13, Math.round(size)));
}

/** 夹紧工作台伪终端字号至 `11..18` px 整数，保障 `@xterm/addon-fit` 至少留出 2 列可视宽度。 */
export function clampTerminalFontSize(size: number): number {
  if (!Number.isFinite(size)) return DEFAULT_TYPOGRAPHY_PREFERENCES.terminalFontSize;
  return Math.min(18, Math.max(11, Math.round(size)));
}

/**
 * 按用户「时间格式」与生效语言格式化会话活动时间；零值或非法时间戳恒返回空串，绝不伪造「刚刚」。
 */
export function formatActivityTimestamp(
  timestamp: number,
  format: TimeFormatPreference = 'relative',
  locale: ResolvedDesktopLocale = 'zh-CN',
  now = Date.now(),
): string {
  if (!timestamp || !Number.isFinite(timestamp) || timestamp <= 0) return '';
  if (format === 'relative') {
    const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
    if (minutes < 1) return locale === 'en' ? 'Just now' : '刚刚';
    if (minutes < 60) return locale === 'en' ? `${minutes}m ago` : `${minutes}分钟前`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return locale === 'en' ? `${hours}h ago` : `${hours}小时前`;
    const days = Math.floor(hours / 24);
    if (days < 7) return locale === 'en' ? `${days}d ago` : `${days}天前`;
    return new Date(timestamp).toLocaleDateString(locale === 'en' ? 'en-US' : 'zh-CN');
  }
  const date = new Date(timestamp);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const intlLocale = locale === 'en' ? 'en-US' : 'zh-CN';
  if (format === '24h' || format === '12h') {
    const timePart = date.toLocaleTimeString(intlLocale, {
      hour: '2-digit',
      minute: '2-digit',
      hour12: format === '12h',
    });
    return sameDay
      ? timePart
      : `${date.toLocaleDateString(intlLocale, { month: 'numeric', day: 'numeric' })} ${timePart}`;
  }
  return sameDay
    ? date.toLocaleTimeString(intlLocale, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(intlLocale);
}

/**
 * 判定输入框键盘事件是否应触发发送消息：
 * IME 组合选词期（`isComposing`）恒拦截；`mod-enter` 模式下要求按下 `Ctrl` 或 `Meta`。
 */
export function shouldSubmitComposerKey(
  event: {
    readonly key: string;
    readonly shiftKey: boolean;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly isComposing?: boolean;
  },
  shortcut: SendShortcutPreference = 'enter',
): boolean {
  if (event.isComposing || event.key !== 'Enter') return false;
  if (shortcut === 'mod-enter') {
    return (event.metaKey || event.ctrlKey) && !event.shiftKey;
  }
  return !event.shiftKey;
}
