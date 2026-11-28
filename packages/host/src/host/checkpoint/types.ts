/**
 * @fileoverview Shadow Git 工作区检查点引擎公共契约、预算常量与错误分类。
 *
 * 设计边界与取舍：
 * - 检查点仓库完全侧挂在 `~/.kapibala/checkpoints/<projectKey>/<executionRootHash>/git`，
 *   绝不向用户工作区写入 `.git` 目录或污染主仓 `.git/refs` 与 `.git/index`；
 * - 回滚严格限定在目标轮次之后 Agent 实际触碰过的归因路径集，避免全盘 `git reset --hard` 或
 *   `git clean -fd` 误删用户原有的未跟踪文件与会话外手动改动；
 * - 统一采用三层未跟踪文件硬预算与 Patch 字节上限，防止构建产物目录或大体积二进制引发 I/O 风暴。
 */

import { KapibalaError } from '@kiturone/kapibala';

/** 单个未跟踪文件允许入库的最大字节数（10 MiB）；超出后记入跳过清单，避免大体积产物拖慢轮次。 */
export const MAX_UNTRACKED_FILE_BYTES = 10 * 1024 * 1024;

/** 单个未跟踪目录（父目录或新建顶层目录）允许暂存的最大文件数，防止漏配 `.gitignore` 的产物目录灌爆索引。 */
export const MAX_UNTRACKED_DIR_FILES = 200;

/** 单次快照捕获允许新增暂存的未跟踪文件累计字节上限（64 MiB）。 */
export const MAX_UNTRACKED_TOTAL_BYTES = 64 * 1024 * 1024;

/** 轮次启动前置基线采样的默认超时毫秒数（5 秒）；慢盘超时直接降级跳过，不阻塞主对话请求。 */
export const DEFAULT_PRE_TURN_TIMEOUT_MS = 5_000;

/** 同一会话连续触发前置采样超时的熔断阈值；达到后自动熔断该会话的后续自动前置采样。 */
export const PRE_TURN_TIMEOUT_CIRCUIT_THRESHOLD = 2;

/** 单文件 Unified Diff Patch 的最大 UTF-8 字节上限（256 KiB），超出在字符边界截断并置 `truncated: true`。 */
export const MAX_SINGLE_FILE_PATCH_BYTES = 256 * 1024;

/** 单次 Diff 查询返回的总 Unified Diff Patch 最大 UTF-8 字节上限（2 MiB）。 */
export const MAX_TOTAL_DIFF_PATCH_BYTES = 2 * 1024 * 1024;

/** 单项目桶默认保留的最大已终结会话检查点数量。 */
export const DEFAULT_MAX_CHECKPOINT_SESSIONS = 30;

/** 单项目桶侧挂对象库触发容量修剪的默认字节上限（500 MiB）。 */
export const DEFAULT_MAX_CHECKPOINT_BUCKET_BYTES = 500 * 1024 * 1024;

/**
 * 写入 `<sideGitDir>/info/exclude` 的内置排除规则。
 *
 * 约束：必须同时排除 `.git` 与 `.kapibala` 自身，防止侧挂索引将主仓 `.git` 目录或会话元数据当作普通文件入库。
 */
export const BUILTIN_EXCLUDES: readonly string[] = [
  '.git',
  '.git/**',
  '.kapibala',
  '.kapibala/**',
  'node_modules/',
  'dist/',
  'out/',
  'build/',
  'target/',
  '.next/',
  '.nuxt/',
  '.turbo/',
  'coverage/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '*.pyc',
  '*.o',
  '*.obj',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.exe',
];

/** 检查点领域稳定错误码：前置采样阶段遇不可用或超时做静默降级，显式查询或回滚阶段则按此错误码抛出给宿主。 */
export type CheckpointErrorCode =
  | 'CHECKPOINT_UNSAFE_ROOT'
  | 'CHECKPOINT_GIT_UNAVAILABLE'
  | 'CHECKPOINT_GIT_FAILED'
  | 'CHECKPOINT_LOCK_TIMEOUT'
  | 'CHECKPOINT_NOT_FOUND'
  | 'CHECKPOINT_SYMLINK_ESCAPE';

const CHECKPOINT_SAFE_MESSAGES: Readonly<Record<CheckpointErrorCode, string>> = {
  CHECKPOINT_UNSAFE_ROOT: '当前目录属于系统高危根路径，已禁用工作区检查点',
  CHECKPOINT_GIT_UNAVAILABLE: '未检测到可用的 Git 命令，无法使用工作区检查点',
  CHECKPOINT_GIT_FAILED: '工作区检查点 Git 操作失败',
  CHECKPOINT_LOCK_TIMEOUT: '等待工作区检查点锁超时',
  CHECKPOINT_NOT_FOUND: '未找到对应的工作区检查点记录',
  CHECKPOINT_SYMLINK_ESCAPE: '检测到符号链接越界风险，已中止文件还原',
};

/**
 * Shadow Git 检查点受控错误类型。
 *
 * 前置约束：`code` 固定归属 `CHECKPOINT_*` 命名空间，`safeMessage` 不暴露宿主机隐私路径原文。
 */
export class CheckpointError extends KapibalaError {
  override readonly code: CheckpointErrorCode;

  constructor(
    code: CheckpointErrorCode,
    message: string,
    retryPolicy: KapibalaError['retryPolicy'] = 'after_user_action',
  ) {
    super(message, {
      code,
      safeMessage: CHECKPOINT_SAFE_MESSAGES[code],
      retryPolicy,
    });
    this.name = 'CheckpointError';
    this.code = code;
  }
}

/** 工作区检查点可用性探测结果；高危根目录或缺少 Git 时明确返回不可用原因。 */
export type CheckpointAvailability =
  | {
      readonly available: true;
      readonly canonicalProjectRoot: string;
      readonly canonicalExecutionRoot: string;
      readonly projectKey: string;
      readonly executionRootHash: string;
      readonly bucketDir: string;
      readonly sideGitDir: string;
    }
  | {
      readonly available: false;
      readonly reason: 'unsafe_root' | 'git_unavailable';
    };

/** 单文件变更摘要（用于 `manifest.jsonl` 持久化与归因路径计算）。 */
export interface CheckpointChangedFile {
  /** 相对 `executionRoot` 的规范化正斜杠路径。 */
  readonly path: string;
  /** 相对本轮起点的状态；禁用重命名折叠以确保回滚时旧路径恢复与新路径清理由明确归因承载。 */
  readonly status: 'added' | 'modified' | 'deleted';
  /** 新增文本行数（二进制文件固定为 0）。 */
  readonly additions: number;
  /** 删除文本行数（二进制文件固定为 0）。 */
  readonly deletions: number;
  /** 是否为 Git 判定的二进制文件。 */
  readonly binary: boolean;
}

/** 持久化在 `manifest.jsonl` 中的单条检查点记录。 */
export interface CheckpointRecord {
  readonly id: string;
  readonly sessionId: string;
  readonly ordinal: number;
  readonly kind: 'turn' | 'pre-restore';
  readonly label?: string;
  readonly createdAt: number;
  /** 本轮（或本次还原前）起始工作区树对象 OID。 */
  readonly startTree: string;
  /** 本轮结束工作区树对象 OID。 */
  readonly endTree: string;
  /** 锚定在 `refs/kpbl/sessions/...` 上的提交对象 OID，保证 `startTree` 与 `endTree` 不被 `git gc` 误删。 */
  readonly commitOid: string;
  /** 完整引用名（如 `refs/kpbl/sessions/<id>/turn-0`）。 */
  readonly refName: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: readonly CheckpointChangedFile[];
  /** 因超出三层未跟踪文件预算而在本轮跳过入库的相对路径列表。 */
  readonly skippedUntrackedFiles?: readonly string[];
}

/** 轮次前置基线采样请求参数；`projectRoot` 决定检查点项目桶，`executionRoot` 指定实际扫描的工作树或目录。 */
export interface CapturePreTurnInput {
  readonly projectRoot: string;
  readonly executionRoot: string;
  readonly sessionId: string;
  readonly ordinal: number;
  /** 超时毫秒数（默认 5,000ms）。 */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** `capturePreTurn` 结果；慢盘超时或命中高危目录时优雅降级返回 `skipped: true`，不抛异常阻断主轮次。 */
export type CapturePreTurnResult =
  | {
      readonly captured: true;
      readonly skipped: false;
      readonly sessionId: string;
      readonly ordinal: number;
      readonly startTree: string;
      readonly commitOid: string;
      readonly refName: string;
      readonly durationMs: number;
      readonly skippedUntrackedFiles: readonly string[];
    }
  | {
      readonly captured: false;
      readonly skipped: true;
      readonly reason: 'unsafe_root' | 'git_unavailable' | 'timeout' | 'timeout_circuit_open';
    };

/** 轮次收尾增量捕获与落盘请求参数：将 `startTree` 与终点工作区树锚定为父子提交链以防 `git gc` 回收基线对象。 */
export interface CapturePostTurnInput {
  readonly projectRoot: string;
  readonly executionRoot: string;
  readonly sessionId: string;
  readonly ordinal: number;
  /** 由对应 `capturePreTurn` 返回的起始树 OID。 */
  readonly startTree: string;
  /** 可选由对应 `capturePreTurn` 已锚定到 `turn-<ordinal>` 的起始提交 OID；传入后避免重复 `commit-tree`，且无文件变更时零子进程直接复用。 */
  readonly startCommitOid?: string;
  readonly label?: string;
  readonly signal?: AbortSignal;
}

/** 查询指定会话当前生效轮次检查点的定位参数（已回退或被同序号重跑覆盖的历史条目自动折叠）。 */
export interface ListCheckpointsInput {
  readonly projectRoot: string;
  readonly executionRoot: string;
  readonly sessionId: string;
}

/** 单文件结构化 Diff 明细（含受预算裁剪的 Unified Patch）。 */
export interface CheckpointFileDiff {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted';
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  /** Unified Diff 文本（二进制文件或总预算耗尽时为空字符串）。 */
  readonly patch: string;
  /** 单文件超过 256 KiB 或总负载超过 2 MiB 发生 UTF-8 安全截断时为 `true`。 */
  readonly truncated: boolean;
}

/** `diff` 查询入参；指定 `ordinal` 查单轮，省略时按 `[fromOrdinal, toOrdinal]` 聚合会话归因变更。 */
export interface CheckpointDiffInput {
  readonly projectRoot: string;
  readonly executionRoot: string;
  readonly sessionId: string;
  /** 精确查看某一轮次的 Diff；与 `fromOrdinal` / `toOrdinal` 互斥（优先使用 `ordinal`）。 */
  readonly ordinal?: number;
  /** 起始轮次序号（含）；缺省从该会话最早记录轮次起算。 */
  readonly fromOrdinal?: number;
  /** 结束轮次序号（含）；缺省至该会话最新记录轮次。 */
  readonly toOrdinal?: number;
  /** 为 `true` 时将当前工作区实时未提交改动叠加为末端状态一并对比。 */
  readonly includeLiveWorktree?: boolean;
  readonly signal?: AbortSignal;
}

/** 结构化检查点 Diff 聚合结果；当目标目录不可用检查点时返回 `available: false` 与空列表而不抛错。 */
export interface CheckpointDiffResult {
  readonly available: boolean;
  readonly files: CheckpointFileDiff[];
  readonly additions: number;
  readonly deletions: number;
  /** 任一文件因单文件或总字节预算被截断时为 `true`。 */
  readonly truncated: boolean;
}

/** 按归因路径集外科手术式还原磁盘文件的控制参数；绝不触碰会话期间未归因的用户文件。 */
export interface RestoreCheckpointInput {
  readonly projectRoot: string;
  readonly executionRoot: string;
  readonly sessionId: string;
  /**
   * 目标回退水位：回滚所有 `ordinal > targetOrdinal` 的轮次归因文件。
   * 传 `K` 回退到第 `K` 轮结束态；传 `-1`（或首轮 `ordinal - 1`）回退到首轮开始前状态。
   */
  readonly targetOrdinal: number;
  /** 为 `true` 时忽略事后用户手动修改冲突，强制覆盖归因路径（仍先生成 `pre-restore` 备份快照）。 */
  readonly force?: boolean;
  /** 为 `true` 时仅执行三路冲突预检而不写入 `pre-restore` 备份或修改磁盘/清单，用于跨子系统写盘前原子门禁。 */
  readonly dryRun?: boolean;
  readonly signal?: AbortSignal;
}

/** 检查点归因还原结果：命中事后手动编辑且未指定 `force` 时返回 `conflict` 且保证磁盘零写操作。 */
export type RestoreCheckpointResult =
  | {
      readonly status: 'restored';
      readonly restoredFiles: string[];
      readonly deletedFiles: string[];
      readonly preRestoreRef: string;
      readonly preRestoreRecord: CheckpointRecord;
    }
  | {
      readonly status: 'conflict';
      /** 在最后一轮结束后又被用户在磁盘手动修改、删除或新建的归因文件相对路径列表。 */
      readonly conflicts: string[];
    }
  | {
      readonly status: 'noop';
      readonly restoredFiles: [];
      readonly deletedFiles: [];
    };

/** 检查点分桶容量与过期会话引用修剪参数；活跃中的会话 ID 受保护永不淘汰。 */
export interface PruneCheckpointsInput {
  readonly projectRoot: string;
  readonly executionRoot: string;
  /** 最多保留的已终结会话数（默认 30）。 */
  readonly maxSessions?: number;
  /** 侧挂对象目录软上限字节数（默认 500 MiB）。 */
  readonly maxBytes?: number;
  /** 当前仍处于活跃打开态的会话 ID 集合；集合内会话绝不被修剪。 */
  readonly activeSessionIds?: ReadonlySet<string>;
}

/** 检查点引用淘汰与 `git gc` 回收统计结果。 */
export interface PruneCheckpointsResult {
  readonly prunedSessions: string[];
  readonly remainingSessions: number;
}

/** `CheckpointService` 依赖注入配置；支持覆写用户主目录、洁净环境变量与测试时钟。 */
export interface CheckpointServiceOptions {
  readonly homeDir?: string;
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
}
