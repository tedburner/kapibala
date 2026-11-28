import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toNativePhysicalPath } from '@kiturone/kapibala';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ExecutionRootCoordinator,
  MAX_WORKTREE_INCLUDE_FILE_BYTES,
  WorktreeError,
  WorktreeService,
  copyWorktreeIncludeFiles,
  verifyManagedWorktreeLink,
} from '../src/host/worktree/index.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return toNativePhysicalPath(dir);
}

function gitIn(cwd: string, args: readonly string[]): string {
  const fullArgs =
    process.platform === 'win32' ? ['-c', 'core.longpaths=true', ...args] : [...args];
  return execFileSync('git', fullArgs, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test Author',
      GIT_AUTHOR_EMAIL: 'author@example.com',
      GIT_COMMITTER_NAME: 'Test Author',
      GIT_COMMITTER_EMAIL: 'author@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

function initMainGitRepo(): string {
  const repo = makeTempDir('kpbl-wt-repo-');
  gitIn(repo, ['init', '-b', 'main']);
  gitIn(repo, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(
    path.join(repo, '.gitignore'),
    'node_modules/\n.env\n.env.*\nconfig/*.local.json\nhuge.ignored\nlink.ignored\n',
    'utf8',
  );
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'shared.ts'), 'export const value = "base";\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'README.md'), '# Demo Repo\n', 'utf8');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-m', 'init main']);
  return repo;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('WorktreeService & ExecutionRootCoordinator', () => {
  it('creates kpbl/<slug>-<bucket> worktree, falls back on refs/heads/kpbl D/F collision, copies .worktreeinclude, and verifies 4-step link', async () => {
    const fakeHome = makeTempDir('kpbl-wt-home-');
    const repo = initMainGitRepo();

    // 准备 .worktreeinclude 及各类被忽略/未忽略/超大文件以校验精准拷贝边界。
    fs.writeFileSync(
      path.join(repo, '.worktreeinclude'),
      [
        '# Copy local env and local config',
        '.env*',
        '!.env.secret',
        'config/*.local.json',
        'huge.ignored',
      ].join('\n'),
      'utf8',
    );
    fs.writeFileSync(path.join(repo, '.env'), 'PORT=3000\n', 'utf8');
    fs.writeFileSync(path.join(repo, '.env.local'), 'API_BASE=http://localhost:4000\n', 'utf8');
    fs.writeFileSync(path.join(repo, '.env.secret'), 'DO_NOT_COPY=1\n', 'utf8');
    fs.mkdirSync(path.join(repo, 'config'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'config', 'dev.local.json'), '{"debug":true}\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'untracked-not-ignored.txt'), 'not ignored\n', 'utf8');

    const hugeIgnored = path.join(repo, 'huge.ignored');
    const fd = fs.openSync(hugeIgnored, 'w');
    fs.ftruncateSync(fd, MAX_WORKTREE_INCLUDE_FILE_BYTES + 512);
    fs.closeSync(fd);

    const service = new WorktreeService({
      homeDir: fakeHome,
      hostEnv: {
        ...process.env,
        GIT_DIR: path.join(fakeHome, 'poison-git'),
        NODE_OPTIONS: '--invalid-flag',
      },
    });

    const wt1 = await service.create({
      projectRoot: repo,
      name: 'Fix Auth Flow!',
      relativeCwd: 'src',
    });

    expect(wt1.binding.branch).toMatch(/^kpbl\/fix-auth-flow-[0-9a-f]{4}$/);
    expect(wt1.binding.baseRef).toBe('main');
    expect(wt1.executionCwd).toBe(path.join(wt1.binding.worktreePath, 'src'));
    expect(wt1.copiedIncludeFiles).toEqual(['.env', '.env.local', 'config/dev.local.json']);
    expect(fs.readFileSync(path.join(wt1.binding.worktreePath, '.env.local'), 'utf8')).toBe(
      'API_BASE=http://localhost:4000\n',
    );
    expect(fs.existsSync(path.join(wt1.binding.worktreePath, '.env.secret'))).toBe(false);
    expect(fs.existsSync(path.join(wt1.binding.worktreePath, 'untracked-not-ignored.txt'))).toBe(
      false,
    );
    expect(fs.existsSync(path.join(wt1.binding.worktreePath, 'huge.ignored'))).toBe(false);

    // 4 步 `.git` 双向回链验真通过。
    expect(
      verifyManagedWorktreeLink({
        worktreesRoot: service.worktreesRoot,
        projectRoot: repo,
        worktreePath: wt1.binding.worktreePath,
      }),
    ).toBe(true);

    // 构造伪造的 .git 指针目录（指向真实 worktree adminDir，但 adminDir/gitdir 反向不指回伪造目录），必须闭合拒绝！
    const spoofDir = path.join(service.worktreesRoot, 'ffff', 'spoof');
    fs.mkdirSync(spoofDir, { recursive: true });
    fs.writeFileSync(
      path.join(spoofDir, '.git'),
      fs.readFileSync(path.join(wt1.binding.worktreePath, '.git'), 'utf8'),
      'utf8',
    );
    expect(
      verifyManagedWorktreeLink({
        worktreesRoot: service.worktreesRoot,
        projectRoot: repo,
        worktreePath: spoofDir,
      }),
    ).toBe(false);
    fs.rmSync(path.join(service.worktreesRoot, 'ffff'), { recursive: true, force: true });

    // 先移除 wt1 以释放 refs/heads/kpbl/* 命名空间，然后在主仓创建单文件分支 `kpbl`，验证 D/F 冲突自动扁平回退！
    const rm1 = await service.remove({ id: wt1.binding.id });
    expect(rm1).toEqual({ removed: true, id: wt1.binding.id });

    gitIn(repo, ['branch', 'kpbl']);
    const wt2 = await service.create({
      projectRoot: repo,
      name: 'Refactor UI',
    });
    expect(wt2.binding.branch).toMatch(/^kpbl-refactor-ui-[0-9a-f]{4}$/);

    // 当主仓处于未决合并态（存在 MERGE_HEAD）时，必须拒绝新建工作树。
    const mergeHeadFile = path.join(repo, '.git', 'MERGE_HEAD');
    fs.writeFileSync(mergeHeadFile, `${wt2.binding.baseCommit}\n`, 'utf8');
    try {
      await expect(service.create({ projectRoot: repo, name: 'Blocked' })).rejects.toMatchObject({
        code: 'WORKTREE_REPO_UNMERGED',
      });
    } finally {
      fs.unlinkSync(mergeHeadFile);
    }
  });

  it('performs conflict-isolated previewMerge + applyMerge: clean fast-forward, stale token rejection, and conflict isolation leaving projectRoot untouched', async () => {
    const fakeHome = makeTempDir('kpbl-wt-home-');
    const repo = initMainGitRepo();
    const service = new WorktreeService({ homeDir: fakeHome });

    // 场景 A：工作树有未提交新功能，同时主仓在另一文件推进了 1 个提交 -> 预合并 + 主仓原子快进。
    const wtClean = await service.create({ projectRoot: repo, name: 'Add Feature' });
    fs.writeFileSync(
      path.join(wtClean.binding.worktreePath, 'src', 'feature.ts'),
      'export const feature = 42;\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(wtClean.binding.worktreePath, 'src', 'shared.ts'),
      'export const value = "base";\nexport const extra = true;\n',
      'utf8',
    );

    const statusSnap = await service.status(wtClean.binding.id);
    expect(statusSnap.dirty).toBe(true);
    expect(statusSnap.untrackedCount).toBe(1);
    expect(statusSnap.changedFiles.map((f) => f.path)).toEqual(['src/feature.ts', 'src/shared.ts']);

    const wtDiff = await service.diff(wtClean.binding.id);
    expect(wtDiff.files.map((f) => f.path)).toEqual(['src/feature.ts', 'src/shared.ts']);
    expect(wtDiff.files[0]?.patch).toContain('+export const feature = 42;');
    expect(wtDiff.files[1]?.patch).toContain('+export const extra = true;');
    // 还原 shared.ts 以便后续专门验证后续场景 B 的同文件冲突。
    fs.writeFileSync(
      path.join(wtClean.binding.worktreePath, 'src', 'shared.ts'),
      'export const value = "base";\n',
      'utf8',
    );

    gitIn(repo, ['checkout', 'main']);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Demo Repo\n\nUpdated on main.\n', 'utf8');
    gitIn(repo, ['add', 'README.md']);
    gitIn(repo, ['commit', '-m', 'docs: update readme on main']);

    const stalePreview = await service.previewMerge(wtClean.binding.id);
    expect(stalePreview.behindCount).toBe(1);
    expect(stalePreview.worktreeDirty).toBe(true);
    expect(stalePreview.changedFiles.map((f) => f.path)).toEqual(['src/feature.ts']);

    // 在工作树继续追加修改使 previewToken 失效，断言拒绝陈旧预览。
    fs.writeFileSync(
      path.join(wtClean.binding.worktreePath, 'src', 'feature.ts'),
      'export const feature = 99;\n',
      'utf8',
    );
    await expect(
      service.applyMerge({ id: wtClean.binding.id, previewToken: stalePreview.previewToken }),
    ).rejects.toMatchObject({ code: 'WORKTREE_MERGE_STALE_PREVIEW' });

    const freshPreview = await service.previewMerge(wtClean.binding.id);
    const mergeRes = await service.applyMerge({
      id: wtClean.binding.id,
      previewToken: freshPreview.previewToken,
      commitMessage: 'feat: land worktree feature',
    });
    expect(mergeRes.status).toBe('merged');
    expect(fs.readFileSync(path.join(repo, 'src', 'feature.ts'), 'utf8')).toBe(
      'export const feature = 99;\n',
    );
    expect(fs.readFileSync(path.join(repo, 'README.md'), 'utf8')).toContain('Updated on main.');
    expect(gitIn(repo, ['status', '--porcelain'])).toBe('');

    // 已合并且干净的工作树无需 force 即可安全移除。
    const cleanRemove = await service.remove({ id: wtClean.binding.id });
    expect(cleanRemove).toEqual({ removed: true, id: wtClean.binding.id });

    // 场景 B：真实代码冲突必须 100% 隔离在工作树内部，主工作区保持零改动零冲突！
    const wtConflict = await service.create({ projectRoot: repo, name: 'Conflicting Edit' });
    fs.writeFileSync(
      path.join(wtConflict.binding.worktreePath, 'src', 'shared.ts'),
      'export const value = "from-worktree";\n',
      'utf8',
    );
    gitIn(wtConflict.binding.worktreePath, ['add', 'src/shared.ts']);
    gitIn(wtConflict.binding.worktreePath, ['commit', '-m', 'feat: worktree shared change']);

    fs.writeFileSync(
      path.join(repo, 'src', 'shared.ts'),
      'export const value = "from-main";\n',
      'utf8',
    );
    gitIn(repo, ['add', 'src/shared.ts']);
    gitIn(repo, ['commit', '-m', 'feat: main shared change']);

    const conflictPreview = await service.previewMerge(wtConflict.binding.id);
    const conflictOutcome = await service.applyMerge({
      id: wtConflict.binding.id,
      previewToken: conflictPreview.previewToken,
    });

    expect(conflictOutcome).toEqual({
      status: 'conflict',
      conflictedFiles: ['src/shared.ts'],
    });

    // 主工作区必须毫发无损、无 MERGE_HEAD、无未决冲突！
    expect(gitIn(repo, ['status', '--porcelain'])).toBe('');
    expect(fs.existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect(fs.readFileSync(path.join(repo, 'src', 'shared.ts'), 'utf8')).toBe(
      'export const value = "from-main";\n',
    );
  });

  it('safely unlinks Windows NTFS junctions inside worktree without deleting target files in projectRoot', async () => {
    const fakeHome = makeTempDir('kpbl-wt-home-');
    const repo = initMainGitRepo();

    // 在主仓内准备被软链/Junction 指向的目标目录与关键文件。
    const targetPkgDir = path.join(repo, 'vendor-store', 'critical-pkg');
    fs.mkdirSync(targetPkgDir, { recursive: true });
    const criticalFile = path.join(targetPkgDir, 'index.js');
    const nestedCriticalFile = path.join(targetPkgDir, 'sub', 'data.json');
    fs.mkdirSync(path.dirname(nestedCriticalFile), { recursive: true });
    fs.writeFileSync(criticalFile, 'module.exports = "MUST_SURVIVE";\n', 'utf8');
    fs.writeFileSync(nestedCriticalFile, '{"intact":true}\n', 'utf8');
    gitIn(repo, ['add', 'vendor-store']);
    gitIn(repo, ['commit', '-m', 'chore: add vendor store']);

    const service = new WorktreeService({ homeDir: fakeHome });
    const wt = await service.create({ projectRoot: repo, name: 'Junction Test' });

    const wtNodeModules = path.join(wt.binding.worktreePath, 'node_modules');
    fs.mkdirSync(wtNodeModules, { recursive: true });
    const junctionPath = path.join(wtNodeModules, 'critical-pkg');
    fs.symlinkSync(targetPkgDir, junctionPath, process.platform === 'win32' ? 'junction' : 'dir');
    expect(fs.lstatSync(junctionPath).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(junctionPath, 'index.js'))).toBe(true);

    const removeResult = await service.remove({ id: wt.binding.id });
    expect(removeResult).toEqual({ removed: true, id: wt.binding.id });
    expect(fs.existsSync(wt.binding.worktreePath)).toBe(false);

    // 断言主仓被链接目录内的全部文件 100% 完好！
    expect(fs.existsSync(criticalFile)).toBe(true);
    expect(fs.readFileSync(criticalFile, 'utf8')).toBe('module.exports = "MUST_SURVIVE";\n');
    expect(fs.existsSync(nestedCriticalFile)).toBe(true);
    expect(fs.readFileSync(nestedCriticalFile, 'utf8')).toBe('{"intact":true}\n');
  });

  it('enforces 3-way dirty / unmerged_commits / .env.local checks before removal unless force: true', async () => {
    const fakeHome = makeTempDir('kpbl-wt-home-');
    const repo = initMainGitRepo();
    const service = new WorktreeService({ homeDir: fakeHome });
    const wt = await service.create({ projectRoot: repo, name: 'Safety Guards' });

    // 1. 未提交脏文件拦截。
    const dirtyFile = path.join(wt.binding.worktreePath, 'untracked.ts');
    fs.writeFileSync(dirtyFile, 'export const wip = 1;\n', 'utf8');
    const dirtyCheck = await service.remove({ id: wt.binding.id });
    expect(dirtyCheck).toEqual({
      removed: false,
      reason: 'dirty',
      details: ['untracked.ts'],
    });

    // 2. 提交后变为未合并提交拦截。
    gitIn(wt.binding.worktreePath, ['add', 'untracked.ts']);
    gitIn(wt.binding.worktreePath, ['commit', '-m', 'wip commit']);
    const unmergedCheck = await service.remove({ id: wt.binding.id });
    expect(unmergedCheck.removed).toBe(false);
    if (!unmergedCheck.removed) {
      expect(unmergedCheck.reason).toBe('unmerged_commits');
    }

    // 重置回基线提交，写入仅存在于工作树中的被忽略敏感文件 `.env.local`，验证第 3 路敏感文件拦截。
    gitIn(wt.binding.worktreePath, ['reset', '--hard', wt.binding.baseCommit]);
    fs.writeFileSync(
      path.join(wt.binding.worktreePath, '.env.local'),
      'NEW_UNSAVED_TOKEN=local-only\n',
      'utf8',
    );
    const envCheck = await service.remove({ id: wt.binding.id });
    expect(envCheck).toEqual({
      removed: false,
      reason: 'at_risk_ignored_files',
      details: ['.env.local'],
    });

    // 推进一个未合并提交并执行 force: true 强制清理，验证目录、注册表与本地分支一并移除。
    fs.writeFileSync(dirtyFile, 'export const forceDrop = true;\n', 'utf8');
    gitIn(wt.binding.worktreePath, ['add', 'untracked.ts']);
    gitIn(wt.binding.worktreePath, ['commit', '-m', 'unmerged before force remove']);

    const forced = await service.remove({ id: wt.binding.id, force: true });
    expect(forced).toEqual({ removed: true, id: wt.binding.id });
    expect(fs.existsSync(wt.binding.worktreePath)).toBe(false);
    expect(service.get(wt.binding.id)).toBeUndefined();
    const branches = gitIn(repo, ['branch', '--list', wt.binding.branch]);
    expect(branches).toBe('');
  });

  it('coordinates cross-subsystem execution leases, removal fences, and SubagentWorktreeProvider lifecycle', async () => {
    const fakeHome = makeTempDir('kpbl-wt-home-');
    const repo = initMainGitRepo();
    const coordinator = new ExecutionRootCoordinator();
    const service = new WorktreeService({ homeDir: fakeHome, coordinator });

    // 验证跨 native / external 互斥排队与活动运行期间阻止删除工作树。
    const wt = await service.create({ projectRoot: repo, name: 'Active Guard' });
    const order: string[] = [];
    const lease1 = await coordinator.acquireMutatingLease({
      executionRoot: wt.binding.worktreePath,
      ownerId: 'native-sess-1',
      kind: 'native',
    });
    order.push('native-acquired');

    const externalPromise = coordinator
      .acquireMutatingLease({
        executionRoot: wt.binding.worktreePath,
        ownerId: 'ext-sess-1',
        kind: 'external',
      })
      .then((lease2) => {
        order.push('external-acquired');
        lease2.release();
      });

    // 活动运行进行中尝试移除工作树必须抛 WORKTREE_ACTIVE_RUN。
    await expect(service.remove({ id: wt.binding.id, force: true })).rejects.toBeInstanceOf(
      WorktreeError,
    );
    await expect(service.remove({ id: wt.binding.id, force: true })).rejects.toMatchObject({
      code: 'WORKTREE_ACTIVE_RUN',
    });

    lease1.release();
    await externalPromise;
    expect(order).toEqual(['native-acquired', 'external-acquired']);

    // 门闩期间拒绝启动任何新运行。
    const fence = coordinator.acquireRemovalFence(wt.binding.worktreePath);
    expect(() =>
      coordinator.trackActiveRun({
        executionRoot: wt.binding.worktreePath,
        ownerId: 'blocked-run',
        kind: 'native',
      }),
    ).toThrowError(WorktreeError);
    fence.release();
    await service.remove({ id: wt.binding.id, force: true });

    // 验证 SubagentWorktreeProvider：无改动的 ephemeral 自动清理；有改动或 detached 自动保留。
    const provider = service.asSubagentWorktreeProvider();

    const ephClean = await provider.allocate({
      agentId: 'ag-clean',
      projectRoot: repo,
      relativeCwd: '.',
      description: 'Readonly explore',
      mode: 'ephemeral',
    });
    expect(fs.existsSync(ephClean.workspaceRoot)).toBe(true);
    await provider.release({
      binding: ephClean.binding,
      mode: 'ephemeral',
      status: 'completed',
    });
    expect(fs.existsSync(ephClean.workspaceRoot)).toBe(false);

    const ephDirty = await provider.allocate({
      agentId: 'ag-dirty',
      projectRoot: repo,
      relativeCwd: '.',
      description: 'Write patch',
      mode: 'ephemeral',
    });
    fs.writeFileSync(path.join(ephDirty.workspaceRoot, 'patch.txt'), 'useful output\n', 'utf8');
    await provider.release({
      binding: ephDirty.binding,
      mode: 'ephemeral',
      status: 'completed',
    });
    expect(fs.existsSync(ephDirty.workspaceRoot)).toBe(true);

    const detachedClean = await provider.allocate({
      agentId: 'ag-detached',
      projectRoot: repo,
      relativeCwd: '.',
      description: 'Delegated worker',
      mode: 'detached',
    });
    await provider.release({
      binding: detachedClean.binding,
      mode: 'detached',
      status: 'completed',
    });
    expect(fs.existsSync(detachedClean.workspaceRoot)).toBe(true);

    // detached 模式若因容量超限或早期取消进入 failed / cancelled 且零提交零脏改动，应自动回收空工作树避免孤儿泄漏。
    const detachedFailedClean = await provider.allocate({
      agentId: 'ag-detached-failed-clean',
      projectRoot: repo,
      relativeCwd: '.',
      description: 'Delegated quota rejected',
      mode: 'detached',
    });
    await provider.release({
      binding: detachedFailedClean.binding,
      mode: 'detached',
      status: 'failed',
    });
    expect(fs.existsSync(detachedFailedClean.workspaceRoot)).toBe(false);

    // detached 模式若已产生修改后再失败，必须保留工作树防丢代码。
    const detachedFailedDirty = await provider.allocate({
      agentId: 'ag-detached-failed-dirty',
      projectRoot: repo,
      relativeCwd: '.',
      description: 'Delegated partial edit',
      mode: 'detached',
    });
    fs.writeFileSync(
      path.join(detachedFailedDirty.workspaceRoot, 'partial.ts'),
      'export const wip = true;\n',
      'utf8',
    );
    await provider.release({
      binding: detachedFailedDirty.binding,
      mode: 'detached',
      status: 'failed',
    });
    expect(fs.existsSync(detachedFailedDirty.workspaceRoot)).toBe(true);
  });

  it('releases 1st merge fence when 2nd fence fails, blocks unresolved conflict re-merge, catches untracked subdir collisions, and skips dangling symlinks in .worktreeinclude', async () => {
    const fakeHome = makeTempDir('kpbl-wt-reg-home-');
    const repo = initMainGitRepo();
    const coordinator = new ExecutionRootCoordinator();
    const service = new WorktreeService({ homeDir: fakeHome, coordinator });

    const wt = await service.create({ projectRoot: repo, name: 'Merge Regression' });
    fs.writeFileSync(
      path.join(wt.binding.worktreePath, 'src', 'shared.ts'),
      'export const value = "wt-side";\n',
      'utf8',
    );
    gitIn(wt.binding.worktreePath, ['add', 'src/shared.ts']);
    gitIn(wt.binding.worktreePath, ['commit', '-m', 'feat: wt change']);

    // 1. Fence 泄漏回归：锁住字典序第 2 个目录的活动运行，触发 applyMerge 第 2 把门闩抛 WORKTREE_ACTIVE_RUN，断言第 1 个目录未残留死门闩。
    const ordered = [repo, wt.binding.worktreePath].sort((a, b) => a.localeCompare(b));
    const firstRoot = ordered[0]!;
    const secondRoot = ordered[1]!;
    const activeOnSecond = coordinator.trackActiveRun({
      executionRoot: secondRoot,
      ownerId: 'busy-second',
      kind: 'native',
    });
    const initPreview = await service.previewMerge(wt.binding.id);
    try {
      await expect(
        service.applyMerge({ id: wt.binding.id, previewToken: initPreview.previewToken }),
      ).rejects.toMatchObject({ code: 'WORKTREE_ACTIVE_RUN' });
    } finally {
      activeOnSecond.release();
    }
    expect(coordinator.isFenced(firstRoot)).toBe(false);
    expect(coordinator.isFenced(secondRoot)).toBe(false);

    // 2. 主仓未跟踪子目录碰撞回归：工作树新增 newdir/sub.ts，主仓存在未跟踪 newdir/sub.ts 时预检拦截并返回 WORKTREE_MAIN_DIRTY。
    fs.mkdirSync(path.join(wt.binding.worktreePath, 'newdir'), { recursive: true });
    fs.writeFileSync(
      path.join(wt.binding.worktreePath, 'newdir', 'sub.ts'),
      'export const sub = "wt";\n',
      'utf8',
    );
    gitIn(wt.binding.worktreePath, ['add', 'newdir/sub.ts']);
    gitIn(wt.binding.worktreePath, ['commit', '-m', 'feat: add newdir/sub.ts']);

    fs.mkdirSync(path.join(repo, 'newdir'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'newdir', 'sub.ts'),
      'export const sub = "main-untracked";\n',
      'utf8',
    );
    const subdirCollisionPreview = await service.previewMerge(wt.binding.id);
    expect(subdirCollisionPreview.canApply).toBe(false);
    expect(subdirCollisionPreview.blockingReason).toContain('newdir/sub.ts');
    await expect(
      service.applyMerge({
        id: wt.binding.id,
        previewToken: subdirCollisionPreview.previewToken,
      }),
    ).rejects.toMatchObject({ code: 'WORKTREE_MAIN_DIRTY' });
    fs.rmSync(path.join(repo, 'newdir'), { recursive: true, force: true });

    // 3. 未决冲突二次合并防护：制造真实合并冲突后，未解决冲突直接再次 previewMerge + applyMerge 绝不能把 `<<<<<<<` 快进合入主分支！
    fs.writeFileSync(
      path.join(repo, 'src', 'shared.ts'),
      'export const value = "main-side";\n',
      'utf8',
    );
    gitIn(repo, ['add', 'src/shared.ts']);
    gitIn(repo, ['commit', '-m', 'feat: main conflicting edit']);
    const mainHeadBefore = gitIn(repo, ['rev-parse', 'HEAD']);

    const p1 = await service.previewMerge(wt.binding.id);
    expect(p1.canApply).toBe(true);
    const firstMerge = await service.applyMerge({
      id: wt.binding.id,
      previewToken: p1.previewToken,
    });
    expect(firstMerge).toEqual({ status: 'conflict', conflictedFiles: ['src/shared.ts'] });
    expect(
      fs.readFileSync(path.join(wt.binding.worktreePath, 'src', 'shared.ts'), 'utf8'),
    ).toContain('<<<<<<<');

    // 未解决冲突直接重新预览与合并：previewMerge 必须置 canApply = false，applyMerge 必须抛 WORKTREE_REPO_UNMERGED。
    const p2 = await service.previewMerge(wt.binding.id);
    expect(p2.canApply).toBe(false);
    expect(p2.blockingReason).toContain('冲突');
    await expect(
      service.applyMerge({ id: wt.binding.id, previewToken: p2.previewToken }),
    ).rejects.toMatchObject({ code: 'WORKTREE_REPO_UNMERGED' });

    // 即使用户误执行 `git add` 暂存了带冲突标记的文件而未完成清理提交，MERGE_HEAD 与冲突标记守卫仍必须拦截。
    gitIn(wt.binding.worktreePath, ['add', 'src/shared.ts']);
    const p3 = await service.previewMerge(wt.binding.id);
    expect(p3.canApply).toBe(false);
    await expect(
      service.applyMerge({ id: wt.binding.id, previewToken: p3.previewToken }),
    ).rejects.toMatchObject({ code: 'WORKTREE_REPO_UNMERGED' });
    expect(gitIn(repo, ['rev-parse', 'HEAD'])).toBe(mainHeadBefore);
    expect(fs.readFileSync(path.join(repo, 'src', 'shared.ts'), 'utf8')).toBe(
      'export const value = "main-side";\n',
    );

    // 4. `.worktreeinclude` 悬空文件软链防护：工作树内目标位置已存在指向外部不存在路径的悬空软链时必须跳过。
    const outsideTarget = path.join(fakeHome, 'dangling-symlink-target.txt');
    fs.writeFileSync(path.join(repo, '.worktreeinclude'), 'link.ignored\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'link.ignored'), 'SENSITIVE_ENV=1\n', 'utf8');
    const danglingDest = path.join(wt.binding.worktreePath, 'link.ignored');
    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideTarget, danglingDest, 'file');
      symlinkCreated = true;
    } catch {
      symlinkCreated = false;
    }
    if (symlinkCreated) {
      expect(fs.existsSync(danglingDest)).toBe(false);
      expect(fs.lstatSync(danglingDest).isSymbolicLink()).toBe(true);
      const copied = await copyWorktreeIncludeFiles({
        projectRoot: repo,
        worktreePath: wt.binding.worktreePath,
      });
      expect(copied).not.toContain('link.ignored');
      expect(fs.existsSync(outsideTarget)).toBe(false);
    }
  });
});
