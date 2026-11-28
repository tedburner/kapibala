/**
 * @fileoverview 受管 Git Worktree 服务与跨子系统执行根协调器的公共类型、配额常量与错误分类。
 *
 * 设计不变量：
 * - `projectRoot`（主仓物理根，决定项目桶、信任根与会话归属）与 `worktreePath`（实际 `executionRoot`）严格解耦；
 * - 受管工作树统一落盘于 `~/.kapibala/worktrees/<4-hex-bucket>/<repoBasename>` 短路径桶，防止 Windows MAX_PATH 溢出；
 * - 本地合并采用「先在 Worktree 内预合并主分支隔离冲突 → 再对主工作区执行 `--ff-only` 快进」，确保主仓永不落入冲突半残态。
 */

import {
  KapibalaError,
  type SessionWorktreeBinding,
  type SubagentWorktreeProvider,
} from '@kiturone/kapibala';
import type { ExecutionRootCoordinator } from './coordinator.js';

export type {
  AllocatedSubagentWorktree,
  SessionWorktreeBinding,
  SubagentWorktreeProvider,
} from '@kiturone/kapibala';

/** `.worktreeinclude` 允许拷贝的单个被忽略常规文件最大字节数（8 MiB）。 */
export const MAX_WORKTREE_INCLUDE_FILE_BYTES = 8 * 1024 * 1024;

/** `.worktreeinclude` 单次创建工作树累计允许拷贝的最大字节数（32 MiB）。 */
export const MAX_WORKTREE_INCLUDE_TOTAL_BYTES = 32 * 1024 * 1024;

/** `.git` 回链文件与 `.worktreeinclude` 规则文件的安全读取上限（64 KiB）。 */
export const MAX_GIT_LINK_READ_BYTES = 64 * 1024;

/** 分配 4 位十六进制短路径桶时的最大原子 `mkdirSync` 碰撞重试次数。 */
export const WORKTREE_BUCKET_MAX_RETRIES = 64;

/** 受管工作树元数据登记簿文件名（`~/.kapibala/worktrees/registry.json`）。 */
export const WORKTREE_REGISTRY_FILE_NAME = 'registry.json';

/** `applyMerge` 自动打包工作树未提交改动时的默认提交说明。 */
export const DEFAULT_WORKTREE_COMMIT_MESSAGE = 'chore: commit worktree changes';

/** Worktree Diff 单文件 Patch 最大 UTF-8 字节上限（256 KiB）。 */
export const MAX_WORKTREE_FILE_PATCH_BYTES = 256 * 1024;

/** Worktree Diff 单次查询总 Patch 最大 UTF-8 字节上限（2 MiB）。 */
export const MAX_WORKTREE_TOTAL_PATCH_BYTES = 2 * 1024 * 1024;

/** 受管 Git Worktree 机器可读错误码集合。 */
export type WorktreeErrorCode =
  | 'WORKTREE_NOT_GIT_REPO'
  | 'WORKTREE_REPO_UNMERGED'
  | 'WORKTREE_INVALID_BASE_REF'
  | 'WORKTREE_INVALID_BRANCH'
  | 'WORKTREE_BRANCH_EXISTS'
  | 'WORKTREE_CAPACITY_EXCEEDED'
  | 'WORKTREE_LINK_INVALID'
  | 'WORKTREE_NOT_FOUND'
  | 'WORKTREE_ACTIVE_RUN'
  | 'WORKTREE_FENCED'
  | 'WORKTREE_BUSY'
  | 'WORKTREE_MERGE_STALE_PREVIEW'
  | 'WORKTREE_DETACHED_MAIN'
  | 'WORKTREE_MAIN_BRANCH_MISMATCH'
  | 'WORKTREE_MAIN_DIRTY'
  | 'WORKTREE_GIT_UNAVAILABLE'
  | 'WORKTREE_GIT_FAILED'
  | 'WORKTREE_ESCAPE';

const WORKTREE_SAFE_MESSAGES: Readonly<Record<WorktreeErrorCode, string>> = {
  WORKTREE_NOT_GIT_REPO: '当前项目不是有效的 Git 仓库，无法创建受管工作树',
  WORKTREE_REPO_UNMERGED: '仓库或工作树存在未完成的合并、变基或未解决冲突，请先处理后再继续操作',
  WORKTREE_INVALID_BASE_REF: '指定的基线分支或提交在本地不存在',
  WORKTREE_INVALID_BRANCH: '工作树分支名称不符合 Git 引用规范',
  WORKTREE_BRANCH_EXISTS: '同名本地分支已存在，请更换分支名',
  WORKTREE_CAPACITY_EXCEEDED: '受管工作树短路径桶分配冲突过多，请清理闲置工作树后重试',
  WORKTREE_LINK_INVALID: '工作树双向 Git 回链校验失败，已拒绝信任或访问该目录',
  WORKTREE_NOT_FOUND: '找不到指定的受管工作树记录',
  WORKTREE_ACTIVE_RUN: '该工作树仍有运行中的本地或外部任务，请先停止任务后再执行此操作',
  WORKTREE_FENCED: '该工作树正处于合并或移除门闩保护期，暂不接受新任务',
  WORKTREE_BUSY: '工作树目录或句柄正被系统进程占用，请关闭相关终端或编辑器后重试',
  WORKTREE_MERGE_STALE_PREVIEW: '工作树或主仓库状态已发生变化，请刷新合并预览后再确认合并',
  WORKTREE_DETACHED_MAIN: '主工作区处于游离 HEAD 状态，无法执行目标分支快进合并',
  WORKTREE_MAIN_BRANCH_MISMATCH: '主工作区当前检出分支与工作树基线分支不一致，请先切回基线分支',
  WORKTREE_MAIN_DIRTY: '主工作区在受影响文件上存在未提交修改，无法安全快进合并',
  WORKTREE_GIT_UNAVAILABLE: '未检测到可用的 Git 命令',
  WORKTREE_GIT_FAILED: '执行 Git 工作树命令失败',
  WORKTREE_ESCAPE: '请求的子目录越出了工作树根边界',
};

/**
 * 受管 Git Worktree 领域错误类型。
 *
 * 约束：统一携带稳定 `WORKTREE_*` 错误码与脱敏 `safeMessage`，供 CLI 与桌面端精确映射交互提示。
 */
export class WorktreeError extends KapibalaError {
  override readonly code: WorktreeErrorCode;

  constructor(
    code: WorktreeErrorCode,
    message: string,
    retryPolicy: KapibalaError['retryPolicy'] = 'after_user_action',
  ) {
    super(message, {
      code,
      safeMessage: WORKTREE_SAFE_MESSAGES[code],
      retryPolicy,
    });
    this.name = 'WorktreeError';
    this.code = code;
  }
}

/** 持久化在 `registry.json` 中的完整受管工作树元数据。 */
export interface WorktreeRecord extends SessionWorktreeBinding {
  /** 4 位小写十六进制桶名（同工作树 `id`）。 */
  readonly bucket: string;
  /** 创建时传入的可读任务名称快照。 */
  readonly name?: string;
  readonly updatedAt: number;
}

/** 新建受管 Git Worktree 的请求契约：要求 `projectRoot` 指向干净 Git 仓库，全程仅解析本地提交而不联网拉取。 */
export interface CreateWorktreeOptions {
  /** 主项目仓库物理根路径。 */
  readonly projectRoot: string;
  /** 可选任务简称（用于派生 `kpbl/<slug>-<bucket>` 分支名）。 */
  readonly name?: string;
  /** 可选显式自定义分支名；省略时自动生成并处理 `refs/heads/kpbl` D/F 冲突回退。 */
  readonly branch?: string;
  /** 可选本地基线引用（默认取主仓当前分支名，游离态取 `'HEAD'`；绝不触发联网 `git fetch`）。 */
  readonly baseRef?: string;
  /** 可选相对执行子目录（如 `'packages/core'`），解析后必须位于新建工作树内部。 */
  readonly relativeCwd?: string;
}

/** 新建受管 Git Worktree 成功后的原子交付产物（已通过四步 `.git` 双向验真并解锁登记）。 */
export interface CreatedWorktree {
  readonly binding: SessionWorktreeBinding;
  readonly record: WorktreeRecord;
  /** 映射到新工作树内的规范化执行目录物理路径。 */
  readonly executionCwd: string;
  /** 经 `.worktreeinclude` 规则成功拷贝的相对路径列表。 */
  readonly copiedIncludeFiles: readonly string[];
}

/** 工作树相对对比基线的单文件统计摘要（含重命名原路径与二进制标记）。 */
export interface WorktreeChangedFile {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly oldPath?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
}

/** 附带受 256 KiB 单文件 / 2 MiB 总量预算保护 Unified Patch 的工作树文件变更明细。 */
export interface WorktreeFileDiff extends WorktreeChangedFile {
  readonly patch: string;
  readonly truncated: boolean;
}

/** 受管工作树实时盘点结果；当磁盘目录已被外部删除时 `exists` 与 `linkVerified` 均返回 `false` 而不抛错。 */
export interface WorktreeStatus {
  readonly id: string;
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly headCommit?: string;
  readonly exists: boolean;
  readonly linkVerified: boolean;
  readonly dirty: boolean;
  readonly untrackedCount: number;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: WorktreeChangedFile[];
}

/** 受管工作树相对创建基线 `baseCommit` 的结构化 Diff 聚合结果（含未提交修改与未忽略新文件）。 */
export interface WorktreeDiffResult {
  readonly id: string;
  readonly branch: string;
  readonly baseCommit: string;
  readonly headCommit: string;
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
  readonly files: WorktreeFileDiff[];
}

/** 受管工作树合并回主分支前的只读预检快照；任何未决冲突、目标分支偏离或主仓路径重叠均置 `canApply: false`。 */
export interface WorktreeMergePreview {
  readonly id: string;
  readonly branch: string;
  readonly targetBranch: string;
  readonly baseCommit: string;
  readonly worktreeHead: string;
  readonly mainHead: string;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly worktreeDirty: boolean;
  readonly mainDirty: boolean;
  readonly canApply: boolean;
  readonly blockingReason?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFiles: WorktreeChangedFile[];
  /** 综合双端 `HEAD`、目标分支、未决冲突态、Porcelain 列表与脏文件内容哈希计算的防状态漂移令牌。 */
  readonly previewToken: string;
}

/** 执行冲突隔离本地合并的请求参数；`previewToken` 与当前双端状态不一致时抛 `WORKTREE_MERGE_STALE_PREVIEW`。 */
export interface ApplyWorktreeMergeOptions {
  readonly id: string;
  readonly previewToken: string;
  /** 当工作树含未提交改动时用于自动提交的说明；缺省为 `'chore: commit worktree changes'`。 */
  readonly commitMessage?: string;
}

/** `WorktreeService.applyMerge` 执行结果；发生冲突时严格隔离在工作树内，主仓保持零污染。 */
export type ApplyWorktreeMergeResult =
  | {
      readonly status: 'merged';
      readonly mergedCommit: string;
      readonly targetBranch: string;
    }
  | {
      readonly status: 'conflict';
      readonly conflictedFiles: string[];
    };

/** 移除受管工作树的控制参数；默认启用脏改动、未合入提交与 `.env*` 敏感文件三路拦截。 */
export interface RemoveWorktreeOptions {
  readonly id: string;
  /** 为 `true` 时跳过未提交文件、未合并提交与敏感被忽略文件检查，强制移除。 */
  readonly force?: boolean;
  /** 获得删除门闩且通过脏检查后、实际摘除磁盘目录前的钩子（供宿主关闭空闲会话句柄与保活终端）。 */
  readonly onBeforeRemove?: (record: WorktreeRecord) => void | Promise<void>;
}

/** `WorktreeService.remove` 结果；非强制模式下命中任一风险项即明确返回原因与详情列表。 */
export type RemoveWorktreeResult =
  | {
      readonly removed: true;
      readonly id: string;
    }
  | {
      readonly removed: false;
      readonly reason: 'dirty' | 'unmerged_commits' | 'at_risk_ignored_files';
      readonly details: string[];
    };

/** `WorktreeService` 依赖注入配置；支持测试覆写 `homeDir`、洁净基准环境与确定性时钟。 */
export interface WorktreeServiceOptions {
  readonly homeDir?: string;
  readonly coordinator?: ExecutionRootCoordinator;
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => number;
}
