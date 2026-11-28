import type { ViewMessage } from '@kiturone/kapibala-host/view-model';
import { create } from 'zustand';
import type { UnifiedThreadViewModel } from '../adapters/unified-thread.js';
import {
  type PromptHistoryState,
  isPromptHistoryBrowsing,
  rememberPromptEntry,
  seedPromptHistory,
  stepPromptHistory,
} from '../prompt-history.js';

/** 构造草稿与历史游标作用域键：已打开会话走 `sessionKey`，Launchpad 按空间隔离。 */
export function buildDraftScopeKey(
  sessionKey: string | null | undefined,
  workspaceId?: string | null,
): string {
  if (sessionKey) return sessionKey;
  return `launchpad:${workspaceId ?? 'default'}`;
}

/** 输入坞顶部 `@` 跨文件/跨会话引用快照胶囊结构（017 §6.4）。 */
export interface ReferenceChip {
  readonly id: string;
  readonly kind: 'file' | 'session' | 'symbol';
  readonly label: string;
  readonly target: string;
  readonly preview?: string;
}

/** 下一轮发送暂存的模型、外部代理、角色、权限档位与推理强度覆盖配置。 */
export interface StagedNextTurnSelection {
  readonly targetKind: 'native' | 'external';
  readonly profileId?: string;
  readonly harnessId?: string;
  readonly harnessName?: string;
  readonly externalModelId?: string;
  readonly role?: 'default' | 'planning' | 'execution' | 'fast';
  readonly permissionMode?: 'Approval' | 'Plan' | 'Auto' | 'FullAccess';
  readonly effort?: string;
}

/** 可注入的会话控制桥接接口：支持在无 Electron 环境单测单键审批（`Y / S / N`）与发送编排。 */
export interface SessionStoreBridge {
  readonly replyApproval?: (params: {
    readonly sessionKey: string;
    readonly approvalId: string;
    readonly actionId: string;
    readonly source: 'native' | 'delegation' | 'external';
  }) => Promise<void>;
}

/** `SessionStore` 状态与动作契约（017 §5.1）。 */
export interface SessionStoreState {
  /** 当前活跃会话键：`native:<ws>:<conv>` | `external:<id>` | `null`（Launchpad 启动台）。 */
  readonly activeSessionKey: string | null;
  readonly activeThread: UnifiedThreadViewModel | null;
  readonly draftsByKey: Readonly<Record<string, string>>;
  readonly referencesByKey: Readonly<Record<string, readonly ReferenceChip[]>>;
  readonly promptHistoryByKey: Readonly<Record<string, PromptHistoryState>>;
  readonly stagedSelectionsByKey: Readonly<Record<string, StagedNextTurnSelection>>;
  readonly worktreeEnabled: boolean;
  readonly worktreeBranchDraft: string;
  readonly replyingApprovalIds: Readonly<Record<string, boolean>>;
  setBridge: (bridge: SessionStoreBridge) => void;
  openLaunchpad: () => void;
  setActiveSession: (sessionKey: string | null, thread?: UnifiedThreadViewModel | null) => void;
  setActiveThread: (thread: UnifiedThreadViewModel | null) => void;
  setDraft: (scopeKey: string, draft: string) => void;
  recallPromptHistory: (
    scopeKey: string,
    direction: -1 | 1,
  ) => { readonly consumed: boolean; readonly value?: string };
  seedSessionPromptHistory: (scopeKey: string, messages: readonly ViewMessage[]) => void;
  recordSubmittedPrompt: (scopeKey: string, text: string) => void;
  addReferenceChip: (scopeKey: string, chip: ReferenceChip) => void;
  removeReferenceChip: (scopeKey: string, chipId: string) => void;
  clearReferenceChips: (scopeKey: string) => void;
  setWorktreeEnabled: (enabled: boolean) => void;
  setWorktreeBranchDraft: (branch: string) => void;
  stageNextTurnSelection: (scopeKey: string, selection: StagedNextTurnSelection) => void;
  clearStagedSelection: (scopeKey: string) => void;
  replyApproval: (approvalId: string, actionId: string) => Promise<boolean>;
}

const EMPTY_CHIPS: readonly ReferenceChip[] = Object.freeze([]);

/** 读取指定作用域的引用胶囊列表（缺省返回冻结空数组）。 */
export function selectReferenceChips(
  state: Pick<SessionStoreState, 'referencesByKey'>,
  scopeKey: string,
): readonly ReferenceChip[] {
  return state.referencesByKey[scopeKey] ?? EMPTY_CHIPS;
}

function cloneHistoryState(
  history: PromptHistoryState | undefined,
): PromptHistoryState | undefined {
  if (!history) return undefined;
  return {
    entries: [...history.entries],
    index: history.index,
    draft: history.draft,
    ...(history.seeded ? { seeded: true } : {}),
  };
}

/** 创建隔离的 `SessionStore` 实例。 */
export function createSessionStore(initialBridge: SessionStoreBridge = {}) {
  let bridge = initialBridge;
  return create<SessionStoreState>((set, get) => ({
    activeSessionKey: null,
    activeThread: null,
    draftsByKey: {},
    referencesByKey: {},
    promptHistoryByKey: {},
    stagedSelectionsByKey: {},
    worktreeEnabled: false,
    worktreeBranchDraft: '',
    replyingApprovalIds: {},

    setBridge: (nextBridge) => {
      bridge = nextBridge;
    },

    openLaunchpad: () => set({ activeSessionKey: null, activeThread: null }),

    setActiveSession: (sessionKey, thread = null) =>
      set({
        activeSessionKey: sessionKey,
        activeThread: sessionKey ? thread : null,
      }),

    setActiveThread: (thread) =>
      set((state) => ({
        activeSessionKey: thread ? thread.sessionKey : state.activeSessionKey,
        activeThread: thread,
      })),

    setDraft: (scopeKey, draft) =>
      set((state) => {
        const existingHistory = state.promptHistoryByKey[scopeKey];
        if (!isPromptHistoryBrowsing(existingHistory)) {
          return {
            draftsByKey: { ...state.draftsByKey, [scopeKey]: draft },
          };
        }
        const resetHistory: PromptHistoryState = {
          entries: existingHistory!.entries,
          index: existingHistory!.entries.length,
          draft: undefined,
          ...(existingHistory!.seeded ? { seeded: true } : {}),
        };
        return {
          draftsByKey: { ...state.draftsByKey, [scopeKey]: draft },
          promptHistoryByKey: { ...state.promptHistoryByKey, [scopeKey]: resetHistory },
        };
      }),

    recallPromptHistory: (scopeKey, direction) => {
      const state = get();
      const cloned = cloneHistoryState(state.promptHistoryByKey[scopeKey]);
      const currentDraft = state.draftsByKey[scopeKey] ?? '';
      const result = stepPromptHistory(cloned, direction, currentDraft);
      if (!result.consumed || !cloned) return { consumed: false };
      const nextValue = result.value ?? '';
      set((prev) => ({
        draftsByKey: { ...prev.draftsByKey, [scopeKey]: nextValue },
        promptHistoryByKey: { ...prev.promptHistoryByKey, [scopeKey]: cloned },
      }));
      return { consumed: true, value: nextValue };
    },

    seedSessionPromptHistory: (scopeKey, messages) =>
      set((state) => {
        const current = state.promptHistoryByKey[scopeKey];
        const next = seedPromptHistory(current, messages);
        if (next === current) return state;
        return {
          promptHistoryByKey: { ...state.promptHistoryByKey, [scopeKey]: next },
        };
      }),

    recordSubmittedPrompt: (scopeKey, text) =>
      set((state) => ({
        draftsByKey: { ...state.draftsByKey, [scopeKey]: '' },
        promptHistoryByKey: {
          ...state.promptHistoryByKey,
          [scopeKey]: rememberPromptEntry(state.promptHistoryByKey[scopeKey], text),
        },
      })),

    addReferenceChip: (scopeKey, chip) =>
      set((state) => {
        const current = state.referencesByKey[scopeKey] ?? EMPTY_CHIPS;
        if (current.some((item) => item.id === chip.id || item.target === chip.target)) {
          return state;
        }
        return {
          referencesByKey: { ...state.referencesByKey, [scopeKey]: [...current, chip] },
        };
      }),

    removeReferenceChip: (scopeKey, chipId) =>
      set((state) => {
        const current = state.referencesByKey[scopeKey];
        if (!current) return state;
        return {
          referencesByKey: {
            ...state.referencesByKey,
            [scopeKey]: current.filter((item) => item.id !== chipId),
          },
        };
      }),

    clearReferenceChips: (scopeKey) =>
      set((state) => ({
        referencesByKey: { ...state.referencesByKey, [scopeKey]: EMPTY_CHIPS },
      })),

    setWorktreeEnabled: (enabled) => set({ worktreeEnabled: enabled }),

    setWorktreeBranchDraft: (branch) => set({ worktreeBranchDraft: branch }),

    stageNextTurnSelection: (scopeKey, selection) =>
      set((state) => ({
        stagedSelectionsByKey: { ...state.stagedSelectionsByKey, [scopeKey]: selection },
      })),

    clearStagedSelection: (scopeKey) =>
      set((state) => {
        if (!(scopeKey in state.stagedSelectionsByKey)) return state;
        const next = { ...state.stagedSelectionsByKey };
        delete next[scopeKey];
        return { stagedSelectionsByKey: next };
      }),

    replyApproval: async (approvalId, actionId) => {
      const state = get();
      const thread = state.activeThread;
      if (!thread || state.replyingApprovalIds[approvalId]) return false;
      const approval = thread.approvals.find((item) => item.id === approvalId);
      if (!approval || !bridge.replyApproval) return false;
      set((prev) => ({
        replyingApprovalIds: { ...prev.replyingApprovalIds, [approvalId]: true },
      }));
      try {
        await bridge.replyApproval({
          sessionKey: thread.sessionKey,
          approvalId,
          actionId,
          source: approval.source,
        });
        return true;
      } finally {
        set((prev) => {
          const next = { ...prev.replyingApprovalIds };
          delete next[approvalId];
          return { replyingApprovalIds: next };
        });
      }
    },
  }));
}

/** 渲染进程默认单例 `SessionStore` Hook。 */
export const useSessionStore = createSessionStore();
