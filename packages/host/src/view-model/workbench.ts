/**
 * @fileoverview 工作台（Worktree / Shadow Git Checkpoint / Diff）纯浏览器安全展示 DTO。
 *
 * 架构边界：
 * - 0 Node 内置模块导入、0 全局副作用、0 ANSI 控制符，通过 `check-view-model` 与 `check-cli-boundary` 门禁；
 * - 同时服务桌面端 `DiffTab` / `SessionHeader` / `WorkspaceTree` 与本地宿主投影。
 */

/** 会话或轮次级磁盘文件增删行统计摘要。 */
export interface ViewDiffSummary {
  readonly additions: number;
  readonly deletions: number;
}

/** 会话绑定的受管 Git Worktree 浏览器安全只读摘要。 */
export interface ViewWorktreeSummary {
  readonly id: string;
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly baseCommit: string;
  readonly createdAt: number;
  /** 绑定的受管工作树目录已不存在时为 `true`，此时会话以只读历史模式打开，续跑前须重新绑定执行根。 */
  readonly missing?: boolean;
}

/** 单条轮次级 Shadow Git 检查点只读摘要，供工作台 `Diff` 标签与回退菜单渲染。 */
export interface ViewCheckpointItem {
  readonly ordinal: number;
  readonly createdAt: number;
  readonly startTree: string;
  readonly endTree: string;
  readonly additions: number;
  readonly deletions: number;
  readonly changedFilesCount: number;
  readonly label?: string;
}

/** 单文件结构化 Unified Diff 投影；超预算内容由宿主在 UTF-8 字符边界截断并置 `truncated: true`。 */
export interface ViewFileDiff {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'deleted' | 'renamed';
  readonly originalPath?: string;
  readonly additions: number;
  readonly deletions: number;
  readonly binary: boolean;
  readonly patch: string;
  readonly truncated: boolean;
}

/** 受管工作树合并回主工作区的冲突隔离预检快照；`previewToken` 防预览后双端状态漂移。 */
export interface ViewMergePreview {
  readonly worktreeId: string;
  readonly branch: string;
  readonly baseRef: string;
  readonly aheadCount: number;
  readonly behindCount: number;
  readonly worktreeDirty: boolean;
  readonly mainDirty: boolean;
  readonly canApply?: boolean;
  readonly blockingReason?: string;
  readonly additions?: number;
  readonly deletions?: number;
  readonly previewToken: string;
  readonly changedFiles: readonly {
    readonly path: string;
    readonly status: 'added' | 'modified' | 'deleted' | 'renamed' | (string & {});
    readonly oldPath?: string;
    readonly additions: number;
    readonly deletions: number;
  }[];
}
