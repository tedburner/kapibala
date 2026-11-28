import type {
  ViewExternalHarness,
  ViewExternalHarnessProbe,
  ViewExternalTemplate,
} from '@kiturone/kapibala-host/view-model';
import { useSyncExternalStore } from 'react';
import { create } from 'zustand';
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
  type ResolvedDesktopLocale,
  clampChatFontSize,
  clampTerminalFontSize,
  resolveDesktopLocale,
  resolveMonoFontStack,
  resolveSansFontStack,
} from '../../shared/i18n/index.js';

/** 外观主题偏好枚举：对齐 `boot-theme.js` 与 `tokens.css` 双主题选择。 */
export type ThemeMode = 'system' | 'light' | 'dark';

/** 公开模型配置项投影（凭证仅暴露已配置布尔位与来源枚举，绝不携带密钥明文）。 */
export interface ModelProfileSummary {
  readonly id: string;
  readonly name: string;
  readonly provider: 'openai-compatible' | 'openai-responses' | 'anthropic';
  readonly providerKey: string;
  readonly modelName: string;
  readonly effectiveBaseURL: string;
  readonly builtin: boolean;
  readonly disabled: boolean;
  readonly scope: 'global' | 'project';
  readonly supportsThinking?: boolean;
  readonly contextWindow?: number;
  readonly credential: {
    readonly configured: boolean;
    readonly source: 'none' | 'inline' | 'shared' | 'env' | 'family-env';
    readonly group: string;
    readonly env?: string;
  };
}

/** 模型服务商分组目录项。 */
export interface ProviderGroupSummary {
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly custom: boolean;
}

/** MCP 与技能系统的健康诊断与跨工具导入扫描状态摘要。 */
export interface ResourceDiagnosticsSummary {
  readonly mcpServerCount: number;
  readonly mcpErrorCount: number;
  readonly skillsEnabled: boolean;
  readonly skillCount: number;
  readonly skillWarningCount: number;
  readonly importScanning: boolean;
  readonly pendingMcpImportCount: number;
  readonly pendingSkillImportCount: number;
}

/** 桌面客户端版本更新检测与安装包校验下载状态。 */
export interface ReleaseUpdateState {
  readonly checkStatus:
    | 'idle'
    | 'checking'
    | 'update-available'
    | 'up-to-date'
    | 'no-asset'
    | 'unknown';
  readonly currentVersion?: string;
  readonly latestVersion?: string;
  readonly releaseUrl?: string;
  readonly downloadStatus: 'idle' | 'downloading' | 'downloaded' | 'cancelled' | 'failed';
  readonly errorMessage?: string;
}

/** 主进程返回给渲染层水合的完整常规偏好快照。 */
export interface HydratedDesktopPreferences {
  readonly theme: ThemeMode;
  readonly mode?: 'light' | 'dark';
  readonly locale: DesktopLocalePreference;
  readonly resolvedLocale?: ResolvedDesktopLocale;
  readonly typography: DesktopTypographyPreferences;
  readonly general: DesktopGeneralPreferences;
  readonly confirmations: DesktopConfirmationPreferences;
}

/** 可注入的设置中心桥接接口：隔离 IPC 调用以保障纯 Node 单元测试可独立验证状态流转。 */
export interface SettingsStoreBridge {
  readonly readCatalog?: () => Promise<{
    readonly profiles: readonly ModelProfileSummary[];
    readonly providers: readonly ProviderGroupSummary[];
    readonly defaultModel: string;
    readonly routing: Readonly<Record<string, string>>;
    readonly permissionMode: 'Approval' | 'Plan' | 'Auto' | 'FullAccess';
  }>;
  readonly listHarnesses?: (workspaceId?: string) => Promise<{
    readonly harnesses: readonly ViewExternalHarness[];
    readonly templates?: readonly ViewExternalTemplate[];
  }>;
  readonly probeHarness?: (
    harnessId: string,
    workspaceId?: string,
  ) => Promise<ViewExternalHarnessProbe>;
  readonly saveThemeMode?: (mode: ThemeMode) => Promise<void>;
  readonly savePreferences?: (patch: DesktopPreferencesPatch) => Promise<void>;
  readonly checkUpdates?: () => Promise<Partial<ReleaseUpdateState>>;
}

/** `SettingsStore` 状态与动作契约（017 §5.1, §5.3 & §6.7）。 */
export interface SettingsStoreState {
  readonly themeMode: ThemeMode;
  readonly localePreference: DesktopLocalePreference;
  readonly resolvedLocale: ResolvedDesktopLocale;
  readonly typography: DesktopTypographyPreferences;
  readonly general: DesktopGeneralPreferences;
  readonly confirmations: DesktopConfirmationPreferences;
  readonly profiles: readonly ModelProfileSummary[];
  readonly providers: readonly ProviderGroupSummary[];
  readonly defaultModel: string;
  readonly routing: Readonly<Record<string, string>>;
  readonly defaultPermissionMode: 'Approval' | 'Plan' | 'Auto' | 'FullAccess';
  readonly harnesses: readonly ViewExternalHarness[];
  readonly templates: readonly ViewExternalTemplate[];
  readonly probingHarnessIds: Readonly<Record<string, boolean>>;
  readonly resourceDiagnostics: ResourceDiagnosticsSummary;
  readonly updateState: ReleaseUpdateState;
  setBridge: (bridge: SettingsStoreBridge) => void;
  setThemeMode: (mode: ThemeMode) => Promise<void>;
  hydratePreferences: (prefs: HydratedDesktopPreferences) => void;
  updatePreferences: (patch: DesktopPreferencesPatch) => Promise<void>;
  resetGeneralPreferences: () => Promise<void>;
  setCatalogSnapshot: (snapshot: {
    readonly profiles: readonly ModelProfileSummary[];
    readonly providers: readonly ProviderGroupSummary[];
    readonly defaultModel: string;
    readonly routing: Readonly<Record<string, string>>;
    readonly permissionMode: 'Approval' | 'Plan' | 'Auto' | 'FullAccess';
  }) => void;
  setExternalCatalog: (
    harnesses: readonly ViewExternalHarness[],
    templates?: readonly ViewExternalTemplate[],
  ) => void;
  updateHarnessProbe: (harnessId: string, probe: ViewExternalHarnessProbe) => void;
  setResourceDiagnostics: (patch: Partial<ResourceDiagnosticsSummary>) => void;
  setUpdateState: (patch: Partial<ReleaseUpdateState>) => void;
  reloadCatalog: () => Promise<void>;
  reloadHarnesses: (workspaceId?: string) => Promise<void>;
  probeHarness: (
    harnessId: string,
    workspaceId?: string,
  ) => Promise<ViewExternalHarnessProbe | null>;
  checkForUpdates: () => Promise<void>;
}

const DEFAULT_DIAGNOSTICS: ResourceDiagnosticsSummary = Object.freeze({
  mcpServerCount: 0,
  mcpErrorCount: 0,
  skillsEnabled: true,
  skillCount: 0,
  skillWarningCount: 0,
  importScanning: false,
  pendingMcpImportCount: 0,
  pendingSkillImportCount: 0,
});

const DEFAULT_UPDATE_STATE: ReleaseUpdateState = Object.freeze({
  checkStatus: 'idle',
  downloadStatus: 'idle',
});

function resolveColorMode(
  mode: ThemeMode,
  explicitSystemMode?: 'light' | 'dark',
): 'light' | 'dark' {
  if (mode === 'light' || mode === 'dark') return mode;
  if (explicitSystemMode) return explicitSystemMode;
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/** 同步主题、语言、字体栈与字号到根 `<html>` 属性与 CSS 变量，唤醒已挂载 `@xterm/xterm` 的 `MutationObserver`。 */
export function applyDesktopPreferencesToDom(params: {
  readonly themeMode: ThemeMode;
  readonly systemMode?: 'light' | 'dark';
  readonly resolvedLocale: ResolvedDesktopLocale;
  readonly typography: DesktopTypographyPreferences;
  readonly codeWordWrap?: boolean;
}): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.mode = resolveColorMode(params.themeMode, params.systemMode);
  root.lang = params.resolvedLocale;
  const chatPx = clampChatFontSize(params.typography.chatFontSize);
  root.style.setProperty('--kpbl-font-sans', resolveSansFontStack(params.typography.uiFontFamily));
  root.style.setProperty(
    '--kpbl-font-mono',
    resolveMonoFontStack(params.typography.codeFontFamily),
  );
  root.style.setProperty('--kpbl-text-prose', `${chatPx}px`);
  root.style.setProperty('--kpbl-text-code', `${Math.max(12, chatPx - 2)}px`);
  root.dataset.codeLigatures = params.typography.codeLigatures ? 'true' : 'false';
  if (params.codeWordWrap !== undefined)
    root.dataset.codeWrap = params.codeWordWrap ? 'true' : 'false';
  root.dataset.terminalFontSize = String(clampTerminalFontSize(params.typography.terminalFontSize));
  root.dataset.monoFont = params.typography.codeFontFamily;
}

/** 派生已启用外部代理列表，供 `CommandPalette`、`LaunchpadView` 与 `ModelHarnessPicker` 共用。 */
export function selectEnabledHarnesses(
  state: Pick<SettingsStoreState, 'harnesses'>,
): readonly ViewExternalHarness[] {
  return state.harnesses.filter((item) => item.enabled);
}

/** 创建隔离的 `SettingsStore` 实例。 */
export function createSettingsStore(initialBridge: SettingsStoreBridge = {}) {
  let bridge = initialBridge;
  let hydratedSystemLocale: ResolvedDesktopLocale | undefined;
  const resolveWithHydratedSystem = (pref: DesktopLocalePreference): ResolvedDesktopLocale => {
    if (pref === 'zh-CN' || pref === 'en') return pref;
    if (hydratedSystemLocale) return hydratedSystemLocale;
    if (typeof window === 'undefined') return 'zh-CN';
    return resolveDesktopLocale(
      pref,
      typeof navigator !== 'undefined' ? navigator.language : undefined,
    );
  };
  const storeApi = create<SettingsStoreState>((set, get) => ({
    themeMode: 'light',
    localePreference: DEFAULT_LOCALE_PREFERENCE,
    resolvedLocale: resolveWithHydratedSystem(DEFAULT_LOCALE_PREFERENCE),
    typography: DEFAULT_TYPOGRAPHY_PREFERENCES,
    general: DEFAULT_GENERAL_PREFERENCES,
    confirmations: DEFAULT_CONFIRMATION_PREFERENCES,
    profiles: [],
    providers: [],
    defaultModel: 'deepseek-flash',
    routing: {},
    defaultPermissionMode: 'Approval',
    harnesses: [],
    templates: [],
    probingHarnessIds: {},
    resourceDiagnostics: DEFAULT_DIAGNOSTICS,
    updateState: DEFAULT_UPDATE_STATE,

    setBridge: (nextBridge) => {
      bridge = nextBridge;
    },

    setThemeMode: async (mode) => {
      await get().updatePreferences({ theme: mode });
      await bridge.saveThemeMode?.(mode);
    },

    hydratePreferences: (prefs) => {
      if (prefs.locale === 'system' && prefs.resolvedLocale) {
        hydratedSystemLocale = prefs.resolvedLocale;
      }
      const resolvedLocale = prefs.resolvedLocale ?? resolveWithHydratedSystem(prefs.locale);
      set({
        themeMode: prefs.theme,
        localePreference: prefs.locale,
        resolvedLocale,
        typography: prefs.typography,
        general: prefs.general,
        confirmations: prefs.confirmations,
      });
      applyDesktopPreferencesToDom({
        themeMode: prefs.theme,
        systemMode: prefs.mode,
        resolvedLocale,
        typography: prefs.typography,
        codeWordWrap: prefs.general.codeWordWrap,
      });
    },

    updatePreferences: async (patch) => {
      if (patch.resetGeneral) {
        await get().resetGeneralPreferences();
        return;
      }
      const cur = get();
      const nextTheme = patch.theme ?? cur.themeMode;
      const nextLocalePref = patch.locale ?? cur.localePreference;
      const nextResolvedLocale = resolveWithHydratedSystem(nextLocalePref);
      const nextTypography: DesktopTypographyPreferences = patch.typography
        ? {
            uiFontFamily:
              patch.typography.uiFontFamily !== undefined
                ? patch.typography.uiFontFamily.trim() || 'system'
                : cur.typography.uiFontFamily,
            codeFontFamily:
              patch.typography.codeFontFamily !== undefined
                ? patch.typography.codeFontFamily.trim() || 'system'
                : cur.typography.codeFontFamily,
            chatFontSize:
              patch.typography.chatFontSize !== undefined
                ? clampChatFontSize(patch.typography.chatFontSize)
                : cur.typography.chatFontSize,
            terminalFontSize:
              patch.typography.terminalFontSize !== undefined
                ? clampTerminalFontSize(patch.typography.terminalFontSize)
                : cur.typography.terminalFontSize,
            codeLigatures: patch.typography.codeLigatures ?? cur.typography.codeLigatures,
          }
        : cur.typography;
      const nextGeneral = patch.general ? { ...cur.general, ...patch.general } : cur.general;
      const nextConfirmations = patch.confirmations
        ? { ...cur.confirmations, ...patch.confirmations }
        : cur.confirmations;
      set({
        themeMode: nextTheme,
        localePreference: nextLocalePref,
        resolvedLocale: nextResolvedLocale,
        typography: nextTypography,
        general: nextGeneral,
        confirmations: nextConfirmations,
      });
      applyDesktopPreferencesToDom({
        themeMode: nextTheme,
        resolvedLocale: nextResolvedLocale,
        typography: nextTypography,
        codeWordWrap: nextGeneral.codeWordWrap,
      });
      if (bridge.savePreferences) await bridge.savePreferences(patch);
      else if (typeof window !== 'undefined' && window.kapibala) {
        await window.kapibala.preferences.update(patch);
      }
    },

    resetGeneralPreferences: async () => {
      const resetResolved = resolveWithHydratedSystem(DEFAULT_LOCALE_PREFERENCE);
      set({
        themeMode: 'light',
        localePreference: DEFAULT_LOCALE_PREFERENCE,
        resolvedLocale: resetResolved,
        typography: DEFAULT_TYPOGRAPHY_PREFERENCES,
        general: DEFAULT_GENERAL_PREFERENCES,
        confirmations: DEFAULT_CONFIRMATION_PREFERENCES,
      });
      applyDesktopPreferencesToDom({
        themeMode: 'light',
        resolvedLocale: resetResolved,
        typography: DEFAULT_TYPOGRAPHY_PREFERENCES,
        codeWordWrap: DEFAULT_GENERAL_PREFERENCES.codeWordWrap,
      });
      const patch: DesktopPreferencesPatch = { resetGeneral: true };
      if (bridge.savePreferences) await bridge.savePreferences(patch);
      else if (typeof window !== 'undefined' && window.kapibala) {
        await window.kapibala.preferences.update(patch);
      }
    },

    setCatalogSnapshot: (s) =>
      set({
        profiles: s.profiles,
        providers: s.providers,
        defaultModel: s.defaultModel,
        routing: s.routing,
        defaultPermissionMode: s.permissionMode,
      }),

    setExternalCatalog: (harnesses, templates) =>
      set((state) => ({ harnesses, templates: templates ?? state.templates })),

    updateHarnessProbe: (harnessId, probe) =>
      set((state) => ({
        harnesses: state.harnesses.map((item) =>
          item.id === harnessId
            ? {
                ...item,
                probe,
                ...(probe.configOptions ? { cachedConfigOptions: probe.configOptions } : {}),
              }
            : item,
        ),
      })),

    setResourceDiagnostics: (patch) =>
      set((s) => ({ resourceDiagnostics: { ...s.resourceDiagnostics, ...patch } })),

    setUpdateState: (patch) => set((s) => ({ updateState: { ...s.updateState, ...patch } })),

    reloadCatalog: async () => {
      if (bridge.readCatalog) get().setCatalogSnapshot(await bridge.readCatalog());
    },

    reloadHarnesses: async (workspaceId) => {
      if (!bridge.listHarnesses) return;
      const res = await bridge.listHarnesses(workspaceId);
      get().setExternalCatalog(res.harnesses, res.templates);
    },

    probeHarness: async (harnessId, workspaceId) => {
      if (!bridge.probeHarness) return null;
      set((state) => ({ probingHarnessIds: { ...state.probingHarnessIds, [harnessId]: true } }));
      try {
        const probe = await bridge.probeHarness(harnessId, workspaceId);
        get().updateHarnessProbe(harnessId, probe);
        return probe;
      } finally {
        set((state) => {
          const next = { ...state.probingHarnessIds };
          delete next[harnessId];
          return { probingHarnessIds: next };
        });
      }
    },

    checkForUpdates: async () => {
      if (!bridge.checkUpdates) return;
      set((s) => ({
        updateState: { ...s.updateState, checkStatus: 'checking', errorMessage: undefined },
      }));
      const result = await bridge.checkUpdates();
      set((s) => ({ updateState: { ...s.updateState, ...result } }));
    },
  }));
  const useBoundSettings = (<T = SettingsStoreState>(
    selector?: (state: SettingsStoreState) => T,
  ): T => {
    const pick = () =>
      selector ? selector(storeApi.getState()) : (storeApi.getState() as unknown as T);
    return useSyncExternalStore(storeApi.subscribe, pick, pick);
  }) as typeof storeApi;
  return Object.assign(useBoundSettings, storeApi);
}

/** 渲染进程默认单例 `SettingsStore` Hook。 */
export const useSettingsStore = createSettingsStore();
