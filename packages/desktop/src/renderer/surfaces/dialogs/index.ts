/**
 * Kapibala UI 2.0 原生 `<dialog>` 业务模态框公共入口（017 §0 铁律 3 & §7）。
 * 仅承载项目登记、目录信任授权、完全访问确认与会话重命名/不可逆删除确认。
 */
export {
  FullAccessConfirmDialog,
  type FullAccessConfirmDialogProps,
  ProjectCreateDialog,
  ProjectDialog,
  type ProjectDialogProps,
  sanitizeInitialProjectName,
  WorkspaceTrustDialog,
  type WorkspaceTrustDialogProps,
} from './ProjectDialogs.js';
export {
  ExternalSessionDeleteDialog,
  type ExternalSessionDeleteDialogProps,
  type ExternalSessionDeleteTarget,
  SessionArchiveDialog,
  type SessionArchiveDialogProps,
  SessionDeleteDialog,
  type SessionDeleteDialogProps,
  SessionRenameDialog,
  type SessionRenameDialogProps,
  type SessionTarget,
} from './SessionDialogs.js';
