/**
 * @fileoverview `WorktreeService` —— 宿主级受管 Git Worktree 物理隔离、冲突隔离合并与安全移除引擎。
 *
 * 关键工程不变量：
 * 1. 创建零联网阻塞：仅解析本地提交，使用 `--lock --reason kpbl-init --no-track -b <branch>` 创建，
 *    自动检测 `refs/heads/kpbl` 单文件分支回退 `kpbl-<slug>-<bucket>` 防 D/F 锁死，配置与 `.worktreeinclude`
 *    就绪且通过四步 `.git` 双向验真后再解锁注册；任一步失败全量回滚；
 * 2. 冲突隔离本地合并：`applyMerge` 先校验 `previewToken` 未漂移，再在 `<worktreePath>` 内部 merge 主分支，
 *    发生冲突时主仓 100% 干净零改动；通过后对主仓执行原子 `git merge --ff-only`；
 * 3. Windows NTFS Junction 安全移除：先备份 `.git` 指针字节，使用 Node `fs.rmSync` 摘除目录软链而不穿透删除主仓目标，
 *    中途句柄占用报错时还原 `.git` 保持工作树有效态，最后 `git worktree prune` 并安全删除分支。
 */

import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type AgentTaskStatus,
  type AllocatedSubagentWorktree,
  type SessionWorktreeBinding,
  type SubagentWorktreeProvider,
  isPathInside,
  isSamePath,
  toNativePhysicalPath,
} from '@kiturone/kapibala';
import { type ExecutionRemovalFence, ExecutionRootCoordinator } from './coordinator.js';
import {
  runWorktreeGit,
  sanitizeWorktreeSlug,
  splitNulStrings,
  truncateUtf8Safe,
} from './git-exec.js';
import { WorktreeRegistry } from './registry.js';
import {
  type ApplyWorktreeMergeOptions,
  type ApplyWorktreeMergeResult,
  type CreateWorktreeOptions,
  type CreatedWorktree,
  DEFAULT_WORKTREE_COMMIT_MESSAGE,
  MAX_WORKTREE_FILE_PATCH_BYTES,
  MAX_WORKTREE_TOTAL_PATCH_BYTES,
  type RemoveWorktreeOptions,
  type RemoveWorktreeResult,
  WORKTREE_BUCKET_MAX_RETRIES,
  type WorktreeChangedFile,
  type WorktreeDiffResult,
  WorktreeError,
  type WorktreeFileDiff,
  type WorktreeMergePreview,
  type WorktreeRecord,
  type WorktreeServiceOptions,
  type WorktreeStatus,
} from './types.js';
import { verifyManagedWorktreeLink } from './verify-link.js';
import { copyWorktreeIncludeFiles } from './worktree-include.js';

/**
 * 宿主受管 Git Worktree 生命周期服务，同时可适配为 Core `SubagentWorktreeProvider`。
 */
export class WorktreeService {
  readonly coordinator: ExecutionRootCoordinator;
  readonly registry: WorktreeRegistry;
  private readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  private readonly now: () => number;
  private readonly subagentBranchHints = new Map<string, string[]>();

  constructor(options: WorktreeServiceOptions = {}) {
    this.coordinator = options.coordinator ?? new ExecutionRootCoordinator();
    this.registry = new WorktreeRegistry({ homeDir: options.homeDir });
    this.hostEnv = options.hostEnv;
    this.now = options.now ?? Date.now;
  }

  /** 返回受管工作树根目录 `~/.kapibala/worktrees`。 */
  get worktreesRoot(): string {
    return this.registry.worktreesRoot;
  }

  /** 列出全部或指定 `projectRoot` 下的受管工作树记录。 */
  list(projectRoot?: string): WorktreeRecord[] {
    return this.registry.list(projectRoot);
  }

  /** 按 `id` 获取单条受管工作树记录。 */
  get(id: string): WorktreeRecord | undefined {
    return this.registry.get(id);
  }

  /** 按工作树目录物理路径反查受管记录。 */
  findByPath(worktreePath: string): WorktreeRecord | undefined {
    return this.registry.findByWorktreePath(worktreePath);
  }

  /** 对给定工作树执行同步四步 `.git` 双向回链验真。 */
  verifyLink(projectRoot: string, worktreePath: string): boolean {
    return verifyManagedWorktreeLink({
      worktreesRoot: this.worktreesRoot,
      projectRoot,
      worktreePath,
    });
  }

  /**
   * 在 `~/.kapibala/worktrees/<4hex>/<repo>` 下创建独立分支的受管 Git Worktree。
   */
  async create(options: CreateWorktreeOptions): Promise<CreatedWorktree> {
    const inputRoot = toNativePhysicalPath(path.resolve(options.projectRoot));
    const repoMeta = await this.inspectMainRepo(inputRoot);
    const canonicalProjectRoot = repoMeta.topLevel;

    await this.assertRepoCleanMergeState(canonicalProjectRoot, repoMeta.gitDir);

    const { effectiveBaseRef, baseCommit } = await this.resolveLocalBaseCommit(
      canonicalProjectRoot,
      options.baseRef,
    );

    this.ensureWorktreesRootPrepared();
    const { bucket, bucketDir } = this.allocateShortBucketDir();
    const repoSlug = sanitizeWorktreeSlug(path.basename(canonicalProjectRoot), 'repo');
    const rawWorktreePath = path.join(bucketDir, repoSlug);

    let branch = '';
    let worktreeCreated = false;
    try {
      branch = await this.resolveTargetBranchName({
        projectRoot: canonicalProjectRoot,
        bucket,
        name: options.name,
        explicitBranch: options.branch,
      });

      await runWorktreeGit({
        cwd: canonicalProjectRoot,
        args: [
          'worktree',
          'add',
          '--lock',
          '--reason',
          'kpbl-init',
          '--no-track',
          '-b',
          branch,
          rawWorktreePath,
          baseCommit,
        ],
        baseEnv: this.hostEnv,
      });
      worktreeCreated = true;

      const canonicalWorktreePath = toNativePhysicalPath(rawWorktreePath);

      await runWorktreeGit({
        cwd: canonicalWorktreePath,
        args: ['config', `branch.${branch}.kpblBaseCommit`, baseCommit],
        baseEnv: this.hostEnv,
      });
      await runWorktreeGit({
        cwd: canonicalWorktreePath,
        args: ['config', `branch.${branch}.kpblBaseRef`, effectiveBaseRef],
        baseEnv: this.hostEnv,
      });

      const copiedIncludeFiles = await copyWorktreeIncludeFiles({
        projectRoot: canonicalProjectRoot,
        worktreePath: canonicalWorktreePath,
        baseEnv: this.hostEnv,
      });

      const linkOk = verifyManagedWorktreeLink({
        worktreesRoot: this.worktreesRoot,
        projectRoot: canonicalProjectRoot,
        worktreePath: canonicalWorktreePath,
      });
      if (!linkOk) {
        throw new WorktreeError(
          'WORKTREE_LINK_INVALID',
          `Managed worktree link verification failed for '${canonicalWorktreePath}'`,
        );
      }

      const executionCwd = this.resolveExecutionCwdInsideWorktree(
        canonicalWorktreePath,
        options.relativeCwd,
      );

      await runWorktreeGit({
        cwd: canonicalProjectRoot,
        args: ['worktree', 'unlock', canonicalWorktreePath],
        baseEnv: this.hostEnv,
      });

      const createdAt = this.now();
      const binding: SessionWorktreeBinding = {
        id: bucket,
        projectRoot: canonicalProjectRoot,
        worktreePath: canonicalWorktreePath,
        branch,
        baseRef: effectiveBaseRef,
        baseCommit,
        createdAt,
      };
      const record: WorktreeRecord = {
        ...binding,
        bucket,
        name: options.name,
        updatedAt: createdAt,
      };
      await this.registry.upsert(record);

      return {
        binding,
        record,
        executionCwd,
        copiedIncludeFiles,
      };
    } catch (err) {
      // 任何创建中间步骤失败均执行完整回滚，绝不残留半截锁死工作树、空桶或孤儿分支。
      await this.rollbackFailedCreation({
        projectRoot: canonicalProjectRoot,
        bucketDir,
        worktreePath: rawWorktreePath,
        branch,
        worktreeCreated,
        bucket,
      });
      throw err;
    }
  }

  /**
   * 读取指定受管工作树的实时脏状态、领先/落后提交计数与相对 `baseCommit` 的文件变更摘要。
   */
  async status(id: string): Promise<WorktreeStatus> {
    const record = this.requireRecord(id);
    const exists = fs.existsSync(record.worktreePath);
    if (!exists) {
      return {
        id: record.id,
        projectRoot: record.projectRoot,
        worktreePath: record.worktreePath,
        branch: record.branch,
        baseRef: record.baseRef,
        baseCommit: record.baseCommit,
        exists: false,
        linkVerified: false,
        dirty: false,
        untrackedCount: 0,
        aheadCount: 0,
        behindCount: 0,
        additions: 0,
        deletions: 0,
        changedFiles: [],
      };
    }

    const linkVerified = this.verifyLink(record.projectRoot, record.worktreePath);
    const headCommit = await this.readHeadCommit(record.worktreePath);
    const porcelainEntries = await this.readPorcelainEntries(record.worktreePath);
    const untrackedCount = porcelainEntries.filter((e) => e.xy === '??').length;
    const dirty = porcelainEntries.length > 0;

    const { aheadCount, behindCount } = await this.computeAheadBehind(record);
    const changedFiles = await this.computeWorktreeChangedFiles(
      record.worktreePath,
      record.baseCommit,
    );

    let additions = 0;
    let deletions = 0;
    for (const f of changedFiles) {
      additions += f.additions;
      deletions += f.deletions;
    }

    return {
      id: record.id,
      projectRoot: record.projectRoot,
      worktreePath: record.worktreePath,
      branch: record.branch,
      baseRef: record.baseRef,
      baseCommit: record.baseCommit,
      headCommit,
      exists: true,
      linkVerified,
      dirty,
      untrackedCount,
      aheadCount,
      behindCount,
      additions,
      deletions,
      changedFiles,
    };
  }

  /**
   * 计算受管工作树相对 `baseCommit` 的完整结构化文件 Diff（含未提交及未跟踪常规文件，带 256 KiB / 2 MiB 预算保护）。
   */
  async diff(id: string): Promise<WorktreeDiffResult> {
    const record = this.requireExistingVerifiedRecord(id);
    const headCommit = await this.readHeadCommit(record.worktreePath);
    const summaries = await this.computeWorktreeChangedFiles(
      record.worktreePath,
      record.baseCommit,
    );

    let totalBytes = 0;
    let anyTruncated = false;
    let additions = 0;
    let deletions = 0;
    const files: WorktreeFileDiff[] = [];

    const untrackedPaths = new Set(await this.readUntrackedNonIgnoredFiles(record.worktreePath));

    for (const item of summaries) {
      additions += item.additions;
      deletions += item.deletions;

      if (item.binary) {
        files.push({ ...item, patch: '', truncated: false });
        continue;
      }

      const remaining = MAX_WORKTREE_TOTAL_PATCH_BYTES - totalBytes;
      if (remaining <= 0) {
        anyTruncated = true;
        files.push({ ...item, patch: '', truncated: true });
        continue;
      }
      const budget = Math.min(MAX_WORKTREE_FILE_PATCH_BYTES, remaining);

      let rawPatch: Buffer;
      let streamTruncated = false;
      if (untrackedPaths.has(item.path)) {
        rawPatch = buildUntrackedUnifiedPatch(record.worktreePath, item.path, budget + 4);
      } else {
        const res = await runWorktreeGit({
          cwd: record.worktreePath,
          args: [
            'diff',
            '--no-ext-diff',
            '--no-color',
            '--src-prefix=a/',
            '--dst-prefix=b/',
            record.baseCommit,
            '--',
            item.path,
          ],
          baseEnv: this.hostEnv,
          maxStdoutBytes: budget + 4,
        });
        rawPatch = res.stdout;
        streamTruncated = res.stdoutTruncated;
      }

      const sliced = truncateUtf8Safe(rawPatch, budget);
      const truncated = streamTruncated || sliced.truncated;
      if (truncated) anyTruncated = true;
      totalBytes += sliced.byteLength;
      files.push({
        ...item,
        patch: sliced.text,
        truncated,
      });
    }

    return {
      id: record.id,
      branch: record.branch,
      baseCommit: record.baseCommit,
      headCommit,
      additions,
      deletions,
      truncated: anyTruncated,
      files,
    };
  }

  /**
   * 生成将受管工作树合并回主工作区的审阅预览与防状态漂移 `previewToken`。
   */
  async previewMerge(id: string): Promise<WorktreeMergePreview> {
    const record = this.requireExistingVerifiedRecord(id);
    const snapshot = await this.collectMergeStateSnapshot(record);

    let additions = 0;
    let deletions = 0;
    for (const f of snapshot.changedFiles) {
      additions += f.additions;
      deletions += f.deletions;
    }

    return {
      id: record.id,
      branch: record.branch,
      targetBranch: snapshot.targetBranch,
      baseCommit: record.baseCommit,
      worktreeHead: snapshot.worktreeHead,
      mainHead: snapshot.mainHead,
      aheadCount: snapshot.aheadCount,
      behindCount: snapshot.behindCount,
      worktreeDirty: snapshot.worktreeDirty,
      mainDirty: snapshot.mainDirty,
      canApply: snapshot.blockingReason === undefined,
      blockingReason: snapshot.blockingReason,
      additions,
      deletions,
      changedFiles: snapshot.changedFiles,
      previewToken: snapshot.previewToken,
    };
  }

  /**
   * 执行冲突隔离式本地合并：
   * 1. 核验 `previewToken` 未漂移且主工作区检出在目标分支、受影响路径无脏改动；
   * 2. 若工作树含未提交修改，先在工作树分支内打包提交；
   * 3. **在工作树内部**执行 `git merge --no-edit refs/heads/<targetBranch>`，有冲突则仅留在工作树内并返回 `conflict`；
   * 4. 预合并无冲突后，对主工作区执行原子 `git merge --ff-only <newWorktreeHead>`。
   */
  async applyMerge(options: ApplyWorktreeMergeOptions): Promise<ApplyWorktreeMergeResult> {
    const record = this.requireExistingVerifiedRecord(options.id);

    // 按规范化路径字典序逐个加锁双目录，严格预防跨目录加锁死锁，且第 2 把门闩获取失败时由 finally 无条件释放第 1 把门闩。
    const orderedRoots = isSamePath(record.projectRoot, record.worktreePath)
      ? [record.worktreePath]
      : [record.projectRoot, record.worktreePath].sort((a, b) => a.localeCompare(b));
    const fences: ExecutionRemovalFence[] = [];

    try {
      for (const root of orderedRoots) {
        fences.push(this.coordinator.acquireRemovalFence(root, 'merge'));
      }

      const snapshot = await this.collectMergeStateSnapshot(record);
      if (snapshot.previewToken !== options.previewToken) {
        throw new WorktreeError(
          'WORKTREE_MERGE_STALE_PREVIEW',
          'Preview token mismatch: worktree or main repository state changed since preview',
        );
      }
      if (snapshot.worktreeUnmerged) {
        throw new WorktreeError(
          'WORKTREE_REPO_UNMERGED',
          'Worktree has unresolved merge conflicts or raw conflict markers; resolve them before merging',
        );
      }
      if (snapshot.mainUnmerged) {
        throw new WorktreeError(
          'WORKTREE_REPO_UNMERGED',
          'Main repository has unfinished merge/rebase state or unmerged index entries',
        );
      }
      if (snapshot.currentMainBranch !== snapshot.targetBranch) {
        throw new WorktreeError(
          'WORKTREE_MAIN_BRANCH_MISMATCH',
          `Main repository is on '${snapshot.currentMainBranch ?? 'HEAD'}', expected '${snapshot.targetBranch}'`,
        );
      }
      if (snapshot.overlappingMainDirtyPaths.length > 0) {
        throw new WorktreeError(
          'WORKTREE_MAIN_DIRTY',
          `Main repository has uncommitted changes on affected files: ${snapshot.overlappingMainDirtyPaths.join(', ')}`,
        );
      }

      const identityArgs = await this.resolveCommitIdentityArgs(record.worktreePath);

      // 若工作树仍有未提交变更，先在工作树分支中固化为一次提交。
      if (snapshot.worktreeDirty) {
        await runWorktreeGit({
          cwd: record.worktreePath,
          args: ['add', '-A'],
          baseEnv: this.hostEnv,
        });
        const message = options.commitMessage?.trim() || DEFAULT_WORKTREE_COMMIT_MESSAGE;
        await runWorktreeGit({
          cwd: record.worktreePath,
          args: [...identityArgs, 'commit', '-m', message],
          baseEnv: this.hostEnv,
        });
      }

      // 第一阶段：在工作树内预合并主分支，把潜在冲突完全隔离在工作树内部。
      const mergeRes = await runWorktreeGit({
        cwd: record.worktreePath,
        args: [...identityArgs, 'merge', '--no-edit', `refs/heads/${snapshot.targetBranch}`],
        baseEnv: this.hostEnv,
        allowedExitCodes: [0, 1, 2],
      });

      if (mergeRes.exitCode !== 0) {
        const conflictedFiles = await this.readConflictedFiles(record.worktreePath);
        if (conflictedFiles.length > 0) {
          return { status: 'conflict', conflictedFiles };
        }
        throw new WorktreeError(
          'WORKTREE_GIT_FAILED',
          `Pre-merge inside worktree failed: ${mergeRes.stderr || `exit ${mergeRes.exitCode}`}`,
        );
      }

      const newWorktreeHead = await this.readHeadCommit(record.worktreePath);
      if (newWorktreeHead !== snapshot.mainHead) {
        // 第二阶段：对主工作区执行零冲突原子快进合并。
        await runWorktreeGit({
          cwd: record.projectRoot,
          args: ['merge', '--ff-only', newWorktreeHead],
          baseEnv: this.hostEnv,
        });
      }

      await this.registry.upsert({ ...record, updatedAt: this.now() });
      return {
        status: 'merged',
        mergedCommit: newWorktreeHead,
        targetBranch: snapshot.targetBranch,
      };
    } finally {
      for (let i = fences.length - 1; i >= 0; i--) {
        fences[i]!.release();
      }
    }
  }

  /**
   * 移除受管 Git Worktree（含三路脏状态保护与 Windows NTFS Junction 安全摘除协议）。
   */
  async remove(options: RemoveWorktreeOptions): Promise<RemoveWorktreeResult> {
    const record = this.requireRecord(options.id);
    const fence = this.coordinator.acquireRemovalFence(record.worktreePath, 'remove');

    try {
      if (fs.existsSync(record.worktreePath)) {
        // 硬护栏：绝不允许对 `~/.kapibala/worktrees` 之外的任何路径执行递归删除。
        const canonicalRoot = toNativePhysicalPath(this.worktreesRoot);
        const canonicalTarget = toNativePhysicalPath(record.worktreePath);
        if (
          isSamePath(canonicalRoot, canonicalTarget) ||
          !isPathInside(canonicalRoot, canonicalTarget)
        ) {
          throw new WorktreeError(
            'WORKTREE_LINK_INVALID',
            `Refusing to remove path outside managed worktrees root: '${canonicalTarget}'`,
          );
        }

        if (options.force !== true) {
          const preflight = await this.runThreeWayRemovalCheck(record);
          if (preflight !== undefined) {
            return preflight;
          }
        }

        await options.onBeforeRemove?.(record);

        // Windows Junction 安全删除协议：备份 `.git` 指针 -> Node `fs.rmSync` 摘除目录及软链本身 -> 异常恢复 `.git`。
        const dotGitFile = path.join(record.worktreePath, '.git');
        let savedDotGitBytes: Buffer | undefined;
        try {
          if (fs.existsSync(dotGitFile) && fs.lstatSync(dotGitFile).isFile()) {
            savedDotGitBytes = fs.readFileSync(dotGitFile);
          }
        } catch {
          savedDotGitBytes = undefined;
        }

        try {
          fs.rmSync(record.worktreePath, {
            recursive: true,
            force: true,
            maxRetries: 2,
            retryDelay: 30,
          });
        } catch (err) {
          if (
            savedDotGitBytes &&
            fs.existsSync(record.worktreePath) &&
            !fs.existsSync(dotGitFile)
          ) {
            try {
              fs.writeFileSync(dotGitFile, savedDotGitBytes);
            } catch {
              /* 尽力写回 `.git` 指针文件，不掩盖原始占用错误。 */
            }
          }
          throw new WorktreeError(
            'WORKTREE_BUSY',
            `Failed to remove worktree directory '${record.worktreePath}': ${(err as Error).message}`,
          );
        }

        const bucketDir = path.dirname(record.worktreePath);
        if (!isSamePath(bucketDir, canonicalRoot) && isPathInside(canonicalRoot, bucketDir)) {
          try {
            fs.rmdirSync(bucketDir);
          } catch {
            /* 桶目录非空时忽略。 */
          }
        }
      } else {
        await options.onBeforeRemove?.(record);
      }

      if (fs.existsSync(record.projectRoot)) {
        await runWorktreeGit({
          cwd: record.projectRoot,
          args: ['worktree', 'prune'],
          baseEnv: this.hostEnv,
          allowedExitCodes: [0, 128],
        });

        await this.deleteManagedBranch({
          projectRoot: record.projectRoot,
          branch: record.branch,
          force: options.force === true,
        });
      }

      await this.registry.delete(record.id);
      return { removed: true, id: record.id };
    } finally {
      fence.release();
    }
  }

  /**
   * 清理由外部手动删掉目录后残留在 `registry.json` 与 Git `worktrees/` 管理区的孤儿条目。
   */
  async prune(projectRoot?: string): Promise<{ readonly prunedIds: string[] }> {
    const records = this.registry.list(projectRoot);
    const prunedIds: string[] = [];
    const touchedProjects = new Set<string>();

    for (const rec of records) {
      if (fs.existsSync(rec.worktreePath)) continue;
      if (this.coordinator.hasActiveRuns(rec.worktreePath)) continue;
      await this.registry.delete(rec.id);
      prunedIds.push(rec.id);
      if (fs.existsSync(rec.projectRoot)) {
        touchedProjects.add(rec.projectRoot);
      }
      const bucketDir = path.dirname(rec.worktreePath);
      try {
        if (fs.existsSync(bucketDir)) fs.rmdirSync(bucketDir);
      } catch {
        /* 忽略非空或已删除目录。 */
      }
    }

    if (projectRoot && fs.existsSync(projectRoot)) {
      touchedProjects.add(toNativePhysicalPath(path.resolve(projectRoot)));
    }
    for (const proj of touchedProjects) {
      await runWorktreeGit({
        cwd: proj,
        args: ['worktree', 'prune'],
        baseEnv: this.hostEnv,
        allowedExitCodes: [0, 128],
      });
    }

    return { prunedIds };
  }

  /**
   * 为即将派发的子代理按任务描述登记一次性自定义分支名提示（供 `/delegate --worktree --branch <name>` 透传）。
   * 返回清理函数，调用方在派发异常中止时幂等撤回未消费的提示。
   */
  registerSubagentBranchHint(description: string, branch: string): () => void {
    const key = description.trim();
    const trimmedBranch = branch.trim();
    if (!key || !trimmedBranch) return () => {};
    const queue = this.subagentBranchHints.get(key) ?? [];
    queue.push(trimmedBranch);
    this.subagentBranchHints.set(key, queue);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      const current = this.subagentBranchHints.get(key);
      if (!current) return;
      const idx = current.indexOf(trimmedBranch);
      if (idx >= 0) current.splice(idx, 1);
      if (current.length === 0) this.subagentBranchHints.delete(key);
    };
  }

  private consumeSubagentBranchHint(description: string): string | undefined {
    const key = description.trim();
    const queue = this.subagentBranchHints.get(key);
    if (!queue || queue.length === 0) return undefined;
    const next = queue.shift();
    if (queue.length === 0) this.subagentBranchHints.delete(key);
    return next;
  }

  /**
   * 导出适配 Core `AgentRuntime`（`spawn_agent(isolation: 'worktree')`）的子代理生命周期提供者。
   *
   * 回收语义：
   * - `detached` 委派子会话正常完成或中断时持久保留工作树供后续续聊与审阅；若因派发配额拒绝、早期取消或运行失败（`failed` / `cancelled`）
   *   且工作树仍停留在 `baseCommit`、零脏改动、零敏感 `.env*` 变更，则自动回收空工作树避免孤儿残留；
   * - `ephemeral` 子代理终结时执行非强制 `remove({ force: false })`：若零提交、零未提交文件且无敏感 `.env*` 改动则自动回收，
   *   产生任何代码变更或提交时自动保留工作树防丢成果。
   */
  asSubagentWorktreeProvider(): SubagentWorktreeProvider {
    return {
      allocate: async (input: {
        readonly agentId: string;
        readonly projectRoot: string;
        readonly relativeCwd: string;
        readonly description: string;
        readonly mode: 'ephemeral' | 'detached';
      }): Promise<AllocatedSubagentWorktree> => {
        const hintBranch = this.consumeSubagentBranchHint(input.description);
        const created = await this.create({
          projectRoot: input.projectRoot,
          name: input.description || input.agentId,
          ...(hintBranch ? { branch: hintBranch } : {}),
          relativeCwd: input.relativeCwd,
        });
        return {
          binding: created.binding,
          workspaceRoot: created.binding.worktreePath,
          cwd: created.executionCwd,
        };
      },
      release: async (input: {
        readonly binding: SessionWorktreeBinding;
        readonly mode: 'ephemeral' | 'detached';
        readonly status: AgentTaskStatus;
      }): Promise<void> => {
        if (
          input.mode === 'detached' &&
          input.status !== 'failed' &&
          input.status !== 'cancelled'
        ) {
          return;
        }
        try {
          if (input.mode === 'detached' && fs.existsSync(input.binding.worktreePath)) {
            const headCommit = await this.readHeadCommit(input.binding.worktreePath);
            if (headCommit !== input.binding.baseCommit) {
              return;
            }
          }
          await this.remove({ id: input.binding.id, force: false });
        } catch {
          /* 自动回收遇到占用或异常时保守保留登记，绝不冲掉子任务终态结算。 */
        }
      },
    };
  }

  private requireRecord(id: string): WorktreeRecord {
    const rec = this.registry.get(id);
    if (!rec) {
      throw new WorktreeError('WORKTREE_NOT_FOUND', `Managed worktree '${id}' not found`);
    }
    return rec;
  }

  private requireExistingVerifiedRecord(id: string): WorktreeRecord {
    const rec = this.requireRecord(id);
    if (!fs.existsSync(rec.worktreePath)) {
      throw new WorktreeError(
        'WORKTREE_NOT_FOUND',
        `Managed worktree directory missing on disk: '${rec.worktreePath}'`,
      );
    }
    if (!this.verifyLink(rec.projectRoot, rec.worktreePath)) {
      throw new WorktreeError(
        'WORKTREE_LINK_INVALID',
        `Managed worktree '${id}' failed 4-step bidirectional .git link verification`,
      );
    }
    return rec;
  }

  private ensureWorktreesRootPrepared(): void {
    fs.mkdirSync(this.worktreesRoot, { recursive: true, mode: 0o700 });
    if (process.platform === 'darwin') {
      const spotlightMarker = path.join(this.worktreesRoot, '.metadata_never_index');
      if (!fs.existsSync(spotlightMarker)) {
        try {
          fs.writeFileSync(spotlightMarker, '', { mode: 0o600 });
        } catch {
          /* Spotlight 标记写入失败不阻断功能。 */
        }
      }
    }
  }

  private allocateShortBucketDir(): { readonly bucket: string; readonly bucketDir: string } {
    for (let attempt = 0; attempt < WORKTREE_BUCKET_MAX_RETRIES; attempt++) {
      const bucket = randomBytes(2).toString('hex').toLowerCase();
      if (this.registry.get(bucket)) continue;
      const bucketDir = path.join(this.worktreesRoot, bucket);
      try {
        fs.mkdirSync(bucketDir, { mode: 0o700 });
        return { bucket, bucketDir };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
          continue;
        }
        throw err;
      }
    }
    throw new WorktreeError(
      'WORKTREE_CAPACITY_EXCEEDED',
      `Failed to allocate unique 4-hex worktree bucket after ${WORKTREE_BUCKET_MAX_RETRIES} attempts`,
    );
  }

  private resolveExecutionCwdInsideWorktree(
    canonicalWorktreePath: string,
    relativeCwd?: string,
  ): string {
    if (!relativeCwd || relativeCwd === '.' || relativeCwd === '') {
      return canonicalWorktreePath;
    }
    if (path.isAbsolute(relativeCwd)) {
      throw new WorktreeError(
        'WORKTREE_ESCAPE',
        `relativeCwd must be relative, received: '${relativeCwd}'`,
      );
    }
    const target = path.resolve(canonicalWorktreePath, relativeCwd);
    const canonicalTarget = toNativePhysicalPath(target);
    if (!isPathInside(canonicalWorktreePath, canonicalTarget)) {
      throw new WorktreeError(
        'WORKTREE_ESCAPE',
        `relativeCwd '${relativeCwd}' escapes worktree root`,
      );
    }
    if (!fs.existsSync(canonicalTarget)) {
      fs.mkdirSync(canonicalTarget, { recursive: true });
    }
    return toNativePhysicalPath(canonicalTarget);
  }

  private async inspectMainRepo(
    projectRoot: string,
  ): Promise<{ readonly topLevel: string; readonly gitDir: string }> {
    const res = await runWorktreeGit({
      cwd: projectRoot,
      args: ['rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir'],
      baseEnv: this.hostEnv,
      allowedExitCodes: [0, 128],
    });
    if (res.exitCode !== 0) {
      throw new WorktreeError('WORKTREE_NOT_GIT_REPO', `'${projectRoot}' is not a Git repository`);
    }
    const lines = res.stdout
      .toString('utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length < 3) {
      throw new WorktreeError('WORKTREE_NOT_GIT_REPO', `'${projectRoot}' is not a Git repository`);
    }
    const commonGitDir = toNativePhysicalPath(path.resolve(projectRoot, lines[1]!));
    const gitDir = toNativePhysicalPath(path.resolve(projectRoot, lines[2]!));
    // 若传入的是某个子 worktree 而非主仓，回溯 commonGitDir 父目录定位主项目根。
    const mainTopLevel = isSamePath(commonGitDir, gitDir)
      ? toNativePhysicalPath(path.resolve(projectRoot, lines[0]!))
      : toNativePhysicalPath(path.dirname(commonGitDir));
    return { topLevel: mainTopLevel, gitDir };
  }

  private async assertRepoCleanMergeState(projectRoot: string, gitDir: string): Promise<void> {
    const conflictMarkers = [
      'MERGE_HEAD',
      'rebase-merge',
      'rebase-apply',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
    ];
    for (const marker of conflictMarkers) {
      if (fs.existsSync(path.join(gitDir, marker))) {
        throw new WorktreeError(
          'WORKTREE_REPO_UNMERGED',
          `Repository has active ${marker}; resolve it before creating a worktree`,
        );
      }
    }
    const unmergedRes = await runWorktreeGit({
      cwd: projectRoot,
      args: ['ls-files', '--unmerged'],
      baseEnv: this.hostEnv,
    });
    if (unmergedRes.stdout.length > 0) {
      throw new WorktreeError(
        'WORKTREE_REPO_UNMERGED',
        'Repository index has unmerged entries; resolve conflicts before creating a worktree',
      );
    }
  }

  private async detectRepoUnmergedState(
    repoPath: string,
    porcelainEntries: ReadonlyArray<{ readonly xy: string; readonly path: string }>,
    options?: { readonly scanConflictMarkers?: boolean },
  ): Promise<boolean> {
    if (porcelainEntries.some((entry) => UNMERGED_PORCELAIN_CODES.has(entry.xy))) {
      return true;
    }
    const markerNames = [
      'MERGE_HEAD',
      'rebase-merge',
      'rebase-apply',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
    ];
    const gitPathArgs = ['rev-parse'];
    for (const marker of markerNames) {
      gitPathArgs.push('--git-path', marker);
    }
    const [gitPathRes, lsUnmergedRes] = await Promise.all([
      runWorktreeGit({
        cwd: repoPath,
        args: gitPathArgs,
        baseEnv: this.hostEnv,
      }),
      runWorktreeGit({
        cwd: repoPath,
        args: ['ls-files', '--unmerged'],
        baseEnv: this.hostEnv,
      }),
    ]);
    if (lsUnmergedRes.stdout.length > 0) {
      return true;
    }
    const resolvedLines = gitPathRes.stdout
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    for (const relOrAbs of resolvedLines) {
      if (fs.existsSync(path.resolve(repoPath, relOrAbs))) {
        return true;
      }
    }
    if (options?.scanConflictMarkers && hasRawGitConflictMarkers(repoPath, porcelainEntries)) {
      return true;
    }
    return false;
  }

  private async resolveLocalBaseCommit(
    projectRoot: string,
    requestedBaseRef?: string,
  ): Promise<{ readonly effectiveBaseRef: string; readonly baseCommit: string }> {
    let effectiveBaseRef = requestedBaseRef?.trim();
    if (effectiveBaseRef?.startsWith('-')) {
      throw new WorktreeError('WORKTREE_INVALID_BASE_REF', `Invalid baseRef '${effectiveBaseRef}'`);
    }

    if (!effectiveBaseRef || effectiveBaseRef === 'HEAD') {
      const branchName = await this.readCurrentBranch(projectRoot);
      effectiveBaseRef = branchName ?? 'HEAD';
    }

    const revRes = await runWorktreeGit({
      cwd: projectRoot,
      args: [
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `${effectiveBaseRef}^{commit}`,
      ],
      baseEnv: this.hostEnv,
      allowedExitCodes: [0, 1, 128],
    });
    const baseCommit = revRes.stdout.toString('utf8').trim();
    if (revRes.exitCode !== 0 || !/^[0-9a-f]{40}$/i.test(baseCommit)) {
      throw new WorktreeError(
        'WORKTREE_INVALID_BASE_REF',
        `Cannot resolve local commit for baseRef '${effectiveBaseRef}'`,
      );
    }
    return { effectiveBaseRef, baseCommit };
  }

  private async resolveTargetBranchName(options: {
    readonly projectRoot: string;
    readonly bucket: string;
    readonly name?: string;
    readonly explicitBranch?: string;
  }): Promise<string> {
    const kpblSingleBranchExists = await this.localBranchExists(options.projectRoot, 'kpbl');

    let candidate: string;
    if (options.explicitBranch?.trim()) {
      const raw = options.explicitBranch.trim();
      if (raw.startsWith('-')) {
        throw new WorktreeError('WORKTREE_INVALID_BRANCH', `Invalid branch name '${raw}'`);
      }
      candidate =
        kpblSingleBranchExists && raw.startsWith('kpbl/')
          ? `kpbl-${raw.slice('kpbl/'.length)}`
          : raw;
    } else {
      const slug = sanitizeWorktreeSlug(options.name, 'task');
      candidate = kpblSingleBranchExists
        ? `kpbl-${slug}-${options.bucket}`
        : `kpbl/${slug}-${options.bucket}`;
    }

    const checkRes = await runWorktreeGit({
      cwd: options.projectRoot,
      args: ['check-ref-format', '--branch', candidate],
      baseEnv: this.hostEnv,
      allowedExitCodes: [0, 1, 128],
    });
    if (checkRes.exitCode !== 0) {
      throw new WorktreeError('WORKTREE_INVALID_BRANCH', `Invalid Git branch name '${candidate}'`);
    }

    if (await this.localBranchExists(options.projectRoot, candidate)) {
      throw new WorktreeError(
        'WORKTREE_BRANCH_EXISTS',
        `Local branch '${candidate}' already exists`,
      );
    }

    return candidate;
  }

  private async localBranchExists(projectRoot: string, branchName: string): Promise<boolean> {
    const res = await runWorktreeGit({
      cwd: projectRoot,
      args: ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`],
      baseEnv: this.hostEnv,
      allowedExitCodes: [0, 1, 128],
    });
    return res.exitCode === 0;
  }

  private async readCurrentBranch(repoPath: string): Promise<string | undefined> {
    const res = await runWorktreeGit({
      cwd: repoPath,
      args: ['symbolic-ref', '--quiet', '--short', 'HEAD'],
      baseEnv: this.hostEnv,
      allowedExitCodes: [0, 1, 128],
    });
    if (res.exitCode !== 0) return undefined;
    const branch = res.stdout.toString('utf8').trim();
    return branch || undefined;
  }

  private async readHeadCommit(repoPath: string): Promise<string> {
    const res = await runWorktreeGit({
      cwd: repoPath,
      args: ['rev-parse', 'HEAD'],
      baseEnv: this.hostEnv,
    });
    return res.stdout.toString('utf8').trim();
  }

  private async readPorcelainEntries(
    repoPath: string,
    untrackedMode: 'normal' | 'all' = 'normal',
  ): Promise<Array<{ readonly xy: string; readonly path: string; readonly origPath?: string }>> {
    const args =
      untrackedMode === 'all'
        ? ['status', '--porcelain=v1', '--untracked-files=all', '-z']
        : ['-c', 'status.showUntrackedFiles=normal', 'status', '--porcelain=v1', '-z'];
    const res = await runWorktreeGit({
      cwd: repoPath,
      args,
      baseEnv: this.hostEnv,
    });
    const tokens = splitNulStrings(res.stdout);
    const entries: Array<{ xy: string; path: string; origPath?: string }> = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.length < 4) continue;
      const xy = token.slice(0, 2);
      const entryPath = token.slice(3);
      if (xy.includes('R') || xy.includes('C')) {
        const origPath = tokens[++i];
        entries.push({ xy, path: entryPath, origPath });
      } else {
        entries.push({ xy, path: entryPath });
      }
    }
    return entries;
  }

  private async computeAheadBehind(
    record: WorktreeRecord,
  ): Promise<{ readonly aheadCount: number; readonly behindCount: number }> {
    const hasBaseBranch =
      record.baseRef !== 'HEAD' &&
      (await this.localBranchExists(record.projectRoot, record.baseRef));
    const compareLeft = hasBaseBranch ? `refs/heads/${record.baseRef}` : record.baseCommit;
    const res = await runWorktreeGit({
      cwd: record.worktreePath,
      args: ['rev-list', '--left-right', '--count', `${compareLeft}...HEAD`],
      baseEnv: this.hostEnv,
    });
    const parts = res.stdout.toString('utf8').trim().split(/\s+/);
    const behindCount = Number.parseInt(parts[0] ?? '0', 10) || 0;
    const aheadCount = Number.parseInt(parts[1] ?? '0', 10) || 0;
    return { aheadCount, behindCount };
  }

  private async computeWorktreeChangedFiles(
    worktreePath: string,
    compareCommit: string,
  ): Promise<WorktreeChangedFile[]> {
    const [statusRes, numstatRes, untrackedList] = await Promise.all([
      runWorktreeGit({
        cwd: worktreePath,
        args: ['diff', '--name-status', '-z', compareCommit],
        baseEnv: this.hostEnv,
      }),
      runWorktreeGit({
        cwd: worktreePath,
        args: ['diff', '--numstat', '-z', compareCommit],
        baseEnv: this.hostEnv,
      }),
      this.readUntrackedNonIgnoredFiles(worktreePath),
    ]);

    const statusTokens = splitNulStrings(statusRes.stdout);
    const statusByPath = new Map<
      string,
      { status: WorktreeChangedFile['status']; oldPath?: string }
    >();
    for (let i = 0; i < statusTokens.length; i++) {
      const code = statusTokens[i]!;
      if (code.startsWith('R') || code.startsWith('C')) {
        const oldPath = statusTokens[++i] ?? '';
        const newPath = statusTokens[++i] ?? '';
        if (newPath) {
          statusByPath.set(newPath, {
            status: code.startsWith('R') ? 'renamed' : 'added',
            oldPath: oldPath || undefined,
          });
        }
      } else {
        const filePath = statusTokens[++i] ?? '';
        if (!filePath) continue;
        const status: WorktreeChangedFile['status'] = code.startsWith('A')
          ? 'added'
          : code.startsWith('D')
            ? 'deleted'
            : 'modified';
        statusByPath.set(filePath, { status });
      }
    }

    const numTokens = splitNulStrings(numstatRes.stdout);
    const statByPath = new Map<string, { additions: number; deletions: number; binary: boolean }>();
    for (let i = 0; i < numTokens.length; i++) {
      const token = numTokens[i]!;
      const tab1 = token.indexOf('\t');
      const tab2 = tab1 >= 0 ? token.indexOf('\t', tab1 + 1) : -1;
      if (tab1 < 0 || tab2 < 0) continue;
      const rawAdd = token.slice(0, tab1);
      const rawDel = token.slice(tab1 + 1, tab2);
      let filePath = token.slice(tab2 + 1);
      // 重命名项在 `diff --numstat -z` 中使 `filePath` 为空，紧随两个 NUL 项分别为 oldPath 与 newPath。
      if (filePath === '') {
        const _oldPath = numTokens[++i];
        void _oldPath;
        filePath = numTokens[++i] ?? '';
      }
      if (!filePath) continue;
      const binary = rawAdd === '-' || rawDel === '-';
      statByPath.set(filePath, {
        additions: binary ? 0 : Number.parseInt(rawAdd, 10) || 0,
        deletions: binary ? 0 : Number.parseInt(rawDel, 10) || 0,
        binary,
      });
    }

    for (const untrackedPath of untrackedList) {
      if (statusByPath.has(untrackedPath)) continue;
      statusByPath.set(untrackedPath, { status: 'added' });
      statByPath.set(untrackedPath, inspectUntrackedFileStats(worktreePath, untrackedPath));
    }

    const files: WorktreeChangedFile[] = [];
    for (const filePath of [...statusByPath.keys()].sort()) {
      const st = statusByPath.get(filePath)!;
      const num = statByPath.get(filePath) ?? { additions: 0, deletions: 0, binary: false };
      files.push({
        path: filePath,
        status: st.status,
        oldPath: st.oldPath,
        additions: num.additions,
        deletions: num.deletions,
        binary: num.binary,
      });
    }
    return files;
  }

  private async readUntrackedNonIgnoredFiles(worktreePath: string): Promise<string[]> {
    const res = await runWorktreeGit({
      cwd: worktreePath,
      args: ['ls-files', '--others', '--exclude-standard', '-z'],
      baseEnv: this.hostEnv,
    });
    return splitNulStrings(res.stdout).filter((p) => p.length > 0 && !p.endsWith('/'));
  }

  private async collectMergeStateSnapshot(record: WorktreeRecord): Promise<{
    readonly targetBranch: string;
    readonly currentMainBranch?: string;
    readonly worktreeHead: string;
    readonly mainHead: string;
    readonly aheadCount: number;
    readonly behindCount: number;
    readonly worktreeDirty: boolean;
    readonly mainDirty: boolean;
    readonly worktreeUnmerged: boolean;
    readonly mainUnmerged: boolean;
    readonly changedFiles: WorktreeChangedFile[];
    readonly overlappingMainDirtyPaths: string[];
    readonly blockingReason?: string;
    readonly previewToken: string;
  }> {
    const currentMainBranch = await this.readCurrentBranch(record.projectRoot);
    let targetBranch: string | undefined;
    if (
      record.baseRef !== 'HEAD' &&
      (await this.localBranchExists(record.projectRoot, record.baseRef))
    ) {
      targetBranch = record.baseRef;
    } else if (currentMainBranch) {
      targetBranch = currentMainBranch;
    }

    if (!targetBranch) {
      throw new WorktreeError(
        'WORKTREE_DETACHED_MAIN',
        'Main repository is in detached HEAD state and worktree has no local target branch',
      );
    }

    const [worktreeHead, mainHead, wtPorcelainRes, mainPorcelainRes, revListRes] =
      await Promise.all([
        this.readHeadCommit(record.worktreePath),
        this.readHeadCommit(record.projectRoot),
        runWorktreeGit({
          cwd: record.worktreePath,
          args: ['status', '--porcelain=v1', '--untracked-files=all', '-z'],
          baseEnv: this.hostEnv,
        }),
        runWorktreeGit({
          cwd: record.projectRoot,
          args: ['status', '--porcelain=v1', '--untracked-files=all', '-z'],
          baseEnv: this.hostEnv,
        }),
        runWorktreeGit({
          cwd: record.worktreePath,
          args: ['rev-list', '--left-right', '--count', `refs/heads/${targetBranch}...HEAD`],
          baseEnv: this.hostEnv,
        }),
      ]);

    const revParts = revListRes.stdout.toString('utf8').trim().split(/\s+/);
    const behindCount = Number.parseInt(revParts[0] ?? '0', 10) || 0;
    const aheadCount = Number.parseInt(revParts[1] ?? '0', 10) || 0;

    const mergeBaseRes = await runWorktreeGit({
      cwd: record.worktreePath,
      args: ['merge-base', `refs/heads/${targetBranch}`, 'HEAD'],
      baseEnv: this.hostEnv,
      allowedExitCodes: [0, 1],
    });
    const compareBase =
      mergeBaseRes.exitCode === 0
        ? mergeBaseRes.stdout.toString('utf8').trim() || record.baseCommit
        : record.baseCommit;

    const changedFiles = await this.computeWorktreeChangedFiles(record.worktreePath, compareBase);

    const wtEntries = await this.readPorcelainEntries(record.worktreePath, 'all');
    const mainEntries = await this.readPorcelainEntries(record.projectRoot, 'all');
    const [worktreeUnmerged, mainUnmerged] = await Promise.all([
      this.detectRepoUnmergedState(record.worktreePath, wtEntries, { scanConflictMarkers: true }),
      this.detectRepoUnmergedState(record.projectRoot, mainEntries),
    ]);

    const overlappingMainDirtyPaths = findOverlappingMainDirtyPaths(changedFiles, mainEntries);

    const worktreePorcelain = wtPorcelainRes.stdout.toString('utf8');
    const mainPorcelain = mainPorcelainRes.stdout.toString('utf8');
    const worktreeDirty = worktreePorcelain.length > 0;
    const mainDirty = mainPorcelain.length > 0;
    const wtDirtyDigest = computePorcelainContentDigest(record.worktreePath, wtEntries);
    const mainDirtyDigest = computePorcelainContentDigest(record.projectRoot, mainEntries);

    const previewToken = createHash('sha256')
      .update(
        `${worktreeHead}\0${mainHead}\0${targetBranch}\0${worktreeUnmerged ? 1 : 0}\0${mainUnmerged ? 1 : 0}\0${worktreePorcelain}\0${wtDirtyDigest}\0${mainPorcelain}\0${mainDirtyDigest}`,
      )
      .digest('hex');

    let blockingReason: string | undefined;
    if (worktreeUnmerged) {
      blockingReason = '工作树内存在未解决的合并冲突，请先解决冲突并移除冲突标记后再合并';
    } else if (mainUnmerged) {
      blockingReason = '主工作区存在未完成的合并、变基或冲突条目，请先处理后再合并';
    } else if (currentMainBranch !== targetBranch) {
      blockingReason = `主工作区当前分支为 ${currentMainBranch ?? 'HEAD'}，需先切回 ${targetBranch}`;
    } else if (overlappingMainDirtyPaths.length > 0) {
      blockingReason = `主工作区存在冲突的未提交改动：${overlappingMainDirtyPaths.join(', ')}`;
    }

    return {
      targetBranch,
      currentMainBranch,
      worktreeHead,
      mainHead,
      aheadCount,
      behindCount,
      worktreeDirty,
      mainDirty,
      worktreeUnmerged,
      mainUnmerged,
      changedFiles,
      overlappingMainDirtyPaths,
      blockingReason,
      previewToken,
    };
  }

  private async resolveCommitIdentityArgs(repoPath: string): Promise<string[]> {
    const [nameRes, emailRes] = await Promise.all([
      runWorktreeGit({
        cwd: repoPath,
        args: ['config', '--get', 'user.name'],
        baseEnv: this.hostEnv,
        allowedExitCodes: [0, 1],
      }),
      runWorktreeGit({
        cwd: repoPath,
        args: ['config', '--get', 'user.email'],
        baseEnv: this.hostEnv,
        allowedExitCodes: [0, 1],
      }),
    ]);
    const hasName = nameRes.exitCode === 0 && nameRes.stdout.toString('utf8').trim().length > 0;
    const hasEmail = emailRes.exitCode === 0 && emailRes.stdout.toString('utf8').trim().length > 0;
    if (hasName && hasEmail) return [];
    return [
      ...(hasName ? [] : ['-c', 'user.name=Kapibala']),
      ...(hasEmail ? [] : ['-c', 'user.email=kapibala@local']),
    ];
  }

  private async readConflictedFiles(worktreePath: string): Promise<string[]> {
    const diffRes = await runWorktreeGit({
      cwd: worktreePath,
      args: ['diff', '--name-only', '--diff-filter=U', '-z'],
      baseEnv: this.hostEnv,
    });
    const fromDiff = splitNulStrings(diffRes.stdout);
    if (fromDiff.length > 0) return Array.from(new Set(fromDiff)).sort();

    const lsRes = await runWorktreeGit({
      cwd: worktreePath,
      args: ['ls-files', '--unmerged', '-z'],
      baseEnv: this.hostEnv,
    });
    const paths = new Set<string>();
    for (const entry of splitNulStrings(lsRes.stdout)) {
      const tab = entry.indexOf('\t');
      if (tab >= 0) paths.add(entry.slice(tab + 1));
    }
    return [...paths].sort();
  }

  private async runThreeWayRemovalCheck(
    record: WorktreeRecord,
  ): Promise<Extract<RemoveWorktreeResult, { removed: false }> | undefined> {
    // 1. 未提交修改或新增未跟踪文件检查。
    const porcelain = await this.readPorcelainEntries(record.worktreePath);
    if (porcelain.length > 0) {
      return {
        removed: false,
        reason: 'dirty',
        details: porcelain.map((e) => e.path),
      };
    }

    // 2. 尚未合入基线分支的独立提交检查。
    const hasBaseBranch =
      record.baseRef !== 'HEAD' &&
      fs.existsSync(record.projectRoot) &&
      (await this.localBranchExists(record.projectRoot, record.baseRef));
    const compareTarget = hasBaseBranch ? `refs/heads/${record.baseRef}` : record.baseCommit;
    const unmergedRes = await runWorktreeGit({
      cwd: record.worktreePath,
      args: ['rev-list', '--count', `${compareTarget}..HEAD`],
      baseEnv: this.hostEnv,
      allowedExitCodes: [0, 128],
    });
    const unmergedCount =
      unmergedRes.exitCode === 0
        ? Number.parseInt(unmergedRes.stdout.toString('utf8').trim(), 10) || 0
        : 0;
    if (unmergedCount > 0) {
      return {
        removed: false,
        reason: 'unmerged_commits',
        details: [`${unmergedCount} unmerged commit(s) on ${record.branch}`],
      };
    }

    // 3. 被忽略但不可再生且发生变更或仅存在于工作树中的敏感本地文件（重点检测 `.env*`）。
    const atRiskEnvFiles = findAtRiskEnvFiles(record.projectRoot, record.worktreePath);
    if (atRiskEnvFiles.length > 0) {
      return {
        removed: false,
        reason: 'at_risk_ignored_files',
        details: atRiskEnvFiles,
      };
    }

    return undefined;
  }

  private async deleteManagedBranch(options: {
    readonly projectRoot: string;
    readonly branch: string;
    readonly force: boolean;
  }): Promise<void> {
    if (!options.branch) return;
    const currentMainBranch = await this.readCurrentBranch(options.projectRoot);
    if (currentMainBranch === options.branch) {
      return;
    }

    if (options.force) {
      const tipRes = await runWorktreeGit({
        cwd: options.projectRoot,
        args: ['rev-parse', '--verify', '--quiet', `refs/heads/${options.branch}`],
        baseEnv: this.hostEnv,
        allowedExitCodes: [0, 1, 128],
      });
      const tip = tipRes.stdout.toString('utf8').trim();
      if (tipRes.exitCode === 0 && /^[0-9a-f]{40}$/i.test(tip)) {
        await runWorktreeGit({
          cwd: options.projectRoot,
          args: ['update-ref', '-d', `refs/heads/${options.branch}`, tip],
          baseEnv: this.hostEnv,
          allowedExitCodes: [0, 1, 128],
        });
      }
      return;
    }

    await runWorktreeGit({
      cwd: options.projectRoot,
      args: ['branch', '-d', options.branch],
      baseEnv: this.hostEnv,
      allowedExitCodes: [0, 1, 128],
    });
  }

  private async rollbackFailedCreation(options: {
    readonly projectRoot: string;
    readonly bucketDir: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly worktreeCreated: boolean;
    readonly bucket: string;
  }): Promise<void> {
    try {
      if (options.worktreeCreated) {
        await runWorktreeGit({
          cwd: options.projectRoot,
          args: ['worktree', 'unlock', options.worktreePath],
          baseEnv: this.hostEnv,
          allowedExitCodes: [0, 128],
        }).catch(() => {});
      }
      if (fs.existsSync(options.worktreePath)) {
        fs.rmSync(options.worktreePath, { recursive: true, force: true });
      }
      if (fs.existsSync(options.bucketDir)) {
        fs.rmSync(options.bucketDir, { recursive: true, force: true });
      }
      if (options.worktreeCreated) {
        await runWorktreeGit({
          cwd: options.projectRoot,
          args: ['worktree', 'prune'],
          baseEnv: this.hostEnv,
          allowedExitCodes: [0, 128],
        }).catch(() => {});
        if (options.branch) {
          await this.deleteManagedBranch({
            projectRoot: options.projectRoot,
            branch: options.branch,
            force: true,
          }).catch(() => {});
        }
      }
      await this.registry.delete(options.bucket).catch(() => {});
    } catch {
      /* 回滚兜底忽略次生错误，向上传递原始失败原因。 */
    }
  }
}

function inspectUntrackedFileStats(
  worktreePath: string,
  relPath: string,
): { additions: number; deletions: number; binary: boolean } {
  const full = path.join(worktreePath, relPath);
  try {
    const stat = fs.lstatSync(full);
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) {
      return { additions: 0, deletions: 0, binary: stat.isFile() && stat.size > 2 * 1024 * 1024 };
    }
    const buf = fs.readFileSync(full);
    const probeLen = Math.min(buf.length, 8192);
    for (let i = 0; i < probeLen; i++) {
      if (buf[i] === 0) return { additions: 0, deletions: 0, binary: true };
    }
    if (buf.length === 0) return { additions: 0, deletions: 0, binary: false };
    const text = buf.toString('utf8');
    const lines = text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length;
    return { additions: lines, deletions: 0, binary: false };
  } catch {
    return { additions: 0, deletions: 0, binary: false };
  }
}

function buildUntrackedUnifiedPatch(
  worktreePath: string,
  relPath: string,
  maxBytes: number,
): Buffer {
  const full = path.join(worktreePath, relPath);
  try {
    const buf = fs.readFileSync(full);
    const text = buf.subarray(0, maxBytes).toString('utf8');
    const rawLines = text.endsWith('\n') ? text.slice(0, -1).split('\n') : text.split('\n');
    const header = `diff --git a/${relPath} b/${relPath}\nnew file mode 100644\n--- /dev/null\n+++ b/${relPath}\n@@ -0,0 +1,${rawLines.length} @@\n`;
    const body = rawLines.map((line) => `+${line}`).join('\n');
    return Buffer.from(`${header}${body}\n`, 'utf8');
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * 扫描工作树内非 `node_modules` 子树下的 `.env` / `.env.*` 常规文件，识别在主仓中不存在或内容相对主仓已修改的敏感文件。
 */
function findAtRiskEnvFiles(projectRoot: string, worktreePath: string): string[] {
  const atRisk: string[] = [];
  const walk = (relDir: string, depth: number) => {
    if (depth > 5) return;
    const currentDir = relDir ? path.join(worktreePath, relDir) : worktreePath;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(currentDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        entry.name === '.git' ||
        entry.name === '.kapibala' ||
        entry.name === 'node_modules' ||
        entry.isSymbolicLink()
      ) {
        continue;
      }
      const relPosix = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPosix, depth + 1);
        continue;
      }
      if (!entry.isFile() || !/^\.env($|\.)/i.test(entry.name)) {
        continue;
      }
      const wtFile = path.join(worktreePath, relPosix);
      const mainFile = path.join(projectRoot, relPosix);
      try {
        if (!fs.existsSync(mainFile) || !fs.lstatSync(mainFile).isFile()) {
          atRisk.push(relPosix);
          continue;
        }
        const wtHash = createHash('sha256').update(fs.readFileSync(wtFile)).digest('hex');
        const mainHash = createHash('sha256').update(fs.readFileSync(mainFile)).digest('hex');
        if (wtHash !== mainHash) {
          atRisk.push(relPosix);
        }
      } catch {
        atRisk.push(relPosix);
      }
    }
  };
  walk('', 0);
  return atRisk.sort();
}

const UNMERGED_PORCELAIN_CODES = new Set(['UU', 'AA', 'DD', 'AU', 'UA', 'DU', 'UD']);

function normalizeMergeRelKey(relPath: string): string {
  const posix = relPath.replaceAll('\\', '/');
  return process.platform === 'win32' ? posix.toLowerCase() : posix;
}

/**
 * 计算主工作区未提交/未跟踪改动中与工作树待合入路径重叠的路径集合。
 *
 * 兼容边界：
 * - Windows 大小写不敏感文件系统下折叠大小写比对，拦截仅大小写不同的文件碰撞；
 * - 同时检测目录前缀包含关系（`dir/` 目录条目或文件/目录同名互换碰撞），防止 `--ff-only` 阶段才报错。
 */
function findOverlappingMainDirtyPaths(
  changedFiles: readonly WorktreeChangedFile[],
  mainEntries: ReadonlyArray<{
    readonly xy: string;
    readonly path: string;
    readonly origPath?: string;
  }>,
): string[] {
  if (changedFiles.length === 0 || mainEntries.length === 0) return [];

  const affectedExactKeys = new Set<string>();
  const affectedDirPrefixes = new Set<string>();
  for (const file of changedFiles) {
    for (const raw of file.oldPath ? [file.path, file.oldPath] : [file.path]) {
      const key = normalizeMergeRelKey(raw).replace(/\/+$/, '');
      if (!key) continue;
      affectedExactKeys.add(key);
      const parts = key.split('/');
      for (let i = 1; i < parts.length; i++) {
        affectedDirPrefixes.add(parts.slice(0, i).join('/'));
      }
    }
  }

  const affectedKeyList = [...affectedExactKeys];
  const matched = new Set<string>();

  for (const entry of mainEntries) {
    const candidates = entry.origPath ? [entry.path, entry.origPath] : [entry.path];
    for (const rawCandidate of candidates) {
      const norm = normalizeMergeRelKey(rawCandidate);
      if (!norm) continue;
      if (norm.endsWith('/')) {
        if (affectedKeyList.some((k) => k.startsWith(norm) || `${k}/` === norm)) {
          matched.add(rawCandidate);
        }
        continue;
      }
      if (affectedExactKeys.has(norm) || affectedDirPrefixes.has(norm)) {
        matched.add(rawCandidate);
        continue;
      }
      const parts = norm.split('/');
      for (let i = 1; i < parts.length; i++) {
        if (affectedExactKeys.has(parts.slice(0, i).join('/'))) {
          matched.add(rawCandidate);
          break;
        }
      }
    }
  }

  return [...matched];
}

/**
 * 扫描工作树脏常规文本文件中是否仍残留标准三段式 Git 合并冲突标记（`<<<<<<<` / `=======` / `>>>>>>>`），
 * 防止用户在未清理冲突标记的情况下误触发自动暂存并快进污染主分支。
 */
function hasRawGitConflictMarkers(
  worktreePath: string,
  entries: ReadonlyArray<{ readonly xy: string; readonly path: string }>,
): boolean {
  for (const entry of entries) {
    if (entry.xy.endsWith('D')) continue;
    const full = path.join(worktreePath, entry.path);
    try {
      const stat = fs.lstatSync(full);
      if (!stat.isFile() || stat.size === 0 || stat.size > 2 * 1024 * 1024) continue;
      const buf = fs.readFileSync(full);
      const probeLen = Math.min(buf.length, 8192);
      let binary = false;
      for (let i = 0; i < probeLen; i++) {
        if (buf[i] === 0) {
          binary = true;
          break;
        }
      }
      if (binary) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      let stage: 0 | 1 | 2 = 0;
      for (const line of lines) {
        if (stage === 0 && line.startsWith('<<<<<<< ')) {
          stage = 1;
        } else if (stage === 1 && line === '=======') {
          stage = 2;
        } else if (stage === 2 && line.startsWith('>>>>>>> ')) {
          return true;
        }
      }
    } catch {
      /* 文件并发消失或不可读时跳过，由后续 Git 状态校验兜底。 */
    }
  }
  return false;
}

/**
 * 对 `git status --porcelain` 中的未提交/未跟踪条目计算内容摘要，确保二次修改同一脏文件后 `previewToken` 立即失效。
 */
function computePorcelainContentDigest(
  repoRoot: string,
  entries: ReadonlyArray<{
    readonly xy: string;
    readonly path: string;
    readonly origPath?: string;
  }>,
): string {
  if (entries.length === 0) return '';
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(`${entry.xy}:${entry.path}:${entry.origPath ?? ''}\0`);
    const full = path.join(repoRoot, entry.path);
    try {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        hash.update(`symlink:${fs.readlinkSync(full)}\0`);
      } else if (stat.isFile()) {
        if (stat.size <= 16 * 1024 * 1024) {
          hash.update(fs.readFileSync(full));
          hash.update('\0');
        } else {
          hash.update(`large:${stat.size}:${stat.mtimeMs}\0`);
        }
      } else {
        hash.update(`other:${stat.mode}\0`);
      }
    } catch {
      hash.update('absent\0');
    }
  }
  return hash.digest('hex');
}
