/**
 * @fileoverview 结构化树间 Diff 计算与按归因路径三路冲突预检定向回滚。
 *
 * 核心安全约束：
 * - Diff 读取全程通过 `--pathspec-from-file=- --pathspec-file-nul` 批量传入路径，规避 Windows 32K 命令行限制；
 * - Patch 严格实施单文件 256 KiB、总计 2 MiB 的 UTF-8 码点边界截断；
 * - 回滚前先对所有归因路径运行 `git hash-object --no-filters` 与最新轮次 `endTree` 做三路冲突预检，
 *   防止静默抹除用户在轮次结束后手动做的编辑；
 * - 写盘前强制生成 `pre-restore` 安全备份引用，还原走隔离 `GIT_INDEX_FILE`，删除走防符号链接逃逸校验。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isPathInside, isSamePath, toNativePhysicalPath } from '@kiturone/kapibala';
import { runGit, splitNulStrings, truncateUtf8Safe } from './git-exec.js';
import { renameAtomicSync } from './lock.js';
import { type HostGitRepoInfo, anchorTreeRef, captureWorkingTree } from './repo.js';
import {
  type CheckpointChangedFile,
  CheckpointError,
  type CheckpointFileDiff,
  type CheckpointRecord,
  MAX_SINGLE_FILE_PATCH_BYTES,
  MAX_TOTAL_DIFF_PATCH_BYTES,
} from './types.js';

let restoreIndexSeq = 0;

/**
 * 计算两棵 Git Tree 之间的变更文件摘要列表（无重命名折叠，确保回滚归因完整覆盖旧路径与新路径）。
 */
export async function computeChangedFilesBetweenTrees(options: {
  readonly sideGitDir: string;
  readonly startTree: string;
  readonly endTree: string;
  readonly filterPaths?: ReadonlySet<string>;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}): Promise<CheckpointChangedFile[]> {
  if (options.startTree === options.endTree) return [];

  const [statusRes, numstatRes] = await Promise.all([
    runGit({
      cwd: options.sideGitDir,
      args: [
        '--git-dir',
        options.sideGitDir,
        'diff-tree',
        '-r',
        '--no-renames',
        '--name-status',
        '-z',
        options.startTree,
        options.endTree,
      ],
      baseEnv: options.baseEnv,
      signal: options.signal,
    }),
    runGit({
      cwd: options.sideGitDir,
      args: [
        '--git-dir',
        options.sideGitDir,
        'diff-tree',
        '-r',
        '--no-renames',
        '--numstat',
        '-z',
        options.startTree,
        options.endTree,
      ],
      baseEnv: options.baseEnv,
      signal: options.signal,
    }),
  ]);

  const statusTokens = splitNulStrings(statusRes.stdout);
  const statusMap = new Map<string, 'added' | 'modified' | 'deleted'>();
  for (let i = 0; i + 1 < statusTokens.length; i += 2) {
    const rawCode = statusTokens[i]!;
    const filePath = statusTokens[i + 1]!;
    if (options.filterPaths && !options.filterPaths.has(filePath)) continue;
    const status: 'added' | 'modified' | 'deleted' = rawCode.startsWith('A')
      ? 'added'
      : rawCode.startsWith('D')
        ? 'deleted'
        : 'modified';
    statusMap.set(filePath, status);
  }

  const numstatMap = new Map<string, { additions: number; deletions: number; binary: boolean }>();
  for (const record of splitNulStrings(numstatRes.stdout)) {
    const firstTab = record.indexOf('\t');
    const secondTab = firstTab >= 0 ? record.indexOf('\t', firstTab + 1) : -1;
    if (firstTab < 0 || secondTab < 0) continue;
    const rawAdd = record.slice(0, firstTab);
    const rawDel = record.slice(firstTab + 1, secondTab);
    const filePath = record.slice(secondTab + 1);
    if (options.filterPaths && !options.filterPaths.has(filePath)) continue;
    const binary = rawAdd === '-' || rawDel === '-';
    numstatMap.set(filePath, {
      additions: binary ? 0 : Number.parseInt(rawAdd, 10) || 0,
      deletions: binary ? 0 : Number.parseInt(rawDel, 10) || 0,
      binary,
    });
  }

  const files: CheckpointChangedFile[] = [];
  const sortedPaths = [...statusMap.keys()].sort();
  for (const filePath of sortedPaths) {
    const status = statusMap.get(filePath)!;
    const stat = numstatMap.get(filePath) ?? { additions: 0, deletions: 0, binary: false };
    files.push({
      path: filePath,
      status,
      additions: stat.additions,
      deletions: stat.deletions,
      binary: stat.binary,
    });
  }
  return files;
}

/**
 * 按给定 `(startTree -> endTree)` 分组集合计算带 Unified Patch 与双层字节预算裁剪的结构化 Diff。
 *
 * 设计细节：会话跨多轮累计 Diff 时，不同归因文件可能在不同轮次首次被触碰（拥有不同的起始 `startTree`），
 * 因此支持按 `sourceTree` 分组对比各自起点与统一末端 `endTree`，避免把轮次间隙的用户手动编辑混入 Agent 归因 Diff。
 */
export async function computeGroupedStructuredDiff(options: {
  readonly sideGitDir: string;
  readonly groups: ReadonlyArray<{
    readonly startTree: string;
    readonly paths?: ReadonlySet<string>;
  }>;
  readonly endTree: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}): Promise<{
  readonly files: CheckpointFileDiff[];
  readonly additions: number;
  readonly deletions: number;
  readonly truncated: boolean;
}> {
  const summaries: Array<{ startTree: string; summary: CheckpointChangedFile }> = [];
  for (const group of options.groups) {
    const changed = await computeChangedFilesBetweenTrees({
      sideGitDir: options.sideGitDir,
      startTree: group.startTree,
      endTree: options.endTree,
      filterPaths: group.paths,
      baseEnv: options.baseEnv,
      signal: options.signal,
    });
    for (const item of changed) {
      summaries.push({ startTree: group.startTree, summary: item });
    }
  }

  summaries.sort((a, b) => a.summary.path.localeCompare(b.summary.path));

  let totalBytesUsed = 0;
  let anyTruncated = false;
  let totalAdditions = 0;
  let totalDeletions = 0;
  const files: CheckpointFileDiff[] = [];

  for (const { startTree, summary } of summaries) {
    totalAdditions += summary.additions;
    totalDeletions += summary.deletions;

    if (summary.binary) {
      files.push({
        ...summary,
        patch: '',
        truncated: false,
      });
      continue;
    }

    const remainingTotal = MAX_TOTAL_DIFF_PATCH_BYTES - totalBytesUsed;
    if (remainingTotal <= 0) {
      anyTruncated = true;
      files.push({
        ...summary,
        patch: '',
        truncated: true,
      });
      continue;
    }

    const fileBudget = Math.min(MAX_SINGLE_FILE_PATCH_BYTES, remainingTotal);
    const diffRes = await runGit({
      cwd: options.sideGitDir,
      args: [
        '--git-dir',
        options.sideGitDir,
        'diff',
        '--no-renames',
        '--no-ext-diff',
        '--no-color',
        '--src-prefix=a/',
        '--dst-prefix=b/',
        startTree,
        options.endTree,
        '--',
        summary.path,
      ],
      baseEnv: options.baseEnv,
      signal: options.signal,
      // 多读 4 字节以准确侦测是否超出 fileBudget，同时在超大单文件时由流限流器提前终止子进程。
      maxStdoutBytes: fileBudget + 4,
    });

    const sliced = truncateUtf8Safe(diffRes.stdout, fileBudget);
    const truncated = diffRes.stdoutTruncated || sliced.truncated;
    if (truncated) anyTruncated = true;
    totalBytesUsed += sliced.byteLength;

    files.push({
      ...summary,
      patch: sliced.text,
      truncated,
    });
  }

  return {
    files,
    additions: totalAdditions,
    deletions: totalDeletions,
    truncated: anyTruncated,
  };
}

interface TreeObjectEntry {
  readonly mode: string;
  readonly oid: string;
}

/**
 * 批量读取指定树对象中给定路径集合的条目信息（不存在于该树中的路径不在返回 Map 内）。
 */
async function lookupPathsInTree(options: {
  readonly sideGitDir: string;
  readonly treeOid: string;
  readonly paths: readonly string[];
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}): Promise<Map<string, TreeObjectEntry>> {
  const result = new Map<string, TreeObjectEntry>();
  if (options.paths.length === 0) return result;

  // 分块控制在 ~4 KiB 以内，彻底避开 Windows CreateProcess 命令行长度限制。
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;
  for (const p of options.paths) {
    if (current.length >= 80 || currentLen + p.length > 3500) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(p);
    currentLen += p.length + 1;
  }
  if (current.length > 0) chunks.push(current);

  for (const chunk of chunks) {
    const res = await runGit({
      cwd: options.sideGitDir,
      args: ['--git-dir', options.sideGitDir, 'ls-tree', '-z', options.treeOid, '--', ...chunk],
      baseEnv: options.baseEnv,
      signal: options.signal,
    });
    for (const line of splitNulStrings(res.stdout)) {
      // 格式：`<mode> <type> <oid>\t<path>`；显式跳过 `040000 tree` 目录项，仅保留文件与符号链接条目。
      const tabIdx = line.indexOf('\t');
      if (tabIdx < 0) continue;
      const headerParts = line.slice(0, tabIdx).trim().split(/\s+/);
      const entryPath = line.slice(tabIdx + 1);
      if (headerParts.length >= 3 && headerParts[1] !== 'tree') {
        result.set(entryPath, { mode: headerParts[0]!, oid: headerParts[2]! });
      }
    }
  }
  return result;
}

/**
 * 检查当某个归因路径在轮次中被替换为目录后，磁盘上该目录是否完全属于 `latestEndTree` 子树（未被用户事后新建额外文件或空目录）。
 */
async function isAgentReplacedDirectoryIntact(options: {
  readonly sideGitDir: string;
  readonly fullDirPath: string;
  readonly relDirPath: string;
  readonly latestEndTree: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}): Promise<boolean> {
  const res = await runGit({
    cwd: options.sideGitDir,
    args: [
      '--git-dir',
      options.sideGitDir,
      'ls-tree',
      '-r',
      '-z',
      options.latestEndTree,
      '--',
      `${options.relDirPath}/`,
    ],
    baseEnv: options.baseEnv,
    signal: options.signal,
  });
  const trackedRelSet = new Set<string>();
  const trackedDirSet = new Set<string>([options.relDirPath]);
  for (const line of splitNulStrings(res.stdout)) {
    const tabIdx = line.indexOf('\t');
    if (tabIdx < 0) continue;
    const entryPath = line.slice(tabIdx + 1);
    if (!entryPath) continue;
    trackedRelSet.add(entryPath);
    const parts = entryPath.split('/');
    for (let i = 1; i < parts.length; i++) {
      trackedDirSet.add(parts.slice(0, i).join('/'));
    }
  }
  if (trackedRelSet.size === 0) {
    return false;
  }

  const walk = (absDir: string, relDir: string): boolean => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return false;
    }
    if (entries.length === 0 && !trackedDirSet.has(relDir)) {
      return false;
    }
    for (const entry of entries) {
      const childRel = `${relDir}/${entry.name}`;
      const childAbs = path.join(absDir, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        if (!trackedDirSet.has(childRel)) return false;
        if (!walk(childAbs, childRel)) return false;
      } else if (!trackedRelSet.has(childRel)) {
        return false;
      }
    }
    return true;
  };

  return walk(options.fullDirPath, options.relDirPath);
}

/**
 * 检测归因路径在最新轮次 `endTree` 之后是否被用户在磁盘上手动修改、删除或新建。
 */
async function detectPostTurnConflicts(options: {
  readonly sideGitDir: string;
  readonly executionRoot: string;
  readonly latestEndTree: string;
  readonly attributedPaths: readonly string[];
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}): Promise<string[]> {
  const endTreeEntries = await lookupPathsInTree({
    sideGitDir: options.sideGitDir,
    treeOid: options.latestEndTree,
    paths: options.attributedPaths,
    baseEnv: options.baseEnv,
    signal: options.signal,
  });

  const conflicts: string[] = [];
  const regularFilesToHash: Array<{ relPath: string; fullPath: string; expectedOid: string }> = [];

  for (const relPath of options.attributedPaths) {
    const expected = endTreeEntries.get(relPath);
    const fullPath = path.join(options.executionRoot, relPath);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      stat = undefined;
    }

    if (!expected) {
      if (stat !== undefined) {
        if (
          stat.isDirectory() &&
          (await isAgentReplacedDirectoryIntact({
            sideGitDir: options.sideGitDir,
            fullDirPath: fullPath,
            relDirPath: relPath,
            latestEndTree: options.latestEndTree,
            baseEnv: options.baseEnv,
            signal: options.signal,
          }))
        ) {
          // Agent 在轮次内将原文件/符号链接替换成了同名非空目录，且用户事后未向其塞入额外文件，不属于事后冲突。
          continue;
        }
        conflicts.push(relPath);
      }
      continue;
    }

    if (!stat || stat.isDirectory()) {
      conflicts.push(relPath);
      continue;
    }

    if (stat.isSymbolicLink()) {
      if (expected.mode !== '120000') {
        conflicts.push(relPath);
        continue;
      }
      const targetText = fs.readlinkSync(fullPath);
      const hashRes = await runGit({
        cwd: options.executionRoot,
        args: ['--git-dir', options.sideGitDir, 'hash-object', '-t', 'blob', '--stdin'],
        input: Buffer.from(targetText, 'utf8'),
        baseEnv: options.baseEnv,
        signal: options.signal,
      });
      if (hashRes.stdout.toString('utf8').trim() !== expected.oid) {
        conflicts.push(relPath);
      }
      continue;
    }

    if (expected.mode === '120000') {
      conflicts.push(relPath);
      continue;
    }

    if (!relPath.includes('\n') && !relPath.includes('\r')) {
      regularFilesToHash.push({ relPath, fullPath, expectedOid: expected.oid });
    } else {
      const singleRes = await runGit({
        cwd: options.executionRoot,
        args: ['--git-dir', options.sideGitDir, 'hash-object', '--no-filters', '--', fullPath],
        baseEnv: options.baseEnv,
        signal: options.signal,
      });
      if (singleRes.stdout.toString('utf8').trim() !== expected.oid) {
        conflicts.push(relPath);
      }
    }
  }

  if (regularFilesToHash.length > 0) {
    const stdinPaths = `${regularFilesToHash.map((item) => item.fullPath).join('\n')}\n`;
    const batchRes = await runGit({
      cwd: options.executionRoot,
      args: ['--git-dir', options.sideGitDir, 'hash-object', '--no-filters', '--stdin-paths'],
      input: Buffer.from(stdinPaths, 'utf8'),
      baseEnv: options.baseEnv,
      signal: options.signal,
    });
    const actualOids = batchRes.stdout.toString('utf8').trim().split(/\r?\n/).filter(Boolean);
    for (let i = 0; i < regularFilesToHash.length; i++) {
      const item = regularFilesToHash[i]!;
      if (actualOids[i] !== item.expectedOid) {
        conflicts.push(item.relPath);
      }
    }
  }

  return conflicts.sort();
}

/**
 * 校验相对路径在 `executionRoot` 下的所有已存在父级分量均非符号链接且未越界，杜绝软链重定向写/删越权。
 */
function assertNoParentSymlinkEscape(canonicalExecutionRoot: string, relPath: string): string {
  if (!relPath || path.isAbsolute(relPath)) {
    throw new CheckpointError('CHECKPOINT_SYMLINK_ESCAPE', `Invalid relative path: ${relPath}`);
  }
  const normalizedRel = path.posix.normalize(relPath.replaceAll('\\', '/'));
  if (
    normalizedRel === '.' ||
    normalizedRel === '..' ||
    normalizedRel.startsWith('../') ||
    normalizedRel === '.git' ||
    normalizedRel.startsWith('.git/')
  ) {
    throw new CheckpointError('CHECKPOINT_SYMLINK_ESCAPE', `Unsafe restore path: ${relPath}`);
  }

  const segments = normalizedRel.split('/');
  let current = canonicalExecutionRoot;
  for (let i = 0; i < segments.length - 1; i++) {
    current = path.join(current, segments[i]!);
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) {
        throw new CheckpointError(
          'CHECKPOINT_SYMLINK_ESCAPE',
          `Refusing to traverse symlink parent during restore: ${segments.slice(0, i + 1).join('/')}`,
        );
      }
    } catch (err) {
      if (err instanceof CheckpointError) throw err;
      // 父目录尚不存在时合法（将由 git checkout 创建）。
      break;
    }
  }

  const targetFull = path.join(canonicalExecutionRoot, ...segments);
  const resolvedParent = toNativePhysicalPath(path.dirname(targetFull));
  if (!isPathInside(canonicalExecutionRoot, resolvedParent)) {
    throw new CheckpointError(
      'CHECKPOINT_SYMLINK_ESCAPE',
      `Target parent escaped execution root: ${relPath}`,
    );
  }
  return targetFull;
}

/**
 * 执行按归因路径集的三路冲突预检、`pre-restore` 强制备份与隔离索引外科手术式回滚。
 */
export async function executeSurgicalRestore(options: {
  readonly sideGitDir: string;
  readonly canonicalExecutionRoot: string;
  readonly hostRepo?: HostGitRepoInfo;
  readonly sessionId: string;
  readonly safeSessionRefSegment: string;
  readonly turnsToRevert: readonly CheckpointRecord[];
  readonly targetOrdinal: number;
  readonly force: boolean;
  readonly now: () => number;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}): Promise<
  | {
      readonly status: 'conflict';
      readonly conflicts: string[];
    }
  | {
      readonly status: 'restored';
      readonly restoredFiles: string[];
      readonly deletedFiles: string[];
      readonly preRestoreRef: string;
      readonly preRestoreRecord: CheckpointRecord;
    }
> {
  // 1. 正向扫描待撤销轮次，记录每个归因路径首次被触碰轮次的 startTree。
  const earliestStartTreeByPath = new Map<string, string>();
  for (const turn of options.turnsToRevert) {
    for (const file of turn.changedFiles) {
      if (!earliestStartTreeByPath.has(file.path)) {
        earliestStartTreeByPath.set(file.path, turn.startTree);
      }
    }
  }

  const attributedPaths = [...earliestStartTreeByPath.keys()].sort();
  const latestEndTree = options.turnsToRevert.at(-1)!.endTree;

  // 2. 非强制模式下执行三路冲突预检，命中冲突零磁盘改动直接返回。
  if (!options.force && attributedPaths.length > 0) {
    const conflicts = await detectPostTurnConflicts({
      sideGitDir: options.sideGitDir,
      executionRoot: options.canonicalExecutionRoot,
      latestEndTree,
      attributedPaths,
      baseEnv: options.baseEnv,
      signal: options.signal,
    });
    if (conflicts.length > 0) {
      return { status: 'conflict', conflicts };
    }
  }

  // 3. 写任何工作区文件前，强制生成 `pre-restore` 安全备份快照。
  const preRestoreCapture = await captureWorkingTree({
    sideGitDir: options.sideGitDir,
    executionRoot: options.canonicalExecutionRoot,
    hostRepo: options.hostRepo,
    persistIndex: true,
    baseEnv: options.baseEnv,
    signal: options.signal,
  });
  const preRestoreRef = `refs/kpbl/sessions/${options.safeSessionRefSegment}/pre-restore`;
  const preRestoreCommit = await anchorTreeRef({
    sideGitDir: options.sideGitDir,
    treeOid: preRestoreCapture.treeOid,
    refName: preRestoreRef,
    message: `pre-restore before rewind to ordinal ${options.targetOrdinal}`,
    baseEnv: options.baseEnv,
    signal: options.signal,
  });
  const createdAt = options.now();
  const preRestoreRecord: CheckpointRecord = {
    id: `${options.sessionId}:pre-restore-${createdAt}`,
    sessionId: options.sessionId,
    ordinal: options.targetOrdinal,
    kind: 'pre-restore',
    label: `pre-restore (target ordinal ${options.targetOrdinal})`,
    createdAt,
    startTree: latestEndTree,
    endTree: preRestoreCapture.treeOid,
    commitOid: preRestoreCommit,
    refName: preRestoreRef,
    additions: 0,
    deletions: 0,
    changedFiles: [],
    skippedUntrackedFiles: preRestoreCapture.skippedUntrackedFiles,
  };

  // 4. 解析每个归因路径在目标 startTree 中的存在性（present -> checkout；absent -> 安全删除）。
  const pathsBySourceTree = new Map<string, string[]>();
  for (const [relPath, sourceTree] of earliestStartTreeByPath) {
    const list = pathsBySourceTree.get(sourceTree) ?? [];
    list.push(relPath);
    pathsBySourceTree.set(sourceTree, list);
  }

  const checkoutGroups = new Map<string, string[]>();
  const absentPaths: string[] = [];

  for (const [sourceTree, groupPaths] of pathsBySourceTree) {
    const entries = await lookupPathsInTree({
      sideGitDir: options.sideGitDir,
      treeOid: sourceTree,
      paths: groupPaths,
      baseEnv: options.baseEnv,
      signal: options.signal,
    });
    for (const relPath of groupPaths) {
      if (entries.has(relPath)) {
        const list = checkoutGroups.get(sourceTree) ?? [];
        list.push(relPath);
        checkoutGroups.set(sourceTree, list);
      } else {
        absentPaths.push(relPath);
      }
    }
  }

  // 预先对所有待写/待删路径做父目录无符号链接越界初检。
  for (const relPath of attributedPaths) {
    assertNoParentSymlinkEscape(options.canonicalExecutionRoot, relPath);
  }

  // 5. 先自深向浅删除检查点时尚不存在的新增归因文件，每次删除前动态复核父级无符号链接越界，
  //    严防「先检出历史符号链接父目录、再按旧路径删除子项」穿透删毁工作区外宿主文件。
  const deletedFiles: string[] = [];
  const sortedAbsentPaths = [...absentPaths].sort(
    (a, b) => b.split('/').length - a.split('/').length || a.localeCompare(b),
  );
  for (const relPath of sortedAbsentPaths) {
    const full = assertNoParentSymlinkEscape(options.canonicalExecutionRoot, relPath);
    try {
      const stat = fs.lstatSync(full);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(full);
      } else {
        fs.rmSync(full, { recursive: stat.isDirectory(), force: true });
      }
      deletedFiles.push(relPath);
      pruneEmptyParentDirs(options.canonicalExecutionRoot, path.dirname(full));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw err;
      }
    }
  }

  // 6. 使用隔离临时 GIT_INDEX_FILE 自浅向深恢复历史归因文件，绝不触碰用户主仓 `.git/index`。
  const restoredFiles: string[] = [];
  const tempCheckoutIndex = path.join(
    options.sideGitDir,
    `index.restore-${process.pid}-${++restoreIndexSeq}-${Date.now()}`,
  );
  try {
    for (const [sourceTree, rawPathsToRestore] of checkoutGroups) {
      const pathsToRestore = [...rawPathsToRestore].sort(
        (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
      );
      for (const relPath of pathsToRestore) {
        const full = assertNoParentSymlinkEscape(options.canonicalExecutionRoot, relPath);
        try {
          const stat = fs.lstatSync(full);
          if (stat.isSymbolicLink()) {
            fs.unlinkSync(full);
          } else if (stat.isDirectory()) {
            fs.rmSync(full, { recursive: true, force: true });
          }
        } catch {
          /* 目标尚不存在时直接由 git checkout 写出。 */
        }
      }

      for (const relPath of pathsToRestore) {
        assertNoParentSymlinkEscape(options.canonicalExecutionRoot, relPath);
      }

      await runGit({
        cwd: options.sideGitDir,
        args: ['--git-dir', options.sideGitDir, 'read-tree', sourceTree],
        baseEnv: options.baseEnv,
        envOverrides: { GIT_INDEX_FILE: tempCheckoutIndex },
        signal: options.signal,
      });

      await runGit({
        cwd: options.canonicalExecutionRoot,
        args: [
          '--git-dir',
          options.sideGitDir,
          '--work-tree',
          options.canonicalExecutionRoot,
          'checkout',
          sourceTree,
          '--force',
          '--pathspec-from-file=-',
          '--pathspec-file-nul',
        ],
        input: Buffer.from(`${pathsToRestore.join('\0')}\0`, 'utf8'),
        baseEnv: options.baseEnv,
        envOverrides: { GIT_INDEX_FILE: tempCheckoutIndex },
        signal: options.signal,
      });

      restoredFiles.push(...pathsToRestore);
    }
  } finally {
    if (fs.existsSync(tempCheckoutIndex)) {
      fs.rmSync(tempCheckoutIndex, { force: true });
    }
  }

  // 7. 将侧挂持久索引同步对齐到还原后的磁盘文件状态。
  const sideIndexPath = path.join(options.sideGitDir, 'index');
  if (attributedPaths.length > 0 && fs.existsSync(sideIndexPath)) {
    const syncIndexPath = `${sideIndexPath}.sync-${process.pid}-${++restoreIndexSeq}`;
    try {
      fs.copyFileSync(sideIndexPath, syncIndexPath);
      await runGit({
        cwd: options.canonicalExecutionRoot,
        args: [
          '--git-dir',
          options.sideGitDir,
          '--work-tree',
          options.canonicalExecutionRoot,
          'update-index',
          '--add',
          '--remove',
          '--replace',
          '-z',
          '--stdin',
        ],
        input: Buffer.from(`${attributedPaths.join('\0')}\0`, 'utf8'),
        baseEnv: options.baseEnv,
        envOverrides: { GIT_INDEX_FILE: syncIndexPath },
        signal: options.signal,
      });
      renameAtomicSync(syncIndexPath, sideIndexPath);
    } finally {
      if (fs.existsSync(syncIndexPath)) {
        fs.rmSync(syncIndexPath, { force: true });
      }
    }
  }

  restoredFiles.sort();
  deletedFiles.sort();

  return {
    status: 'restored',
    restoredFiles,
    deletedFiles,
    preRestoreRef,
    preRestoreRecord,
  };
}

function pruneEmptyParentDirs(canonicalRoot: string, startDir: string): void {
  let current = startDir;
  while (!isSamePath(current, canonicalRoot) && isPathInside(canonicalRoot, current)) {
    try {
      fs.rmdirSync(current);
    } catch {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
