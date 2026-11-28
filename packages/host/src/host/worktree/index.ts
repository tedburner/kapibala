/**
 * @fileoverview 受管 Git Worktree 与执行根协调器显式命名导出入口（禁 `export *`）。
 */

export {
  DEFAULT_WORKTREE_COMMIT_MESSAGE,
  MAX_GIT_LINK_READ_BYTES,
  MAX_WORKTREE_FILE_PATCH_BYTES,
  MAX_WORKTREE_INCLUDE_FILE_BYTES,
  MAX_WORKTREE_INCLUDE_TOTAL_BYTES,
  MAX_WORKTREE_TOTAL_PATCH_BYTES,
  WORKTREE_BUCKET_MAX_RETRIES,
  WORKTREE_REGISTRY_FILE_NAME,
  WorktreeError,
} from './types.js';
export type {
  AllocatedSubagentWorktree,
  ApplyWorktreeMergeOptions,
  ApplyWorktreeMergeResult,
  CreatedWorktree,
  CreateWorktreeOptions,
  RemoveWorktreeOptions,
  RemoveWorktreeResult,
  SessionWorktreeBinding,
  SubagentWorktreeProvider,
  WorktreeChangedFile,
  WorktreeDiffResult,
  WorktreeErrorCode,
  WorktreeFileDiff,
  WorktreeMergePreview,
  WorktreeRecord,
  WorktreeServiceOptions,
  WorktreeStatus,
} from './types.js';
export { ExecutionRootCoordinator, toExecutionRootKey } from './coordinator.js';
export type {
  ActiveExecutionRun,
  ExecutionRemovalFence,
  ExecutionRunHandle,
  ExecutionSubsystemKind,
} from './coordinator.js';
export { verifyManagedWorktreeLink } from './verify-link.js';
export type { VerifyManagedWorktreeLinkInput } from './verify-link.js';
export { copyWorktreeIncludeFiles } from './worktree-include.js';
export { WorktreeRegistry } from './registry.js';
export {
  buildWorktreeGitEnv,
  runWorktreeGit,
  sanitizeWorktreeSlug,
} from './git-exec.js';
export type { RunWorktreeGitOptions, RunWorktreeGitResult } from './git-exec.js';
export { WorktreeService } from './service.js';
