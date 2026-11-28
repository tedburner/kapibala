/**
 * @fileoverview Shadow Git 侧挂裸仓双模初始化、三层未跟踪预算过滤与增量索引捕获流水线。
 *
 * 核心不变量：
 * 1. 双模无缝兼容：宿主是 Git 仓库（含 Worktree）时，通过 `objects/info/alternates` 共享对象库并预热
 *    初始索引实现零拷贝秒级建库；宿主是普通非 Git 文件夹时直接初始化独立侧挂库；
 * 2. 零钩子、零主仓污染：将 `core.hooksPath` 显式指向侧挂受控空目录（经 INI 引号转义，规避空值在 Windows 被当成盘符根及特殊用户名注释截断），
 *    一切暂存操作在 `<sideGitDir>/index.tmp-<pid>-<seq>` 上完成，再原子替换 `<sideGitDir>/index`；
 * 3. 三层未跟踪硬预算：单文件 ≤ 10 MiB、单目录 ≤ 200 文件、单次累计新增 ≤ 64 MiB，且自动剔除嵌套 `.git` 子仓。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPathInside, isSamePath, toNativePhysicalPath } from '@kiturone/kapibala';
import { isUnsafeCheckpointRoot, runGit, splitNulStrings } from './git-exec.js';
import { renameAtomicSync } from './lock.js';
import {
  BUILTIN_EXCLUDES,
  MAX_UNTRACKED_DIR_FILES,
  MAX_UNTRACKED_FILE_BYTES,
  MAX_UNTRACKED_TOTAL_BYTES,
} from './types.js';

let tempIndexSeq = 0;

/**
 * 宿主工作区所属用户 Git 仓库定位信息（普通非 Git 文件夹时为 `undefined`）：
 * 区分单工作树索引目录 `userGitDir` 与共享对象库目录 `userCommonGitDir`，使 Linked Worktree 也能正确挂载 `alternates`。
 */
export interface HostGitRepoInfo {
  readonly topLevel: string;
  readonly userGitDir: string;
  readonly userCommonGitDir: string;
}

/** 单次工作区树扫描结果：携带根 Tree OID（全空目录走空树快速路径）及被三层未跟踪预算过滤掉的相对路径列表。 */
export interface CapturedTreeSnapshot {
  readonly treeOid: string;
  readonly skippedUntrackedFiles: readonly string[];
}

/**
 * 探测 `executionRoot` 是否位于真实合法的用户 Git 仓库内。
 *
 * 防御边界：若机器在 `$HOME` 或系统临时目录根意外存在残留 `.git`，显式排除此类高危祖先仓，
 * 确保测试临时目录或用户普通文件夹不会被误绑到外层无关仓库。
 */
export async function detectHostGitRepo(options: {
  readonly executionRoot: string;
  readonly projectRoot: string;
  readonly homeDir?: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<HostGitRepoInfo | undefined> {
  const res = await runGit({
    cwd: options.executionRoot,
    args: ['rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir'],
    baseEnv: options.baseEnv,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    allowedExitCodes: [0, 128],
  });
  if (res.exitCode !== 0) return undefined;

  const lines = res.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 3) return undefined;

  let topLevel: string;
  let userCommonGitDir: string;
  let userGitDir: string;
  try {
    topLevel = toNativePhysicalPath(path.resolve(options.executionRoot, lines[0]!));
    userCommonGitDir = toNativePhysicalPath(path.resolve(options.executionRoot, lines[1]!));
    userGitDir = toNativePhysicalPath(path.resolve(options.executionRoot, lines[2]!));
  } catch {
    return undefined;
  }

  if (isUnsafeCheckpointRoot(topLevel, options.homeDir, options.baseEnv)) {
    return undefined;
  }
  try {
    const canonicalTmp = toNativePhysicalPath(os.tmpdir());
    if (isSamePath(topLevel, canonicalTmp)) {
      return undefined;
    }
  } catch {
    /* 忽略 tmpdir 规范化异常。 */
  }

  // 若宿主打开的是独立普通目录（与 projectRoot 相同且自身无 .git），不吸收项目根之外的父级偶然 .git。
  const relatesToProject =
    isSamePath(topLevel, options.executionRoot) ||
    isPathInside(topLevel, options.projectRoot) ||
    isPathInside(options.projectRoot, topLevel);
  if (!relatesToProject) {
    return undefined;
  }
  // 额外防护：若 projectRoot 位于 topLevel 深层但 projectRoot 只是某个包含 stray .git 的父目录之下的独立目录，
  // 仅当 topLevel === projectRoot、topLevel 位于 projectRoot 内，或 projectRoot 显式在仓库内时接受。
  if (
    !isSamePath(topLevel, options.executionRoot) &&
    !isSamePath(topLevel, options.projectRoot) &&
    !isPathInside(options.projectRoot, topLevel) &&
    isSamePath(options.projectRoot, options.executionRoot) &&
    !fs.existsSync(path.join(options.executionRoot, '.git'))
  ) {
    // 若用户以单文件夹作为 projectRoot === executionRoot 且该目录自身无 .git，仅当父仓不是系统临时根之类目录才视为子目录模式。
    const tmpRoot = toNativePhysicalPath(os.tmpdir());
    if (isPathInside(tmpRoot, topLevel)) {
      return undefined;
    }
  }

  return { topLevel, userGitDir, userCommonGitDir };
}

/**
 * 确保侧挂 Git 裸仓 `<sideGitDir>` 已完成双模初始化、安全配置注入、排除表落盘与 `alternates` 预热。
 *
 * 幂等保证：已初始化的侧挂库仅做轻量 `alternates` 与 `info/exclude` 核验，不重复执行 `git init` 或覆盖已有缓存索引。
 */
export async function ensureSideRepo(options: {
  readonly sideGitDir: string;
  readonly executionRoot: string;
  readonly projectRoot: string;
  readonly homeDir?: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<{ readonly hostRepo?: HostGitRepoInfo }> {
  const { sideGitDir, executionRoot } = options;
  const markerPath = path.join(sideGitDir, '.kpbl-initialized');
  const headPath = path.join(sideGitDir, 'HEAD');
  const alreadyInitialized = fs.existsSync(markerPath) && fs.existsSync(headPath);
  const alternatesPathCandidate = path.join(sideGitDir, 'objects', 'info', 'alternates');

  // 快速路径：已初始化的非 Git 独立目录若仍不存在 .git，无需每次重复拉起 git rev-parse 探测祖先仓。
  const skipHostDetect =
    alreadyInitialized &&
    !fs.existsSync(alternatesPathCandidate) &&
    isSamePath(options.projectRoot, executionRoot) &&
    !fs.existsSync(path.join(executionRoot, '.git'));

  const hostRepo = skipHostDetect
    ? undefined
    : await detectHostGitRepo({
        executionRoot,
        projectRoot: options.projectRoot,
        homeDir: options.homeDir,
        baseEnv: options.baseEnv,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });

  if (!fs.existsSync(headPath)) {
    fs.mkdirSync(sideGitDir, { recursive: true, mode: 0o700 });
    await runGit({
      cwd: sideGitDir,
      args: ['init', '--bare', sideGitDir],
      baseEnv: options.baseEnv,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
  }

  // 显式指向侧挂受控空目录禁用一切 Git Hooks，防 Windows Git 将空 hooksPath 解析为磁盘根目录；
  // 同时对反斜杠与双引号做 INI 转义并用双引号包裹，防用户名/路径含 `;`、`#` 或尾随空格破坏 Git 配置解析。
  const emptyHooksDir = path.join(sideGitDir, 'empty-hooks');
  fs.mkdirSync(emptyHooksDir, { recursive: true, mode: 0o700 });
  const emptyHooksPosix = emptyHooksDir.replaceAll('\\', '/');
  const escapedHooksPosix = emptyHooksPosix.replaceAll('\\', '\\\\').replaceAll('"', '\\"');

  if (!fs.existsSync(markerPath)) {
    const configPath = path.join(sideGitDir, 'config');
    const existingConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
    const appendedSection = [
      '',
      '[core]',
      '\tautocrlf = false',
      '\tlongpaths = true',
      '\tfsmonitor = false',
      '\tquotepath = false',
      '\tsymlinks = true',
      `\thooksPath = "${escapedHooksPosix}"`,
      '[gc]',
      '\tauto = 0',
      '',
    ].join('\n');
    fs.writeFileSync(configPath, `${existingConfig.trimEnd()}\n${appendedSection}`, 'utf8');
  }

  // 始终保持内置排除规则最新。
  const excludeDir = path.join(sideGitDir, 'info');
  fs.mkdirSync(excludeDir, { recursive: true, mode: 0o700 });
  const excludePath = path.join(excludeDir, 'exclude');
  const excludeContent = `${BUILTIN_EXCLUDES.join('\n')}\n`;
  if (!fs.existsSync(excludePath) || fs.readFileSync(excludePath, 'utf8') !== excludeContent) {
    fs.writeFileSync(excludePath, excludeContent, 'utf8');
  }

  if (hostRepo) {
    const userObjectsDir = path.join(hostRepo.userCommonGitDir, 'objects');
    if (fs.existsSync(userObjectsDir)) {
      const alternatesDir = path.join(sideGitDir, 'objects', 'info');
      fs.mkdirSync(alternatesDir, { recursive: true, mode: 0o700 });
      const alternatesPath = path.join(alternatesDir, 'alternates');
      const desiredLine = `${userObjectsDir.replaceAll('\\', '/')}\n`;
      if (
        !fs.existsSync(alternatesPath) ||
        fs.readFileSync(alternatesPath, 'utf8') !== desiredLine
      ) {
        fs.writeFileSync(alternatesPath, desiredLine, 'utf8');
      }
    }

    // 仅当 executionRoot 恰为主仓/Worktree 顶层根且侧挂索引尚不存在时，复制主仓 index 预热 stat 缓存。
    const sideIndexPath = path.join(sideGitDir, 'index');
    const userIndexPath = path.join(hostRepo.userGitDir, 'index');
    if (
      !fs.existsSync(markerPath) &&
      !fs.existsSync(sideIndexPath) &&
      isSamePath(executionRoot, hostRepo.topLevel) &&
      fs.existsSync(userIndexPath)
    ) {
      try {
        const userIndexStat = fs.statSync(userIndexPath);
        if (userIndexStat.isFile()) {
          fs.copyFileSync(userIndexPath, sideIndexPath);
          await runGit({
            cwd: executionRoot,
            args: [
              '--git-dir',
              sideGitDir,
              '--work-tree',
              executionRoot,
              'update-index',
              '--no-split-index',
            ],
            baseEnv: options.baseEnv,
            timeoutMs: options.timeoutMs,
            signal: options.signal,
          });
          fs.utimesSync(sideIndexPath, userIndexStat.atime, userIndexStat.mtime);
        }
      } catch {
        // 若主仓使用了外部 sharedindex 或索引处于瞬态重写，安全退回空侧挂索引从头增量构建。
        fs.rmSync(sideIndexPath, { force: true });
      }
    }
  }

  if (!fs.existsSync(markerPath)) {
    fs.writeFileSync(markerPath, '1\n', 'utf8');
  }

  return { hostRepo };
}

/**
 * 在隔离临时索引上扫描工作区变动、执行三层未跟踪预算过滤并生成 Git `treeOid`。
 *
 * 参数 `persistIndex`：
 * - `true`（默认，用于 `capturePreTurn` / `capturePostTurn` / `pre-restore`）：原子替换回 `<sideGitDir>/index`；
 * - `false`（用于只读 `diff(includeLiveWorktree: true)`）：生成 `treeOid` 后直接销毁临时索引，零写副作用。
 */
export async function captureWorkingTree(options: {
  readonly sideGitDir: string;
  readonly executionRoot: string;
  readonly hostRepo?: HostGitRepoInfo;
  readonly persistIndex?: boolean;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<CapturedTreeSnapshot> {
  const { sideGitDir, executionRoot, hostRepo } = options;
  const persistIndex = options.persistIndex !== false;
  const sideIndexPath = path.join(sideGitDir, 'index');

  // 空目录快速路径：当工作区目录无任何条目（0 文件、0 子目录、0 隐藏项）时，工作区树恒为 Git 标准空树 OID；
  // 若 persistIndex 为真则同步清空旧侧挂索引，确保后续新增文件时从空基线准确暂存。
  const emptyTreeOid = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  try {
    if (fs.readdirSync(executionRoot).length === 0) {
      if (persistIndex && fs.existsSync(sideIndexPath)) {
        fs.rmSync(sideIndexPath, { force: true });
      }
      return { treeOid: emptyTreeOid, skippedUntrackedFiles: [] };
    }
  } catch {
    /* 回退常规 Git 索引扫描流程。 */
  }

  const tempIndexPath = path.join(
    sideGitDir,
    `index.tmp-${process.pid}-${++tempIndexSeq}-${Date.now()}`,
  );

  try {
    if (fs.existsSync(sideIndexPath)) {
      const stat = fs.statSync(sideIndexPath);
      fs.copyFileSync(sideIndexPath, tempIndexPath);
      fs.utimesSync(tempIndexPath, stat.atime, stat.mtime);
    } else {
      await runGit({
        cwd: sideGitDir,
        args: ['--git-dir', sideGitDir, 'read-tree', '--empty'],
        baseEnv: options.baseEnv,
        envOverrides: { GIT_INDEX_FILE: tempIndexPath },
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
    }

    // 刷新 stat 缓存，忽略返回码 1（存在待更新条目时的正常返回）；显式绑定 cwd 为 executionRoot 防进程处于子目录时计算非空 prefix。
    await runGit({
      cwd: executionRoot,
      args: [
        '--git-dir',
        sideGitDir,
        '--work-tree',
        executionRoot,
        'update-index',
        '-q',
        '--refresh',
      ],
      baseEnv: options.baseEnv,
      envOverrides: { GIT_INDEX_FILE: tempIndexPath },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      allowedExitCodes: [0, 1],
    });

    const [diffFilesRes, untrackedRes, trackedListRes] = await Promise.all([
      runGit({
        cwd: executionRoot,
        args: [
          '--git-dir',
          sideGitDir,
          '--work-tree',
          executionRoot,
          'diff-files',
          '--name-only',
          '-z',
        ],
        baseEnv: options.baseEnv,
        envOverrides: { GIT_INDEX_FILE: tempIndexPath },
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      }),
      runGit({
        cwd: executionRoot,
        args: [
          '--git-dir',
          sideGitDir,
          '--work-tree',
          executionRoot,
          'ls-files',
          '--others',
          '--exclude-standard',
          '-z',
        ],
        baseEnv: options.baseEnv,
        envOverrides: { GIT_INDEX_FILE: tempIndexPath },
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      }),
      runGit({
        cwd: sideGitDir,
        args: ['--git-dir', sideGitDir, 'ls-files', '-z'],
        baseEnv: options.baseEnv,
        envOverrides: { GIT_INDEX_FILE: tempIndexPath },
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      }),
    ]);

    const trackedTopDirs = new Set<string>();
    for (const trackedPath of splitNulStrings(trackedListRes.stdout)) {
      const slash = trackedPath.indexOf('/');
      if (slash > 0) trackedTopDirs.add(trackedPath.slice(0, slash));
    }

    const modifiedOrDeleted = filterSafeTrackedCandidates(
      executionRoot,
      splitNulStrings(diffFilesRes.stdout),
    );

    let untrackedCandidates = splitNulStrings(untrackedRes.stdout).filter(
      (rel) => rel.length > 0 && !rel.endsWith('/'),
    );

    // 若宿主本身位于用户 Git 仓库中，额外通过主仓 check-ignore 过滤主仓 .gitignore 与 .git/info/exclude 规则。
    if (hostRepo && untrackedCandidates.length > 0) {
      untrackedCandidates = await filterHostGitIgnored({
        executionRoot,
        candidates: untrackedCandidates,
        baseEnv: options.baseEnv,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
    }

    const { acceptedUntracked, skippedUntrackedFiles } = applyThreeTierUntrackedBudget(
      executionRoot,
      untrackedCandidates,
      trackedTopDirs,
    );

    const pathsToStage = Array.from(new Set([...modifiedOrDeleted, ...acceptedUntracked]));
    if (pathsToStage.length > 0) {
      const stdinPayload = Buffer.from(`${pathsToStage.join('\0')}\0`, 'utf8');
      await runGit({
        cwd: executionRoot,
        args: [
          '--git-dir',
          sideGitDir,
          '--work-tree',
          executionRoot,
          'update-index',
          '--add',
          '--remove',
          '--replace',
          '-z',
          '--stdin',
        ],
        input: stdinPayload,
        baseEnv: options.baseEnv,
        envOverrides: { GIT_INDEX_FILE: tempIndexPath },
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
    }

    const writeTreeRes = await runGit({
      cwd: sideGitDir,
      args: ['--git-dir', sideGitDir, 'write-tree'],
      baseEnv: options.baseEnv,
      envOverrides: { GIT_INDEX_FILE: tempIndexPath },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    const treeOid = writeTreeRes.stdout.toString('utf8').trim();

    if (persistIndex) {
      renameAtomicSync(tempIndexPath, sideIndexPath);
    }

    return { treeOid, skippedUntrackedFiles };
  } finally {
    if (fs.existsSync(tempIndexPath)) {
      fs.rmSync(tempIndexPath, { force: true });
    }
  }
}

/**
 * 使用 `commit-tree` 创建快照提交并写入 `refs/kpbl/...` 引用，确保对象图受原生 `git gc` 保护。
 */
export async function anchorTreeRef(options: {
  readonly sideGitDir: string;
  readonly treeOid: string;
  readonly refName: string;
  readonly message: string;
  readonly parentCommitOids?: readonly string[];
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<string> {
  const parentArgs: string[] = [];
  for (const parent of options.parentCommitOids ?? []) {
    if (parent) parentArgs.push('-p', parent);
  }
  const commitRes = await runGit({
    cwd: options.sideGitDir,
    args: [
      '--git-dir',
      options.sideGitDir,
      'commit-tree',
      options.treeOid,
      ...parentArgs,
      '-m',
      options.message,
    ],
    baseEnv: options.baseEnv,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  const commitOid = commitRes.stdout.toString('utf8').trim();
  await runGit({
    cwd: options.sideGitDir,
    args: ['--git-dir', options.sideGitDir, 'update-ref', options.refName, commitOid],
    baseEnv: options.baseEnv,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
  });
  return commitOid;
}

async function filterHostGitIgnored(options: {
  readonly executionRoot: string;
  readonly candidates: readonly string[];
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}): Promise<string[]> {
  const stdinBuf = Buffer.from(`${options.candidates.join('\0')}\0`, 'utf8');
  const res = await runGit({
    cwd: options.executionRoot,
    args: ['check-ignore', '--no-index', '-z', '--stdin'],
    input: stdinBuf,
    baseEnv: options.baseEnv,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    allowedExitCodes: [0, 1],
  });
  if (res.exitCode === 1 || res.stdout.length === 0) {
    return [...options.candidates];
  }
  const ignoredSet = new Set(splitNulStrings(res.stdout));
  return options.candidates.filter((item) => !ignoredSet.has(item));
}

function filterSafeTrackedCandidates(executionRoot: string, paths: readonly string[]): string[] {
  const result: string[] = [];
  for (const rel of paths) {
    if (!rel || rel === '.git' || rel.startsWith('.git/') || rel.includes('/.git/')) continue;
    const full = path.join(executionRoot, rel);
    try {
      const stat = fs.lstatSync(full);
      // 若已跟踪文件在磁盘上被替换成目录（例如嵌套子仓库目录），不直接塞进 update-index --add 以免产生 gitlink。
      if (stat.isDirectory()) continue;
    } catch {
      // 文件已删除时保留路径，交由 `update-index --remove` 从索引移除。
    }
    result.push(rel);
  }
  return result;
}

function hasNestedGitOrSymlinkParent(
  executionRoot: string,
  relPath: string,
  dirCache: Map<string, boolean>,
): boolean {
  const segments = relPath.split('/');
  if (segments.some((seg) => seg === '.git' || seg === '.kapibala')) return true;
  let acc = '';
  for (let i = 0; i < segments.length - 1; i++) {
    acc = acc ? `${acc}/${segments[i]!}` : segments[i]!;
    const cached = dirCache.get(acc);
    if (cached !== undefined) {
      if (cached) return true;
      continue;
    }
    const dirFull = path.join(executionRoot, acc);
    let unsafe = false;
    try {
      const stat = fs.lstatSync(dirFull);
      if (stat.isSymbolicLink() || fs.existsSync(path.join(dirFull, '.git'))) {
        unsafe = true;
      }
    } catch {
      unsafe = true;
    }
    dirCache.set(acc, unsafe);
    if (unsafe) return true;
  }
  return false;
}

function applyThreeTierUntrackedBudget(
  executionRoot: string,
  candidates: readonly string[],
  trackedTopDirs: ReadonlySet<string>,
): {
  readonly acceptedUntracked: string[];
  readonly skippedUntrackedFiles: string[];
} {
  const sorted = [...candidates].sort();
  const acceptedUntracked: string[] = [];
  const skippedUntrackedFiles: string[] = [];
  const parentDirCounts = new Map<string, number>();
  const untrackedTopDirCounts = new Map<string, number>();
  const unsafeParentCache = new Map<string, boolean>();
  let cumulativeBytes = 0;

  for (const rel of sorted) {
    if (hasNestedGitOrSymlinkParent(executionRoot, rel, unsafeParentCache)) {
      continue;
    }
    const fullPath = path.join(executionRoot, rel);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(fullPath);
    } catch {
      continue;
    }
    if (stat.isDirectory()) continue;

    const fileBytes = stat.isFile() ? stat.size : 0;

    // 第一层预算：单文件 ≤ 10 MiB。
    if (fileBytes > MAX_UNTRACKED_FILE_BYTES) {
      skippedUntrackedFiles.push(rel);
      continue;
    }

    // 第二层预算：单未跟踪父目录及新建顶层未跟踪目录文件数 ≤ 200。
    const parentDir = path.posix.dirname(rel);
    const parentCount = parentDirCounts.get(parentDir) ?? 0;
    const slashIdx = rel.indexOf('/');
    const topDir = slashIdx > 0 ? rel.slice(0, slashIdx) : undefined;
    const isUntrackedTop = topDir !== undefined && !trackedTopDirs.has(topDir);
    const topCount = isUntrackedTop ? (untrackedTopDirCounts.get(topDir) ?? 0) : 0;

    if (parentCount >= MAX_UNTRACKED_DIR_FILES || topCount >= MAX_UNTRACKED_DIR_FILES) {
      skippedUntrackedFiles.push(rel);
      continue;
    }

    // 第三层预算：单次新增未跟踪累计字节 ≤ 64 MiB。
    if (cumulativeBytes + fileBytes > MAX_UNTRACKED_TOTAL_BYTES) {
      skippedUntrackedFiles.push(rel);
      continue;
    }

    cumulativeBytes += fileBytes;
    parentDirCounts.set(parentDir, parentCount + 1);
    if (isUntrackedTop && topDir !== undefined) {
      untrackedTopDirCounts.set(topDir, topCount + 1);
    }
    acceptedUntracked.push(rel);
  }

  return { acceptedUntracked, skippedUntrackedFiles };
}
