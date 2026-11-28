/**
 * Kapibala UI 2.0 右侧多标签工程工作台（`WorkbenchStage`）公共导出入口。
 * 采用显式命名重导出（禁用 `export *`），供应用壳顶层装配与测试模块按需消费。
 */
export {
  type DiffScopeMode,
  DiffTab,
  type DiffTabProps,
  type DiffViewMode,
} from './DiffTab.js';
export {
  type ApplyWorktreeMergeResult,
  buildWorktreeConflictResolutionPrompt,
  CheckpointConflictDialog,
  type CheckpointConflictDialogProps,
  DiffWorktreePanel,
  type DiffWorktreePanelProps,
  type RestoreCheckpointResult,
} from './DiffWorktreePanel.js';
export {
  buildSplitDiffRows,
  type DiffLineKind,
  type DiffStatusBadgeMeta,
  type ParsedDiffHunk,
  type ParsedDiffRow,
  parseUnifiedDiffPatch,
  resolveDiffStatusBadge,
  type SplitDiffPair,
} from './diff-parser.js';
export {
  EvidenceDashboard,
  type EvidenceDashboardProps,
} from './EvidenceDashboard.js';
export {
  FilesTab,
  type FilesTabProps,
  type WorkspaceFileReadResult,
  type WorkspaceFileSearchResult,
} from './FilesTab.js';
export {
  InspectorTab,
  type InspectorTabProps,
} from './InspectorTab.js';
export {
  formatPreviewBytes,
  type PreviewSurfaceMode,
  PreviewTab,
  type PreviewTabProps,
} from './PreviewTab.js';
export {
  MAX_SESSION_TERMINALS,
  type TerminalInstanceState,
  type TerminalRendererMount,
  type TerminalShellOption,
  TerminalTab,
  type TerminalTabProps,
  type TerminalViewportRenderProps,
} from './TerminalTab.js';
export {
  WorkbenchStage,
  type WorkbenchStageProps,
} from './WorkbenchStage.js';
export { XtermViewport } from './XtermViewport.js';
export {
  emitTerminalStreamData,
  focusTerminalSafely,
  resolveXtermThemeFromTokens,
  subscribeTerminalStreamData,
} from './xterm-theme.js';
