import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_CONFIRMATION_PREFERENCES,
  DEFAULT_GENERAL_PREFERENCES,
  DEFAULT_TYPOGRAPHY_PREFERENCES,
  type DesktopPreferencesPatch,
  clampChatFontSize,
  clampTerminalFontSize,
} from '../shared/i18n/index.js';

const typographySchema = z
  .object({
    uiFontFamily: z.string().min(1).max(120).default(DEFAULT_TYPOGRAPHY_PREFERENCES.uiFontFamily),
    codeFontFamily: z
      .string()
      .min(1)
      .max(120)
      .default(DEFAULT_TYPOGRAPHY_PREFERENCES.codeFontFamily),
    chatFontSize: z
      .number()
      .int()
      .min(13)
      .max(18)
      .default(DEFAULT_TYPOGRAPHY_PREFERENCES.chatFontSize),
    terminalFontSize: z
      .number()
      .int()
      .min(11)
      .max(18)
      .default(DEFAULT_TYPOGRAPHY_PREFERENCES.terminalFontSize),
    codeLigatures: z.boolean().default(DEFAULT_TYPOGRAPHY_PREFERENCES.codeLigatures),
  })
  .strict();

const generalSchema = z
  .object({
    timeFormat: z
      .enum(['system', 'relative', '24h', '12h'])
      .default(DEFAULT_GENERAL_PREFERENCES.timeFormat),
    sendShortcut: z.enum(['enter', 'mod-enter']).default(DEFAULT_GENERAL_PREFERENCES.sendShortcut),
    codeWordWrap: z.boolean().default(DEFAULT_GENERAL_PREFERENCES.codeWordWrap),
    desktopNotifications: z.boolean().default(DEFAULT_GENERAL_PREFERENCES.desktopNotifications),
    preferredShell: z
      .enum(['auto', 'pwsh', 'powershell', 'cmd', 'git-bash', 'zsh', 'bash', 'fish', 'sh'])
      .default(DEFAULT_GENERAL_PREFERENCES.preferredShell),
  })
  .strict();

const confirmationsSchema = z
  .object({
    deleteSession: z.boolean().default(DEFAULT_CONFIRMATION_PREFERENCES.deleteSession),
    archiveSession: z.boolean().default(DEFAULT_CONFIRMATION_PREFERENCES.archiveSession),
    closeActiveTerminal: z.boolean().default(DEFAULT_CONFIRMATION_PREFERENCES.closeActiveTerminal),
  })
  .strict();

const stateSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).default('light'),
    locale: z.enum(['system', 'zh-CN', 'en']).default('system'),
    typography: typographySchema.default(DEFAULT_TYPOGRAPHY_PREFERENCES),
    general: generalSchema.default(DEFAULT_GENERAL_PREFERENCES),
    confirmations: confirmationsSchema.default(DEFAULT_CONFIRMATION_PREFERENCES),
    recent: z
      .array(z.object({ id: z.string(), name: z.string(), root: z.string() }).strict())
      .max(20)
      .default([]),
    width: z.number().int().min(800).max(10_000).default(1280),
    height: z.number().int().min(600).max(10_000).default(800),
  })
  .strict();

/** Main 独占的桌面偏好状态类型。 */
export type DesktopPersistedState = z.infer<typeof stateSchema>;

/** Main 独占的桌面偏好；不存放消息、模型密钥、权限模式或 Host 资源 ID。 */
export class Preferences {
  private state: DesktopPersistedState;
  private readonly file: string;

  constructor(userData: string) {
    this.file = path.join(userData, 'desktop-state.json');
    try {
      if (fs.statSync(this.file).size > 1024 * 1024) throw new Error('State too large');
      this.state = stateSchema.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      this.state = stateSchema.parse({});
    }
  }

  /** 返回独立副本，窗口或页面不能通过引用替换持久状态。 */
  read(): DesktopPersistedState {
    return structuredClone(this.state);
  }

  /** 只提交已校验的主题偏好；system 保存用户选择，不保存当前系统计算值。 */
  theme(theme: 'light' | 'dark' | 'system'): void {
    this.save({ ...this.state, theme });
  }

  /**
   * 增量合并桌面「常规」偏好并原子写盘；当传入 `resetGeneral: true` 时先还原常规默认基线。
   * 字号字段在入库前先夹紧到安全区间，防止越界数值触发严格 Schema 抛错中断保存。
   */
  patch(update: DesktopPreferencesPatch): DesktopPersistedState {
    if (update.resetGeneral) {
      this.resetGeneral();
      return this.read();
    }
    const nextTypography = update.typography
      ? {
          ...this.state.typography,
          ...(update.typography.uiFontFamily !== undefined
            ? { uiFontFamily: update.typography.uiFontFamily.trim() || 'system' }
            : {}),
          ...(update.typography.codeFontFamily !== undefined
            ? { codeFontFamily: update.typography.codeFontFamily.trim() || 'system' }
            : {}),
          ...(update.typography.chatFontSize !== undefined
            ? { chatFontSize: clampChatFontSize(update.typography.chatFontSize) }
            : {}),
          ...(update.typography.terminalFontSize !== undefined
            ? { terminalFontSize: clampTerminalFontSize(update.typography.terminalFontSize) }
            : {}),
          ...(update.typography.codeLigatures !== undefined
            ? { codeLigatures: update.typography.codeLigatures }
            : {}),
        }
      : this.state.typography;

    this.save({
      ...this.state,
      ...(update.theme !== undefined ? { theme: update.theme } : {}),
      ...(update.locale !== undefined ? { locale: update.locale } : {}),
      typography: nextTypography,
      general: update.general ? { ...this.state.general, ...update.general } : this.state.general,
      confirmations: update.confirmations
        ? { ...this.state.confirmations, ...update.confirmations }
        : this.state.confirmations,
    });
    return this.read();
  }

  /** 重置常规外观、语言、字体字号与交互确认偏好，完整保留最近打开项目与窗口几何尺寸。 */
  resetGeneral(): void {
    this.save({
      ...this.state,
      theme: 'light',
      locale: 'system',
      typography: { ...DEFAULT_TYPOGRAPHY_PREFERENCES },
      general: { ...DEFAULT_GENERAL_PREFERENCES },
      confirmations: { ...DEFAULT_CONFIRMATION_PREFERENCES },
    });
  }

  /** 只接受 Main 已确认的项目路径，最多保留 20 项，不持久化 workspaceId。 */
  recent(root: string, name: string): void {
    const known = this.state.recent.find((item) => item.root === root);
    this.save({
      ...this.state,
      recent: [
        { id: known?.id ?? randomUUID(), root, name },
        ...this.state.recent.filter((item) => item.root !== root),
      ].slice(0, 20),
    });
  }

  /** 只由真实窗口 resize 回调更新，页面没有任意状态替换接口。 */
  bounds(width: number, height: number): void {
    // 上下限都与 stateSchema 对齐：BrowserWindow 没有设上限，宽幅多显示器可拉出超过
    // schema.max 的尺寸，若只夹下限，save 的 parse 会抛 ZodError 并在 resize 防抖回调里反复触发。
    this.save({
      ...this.state,
      width: Math.min(10_000, Math.max(800, width)),
      height: Math.min(10_000, Math.max(600, height)),
    });
  }

  private save(state: DesktopPersistedState): void {
    state = stateSchema.parse(state);
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, this.file);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
    this.state = state;
  }
}
