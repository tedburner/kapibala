/** 纯展示入口；导入不会初始化终端或会话，发布子路径在工程接入阶段配置。 */
export { matchCommandCandidates, moveCommandSelection, selectCommandWindow } from './commands.js';
export type {
  CommandCandidate,
  CommandMatch,
  CommandMatchKind,
  CommandWindow,
} from './commands.js';
export {
  createPresentation,
  isBlockExpanded,
  reducePresentation,
  selectMessages,
} from './reducer.js';
export { summarizeToolGroup } from './tool-summary.js';
export type { ToolGroupSummary } from './tool-summary.js';
export type {
  ViewEvidence,
  ViewEvidenceChangeFile,
  ViewEvidenceChangeStatus,
  ViewEvidenceDelegation,
  ViewEvidenceDelegationState,
  ViewEvidenceMcpServer,
  ViewEvidenceReference,
  ViewEvidenceSummary,
} from './evidence.js';
export type {
  OperationPhase,
  OperationResult,
  PresentationChange,
  PresentationEvent,
  PresentationState,
  ViewArtifact,
  ViewBlock,
  ViewIdentity,
  ViewMessage,
  ViewNotice,
  ViewOperation,
  ViewTodoItem,
  ViewTodoState,
  ViewTodoStatus,
  ViewTool,
  ViewUsage,
} from './types.js';
export type {
  ViewExternalApproval,
  ViewExternalConfigCategory,
  ViewExternalConfigChoice,
  ViewExternalConfigOption,
  ViewExternalHarness,
  ViewExternalHarnessProbe,
  ViewExternalSession,
  ViewExternalSessionStatus,
  ViewExternalSnapshot,
  ViewExternalTemplate,
  ViewExternalTransport,
} from './external.js';
