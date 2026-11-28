import { create } from 'zustand';

const WORKBENCH_DEFAULT_RATIO = 0.45;
const WORKBENCH_LEFT_MIN_PX = 420;
const WORKBENCH_RIGHT_MIN_PX = 360;
const WORKBENCH_RIGHT_MAX_RATIO = 0.6;

function clampWorkbenchRatio(ratio: number, containerWidth = 1280): number {
  if (!Number.isFinite(ratio)) return WORKBENCH_DEFAULT_RATIO;
  const safeWidth = Math.max(containerWidth, WORKBENCH_LEFT_MIN_PX + WORKBENCH_RIGHT_MIN_PX);
  const minRatio = WORKBENCH_RIGHT_MIN_PX / safeWidth;
  const maxRatio = Math.min(
    WORKBENCH_RIGHT_MAX_RATIO,
    (safeWidth - WORKBENCH_LEFT_MIN_PX) / safeWidth,
  );
  return Math.min(Math.max(ratio, minRatio), Math.max(minRatio, maxRatio));
}

/** 主舞台顶层视图面：工作台会话舞台与壳内整页设置中心同级互斥（017 §0 铁律 3 & §5.1）。 */
export type ActiveSurface = 'workspace' | 'settings';

/** 壳内设置与代理中心的八大二级分组标识（017 §6.7：首项「常规」合并替换原「外观与应用」）。 */
export type SettingsTabId =
  | 'general'
  | 'providers'
  | 'routing'
  | 'external'
  | 'permissions'
  | 'resources'
  | 'archives'
  | 'diagnostics';

/** 右侧并排多标签工作台的五类标准标签（017 §6.5 & `⌘1..5` 顺序契约）。 */
export type WorkbenchTabKind = 'diff' | 'preview' | 'files' | 'terminal' | 'inspector';

/** `⌘1..5` 快捷键映射的固定标签槽位顺序。 */
export const WORKBENCH_TAB_ORDER: readonly WorkbenchTabKind[] = [
  'diff',
  'preview',
  'files',
  'terminal',
  'inspector',
];

/** 各工作台标签的默认中文无障碍名称（对齐 017 §7 E2E 契约）。 */
export const WORKBENCH_TAB_LABELS: Readonly<Record<WorkbenchTabKind, string>> = {
  diff: '变更',
  preview: '预览',
  files: '文件',
  terminal: '终端',
  inspector: '详情与证据',
};

/** 单个右侧工作台标签页描述：`targetKey` 用于同类型同目标标签去重复用。 */
export interface WorkbenchTab {
  readonly id: string;
  readonly kind: WorkbenchTabKind;
  readonly title: string;
  readonly targetKey?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** `openWorkbenchTab` 入参：`id` 与 `title` 可省略并由 `kind + targetKey` 确定性推导。 */
export interface OpenWorkbenchTabInput {
  readonly id?: string;
  readonly kind: WorkbenchTabKind;
  readonly title?: string;
  readonly targetKey?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}

/** 单个会话（按 `sessionKey` 索引）独立记忆的右侧工作台分栏与标签栈状态。 */
export interface SessionWorkbenchState {
  readonly open: boolean;
  readonly widthRatio: number;
  readonly tabs: readonly WorkbenchTab[];
  readonly activeTabId: string;
}

/** 默认会话工作台初始空闲快照（冻结复用以稳定 React 19 选择器引用）。 */
export const DEFAULT_SESSION_WORKBENCH_STATE: SessionWorkbenchState = Object.freeze({
  open: false,
  widthRatio: WORKBENCH_DEFAULT_RATIO,
  tabs: Object.freeze([]),
  activeTabId: '',
});

/** `ShellStore` 状态与动作契约：纯易失 UI 拓扑状态，不直接持有磁盘持久化真源。 */
export interface ShellStoreState {
  readonly activeSurface: ActiveSurface;
  readonly settingsTab: SettingsTabId;
  readonly railOpen: boolean;
  readonly narrowRailDrawerOpen: boolean;
  readonly commandPaletteOpen: boolean;
  readonly workbenchBySession: Readonly<Record<string, SessionWorkbenchState>>;
  openSettings: (tab?: SettingsTabId) => void;
  returnToWorkspace: () => void;
  toggleSettings: (tab?: SettingsTabId) => void;
  setSettingsTab: (tab: SettingsTabId) => void;
  setRailOpen: (open: boolean) => void;
  setNarrowRailDrawerOpen: (open: boolean) => void;
  toggleRail: (viewportWidth?: number) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  toggleCommandPalette: () => void;
  openWorkbenchTab: (sessionKey: string, input: OpenWorkbenchTabInput) => void;
  closeWorkbenchTab: (sessionKey: string, tabId: string) => void;
  setActiveWorkbenchTab: (sessionKey: string, tabId: string) => void;
  setWorkbenchOpen: (sessionKey: string, open: boolean) => void;
  setWorkbenchWidthRatio: (sessionKey: string, ratio: number, containerWidth?: number) => void;
  toggleWorkbench: (sessionKey: string) => void;
  activateTabByIndex: (sessionKey: string, index: number) => void;
  closeTopmostLayerOnEscape: (context?: {
    readonly sessionKey?: string | null;
    readonly viewportWidth?: number;
  }) => boolean;
}

function buildCanonicalTab(input: OpenWorkbenchTabInput): WorkbenchTab {
  const targetSuffix = input.targetKey ? `:${input.targetKey}` : '';
  return {
    id: input.id ?? `${input.kind}${targetSuffix}`,
    kind: input.kind,
    title: input.title ?? WORKBENCH_TAB_LABELS[input.kind],
    targetKey: input.targetKey,
    payload: input.payload,
  };
}

/** 查询指定 `sessionKey` 的工作台状态；未初始化时返回冻结默认快照。 */
export function selectSessionWorkbench(
  state: Pick<ShellStoreState, 'workbenchBySession'>,
  sessionKey: string | null | undefined,
): SessionWorkbenchState {
  if (!sessionKey) return DEFAULT_SESSION_WORKBENCH_STATE;
  return state.workbenchBySession[sessionKey] ?? DEFAULT_SESSION_WORKBENCH_STATE;
}

/**
 * 创建隔离的 `ShellStore` 实例：支持在 Node 单测中按用例独立构造，避免跨用例状态串扰。
 */
export function createShellStore(initial?: Partial<Pick<ShellStoreState, 'railOpen'>>) {
  return create<ShellStoreState>((set, get) => ({
    activeSurface: 'workspace',
    settingsTab: 'general',
    railOpen: initial?.railOpen ?? true,
    narrowRailDrawerOpen: false,
    commandPaletteOpen: false,
    workbenchBySession: {},

    openSettings: (tab) =>
      set((state) => ({
        activeSurface: 'settings',
        settingsTab: tab ?? state.settingsTab,
        narrowRailDrawerOpen: false,
        commandPaletteOpen: false,
      })),

    returnToWorkspace: () => set({ activeSurface: 'workspace' }),

    toggleSettings: (tab) =>
      set((state) =>
        state.activeSurface === 'settings' && (!tab || tab === state.settingsTab)
          ? { activeSurface: 'workspace' }
          : {
              activeSurface: 'settings',
              settingsTab: tab ?? state.settingsTab,
              narrowRailDrawerOpen: false,
              commandPaletteOpen: false,
            },
      ),

    setSettingsTab: (tab) => set({ activeSurface: 'settings', settingsTab: tab }),

    setRailOpen: (open) => set({ railOpen: open }),

    setNarrowRailDrawerOpen: (open) => set({ narrowRailDrawerOpen: open }),

    toggleRail: (viewportWidth) =>
      set((state) =>
        viewportWidth !== undefined && viewportWidth < 1024
          ? { narrowRailDrawerOpen: !state.narrowRailDrawerOpen }
          : { railOpen: !state.railOpen },
      ),

    setCommandPaletteOpen: (open) => set({ commandPaletteOpen: open }),

    toggleCommandPalette: () => set((state) => ({ commandPaletteOpen: !state.commandPaletteOpen })),

    openWorkbenchTab: (sessionKey, input) => {
      if (!sessionKey) return;
      set((state) => {
        const current = state.workbenchBySession[sessionKey] ?? DEFAULT_SESSION_WORKBENCH_STATE;
        const incoming = buildCanonicalTab(input);
        const existingIndex = current.tabs.findIndex(
          (tab) =>
            tab.id === incoming.id ||
            (tab.kind === incoming.kind && (tab.targetKey ?? '') === (incoming.targetKey ?? '')),
        );
        let nextTabs: WorkbenchTab[];
        let activeTabId: string;
        if (existingIndex >= 0) {
          const matched = current.tabs[existingIndex] as WorkbenchTab;
          const merged: WorkbenchTab = {
            ...matched,
            title: input.title ?? matched.title,
            payload: input.payload ?? matched.payload,
          };
          nextTabs = current.tabs.map((tab, idx) => (idx === existingIndex ? merged : tab));
          activeTabId = merged.id;
        } else {
          nextTabs = [...current.tabs, incoming];
          activeTabId = incoming.id;
        }
        return {
          workbenchBySession: {
            ...state.workbenchBySession,
            [sessionKey]: {
              ...current,
              open: true,
              tabs: nextTabs,
              activeTabId,
            },
          },
        };
      });
    },

    closeWorkbenchTab: (sessionKey, tabId) => {
      if (!sessionKey) return;
      set((state) => {
        const current = state.workbenchBySession[sessionKey];
        if (!current) return state;
        const idx = current.tabs.findIndex((tab) => tab.id === tabId);
        if (idx < 0) return state;
        const nextTabs = current.tabs.filter((tab) => tab.id !== tabId);
        if (nextTabs.length === 0) {
          return {
            workbenchBySession: {
              ...state.workbenchBySession,
              [sessionKey]: { ...current, open: false, tabs: [], activeTabId: '' },
            },
          };
        }
        const nextActiveId =
          current.activeTabId === tabId
            ? (nextTabs[Math.min(idx, nextTabs.length - 1)]?.id ?? nextTabs[0]!.id)
            : current.activeTabId;
        return {
          workbenchBySession: {
            ...state.workbenchBySession,
            [sessionKey]: { ...current, tabs: nextTabs, activeTabId: nextActiveId },
          },
        };
      });
    },

    setActiveWorkbenchTab: (sessionKey, tabId) => {
      if (!sessionKey) return;
      set((state) => {
        const current = state.workbenchBySession[sessionKey];
        if (!current || !current.tabs.some((tab) => tab.id === tabId)) return state;
        return {
          workbenchBySession: {
            ...state.workbenchBySession,
            [sessionKey]: { ...current, open: true, activeTabId: tabId },
          },
        };
      });
    },

    setWorkbenchOpen: (sessionKey, open) => {
      if (!sessionKey) return;
      set((state) => {
        const current = state.workbenchBySession[sessionKey] ?? DEFAULT_SESSION_WORKBENCH_STATE;
        if (!open) {
          return {
            workbenchBySession: {
              ...state.workbenchBySession,
              [sessionKey]: { ...current, open: false },
            },
          };
        }
        const seededTabs =
          current.tabs.length > 0 ? current.tabs : [buildCanonicalTab({ kind: 'inspector' })];
        const activeTabId =
          seededTabs.some((t) => t.id === current.activeTabId) && current.activeTabId
            ? current.activeTabId
            : seededTabs[0]!.id;
        return {
          workbenchBySession: {
            ...state.workbenchBySession,
            [sessionKey]: { ...current, open: true, tabs: seededTabs, activeTabId },
          },
        };
      });
    },

    setWorkbenchWidthRatio: (sessionKey, ratio, containerWidth) => {
      if (!sessionKey) return;
      set((state) => {
        const current = state.workbenchBySession[sessionKey] ?? DEFAULT_SESSION_WORKBENCH_STATE;
        return {
          workbenchBySession: {
            ...state.workbenchBySession,
            [sessionKey]: {
              ...current,
              widthRatio: clampWorkbenchRatio(ratio, containerWidth),
            },
          },
        };
      });
    },

    toggleWorkbench: (sessionKey) => {
      if (!sessionKey) return;
      const current = get().workbenchBySession[sessionKey] ?? DEFAULT_SESSION_WORKBENCH_STATE;
      get().setWorkbenchOpen(sessionKey, !current.open);
    },

    activateTabByIndex: (sessionKey, index) => {
      if (!sessionKey || index < 0 || index >= WORKBENCH_TAB_ORDER.length) return;
      const state = get();
      const current = state.workbenchBySession[sessionKey];
      if (!current?.open) return;
      const targetKind = WORKBENCH_TAB_ORDER[index]!;
      const existing = current.tabs.find((tab) => tab.kind === targetKind);
      if (existing) {
        state.setActiveWorkbenchTab(sessionKey, existing.id);
      } else {
        state.openWorkbenchTab(sessionKey, { kind: targetKind });
      }
    },

    closeTopmostLayerOnEscape: (context) => {
      const state = get();
      if (state.commandPaletteOpen) {
        set({ commandPaletteOpen: false });
        return true;
      }
      if (state.narrowRailDrawerOpen) {
        set({ narrowRailDrawerOpen: false });
        return true;
      }
      const isNarrow = context?.viewportWidth !== undefined && context.viewportWidth < 1024;
      const sessionKey = context?.sessionKey;
      if (isNarrow && sessionKey && state.workbenchBySession[sessionKey]?.open) {
        state.setWorkbenchOpen(sessionKey, false);
        return true;
      }
      if (state.activeSurface === 'settings') {
        set({ activeSurface: 'workspace' });
        return true;
      }
      return false;
    },
  }));
}

/** 渲染进程默认单例 `ShellStore` Hook。 */
export const useShellStore = createShellStore();
