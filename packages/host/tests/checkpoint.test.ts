import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionLock, toNativePhysicalPath } from '@kiturone/kapibala';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BUILTIN_EXCLUDES,
  CheckpointService,
  MAX_SINGLE_FILE_PATCH_BYTES,
  MAX_UNTRACKED_DIR_FILES,
  MAX_UNTRACKED_FILE_BYTES,
  isUnsafeCheckpointRoot,
  toSafeRefSegment,
} from '../src/host/checkpoint/index.js';

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
      GIT_AUTHOR_NAME: 'Test User',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test User',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_TERMINAL_PROMPT: '0',
    },
  }).trim();
}

function initSampleGitRepo(): string {
  const repo = makeTempDir('kpbl-ckpt-repo-');
  gitIn(repo, ['init', '-b', 'main']);
  gitIn(repo, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '*.secret\nignored_out/\n', 'utf8');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const version = 0;\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'src', 'keep.ts'), 'export const keep = true;\n', 'utf8');
  fs.writeFileSync(path.join(repo, 'src', 'legacy.ts'), 'export const legacy = 1;\n', 'utf8');
  gitIn(repo, ['add', '-A']);
  gitIn(repo, ['commit', '-m', 'initial commit']);
  return repo;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('CheckpointService', () => {
  it('refuses filesystem root, $HOME, and top-level personal directories while allowing deep workspaces', async () => {
    const fakeHome = makeTempDir('kpbl-ckpt-home-');
    for (const sub of ['Desktop', 'Documents', 'Downloads', 'Library', 'AppData']) {
      fs.mkdirSync(path.join(fakeHome, sub), { recursive: true });
    }
    const defaultWorkspace = path.join(fakeHome, '.kapibala', 'workspaces', 'default');
    fs.mkdirSync(defaultWorkspace, { recursive: true });

    const service = new CheckpointService({ homeDir: fakeHome });
    const fsRoot = path.parse(fakeHome).root;

    const rootCheck = await service.checkAvailability({
      projectRoot: fsRoot,
      executionRoot: fsRoot,
    });
    expect(rootCheck).toEqual({ available: false, reason: 'unsafe_root' });

    const homeCheck = await service.checkAvailability({
      projectRoot: fakeHome,
      executionRoot: fakeHome,
    });
    expect(homeCheck).toEqual({ available: false, reason: 'unsafe_root' });

    for (const sub of ['Desktop', 'Documents', 'Downloads', 'Library', 'AppData']) {
      const target = path.join(fakeHome, sub);
      const check = await service.checkAvailability({
        projectRoot: target,
        executionRoot: target,
      });
      expect(check).toEqual({ available: false, reason: 'unsafe_root' });

      const pre = await service.capturePreTurn({
        projectRoot: target,
        executionRoot: target,
        sessionId: 'sess-unsafe',
        ordinal: 0,
      });
      expect(pre).toEqual({ captured: false, skipped: true, reason: 'unsafe_root' });
    }

    const safeCheck = await service.checkAvailability({
      projectRoot: defaultWorkspace,
      executionRoot: defaultWorkspace,
    });
    expect(safeCheck.available).toBe(true);

    // 校验 AppData/Roaming、AppData/Local、环境变量 %APPDATA%/%LOCALAPPDATA% 与系统级根目录拦截。
    const roamingDir = path.join(fakeHome, 'AppData', 'Roaming');
    const localDir = path.join(fakeHome, 'AppData', 'Local');
    const envAppData = path.join(fakeHome, 'CustomEnvAppData');
    const envLocalAppData = path.join(fakeHome, 'CustomEnvLocalAppData');
    for (const d of [roamingDir, localDir, envAppData, envLocalAppData]) {
      fs.mkdirSync(d, { recursive: true });
    }
    expect(isUnsafeCheckpointRoot(roamingDir, fakeHome)).toBe(true);
    expect(isUnsafeCheckpointRoot(localDir, fakeHome)).toBe(true);
    expect(
      isUnsafeCheckpointRoot(envAppData, fakeHome, {
        APPDATA: envAppData,
        LOCALAPPDATA: envLocalAppData,
      }),
    ).toBe(true);
    expect(
      isUnsafeCheckpointRoot(envLocalAppData, fakeHome, {
        APPDATA: envAppData,
        LOCALAPPDATA: envLocalAppData,
      }),
    ).toBe(true);
    for (const sysRoot of ['C:\\Windows', 'C:\\Users', '/Users', '/home', '/etc', '/var']) {
      expect(isUnsafeCheckpointRoot(sysRoot, fakeHome)).toBe(true);
    }
  });

  it('initializes side bare repo with objects/info/alternates sharing, scrubbed env, and zero user .git pollution', async () => {
    const fakeHome = makeTempDir('kpbl-ckpt-home-');
    const repo = initSampleGitRepo();
    const userIndexPath = path.join(repo, '.git', 'index');
    const userIndexBefore = fs.readFileSync(userIndexPath);

    // 故意注入污染的 GIT_* 与 NODE_OPTIONS 环境变量，验证子进程清洗。
    const service = new CheckpointService({
      homeDir: fakeHome,
      hostEnv: {
        ...process.env,
        GIT_DIR: path.join(fakeHome, 'poisoned-git-dir'),
        GIT_WORK_TREE: path.join(fakeHome, 'poisoned-wt'),
        GIT_INDEX_FILE: path.join(fakeHome, 'poisoned-index'),
        NODE_OPTIONS: '--definitely-invalid-node-flag',
        ELECTRON_RUN_AS_NODE: '1',
      },
    });

    const avail = await service.checkAvailability({ projectRoot: repo, executionRoot: repo });
    expect(avail.available).toBe(true);
    if (!avail.available) return;

    const pre = await service.capturePreTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-git-init',
      ordinal: 0,
    });
    expect(pre.captured).toBe(true);
    if (!pre.captured) return;

    const alternatesPath = path.join(avail.sideGitDir, 'objects', 'info', 'alternates');
    expect(fs.existsSync(alternatesPath)).toBe(true);
    const alternatesContent = fs.readFileSync(alternatesPath, 'utf8').trim();
    expect(alternatesContent).toBe(path.join(repo, '.git', 'objects').replaceAll('\\', '/'));

    const excludePath = path.join(avail.sideGitDir, 'info', 'exclude');
    const excludeLines = fs.readFileSync(excludePath, 'utf8').split('\n');
    for (const pattern of BUILTIN_EXCLUDES) {
      expect(excludeLines).toContain(pattern);
    }

    const hooksPathVal = execFileSync(
      'git',
      ['--git-dir', avail.sideGitDir, 'config', '--get', 'core.hooksPath'],
      { encoding: 'utf8', windowsHide: true },
    ).trim();
    expect(hooksPathVal).toBe(path.join(avail.sideGitDir, 'empty-hooks').replaceAll('\\', '/'));
    expect(fs.readdirSync(hooksPathVal)).toEqual([]);

    // 用户自身仓库不得出现任何 kpbl 隐藏引用，且 .git/index 字节完全未变。
    const userRefs = gitIn(repo, ['for-each-ref', '--format=%(refname)']);
    expect(userRefs).toBe('refs/heads/main');
    expect(fs.readFileSync(userIndexPath).equals(userIndexBefore)).toBe(true);
  });

  it('supports plain non-Git directories seamlessly without creating .git inside workspace', async () => {
    const fakeHome = makeTempDir('kpbl-ckpt-home-');
    const plainDir = makeTempDir('kpbl-ckpt-plain-');
    fs.writeFileSync(path.join(plainDir, 'notes.md'), '# Initial\n', 'utf8');

    const service = new CheckpointService({ homeDir: fakeHome });

    const pre = await service.capturePreTurn({
      projectRoot: plainDir,
      executionRoot: plainDir,
      sessionId: 'sess-plain',
      ordinal: 0,
    });
    expect(pre.captured).toBe(true);
    if (!pre.captured) return;

    // 模拟 run_command 直接改写与新建文件。
    fs.writeFileSync(path.join(plainDir, 'notes.md'), '# Updated\nLine 2\n', 'utf8');
    fs.writeFileSync(path.join(plainDir, 'created.txt'), 'hello plain folder\n', 'utf8');
    fs.mkdirSync(path.join(plainDir, 'node_modules', 'foo'), { recursive: true });
    fs.writeFileSync(path.join(plainDir, 'node_modules', 'foo', 'index.js'), 'ignored\n', 'utf8');

    const post = await service.capturePostTurn({
      projectRoot: plainDir,
      executionRoot: plainDir,
      sessionId: 'sess-plain',
      ordinal: 0,
      startTree: pre.startTree,
      label: 'Update notes',
    });

    expect(fs.existsSync(path.join(plainDir, '.git'))).toBe(false);
    expect(post.changedFiles).toEqual([
      { path: 'created.txt', status: 'added', additions: 1, deletions: 0, binary: false },
      { path: 'notes.md', status: 'modified', additions: 2, deletions: 1, binary: false },
    ]);

    const diffRes = await service.diff({
      projectRoot: plainDir,
      executionRoot: plainDir,
      sessionId: 'sess-plain',
      ordinal: 0,
    });
    expect(diffRes.files.map((f) => f.path)).toEqual(['created.txt', 'notes.md']);
    expect(diffRes.files[1]?.patch).toContain('+# Updated');

    const restoreRes = await service.restore({
      projectRoot: plainDir,
      executionRoot: plainDir,
      sessionId: 'sess-plain',
      targetOrdinal: -1,
    });
    expect(restoreRes.status).toBe('restored');
    expect(fs.readFileSync(path.join(plainDir, 'notes.md'), 'utf8')).toBe('# Initial\n');
    expect(fs.existsSync(path.join(plainDir, 'created.txt'))).toBe(false);
    expect(fs.existsSync(path.join(plainDir, 'node_modules', 'foo', 'index.js'))).toBe(true);
  });

  it('respects .gitignore, BUILTIN_EXCLUDES, >10 MiB untracked file cap, and 200-file directory cap', async () => {
    const fakeHome = makeTempDir('kpbl-ckpt-home-');
    const repo = initSampleGitRepo();
    const service = new CheckpointService({ homeDir: fakeHome });

    const pre = await service.capturePreTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-budgets',
      ordinal: 0,
    });
    expect(pre.captured).toBe(true);
    if (!pre.captured) return;

    // 1. 直接通过 fs 模拟外部命令修改、删除、新增文件。
    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const version = 1;\n', 'utf8');
    fs.unlinkSync(path.join(repo, 'src', 'legacy.ts'));
    fs.writeFileSync(path.join(repo, 'src', 'added.ts'), 'export const added = true;\n', 'utf8');

    // 2. 写入应被 .gitignore 与 BUILTIN_EXCLUDES 拦截的文件。
    fs.writeFileSync(path.join(repo, 'credentials.secret'), 'top-secret\n', 'utf8');
    fs.mkdirSync(path.join(repo, 'ignored_out'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'ignored_out', 'artifact.txt'), 'ignored\n', 'utf8');
    fs.mkdirSync(path.join(repo, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'dist', 'bundle.js'), 'bundled\n', 'utf8');

    // 3. 写入 >10 MiB 的超大未跟踪文件。
    const hugePath = path.join(repo, 'huge-dataset.bin');
    const fd = fs.openSync(hugePath, 'w');
    fs.ftruncateSync(fd, MAX_UNTRACKED_FILE_BYTES + 1024);
    fs.closeSync(fd);

    // 4. 在未跟踪目录创建 205 个散碎文件，验证 200 文件上限。
    const bulkDir = path.join(repo, 'generated_dump');
    fs.mkdirSync(bulkDir, { recursive: true });
    for (let i = 0; i < MAX_UNTRACKED_DIR_FILES + 5; i++) {
      const name = `f-${String(i).padStart(4, '0')}.txt`;
      fs.writeFileSync(path.join(bulkDir, name), `${i}\n`, 'utf8');
    }

    const post = await service.capturePostTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-budgets',
      ordinal: 0,
      startTree: pre.startTree,
    });

    const changedPaths = post.changedFiles.map((f) => f.path);
    expect(changedPaths).toContain('src/app.ts');
    expect(changedPaths).toContain('src/legacy.ts');
    expect(changedPaths).toContain('src/added.ts');
    expect(changedPaths).not.toContain('credentials.secret');
    expect(changedPaths).not.toContain('ignored_out/artifact.txt');
    expect(changedPaths).not.toContain('dist/bundle.js');
    expect(changedPaths).not.toContain('huge-dataset.bin');

    const stagedBulkCount = changedPaths.filter((p) => p.startsWith('generated_dump/')).length;
    expect(stagedBulkCount).toBe(MAX_UNTRACKED_DIR_FILES);
    expect(post.skippedUntrackedFiles).toContain('huge-dataset.bin');
    expect(post.skippedUntrackedFiles?.filter((p) => p.startsWith('generated_dump/')).length).toBe(
      5,
    );
  });

  it('performs surgical attributed restore without touching user untracked or untouched modified files', async () => {
    const fakeHome = makeTempDir('kpbl-ckpt-home-');
    const repo = initSampleGitRepo();
    const service = new CheckpointService({ homeDir: fakeHome });

    // 用户在会话前已存在的未跟踪文件与手动未提交改动（Agent 全程不碰它们）。
    const userUntracked = path.join(repo, 'my-scratch.md');
    fs.writeFileSync(userUntracked, 'user private notes\n', 'utf8');
    const userModifiedTracked = path.join(repo, 'src', 'keep.ts');
    fs.writeFileSync(userModifiedTracked, 'export const keep = "user-manual-wip";\n', 'utf8');

    // Turn 0：Agent 修改 app.ts 并新建 turn0.ts。
    const pre0 = await service.capturePreTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-restore',
      ordinal: 0,
    });
    if (!pre0.captured) throw new Error('Expected pre0 captured');

    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const version = 1;\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'src', 'turn0.ts'), 'export const t0 = true;\n', 'utf8');

    await service.capturePostTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-restore',
      ordinal: 0,
      startTree: pre0.startTree,
    });

    // 两轮之间用户又新建了另一个无关未跟踪文件。
    const betweenTurnUserFile = path.join(repo, 'user-between-turns.txt');
    fs.writeFileSync(betweenTurnUserFile, 'created by user between turns\n', 'utf8');

    // Turn 1：Agent 再次修改 app.ts、删除 legacy.ts，并在深层目录新建 nested/turn1.ts。
    const pre1 = await service.capturePreTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-restore',
      ordinal: 1,
    });
    if (!pre1.captured) throw new Error('Expected pre1 captured');

    fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const version = 2;\n', 'utf8');
    fs.unlinkSync(path.join(repo, 'src', 'legacy.ts'));
    fs.mkdirSync(path.join(repo, 'nested', 'deep'), { recursive: true });
    fs.writeFileSync(
      path.join(repo, 'nested', 'deep', 'turn1.ts'),
      'export const t1 = true;\n',
      'utf8',
    );

    await service.capturePostTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-restore',
      ordinal: 1,
      startTree: pre1.startTree,
    });

    // 验证整会话累计 Diff 不混入用户手动改动的 src/keep.ts 或用户未跟踪文件。
    const fullDiff = await service.diff({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-restore',
    });
    expect(fullDiff.files.map((f) => f.path)).toEqual([
      'nested/deep/turn1.ts',
      'src/app.ts',
      'src/legacy.ts',
      'src/turn0.ts',
    ]);

    // 回退到 Turn 0 结束态（仅撤销 Turn 1）。
    const resTo0 = await service.restore({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-restore',
      targetOrdinal: 0,
    });
    expect(resTo0.status).toBe('restored');
    expect(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe(
      'export const version = 1;\n',
    );
    expect(fs.readFileSync(path.join(repo, 'src', 'legacy.ts'), 'utf8')).toBe(
      'export const legacy = 1;\n',
    );
    expect(fs.existsSync(path.join(repo, 'nested'))).toBe(false);
    expect(fs.existsSync(path.join(repo, 'src', 'turn0.ts'))).toBe(true);

    // 用户自有未跟踪文件与未触碰改动 100% 完好无损！
    expect(fs.readFileSync(userUntracked, 'utf8')).toBe('user private notes\n');
    expect(fs.readFileSync(betweenTurnUserFile, 'utf8')).toBe('created by user between turns\n');
    expect(fs.readFileSync(userModifiedTracked, 'utf8')).toBe(
      'export const keep = "user-manual-wip";\n',
    );

    const remainingAfterRewind = await service.listCheckpoints({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-restore',
    });
    expect(remainingAfterRewind.map((c) => c.ordinal)).toEqual([0]);

    // 继续回退到首轮之前（targetOrdinal = -1）。
    const resToBefore0 = await service.restore({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-restore',
      targetOrdinal: -1,
    });
    expect(resToBefore0.status).toBe('restored');
    expect(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe(
      'export const version = 0;\n',
    );
    expect(fs.existsSync(path.join(repo, 'src', 'turn0.ts'))).toBe(false);
    expect(fs.readFileSync(userUntracked, 'utf8')).toBe('user private notes\n');
    expect(fs.readFileSync(userModifiedTracked, 'utf8')).toBe(
      'export const keep = "user-manual-wip";\n',
    );
  });

  it('detects 3-way post-turn conflicts without mutating disk, allows force override, and writes pre-restore backup ref', async () => {
    const fakeHome = makeTempDir('kpbl-ckpt-home-');
    const repo = initSampleGitRepo();
    const service = new CheckpointService({ homeDir: fakeHome });

    const pre = await service.capturePreTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-conflict',
      ordinal: 0,
    });
    if (!pre.captured) throw new Error('Expected pre captured');

    const appFile = path.join(repo, 'src', 'app.ts');
    fs.writeFileSync(appFile, 'export const version = "agent-edit";\n', 'utf8');

    await service.capturePostTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-conflict',
      ordinal: 0,
      startTree: pre.startTree,
    });

    // 轮次结束后，用户手动修改了 Agent 刚刚触碰过的文件。
    fs.writeFileSync(appFile, 'export const version = "user-post-turn-edit";\n', 'utf8');

    const conflictRes = await service.restore({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-conflict',
      targetOrdinal: -1,
    });
    expect(conflictRes).toEqual({
      status: 'conflict',
      conflicts: ['src/app.ts'],
    });
    expect(fs.readFileSync(appFile, 'utf8')).toBe(
      'export const version = "user-post-turn-edit";\n',
    );

    // force: true 强制还原，但在改盘前必须把用户手动修改快照进 pre-restore 引用。
    const forcedRes = await service.restore({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-conflict',
      targetOrdinal: -1,
      force: true,
    });
    expect(forcedRes.status).toBe('restored');
    if (forcedRes.status !== 'restored') return;

    expect(fs.readFileSync(appFile, 'utf8')).toBe('export const version = 0;\n');
    const safeSeg = toSafeRefSegment('sess-conflict');
    expect(forcedRes.preRestoreRef).toBe(`refs/kpbl/sessions/${safeSeg}/pre-restore`);

    const avail = await service.checkAvailability({ projectRoot: repo, executionRoot: repo });
    if (!avail.available) throw new Error('Expected available');
    const backedUpBlob = execFileSync(
      'git',
      ['--git-dir', avail.sideGitDir, 'show', `${forcedRes.preRestoreRef}:src/app.ts`],
      { encoding: 'utf8', windowsHide: true },
    );
    expect(backedUpBlob).toBe('export const version = "user-post-turn-edit";\n');
  });

  it('truncates >256 KiB multi-byte UTF-8 patches cleanly on codepoint boundaries and trips timeout circuit after 2 timeouts', async () => {
    const fakeHome = makeTempDir('kpbl-ckpt-home-');
    const repo = initSampleGitRepo();
    const service = new CheckpointService({ homeDir: fakeHome });

    const pre = await service.capturePreTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-utf8',
      ordinal: 0,
    });
    if (!pre.captured) throw new Error('Expected pre captured');

    // 构造超过 256 KiB 的纯中文多字节文本以压测 UTF-8 码点截断边界。
    const line = '这是一行用于测试检查点补丁在多字节汉字边界安全截断的长文本内容。\n';
    const bigText = line.repeat(3200);
    expect(Buffer.byteLength(bigText, 'utf8')).toBeGreaterThan(
      MAX_SINGLE_FILE_PATCH_BYTES + 20_000,
    );
    fs.writeFileSync(path.join(repo, 'src', 'big-zh.txt'), bigText, 'utf8');

    await service.capturePostTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-utf8',
      ordinal: 0,
      startTree: pre.startTree,
    });

    const diffRes = await service.diff({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-utf8',
      ordinal: 0,
    });
    expect(diffRes.truncated).toBe(true);
    expect(diffRes.files[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(diffRes.files[0]!.patch, 'utf8')).toBeLessThanOrEqual(
      MAX_SINGLE_FILE_PATCH_BYTES,
    );
    expect(diffRes.files[0]!.patch.includes('\ufffd')).toBe(false);

    // 验证连续 2 次超时触发会话级自动熔断。
    const avail = await service.checkAvailability({ projectRoot: repo, executionRoot: repo });
    if (!avail.available) return;
    const heldLock = await SessionLock.acquire(path.join(avail.bucketDir, 'checkpoint.lock'));
    try {
      const t1 = await service.capturePreTurn({
        projectRoot: repo,
        executionRoot: repo,
        sessionId: 'sess-slow',
        ordinal: 0,
        timeoutMs: 35,
      });
      expect(t1).toEqual({ captured: false, skipped: true, reason: 'timeout' });

      const t2 = await service.capturePreTurn({
        projectRoot: repo,
        executionRoot: repo,
        sessionId: 'sess-slow',
        ordinal: 1,
        timeoutMs: 35,
      });
      expect(t2).toEqual({ captured: false, skipped: true, reason: 'timeout_circuit_open' });
    } finally {
      await heldLock.release();
    }

    // 即使锁已释放，已熔断会话仍零开销跳过，直至显式 resetCircuit。
    const t3 = await service.capturePreTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-slow',
      ordinal: 2,
    });
    expect(t3).toEqual({ captured: false, skipped: true, reason: 'timeout_circuit_open' });

    service.resetCircuit('sess-slow');
    const t4 = await service.capturePreTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-slow',
      ordinal: 2,
    });
    expect(t4.captured).toBe(true);
  });

  it('prunes oldest session refs beyond maxSessions and preserves active/recent sessions across git gc', async () => {
    const fakeHome = makeTempDir('kpbl-ckpt-home-');
    const repo = initSampleGitRepo();
    let fakeClock = 1_700_000_000_000;
    const service = new CheckpointService({
      homeDir: fakeHome,
      now: () => {
        fakeClock += 1_000;
        return fakeClock;
      },
    });

    for (const sid of ['s1', 's2', 's3', 's4']) {
      const pre = await service.capturePreTurn({
        projectRoot: repo,
        executionRoot: repo,
        sessionId: sid,
        ordinal: 0,
      });
      if (!pre.captured) throw new Error('Expected pre captured');
      fs.writeFileSync(path.join(repo, 'src', 'app.ts'), `export const s = "${sid}";\n`, 'utf8');
      await service.capturePostTurn({
        projectRoot: repo,
        executionRoot: repo,
        sessionId: sid,
        ordinal: 0,
        startTree: pre.startTree,
      });
    }

    const pruneRes = await service.prune({
      projectRoot: repo,
      executionRoot: repo,
      maxSessions: 2,
    });
    expect(pruneRes.prunedSessions).toEqual(['s2', 's1']);
    expect(pruneRes.remainingSessions).toBe(2);

    expect(
      await service.listCheckpoints({ projectRoot: repo, executionRoot: repo, sessionId: 's1' }),
    ).toEqual([]);
    expect(
      (await service.listCheckpoints({ projectRoot: repo, executionRoot: repo, sessionId: 's4' }))
        .length,
    ).toBe(1);

    // 验证 git gc --prune=now 后 s4 的 startTree 与 endTree 仍可正常计算 Diff（父提交锚定有效）。
    const s4Diff = await service.diff({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 's4',
      ordinal: 0,
    });
    expect(s4Diff.files[0]?.patch).toContain('+export const s = "s4";');
  });

  it('deletes absent child files before restoring parent symlinks so outside files are never unlinked', async () => {
    const fakeHome = makeTempDir('kpbl-ckpt-symlink-home-');
    const outsideDir = makeTempDir('kpbl-ckpt-outside-victim-');
    const outsideVictimFile = path.join(outsideDir, 'victim.txt');
    fs.writeFileSync(outsideVictimFile, 'MUST_NEVER_BE_DELETED\n', 'utf8');

    const repo = initSampleGitRepo();
    const linkInRepo = path.join(repo, 'ext-link');
    try {
      fs.symlinkSync(outsideDir, linkInRepo, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      // 无符号链接权限的环境跳过此附加校验。
      return;
    }

    const service = new CheckpointService({ homeDir: fakeHome });
    const pre = await service.capturePreTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-symlink-order',
      ordinal: 0,
    });
    if (!pre.captured) throw new Error('Expected pre captured');

    // 轮次内：将原本指向外部目录的链接替换为普通目录并写入同名子文件 victim.txt。
    const stat = fs.lstatSync(linkInRepo);
    if (stat.isSymbolicLink()) fs.unlinkSync(linkInRepo);
    else fs.rmSync(linkInRepo, { recursive: true, force: true });
    fs.mkdirSync(linkInRepo, { recursive: true });
    fs.writeFileSync(path.join(linkInRepo, 'victim.txt'), 'inside-workspace-copy\n', 'utf8');

    await service.capturePostTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-symlink-order',
      ordinal: 0,
      startTree: pre.startTree,
    });

    const restored = await service.restore({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-symlink-order',
      targetOrdinal: -1,
      force: true,
    });
    expect(['restored', 'noop']).toContain(restored.status);
    // 无论宿主 Git 是否物化符号链接，工作区外的同名宿主文件绝不可被误删。
    expect(fs.existsSync(outsideVictimFile)).toBe(true);
    expect(fs.readFileSync(outsideVictimFile, 'utf8')).toBe('MUST_NEVER_BE_DELETED\n');
  });

  it('captures, diffs, and restores accurately when process.cwd() is a subdirectory, escapes INI hooksPath, and handles file-to-directory replacement without false conflict', async () => {
    const baseHome = makeTempDir('kpbl-ckpt-special-');
    // 构造包含分号、井号与空格的 homeDir，验证 hooksPath 双引号 INI 转义不被当成注释截断。
    const trickyHome = path.join(baseHome, 'user;dev #1 space');
    fs.mkdirSync(trickyHome, { recursive: true });

    const repo = initSampleGitRepo();
    const nestedCwd = path.join(repo, 'packages', 'subpkg');
    fs.mkdirSync(nestedCwd, { recursive: true });
    fs.writeFileSync(path.join(nestedCwd, 'index.ts'), 'export const sub = 1;\n', 'utf8');
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['commit', '-m', 'add nested subpkg']);

    const service = new CheckpointService({ homeDir: trickyHome });
    const avail = await service.checkAvailability({ projectRoot: repo, executionRoot: repo });
    expect(avail.available).toBe(true);
    if (!avail.available) return;

    const originalCwd = process.cwd();
    process.chdir(nestedCwd);
    try {
      const pre = await service.capturePreTurn({
        projectRoot: repo,
        executionRoot: repo,
        sessionId: 'sess-subcwd',
        ordinal: 0,
      });
      expect(pre.captured).toBe(true);
      if (!pre.captured) return;

      // 验证包含 `;` 与 `#` 的 hooksPath 被 Git 完整解析，未被截断。
      const hooksConfigured = execFileSync(
        'git',
        ['--git-dir', avail.sideGitDir, 'config', '--get', 'core.hooksPath'],
        { encoding: 'utf8', windowsHide: true },
      ).trim();
      expect(hooksConfigured).toBe(
        path.join(avail.sideGitDir, 'empty-hooks').replaceAll('\\', '/'),
      );

      // 1) 在子目录之外的仓库根修改 src/app.ts 并新增 root-outside-cwd.txt；
      // 2) 将原常规文件 src/legacy.ts 删除并替换为同名目录 src/legacy.ts/child.ts（验证 040000 tree 不误报事后冲突）。
      fs.writeFileSync(path.join(repo, 'src', 'app.ts'), 'export const version = 99;\n', 'utf8');
      fs.writeFileSync(path.join(repo, 'root-outside-cwd.txt'), 'from root\n', 'utf8');
      fs.unlinkSync(path.join(repo, 'src', 'legacy.ts'));
      fs.mkdirSync(path.join(repo, 'src', 'legacy.ts'), { recursive: true });
      fs.writeFileSync(
        path.join(repo, 'src', 'legacy.ts', 'child.ts'),
        'export const replacedDir = true;\n',
        'utf8',
      );

      const post = await service.capturePostTurn({
        projectRoot: repo,
        executionRoot: repo,
        sessionId: 'sess-subcwd',
        ordinal: 0,
        startTree: pre.startTree,
      });
      expect(post.changedFiles.map((f) => f.path)).toEqual([
        'root-outside-cwd.txt',
        'src/app.ts',
        'src/legacy.ts',
        'src/legacy.ts/child.ts',
      ]);

      // 非强制回滚（force: false）：文件变目录不得被误判为 post-turn conflict，且所有根级与跨子目录路径均完整还原。
      const restoreClean = await service.restore({
        projectRoot: repo,
        executionRoot: repo,
        sessionId: 'sess-subcwd',
        targetOrdinal: -1,
      });
      expect(restoreClean.status).toBe('restored');
      expect(fs.existsSync(path.join(repo, 'root-outside-cwd.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(repo, 'src', 'app.ts'), 'utf8')).toBe(
        'export const version = 0;\n',
      );
      expect(fs.lstatSync(path.join(repo, 'src', 'legacy.ts')).isFile()).toBe(true);
      expect(fs.readFileSync(path.join(repo, 'src', 'legacy.ts'), 'utf8')).toBe(
        'export const legacy = 1;\n',
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('uses literal pathspecs and preserves POSIX backslashes so restore never touches unattributed sibling files', async () => {
    const fakeHome = makeTempDir('kpbl-ckpt-literal-home-');
    const repo = initSampleGitRepo();

    // 预置不会被 Agent 触碰的兄弟文件（与 glob 字符和 POSIX 反斜杠同名子目录路径相邻）。
    fs.writeFileSync(path.join(repo, 'src', 'a1.ts'), 'export const untouchedA1 = "v0";\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'src', 'a2.ts'), 'export const untouchedA2 = "v0";\n', 'utf8');
    const globNamedPath = path.join(repo, 'src', 'a[12].ts');
    fs.writeFileSync(globNamedPath, 'export const literalBracket = "v0";\n', 'utf8');
    const hasPosixBackslash = process.platform !== 'win32';
    if (hasPosixBackslash) {
      fs.mkdirSync(path.join(repo, 'dirlike'), { recursive: true });
      fs.writeFileSync(path.join(repo, 'dirlike', 'keep.txt'), 'real-subdir-file\n', 'utf8');
    }
    gitIn(repo, ['add', '-A']);
    gitIn(repo, ['commit', '-m', 'add literal pathspec fixtures']);

    const service = new CheckpointService({ homeDir: fakeHome });
    const pre = await service.capturePreTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-literal-paths',
      ordinal: 0,
    });
    if (!pre.captured) throw new Error('Expected pre captured');

    // 用户在轮次外（或并发）有自己的修改位于归因外的兄弟文件 src/a1.ts，Agent 只修改 src/a[12].ts 与新建含反斜杠文件名。
    fs.writeFileSync(globNamedPath, 'export const literalBracket = "agent-v1";\n', 'utf8');
    if (hasPosixBackslash) {
      fs.writeFileSync(path.join(repo, 'dirlike\\keep.txt'), 'agent-backslash-file\n', 'utf8');
    }

    await service.capturePostTurn({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-literal-paths',
      ordinal: 0,
      startTree: pre.startTree,
    });

    // 轮次结束后用户在归因范围外的兄弟文件写入手动修改；若 checkout 误展开 `a[12].ts` 为 glob，就会覆盖 src/a1.ts！
    fs.writeFileSync(
      path.join(repo, 'src', 'a1.ts'),
      'export const untouchedA1 = "user-manual-after-turn";\n',
      'utf8',
    );

    const restored = await service.restore({
      projectRoot: repo,
      executionRoot: repo,
      sessionId: 'sess-literal-paths',
      targetOrdinal: -1,
    });
    expect(restored.status).toBe('restored');
    expect(fs.readFileSync(globNamedPath, 'utf8')).toBe('export const literalBracket = "v0";\n');
    // 归因范围外的 src/a1.ts 与 dirlike/keep.txt 必须 100% 完好无损！
    expect(fs.readFileSync(path.join(repo, 'src', 'a1.ts'), 'utf8')).toBe(
      'export const untouchedA1 = "user-manual-after-turn";\n',
    );
    if (hasPosixBackslash) {
      expect(fs.existsSync(path.join(repo, 'dirlike\\keep.txt'))).toBe(false);
      expect(fs.readFileSync(path.join(repo, 'dirlike', 'keep.txt'), 'utf8')).toBe(
        'real-subdir-file\n',
      );
    }
  });
});
