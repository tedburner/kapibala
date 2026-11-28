/**
 * Kapibala UI 2.0 阶段 3 单一会话流视图面统一公共入口（显式命名重导出，禁用 `export *`）。
 */
export {
  formatProcessDuration,
  ProcessGroup,
  type ProcessGroupProps,
} from './ProcessGroup.js';
export { SessionHeader, type SessionHeaderProps } from './SessionHeader.js';
export { SessionStage, type SessionStageProps } from './SessionStage.js';
export {
  type ParsedUserProvenance,
  parseUserMessageProvenance,
  TurnItem,
  type TurnItemProps,
} from './TurnItem.js';
export {
  resolveThreadActivityKind,
  VirtualTurnList,
  type VirtualTurnListProps,
} from './VirtualTurnList.js';
