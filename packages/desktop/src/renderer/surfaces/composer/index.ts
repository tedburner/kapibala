/**
 * Kapibala UI 2.0 阶段 3 内联全能输入坞视图面统一公共入口（显式命名重导出，禁用 `export *`）。
 */
export {
  ApprovalDeck,
  type ApprovalDeckProps,
  sanitizeApprovalDisplayText,
} from './ApprovalDeck.js';
export { ComposerDock, type ComposerDockProps } from './ComposerDock.js';
export {
  type ActiveWatchSummaryItem,
  type ContextUsageSummary,
  extractLocalhostPreviewUrl,
  LiveStatusStrip,
  type LiveStatusStripProps,
} from './LiveStatusStrip.js';
export {
  ModelHarnessPicker,
  type ModelHarnessPickerProps,
  type NativeSessionRole,
  type PickerHarnessOption,
  type PickerModelOption,
  type PickerProviderOption,
  type SelectedExternalHarness,
} from './ModelHarnessPicker.js';
export {
  type CommandFeedbackItem,
  type ComposerPermissionMode,
  type ComposerSendPayload,
  OmniComposer,
  type OmniComposerProps,
} from './OmniComposer.js';
export {
  type AtReferenceTab,
  buildCompletionEntries,
  type ComposerCompletionCatalogProps,
  type ComposerCompletionEntry,
  type ReferenceMessageHit,
  ReferencePopover,
  type ReferencePopoverProps,
  type ReferenceSessionCandidate,
  resolveActiveTrigger,
  type SkillCatalogOption,
  type SlashCommandOption,
} from './ReferencePopover.js';
