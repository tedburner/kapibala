/**
 * @fileoverview `CheckpointService` —— 零 `.git` 污染的 Shadow Git 工作区检查点与全量真实 Diff 服务。
 *
 * 职责与生命周期：
 * - 管理 `~/.kapibala/checkpoints/<projectKey>/<executionRootHash>/` 下的侧挂裸仓与 `manifest.jsonl`；
 * - 提供轮次前 `capturePreTurn`（带 5s 超时预算与连续 2 次超时会话级自动熔断）与轮次后 `capturePostTurn`；
 * - 提供单轮 / 跨轮归因聚合 `diff`、三路冲突预检定向回滚 `restore` 与超额会话引用修剪 `prune`。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeProjectKey, toNativePhysicalPath } from '@kiturone/kapibala';
import {
  computeChangedFilesBetweenTrees,
  computeGroupedStructuredDiff,
  executeSurgicalRestore,
} from './diff-restore.js';
import {
  computeExecutionRootHash,
  isUnsafeCheckpointRoot,
  runGit,
  splitNulStrings,
  toSafeRefSegment,
} from './git-exec.js';
import { CheckpointBucketMutex, renameAtomicSync } from './lock.js';
import { anchorTreeRef, captureWorkingTree, ensureSideRepo } from './repo.js';
import {
  type CapturePostTurnInput,
  type CapturePreTurnInput,
  type CapturePreTurnResult,
  type CheckpointAvailability,
  type CheckpointDiffInput,
  type CheckpointDiffResult,
  CheckpointError,
  type CheckpointRecord,
  type CheckpointServiceOptions,
  DEFAULT_MAX_CHECKPOINT_BUCKET_BYTES,
  DEFAULT_MAX_CHECKPOINT_SESSIONS,
  DEFAULT_PRE_TURN_TIMEOUT_MS,
  type ListCheckpointsInput,
  PRE_TURN_TIMEOUT_CIRCUIT_THRESHOLD,
  type PruneCheckpointsInput,
  type PruneCheckpointsResult,
  type RestoreCheckpointInput,
  type RestoreCheckpointResult,
} from './types.js';

interface ManifestRewindEntry {
  readonly entryType: 'rewind';
  readonly sessionId: string;
  readonly targetOrdinal: number;
  readonly createdAt: number;
}

type ManifestLine =
  | (CheckpointRecord & { readonly entryType?: 'checkpoint' })
  | ManifestRewindEntry;

/**
 * 宿主级 Shadow Git 工作区检查点引擎。
 *
 * 线程/并发安全：所有写操作均经 `CheckpointBucketMutex` 串行化（进程内 FIFO + 跨进程 `checkpoint.lock`）。
 */
export class CheckpointService {
  private readonly homeDirOverride?: string;
  private readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  private readonly now: () => number;
  private readonly mutex = new CheckpointBucketMutex();
  private readonly consecutiveTimeouts = new Map<string, number>();
  private gitAvailableCache?: boolean;

  constructor(options: CheckpointServiceOptions = {}) {
    this.homeDirOverride = options.homeDir;
    this.hostEnv = options.hostEnv;
    this.now = options.now ?? Date.now;
  }

  private getHomeDir(): string {
    return this.homeDirOverride ?? os.homedir();
  }

  /** 返回检查点全局根目录 `~/.kapibala/checkpoints`。 */
  getCheckpointsRootDir(): string {
    return path.join(this.getHomeDir(), '.kapibala', 'checkpoints');
  }

  /**
   * 检查给定 `(projectRoot, executionRoot)` 是否允许启用工作区检查点，并计算物理分桶路径。
   */
  async checkAvailability(input: {
    readonly projectRoot: string;
    readonly executionRoot: string;
  }): Promise<CheckpointAvailability> {
    const canonicalProjectRoot = toNativePhysicalPath(path.resolve(input.projectRoot));
    const canonicalExecutionRoot = toNativePhysicalPath(path.resolve(input.executionRoot));
    if (isUnsafeCheckpointRoot(canonicalExecutionRoot, this.getHomeDir(), this.hostEnv)) {
      return { available: false, reason: 'unsafe_root' };
    }
    if (!(await this.isGitAvailable())) {
      return { available: false, reason: 'git_unavailable' };
    }
    const projectKey = computeProjectKey(canonicalProjectRoot);
    const executionRootHash = computeExecutionRootHash(canonicalExecutionRoot);
    const bucketDir = path.join(this.getCheckpointsRootDir(), projectKey, executionRootHash);
    const sideGitDir = path.join(bucketDir, 'git');
    return {
      available: true,
      canonicalProjectRoot,
      canonicalExecutionRoot,
      projectKey,
      executionRootHash,
      bucketDir,
      sideGitDir,
    };
  }

  /** 查询指定会话当前是否因连续前置采样超时而处于自动快照熔断态。 */
  isCircuitOpen(sessionId: string): boolean {
    return (this.consecutiveTimeouts.get(sessionId) ?? 0) >= PRE_TURN_TIMEOUT_CIRCUIT_THRESHOLD;
  }

  /** 手动重置指定会话的连续超时熔断计数。 */
  resetCircuit(sessionId: string): void {
    this.consecutiveTimeouts.delete(sessionId);
  }

  /**
   * 轮次启动前捕获起始工作区基线树（`startTree`）。
   *
   * 容错与熔断：
   * - 默认限时 `5,000ms`；超时不会中断用户提问，而是递增会话连续超时计数并返回 `{ skipped: true, reason: 'timeout' }`；
   * - 同一会话连续超时达 2 次后开启熔断，后续调用零 I/O 直接返回 `{ skipped: true, reason: 'timeout_circuit_open' }`。
   */
  async capturePreTurn(input: CapturePreTurnInput): Promise<CapturePreTurnResult> {
    if (this.isCircuitOpen(input.sessionId)) {
      return { captured: false, skipped: true, reason: 'timeout_circuit_open' };
    }

    const availability = await this.checkAvailability(input);
    if (!availability.available) {
      return { captured: false, skipped: true, reason: availability.reason };
    }

    const timeoutMs = input.timeoutMs ?? DEFAULT_PRE_TURN_TIMEOUT_MS;
    const startedAt = this.now();
    const deadline = startedAt + Math.max(1, timeoutMs);
    const remaining = () => Math.max(1, deadline - this.now());

    try {
      const snapshot = await this.mutex.withLock(
        availability.bucketDir,
        async () => {
          const { hostRepo } = await ensureSideRepo({
            sideGitDir: availability.sideGitDir,
            executionRoot: availability.canonicalExecutionRoot,
            projectRoot: availability.canonicalProjectRoot,
            homeDir: this.getHomeDir(),
            baseEnv: this.hostEnv,
            timeoutMs: remaining(),
            signal: input.signal,
          });
          const captured = await captureWorkingTree({
            sideGitDir: availability.sideGitDir,
            executionRoot: availability.canonicalExecutionRoot,
            hostRepo,
            persistIndex: true,
            baseEnv: this.hostEnv,
            timeoutMs: remaining(),
            signal: input.signal,
          });
          const safeSeg = toSafeRefSegment(input.sessionId);
          const refName = `refs/kpbl/sessions/${safeSeg}/turn-${input.ordinal}`;
          const commitOid = await anchorTreeRef({
            sideGitDir: availability.sideGitDir,
            treeOid: captured.treeOid,
            refName,
            message: `pre-turn ${input.ordinal}`,
            baseEnv: this.hostEnv,
            timeoutMs: remaining(),
            signal: input.signal,
          });
          return { ...captured, commitOid, refName };
        },
        { timeoutMs, signal: input.signal },
      );

      this.consecutiveTimeouts.delete(input.sessionId);
      return {
        captured: true,
        skipped: false,
        sessionId: input.sessionId,
        ordinal: input.ordinal,
        startTree: snapshot.treeOid,
        commitOid: snapshot.commitOid,
        refName: snapshot.refName,
        durationMs: Math.max(0, this.now() - startedAt),
        skippedUntrackedFiles: snapshot.skippedUntrackedFiles,
      };
    } catch (err) {
      if ((err as { isTimeout?: boolean }).isTimeout) {
        const prev = this.consecutiveTimeouts.get(input.sessionId) ?? 0;
        const next = prev + 1;
        this.consecutiveTimeouts.set(input.sessionId, next);
        return {
          captured: false,
          skipped: true,
          reason: next >= PRE_TURN_TIMEOUT_CIRCUIT_THRESHOLD ? 'timeout_circuit_open' : 'timeout',
        };
      }
      throw err;
    }
  }

  /**
   * 轮次结束后捕获终点工作区树（`endTree`）、计算真实文件增删改摘要并追加写入 `manifest.jsonl`。
   *
   * 引用图设计：`postCommit` 以包含 `startTree` 的 `startCommit` 作为父提交（`-p`）锚定到
   * `refs/kpbl/sessions/<session>/turn-<ordinal>`，使单条引用同时保护 `startTree` 与 `endTree` 免遭 `git gc` 清除。
   */
  async capturePostTurn(input: CapturePostTurnInput): Promise<CheckpointRecord> {
    const availability = await this.checkAvailability(input);
    if (!availability.available) {
      throw new CheckpointError(
        availability.reason === 'unsafe_root'
          ? 'CHECKPOINT_UNSAFE_ROOT'
          : 'CHECKPOINT_GIT_UNAVAILABLE',
        `Checkpoints unavailable: ${availability.reason}`,
      );
    }

    return this.mutex.withLock(
      availability.bucketDir,
      async () => {
        const { hostRepo } = await ensureSideRepo({
          sideGitDir: availability.sideGitDir,
          executionRoot: availability.canonicalExecutionRoot,
          projectRoot: availability.canonicalProjectRoot,
          homeDir: this.getHomeDir(),
          baseEnv: this.hostEnv,
          signal: input.signal,
        });

        const captured = await captureWorkingTree({
          sideGitDir: availability.sideGitDir,
          executionRoot: availability.canonicalExecutionRoot,
          hostRepo,
          persistIndex: true,
          baseEnv: this.hostEnv,
          signal: input.signal,
        });

        const changedFiles = await computeChangedFilesBetweenTrees({
          sideGitDir: availability.sideGitDir,
          startTree: input.startTree,
          endTree: captured.treeOid,
          baseEnv: this.hostEnv,
          signal: input.signal,
        });

        const safeSeg = toSafeRefSegment(input.sessionId);
        const refName = `refs/kpbl/sessions/${safeSeg}/turn-${input.ordinal}`;

        let commitOid: string;
        if (input.startCommitOid && captured.treeOid === input.startTree) {
          // 轮次前后工作区树完全一致且前置采样已将 startCommitOid 锚定至同一 refName，直接零子进程复用。
          commitOid = input.startCommitOid;
        } else {
          let startCommitOid = input.startCommitOid;
          if (!startCommitOid) {
            // 确保 startTree 拥有父提交对象以在对象图中与 endTree 强连通。
            const startCommitRes = await runGit({
              cwd: availability.sideGitDir,
              args: [
                '--git-dir',
                availability.sideGitDir,
                'commit-tree',
                input.startTree,
                '-m',
                `turn-${input.ordinal}-start`,
              ],
              baseEnv: this.hostEnv,
              signal: input.signal,
            });
            startCommitOid = startCommitRes.stdout.toString('utf8').trim();
          }

          commitOid = await anchorTreeRef({
            sideGitDir: availability.sideGitDir,
            treeOid: captured.treeOid,
            refName,
            parentCommitOids: [startCommitOid],
            message: input.label
              ? `turn ${input.ordinal}: ${input.label}`
              : `turn ${input.ordinal}`,
            baseEnv: this.hostEnv,
            signal: input.signal,
          });
        }

        let additions = 0;
        let deletions = 0;
        for (const item of changedFiles) {
          additions += item.additions;
          deletions += item.deletions;
        }

        const record: CheckpointRecord = {
          id: `${input.sessionId}:turn-${input.ordinal}`,
          sessionId: input.sessionId,
          ordinal: input.ordinal,
          kind: 'turn',
          label: input.label,
          createdAt: this.now(),
          startTree: input.startTree,
          endTree: captured.treeOid,
          commitOid,
          refName,
          additions,
          deletions,
          changedFiles,
          skippedUntrackedFiles:
            captured.skippedUntrackedFiles.length > 0 ? captured.skippedUntrackedFiles : undefined,
        };

        this.appendManifestLine(availability.bucketDir, record);
        return record;
      },
      { signal: input.signal },
    );
  }

  /**
   * 按轮次升序返回指定会话当前生效的轮次检查点列表（已被回滚或同序号重跑覆盖的旧轮次自动收敛）。
   */
  async listCheckpoints(input: ListCheckpointsInput): Promise<CheckpointRecord[]> {
    const availability = await this.checkAvailability(input);
    if (!availability.available) return [];
    const manifestPath = path.join(availability.bucketDir, 'manifest.jsonl');
    if (!fs.existsSync(manifestPath)) return [];
    return this.readActiveSessionTurns(availability.bucketDir, input.sessionId);
  }

  /**
   * 查询单轮或会话跨轮累计的结构化文件 Diff（含 UTF-8 边界截断保护的 Unified Patch）。
   */
  async diff(input: CheckpointDiffInput): Promise<CheckpointDiffResult> {
    const availability = await this.checkAvailability(input);
    if (!availability.available) {
      return { available: false, files: [], additions: 0, deletions: 0, truncated: false };
    }

    const turns = this.readActiveSessionTurns(availability.bucketDir, input.sessionId);
    if (turns.length === 0 && !input.includeLiveWorktree) {
      return { available: true, files: [], additions: 0, deletions: 0, truncated: false };
    }

    return this.mutex.withLock(
      availability.bucketDir,
      async () => {
        const { hostRepo } = await ensureSideRepo({
          sideGitDir: availability.sideGitDir,
          executionRoot: availability.canonicalExecutionRoot,
          projectRoot: availability.canonicalProjectRoot,
          homeDir: this.getHomeDir(),
          baseEnv: this.hostEnv,
          signal: input.signal,
        });

        if (input.ordinal !== undefined) {
          const target = turns.find((t) => t.ordinal === input.ordinal);
          if (!target) {
            throw new CheckpointError(
              'CHECKPOINT_NOT_FOUND',
              `Checkpoint ordinal ${input.ordinal} not found for session ${input.sessionId}`,
            );
          }
          let endTree = target.endTree;
          let filterPaths: ReadonlySet<string> | undefined = new Set(
            target.changedFiles.map((f) => f.path),
          );
          if (input.includeLiveWorktree) {
            const live = await captureWorkingTree({
              sideGitDir: availability.sideGitDir,
              executionRoot: availability.canonicalExecutionRoot,
              hostRepo,
              persistIndex: false,
              baseEnv: this.hostEnv,
              signal: input.signal,
            });
            endTree = live.treeOid;
            filterPaths = undefined;
          }

          const diffOut = await computeGroupedStructuredDiff({
            sideGitDir: availability.sideGitDir,
            groups: [{ startTree: target.startTree, paths: filterPaths }],
            endTree,
            baseEnv: this.hostEnv,
            signal: input.signal,
          });
          return { available: true, ...diffOut };
        }

        const selected = turns.filter(
          (t) =>
            (input.fromOrdinal === undefined || t.ordinal >= input.fromOrdinal) &&
            (input.toOrdinal === undefined || t.ordinal <= input.toOrdinal),
        );

        if (selected.length === 0 && !input.includeLiveWorktree) {
          return { available: true, files: [], additions: 0, deletions: 0, truncated: false };
        }

        // 记录每个归因文件在选定轮次窗口内最早被触碰时的 startTree。
        const earliestTreeByPath = new Map<string, string>();
        for (const turn of selected) {
          for (const f of turn.changedFiles) {
            if (!earliestTreeByPath.has(f.path)) {
              earliestTreeByPath.set(f.path, turn.startTree);
            }
          }
        }

        let endTree = selected.at(-1)?.endTree;
        if (input.includeLiveWorktree) {
          const live = await captureWorkingTree({
            sideGitDir: availability.sideGitDir,
            executionRoot: availability.canonicalExecutionRoot,
            hostRepo,
            persistIndex: false,
            baseEnv: this.hostEnv,
            signal: input.signal,
          });
          if (endTree) {
            const liveChanges = await computeChangedFilesBetweenTrees({
              sideGitDir: availability.sideGitDir,
              startTree: endTree,
              endTree: live.treeOid,
              baseEnv: this.hostEnv,
              signal: input.signal,
            });
            for (const f of liveChanges) {
              if (!earliestTreeByPath.has(f.path)) {
                earliestTreeByPath.set(f.path, endTree);
              }
            }
          }
          endTree = live.treeOid;
        }

        if (!endTree || earliestTreeByPath.size === 0) {
          return { available: true, files: [], additions: 0, deletions: 0, truncated: false };
        }

        const grouped = new Map<string, Set<string>>();
        for (const [filePath, startTree] of earliestTreeByPath) {
          let set = grouped.get(startTree);
          if (!set) {
            set = new Set<string>();
            grouped.set(startTree, set);
          }
          set.add(filePath);
        }

        const diffOut = await computeGroupedStructuredDiff({
          sideGitDir: availability.sideGitDir,
          groups: [...grouped.entries()].map(([startTree, paths]) => ({ startTree, paths })),
          endTree,
          baseEnv: this.hostEnv,
          signal: input.signal,
        });
        return { available: true, ...diffOut };
      },
      { signal: input.signal },
    );
  }

  /**
   * 按归因路径集回滚 `ordinal > targetOrdinal` 的全部 Agent 文件变更。
   *
   * 安全保证：
   * 1. 用户预存未跟踪文件与 Agent 从未触碰的文件 100% 不受影响；
   * 2. `force !== true` 时若检测到用户在末轮结束后手动修改了任一归因文件，立即返回 `conflict` 且零写盘；
   * 3. 动磁盘前必定先创建 `refs/kpbl/sessions/<session>/pre-restore` 备份快照。
   */
  async restore(input: RestoreCheckpointInput): Promise<RestoreCheckpointResult> {
    const availability = await this.checkAvailability(input);
    if (!availability.available) {
      throw new CheckpointError(
        availability.reason === 'unsafe_root'
          ? 'CHECKPOINT_UNSAFE_ROOT'
          : 'CHECKPOINT_GIT_UNAVAILABLE',
        `Checkpoints unavailable: ${availability.reason}`,
      );
    }

    return this.mutex.withLock(
      availability.bucketDir,
      async () => {
        const activeTurns = this.readActiveSessionTurns(availability.bucketDir, input.sessionId);
        const turnsToRevert = activeTurns.filter((t) => t.ordinal > input.targetOrdinal);
        if (turnsToRevert.length === 0) {
          return { status: 'noop', restoredFiles: [], deletedFiles: [] };
        }

        const { hostRepo } = await ensureSideRepo({
          sideGitDir: availability.sideGitDir,
          executionRoot: availability.canonicalExecutionRoot,
          projectRoot: availability.canonicalProjectRoot,
          homeDir: this.getHomeDir(),
          baseEnv: this.hostEnv,
          signal: input.signal,
        });

        const safeSeg = toSafeRefSegment(input.sessionId);
        const outcome = await executeSurgicalRestore({
          sideGitDir: availability.sideGitDir,
          canonicalExecutionRoot: availability.canonicalExecutionRoot,
          hostRepo,
          sessionId: input.sessionId,
          safeSessionRefSegment: safeSeg,
          turnsToRevert,
          targetOrdinal: input.targetOrdinal,
          force: input.force === true,
          dryRun: input.dryRun === true,
          now: this.now,
          baseEnv: this.hostEnv,
          signal: input.signal,
        });

        if (outcome.status === 'conflict' || outcome.status === 'noop') {
          return outcome;
        }

        this.appendManifestLine(availability.bucketDir, outcome.preRestoreRecord);
        const rewindEntry: ManifestRewindEntry = {
          entryType: 'rewind',
          sessionId: input.sessionId,
          targetOrdinal: input.targetOrdinal,
          createdAt: this.now(),
        };
        this.appendManifestLine(availability.bucketDir, rewindEntry);

        return outcome;
      },
      { signal: input.signal },
    );
  }

  /**
   * 淘汰超出会话保留数（默认 30）或对象库体积预算（默认 500 MiB）的最旧会话检查点引用，并执行 `git gc --prune=now --quiet`。
   */
  async prune(input: PruneCheckpointsInput): Promise<PruneCheckpointsResult> {
    const availability = await this.checkAvailability(input);
    if (!availability.available || !fs.existsSync(availability.sideGitDir)) {
      return { prunedSessions: [], remainingSessions: 0 };
    }

    const maxSessions = Math.max(1, input.maxSessions ?? DEFAULT_MAX_CHECKPOINT_SESSIONS);
    const maxBytes = Math.max(1, input.maxBytes ?? DEFAULT_MAX_CHECKPOINT_BUCKET_BYTES);

    return this.mutex.withLock(availability.bucketDir, async () => {
      const allLines = this.readAllManifestLines(availability.bucketDir);
      const sessionMeta = new Map<
        string,
        { sessionId: string; safeSeg: string; lastUpdatedAt: number }
      >();

      for (const entry of allLines) {
        const existing = sessionMeta.get(entry.sessionId);
        const ts = entry.createdAt;
        if (!existing || ts > existing.lastUpdatedAt) {
          sessionMeta.set(entry.sessionId, {
            sessionId: entry.sessionId,
            safeSeg: toSafeRefSegment(entry.sessionId),
            lastUpdatedAt: ts,
          });
        }
      }

      const refsRes = await runGit({
        cwd: availability.sideGitDir,
        args: [
          '--git-dir',
          availability.sideGitDir,
          'for-each-ref',
          '--format=%(refname)%00%(committerdate:unix)',
          'refs/kpbl/sessions/',
        ],
        baseEnv: this.hostEnv,
      });

      const refsBySeg = new Map<string, { refs: string[]; latestSec: number }>();
      const tokens = splitNulStrings(refsRes.stdout);
      // for-each-ref 每行末尾带 `\n`，因此按行解析更稳健。
      const rawLines = refsRes.stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
      void tokens;
      for (const line of rawLines) {
        const nulIdx = line.indexOf('\0');
        if (nulIdx < 0) continue;
        const refName = line.slice(0, nulIdx);
        const sec = Number.parseInt(line.slice(nulIdx + 1), 10) || 0;
        // refs/kpbl/sessions/<safeSeg>/...
        const rest = refName.slice('refs/kpbl/sessions/'.length);
        const slashIdx = rest.indexOf('/');
        if (slashIdx <= 0) continue;
        const seg = rest.slice(0, slashIdx);
        const bucket = refsBySeg.get(seg) ?? { refs: [], latestSec: 0 };
        bucket.refs.push(refName);
        if (sec > bucket.latestSec) bucket.latestSec = sec;
        refsBySeg.set(seg, bucket);
      }

      // 将仅有孤儿 ref 而不在 manifest 里的段也纳入统计，确保可回收。
      const segToSessionId = new Map<string, string>();
      for (const meta of sessionMeta.values()) {
        segToSessionId.set(meta.safeSeg, meta.sessionId);
      }
      for (const [seg, info] of refsBySeg) {
        if (!segToSessionId.has(seg)) {
          segToSessionId.set(seg, seg);
          sessionMeta.set(seg, {
            sessionId: seg,
            safeSeg: seg,
            lastUpdatedAt: info.latestSec * 1000,
          });
        }
      }

      const sortedSessions = [...sessionMeta.values()].sort(
        (a, b) => b.lastUpdatedAt - a.lastUpdatedAt,
      );

      const objectsDir = path.join(availability.sideGitDir, 'objects');
      const overBytes = computeDirectoryBytes(objectsDir) > maxBytes;

      const prunedSessions: string[] = [];
      const prunedSessionSet = new Set<string>();
      const refsToDelete: string[] = [];

      let keptCount = 0;
      for (const item of sortedSessions) {
        if (input.activeSessionIds?.has(item.sessionId)) {
          keptCount += 1;
          continue;
        }
        const mustPruneByCount = keptCount >= maxSessions;
        const mustPruneByBytes = overBytes && keptCount >= Math.max(1, Math.floor(maxSessions / 2));
        if (mustPruneByCount || mustPruneByBytes) {
          prunedSessions.push(item.sessionId);
          prunedSessionSet.add(item.sessionId);
          const refInfo = refsBySeg.get(item.safeSeg);
          if (refInfo) refsToDelete.push(...refInfo.refs);
        } else {
          keptCount += 1;
        }
      }

      if (refsToDelete.length > 0) {
        const deleteScript = refsToDelete.map((ref) => `delete ${ref}\0\0`).join('');
        await runGit({
          cwd: availability.sideGitDir,
          args: ['--git-dir', availability.sideGitDir, 'update-ref', '--stdin', '-z'],
          input: Buffer.from(deleteScript, 'utf8'),
          baseEnv: this.hostEnv,
        });
      }

      if (prunedSessionSet.size > 0) {
        const remainingLines = allLines.filter((entry) => !prunedSessionSet.has(entry.sessionId));
        this.rewriteManifestLines(availability.bucketDir, remainingLines);
      }

      await runGit({
        cwd: availability.sideGitDir,
        args: ['--git-dir', availability.sideGitDir, 'gc', '--prune=now', '--quiet'],
        baseEnv: this.hostEnv,
      });

      return {
        prunedSessions,
        remainingSessions: sortedSessions.length - prunedSessions.length,
      };
    });
  }

  private async isGitAvailable(): Promise<boolean> {
    if (this.gitAvailableCache === true) return true;
    try {
      await runGit({
        args: ['--version'],
        cwd: os.tmpdir(),
        baseEnv: this.hostEnv,
        timeoutMs: 3_000,
      });
      this.gitAvailableCache = true;
      return true;
    } catch {
      // 瞬态超时不永久缓存 false，且固定以 os.tmpdir() 为 cwd 防止外部删除进程当前目录触发 spawn ENOENT。
      return false;
    }
  }

  private appendManifestLine(bucketDir: string, entry: ManifestLine): void {
    const manifestPath = path.join(bucketDir, 'manifest.jsonl');
    fs.appendFileSync(manifestPath, `${JSON.stringify(entry)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
  }

  private rewriteManifestLines(bucketDir: string, entries: readonly ManifestLine[]): void {
    const manifestPath = path.join(bucketDir, 'manifest.jsonl');
    const tempPath = `${manifestPath}.tmp-${process.pid}-${Date.now()}`;
    const content =
      entries.length > 0 ? `${entries.map((e) => JSON.stringify(e)).join('\n')}\n` : '';
    fs.writeFileSync(tempPath, content, { encoding: 'utf8', mode: 0o600 });
    renameAtomicSync(tempPath, manifestPath);
  }

  private readAllManifestLines(bucketDir: string): ManifestLine[] {
    const manifestPath = path.join(bucketDir, 'manifest.jsonl');
    if (!fs.existsSync(manifestPath)) return [];
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const result: ManifestLine[] = [];
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed) as ManifestLine;
        if (parsed && typeof parsed === 'object' && typeof parsed.sessionId === 'string') {
          result.push(parsed);
        }
      } catch {
        /* 单行尾损容错跳过，避免异常断电写半行拖垮历史读取。 */
      }
    }
    return result;
  }

  private readActiveSessionTurns(bucketDir: string, sessionId: string): CheckpointRecord[] {
    const lines = this.readAllManifestLines(bucketDir);
    let activeTurns: CheckpointRecord[] = [];
    for (const entry of lines) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.entryType === 'rewind') {
        activeTurns = activeTurns.filter((t) => t.ordinal <= entry.targetOrdinal);
        continue;
      }
      if (entry.kind === 'turn') {
        activeTurns = activeTurns.filter((t) => t.ordinal < entry.ordinal);
        activeTurns.push(entry);
      }
    }
    return activeTurns.sort((a, b) => a.ordinal - b.ordinal);
  }
}

function computeDirectoryBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += computeDirectoryBytes(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* 并发 GC 移除松散对象时忽略。 */
      }
    }
  }
  return total;
}
