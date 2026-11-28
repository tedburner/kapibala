import { useEffect, useState } from 'react';
import type { Output } from '../../../shared/contracts.js';
import type {
  DesktopLocalePreference,
  PreferredShellPreference,
  SendShortcutPreference,
  TimeFormatPreference,
} from '../../../shared/i18n/index.js';
import { useI18n } from '../../i18n.js';
import { type ThemeMode, useSettingsStore } from '../../stores/index.js';
import { Select, SettingRow, SettingSection, Switch, TextField } from '../../ui/index.js';
import { GeneralThemeCards } from './GeneralThemeCards.js';
import { GeneralUpdatesSection } from './GeneralUpdatesSection.js';

/** 首选终端 Shell 标识符兼容导出。 */
export type PreferredShellId = PreferredShellPreference;

const UI_FONT_PRESETS = ['system', 'inter', 'noto-sans', 'serif'] as const;
const CODE_FONT_PRESETS = [
  'system',
  'jetbrains-mono',
  'cascadia-mono',
  'fira-code',
  'sf-mono',
] as const;
const CHAT_SIZES = [13, 14, 15, 16, 17, 18] as const;
const TERMINAL_SIZES = [11, 12, 13, 14, 15, 16, 17, 18] as const;

/**
 * `GeneralPage` 入参契约（017 §6.7）：
 * 壳内设置中心左轨第 1 项「常规（General）」，整合 T3 Code 三卡配色模式、中英双语、时间格式、
 * 界面/代码字体与对话/终端字号调节、发送快捷键、后台通知、三项确认开关及终端与更新。
 */
export interface GeneralPageProps {
  readonly active?: boolean;
  readonly appInfo?: Output<'app.getInfo'>;
  readonly initialTheme?: ThemeMode;
  readonly preferredShell?: PreferredShellId;
  readonly onPreferredShellChange?: (shell: PreferredShellId) => void;
  readonly initialUpdateCheck?: Output<'app.checkUpdate'>;
  readonly report?: (message: string) => void;
}

/**
 * 壳内设置中心首栏「常规（General）」页面。
 */
export function GeneralPage({
  active = true,
  appInfo,
  initialTheme,
  preferredShell: controlledShell,
  onPreferredShellChange,
  initialUpdateCheck,
  report,
}: GeneralPageProps) {
  const { t } = useI18n();
  const themeMode = useSettingsStore((s) => s.themeMode);
  const localePreference = useSettingsStore((s) => s.localePreference);
  const typography = useSettingsStore((s) => s.typography);
  const general = useSettingsStore((s) => s.general);
  const confirmations = useSettingsStore((s) => s.confirmations);
  const updatePreferences = useSettingsStore((s) => s.updatePreferences);
  const hydratePreferences = useSettingsStore((s) => s.hydratePreferences);

  const effectiveTheme = initialTheme ?? themeMode;
  const effectiveShell = controlledShell ?? general.preferredShell;

  const isCustomUiFont = !(UI_FONT_PRESETS as readonly string[]).includes(typography.uiFontFamily);
  const isCustomCodeFont = !(CODE_FONT_PRESETS as readonly string[]).includes(
    typography.codeFontFamily,
  );
  const [customUiDraft, setCustomUiDraft] = useState(() =>
    isCustomUiFont ? typography.uiFontFamily : '',
  );
  const [customCodeDraft, setCustomCodeDraft] = useState(() =>
    isCustomCodeFont ? typography.codeFontFamily : '',
  );

  useEffect(() => {
    if (!active || typeof window === 'undefined' || !window.kapibala) return;
    void window.kapibala.preferences
      .read()
      .then((prefs) => {
        hydratePreferences(prefs);
      })
      .catch(() => {});
  }, [active, hydratePreferences]);

  const modLabel = appInfo?.platform === 'darwin' ? '⌘' : 'Ctrl+';

  const applyPatch = (patch: Parameters<typeof updatePreferences>[0]) => {
    void updatePreferences(patch).catch((err: unknown) =>
      report?.(err instanceof Error ? err.message : '保存常规设置失败。'),
    );
  };

  return (
    <div className="kpbl-settings-stack">
      <SettingSection title={t('general.colorSection')} description={t('general.colorSectionDesc')}>
        <GeneralThemeCards
          value={effectiveTheme}
          groupLabel={t('general.colorGroupAria')}
          systemLabel={t('general.themeSystem')}
          lightLabel={t('general.themeLight')}
          darkLabel={t('general.themeDark')}
          onChange={(next) => applyPatch({ theme: next })}
        />
      </SettingSection>

      <SettingSection
        title={t('general.displaySection')}
        description={t('general.displaySectionDesc')}
      >
        <SettingRow
          title={t('general.languageLabel')}
          description={t('general.languageDesc')}
          control={
            <Select<DesktopLocalePreference>
              aria-label={t('general.languageLabel')}
              size="sm"
              value={localePreference}
              options={[
                { value: 'zh-CN', label: t('general.languageZh') },
                { value: 'en', label: t('general.languageEn') },
                { value: 'system', label: t('general.languageSystem') },
              ]}
              onValueChange={(next) => applyPatch({ locale: next })}
            />
          }
        />
        <SettingRow
          title={t('general.timeFormatLabel')}
          description={t('general.timeFormatDesc')}
          control={
            <Select<TimeFormatPreference>
              aria-label={t('general.timeFormatLabel')}
              size="sm"
              value={general.timeFormat}
              options={[
                { value: 'relative', label: t('general.timeRelative') },
                { value: 'system', label: t('general.timeSystem') },
                { value: '24h', label: t('general.time24h') },
                { value: '12h', label: t('general.time12h') },
              ]}
              onValueChange={(next) => applyPatch({ general: { timeFormat: next } })}
            />
          }
        />
      </SettingSection>

      <SettingSection title={t('general.fontSection')} description={t('general.fontSectionDesc')}>
        <SettingRow
          title={t('general.uiFontLabel')}
          description={t('general.uiFontDesc')}
          control={
            <Select<string>
              aria-label={t('general.uiFontLabel')}
              size="sm"
              value={isCustomUiFont ? '__custom__' : typography.uiFontFamily}
              options={[
                { value: 'system', label: t('general.fontPresetSystemSans') },
                { value: 'inter', label: t('general.fontPresetInter') },
                { value: 'noto-sans', label: t('general.fontPresetNotoSans') },
                { value: 'serif', label: t('general.fontPresetSerif') },
                { value: '__custom__', label: t('general.fontPresetCustom') },
              ]}
              onValueChange={(val) => {
                if (val === '__custom__') {
                  const seed = customUiDraft.trim() || 'HarmonyOS Sans SC';
                  setCustomUiDraft(seed);
                  applyPatch({ typography: { uiFontFamily: seed } });
                } else {
                  applyPatch({ typography: { uiFontFamily: val } });
                }
              }}
            />
          }
        >
          {isCustomUiFont ? (
            <TextField
              aria-label={t('general.customUiFontAria')}
              placeholder={t('general.customFontPlaceholder')}
              value={customUiDraft}
              onValueChange={(val) => {
                setCustomUiDraft(val);
                if (val.trim()) applyPatch({ typography: { uiFontFamily: val } });
              }}
            />
          ) : null}
        </SettingRow>

        <SettingRow
          title={t('general.codeFontLabel')}
          description={t('general.codeFontDesc')}
          control={
            <Select<string>
              aria-label={t('general.codeFontLabel')}
              size="sm"
              value={isCustomCodeFont ? '__custom__' : typography.codeFontFamily}
              options={[
                { value: 'system', label: t('general.fontPresetSystemMono') },
                { value: 'jetbrains-mono', label: t('general.fontPresetJetBrains') },
                { value: 'cascadia-mono', label: t('general.fontPresetCascadia') },
                { value: 'fira-code', label: t('general.fontPresetFira') },
                { value: 'sf-mono', label: t('general.fontPresetSfMono') },
                { value: '__custom__', label: t('general.fontPresetCustom') },
              ]}
              onValueChange={(val) => {
                if (val === '__custom__') {
                  const seed = customCodeDraft.trim() || 'Maple Mono';
                  setCustomCodeDraft(seed);
                  applyPatch({ typography: { codeFontFamily: seed } });
                } else {
                  applyPatch({ typography: { codeFontFamily: val } });
                }
              }}
            />
          }
        >
          {isCustomCodeFont ? (
            <TextField
              mono
              aria-label={t('general.customCodeFontAria')}
              placeholder={t('general.customMonoPlaceholder')}
              value={customCodeDraft}
              onValueChange={(val) => {
                setCustomCodeDraft(val);
                if (val.trim()) applyPatch({ typography: { codeFontFamily: val } });
              }}
            />
          ) : null}
        </SettingRow>

        <SettingRow
          title={t('general.chatSizeLabel')}
          description={t('general.chatSizeDesc')}
          control={
            <Select<string>
              aria-label={t('general.chatSizeLabel')}
              size="sm"
              value={String(typography.chatFontSize)}
              options={CHAT_SIZES.map((sz) => ({
                value: String(sz),
                label: sz === 15 ? `${sz} px (Default)` : `${sz} px`,
              }))}
              onValueChange={(val) => applyPatch({ typography: { chatFontSize: Number(val) } })}
            />
          }
        >
          <p className="kpbl-font-preview-box">
            <span>{t('general.fontPreviewSample').split('—')[0]}</span>
            <code className="kpbl-font-preview-code"> · const ready = true;</code>
          </p>
        </SettingRow>

        <SettingRow
          title={t('general.terminalSizeLabel')}
          description={t('general.terminalSizeDesc')}
          control={
            <Select<string>
              aria-label={t('general.terminalSizeLabel')}
              size="sm"
              value={String(typography.terminalFontSize)}
              options={TERMINAL_SIZES.map((sz) => ({
                value: String(sz),
                label: sz === 13 ? `${sz} px (Default)` : `${sz} px`,
              }))}
              onValueChange={(val) => applyPatch({ typography: { terminalFontSize: Number(val) } })}
            />
          }
        />

        <SettingRow
          title={t('general.ligaturesLabel')}
          description={t('general.ligaturesDesc')}
          control={
            <Switch
              aria-label={t('general.ligaturesLabel')}
              checked={typography.codeLigatures}
              onCheckedChange={(checked) => applyPatch({ typography: { codeLigatures: checked } })}
            />
          }
        />

        <SettingRow
          title={t('general.wordWrapLabel')}
          description={t('general.wordWrapDesc')}
          control={
            <Switch
              aria-label={t('general.wordWrapLabel')}
              checked={general.codeWordWrap}
              onCheckedChange={(checked) => applyPatch({ general: { codeWordWrap: checked } })}
            />
          }
        />
      </SettingSection>

      <SettingSection
        title={t('general.interactionSection')}
        description={t('general.interactionSectionDesc')}
      >
        <SettingRow
          title={t('general.sendShortcutLabel')}
          description={t('general.sendShortcutDesc')}
          control={
            <Select<SendShortcutPreference>
              aria-label={t('general.sendShortcutLabel')}
              size="sm"
              value={general.sendShortcut}
              options={[
                { value: 'enter', label: t('general.sendEnter') },
                {
                  value: 'mod-enter',
                  label: t('general.sendModEnter', { mod: modLabel }),
                },
              ]}
              onValueChange={(next) => applyPatch({ general: { sendShortcut: next } })}
            />
          }
        />

        <SettingRow
          title={t('general.notificationsLabel')}
          description={t('general.notificationsDesc')}
          control={
            <Switch
              aria-label={t('general.notificationsLabel')}
              checked={general.desktopNotifications}
              onCheckedChange={(checked) =>
                applyPatch({ general: { desktopNotifications: checked } })
              }
            />
          }
        />
      </SettingSection>

      <SettingSection
        title={t('general.confirmSection')}
        description={t('general.confirmSectionDesc')}
      >
        <SettingRow
          title={t('general.confirmDeleteLabel')}
          description={t('general.confirmDeleteDesc')}
          control={
            <Switch
              aria-label={t('general.confirmDeleteLabel')}
              checked={confirmations.deleteSession}
              onCheckedChange={(checked) =>
                applyPatch({ confirmations: { deleteSession: checked } })
              }
            />
          }
        />
        <SettingRow
          title={t('general.confirmArchiveLabel')}
          description={t('general.confirmArchiveDesc')}
          control={
            <Switch
              aria-label={t('general.confirmArchiveLabel')}
              checked={confirmations.archiveSession}
              onCheckedChange={(checked) =>
                applyPatch({ confirmations: { archiveSession: checked } })
              }
            />
          }
        />
        <SettingRow
          title={t('general.confirmTerminalLabel')}
          description={t('general.confirmTerminalDesc')}
          control={
            <Switch
              aria-label={t('general.confirmTerminalLabel')}
              checked={confirmations.closeActiveTerminal}
              onCheckedChange={(checked) =>
                applyPatch({ confirmations: { closeActiveTerminal: checked } })
              }
            />
          }
        />
      </SettingSection>

      <GeneralUpdatesSection
        active={active}
        appInfo={appInfo}
        preferredShell={effectiveShell}
        onPreferredShellChange={(nextShell) => {
          onPreferredShellChange?.(nextShell);
          applyPatch({ general: { preferredShell: nextShell } });
        }}
        initialUpdateCheck={initialUpdateCheck}
      />
    </div>
  );
}
