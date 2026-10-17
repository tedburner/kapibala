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
export type {
  OperationPhase,
  OperationResult,
  PresentationChange,
  PresentationEvent,
  PresentationState,
  ViewBlock,
  ViewIdentity,
  ViewMessage,
  ViewNotice,
  ViewOperation,
  ViewTool,
} from './types.js';
