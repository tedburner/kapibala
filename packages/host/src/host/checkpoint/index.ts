/**
 * @fileoverview Shadow Git 工作区检查点模块显式命名导出入口（禁 `export *`）。
 */

export {
  BUILTIN_EXCLUDES,
  CheckpointError,
  DEFAULT_MAX_CHECKPOINT_BUCKET_BYTES,
  DEFAULT_MAX_CHECKPOINT_SESSIONS,
  DEFAULT_PRE_TURN_TIMEOUT_MS,
  MAX_SINGLE_FILE_PATCH_BYTES,
  MAX_TOTAL_DIFF_PATCH_BYTES,
  MAX_UNTRACKED_DIR_FILES,
  MAX_UNTRACKED_FILE_BYTES,
  MAX_UNTRACKED_TOTAL_BYTES,
  PRE_TURN_TIMEOUT_CIRCUIT_THRESHOLD,
} from './types.js';
export type {
  CapturePostTurnInput,
  CapturePreTurnInput,
  CapturePreTurnResult,
  CheckpointAvailability,
  CheckpointChangedFile,
  CheckpointDiffInput,
  CheckpointDiffResult,
  CheckpointErrorCode,
  CheckpointFileDiff,
  CheckpointRecord,
  CheckpointServiceOptions,
  ListCheckpointsInput,
  PruneCheckpointsInput,
  PruneCheckpointsResult,
  RestoreCheckpointInput,
  RestoreCheckpointResult,
} from './types.js';
export {
  buildCleanGitEnv,
  computeExecutionRootHash,
  isUnsafeCheckpointRoot,
  runGit,
  splitNulStrings,
  toSafeRefSegment,
  truncateUtf8Safe,
} from './git-exec.js';
export type { RunGitOptions, RunGitResult } from './git-exec.js';
export { CheckpointBucketMutex } from './lock.js';
export { CheckpointService } from './service.js';
