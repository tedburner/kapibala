import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PathSandbox, isProtectedWorkspacePath } from '../src/capabilities/security/sandbox.js';
import { writeFileTool } from '../src/capabilities/tools/builtin/fs.js';
import { ToolError } from '../src/errors/index.js';

/**
 * 探测当前环境支持哪种"链接"。
 *
 * 只看 symlinkSync 有没有抛异常是不够的 —— 在部分受限环境(或未开启开发者模式的 Windows)里
 * 它会"成功返回"却不产生符号链接。因此必须用 lstat 复核，否则相关断言会被静默跳过，
 * 安全防线等于从未被验证过。
 */
function detectLinkSupport(): { file: boolean; dir: boolean } {
  const probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-link-probe-'));
  const targetFile = path.join(probeDir, 'target.txt');
  const targetDir = path.join(probeDir, 'targetDir');
  const fileLink = path.join(probeDir, 'fileLink.txt');
  const dirLink = path.join(probeDir, 'dirLink');
  fs.writeFileSync(targetFile, 'probe');
  fs.mkdirSync(targetDir);

  let file = false;
  try {
    fs.symlinkSync(targetFile, fileLink);
    file = fs.lstatSync(fileLink).isSymbolicLink();
  } catch {
    file = false;
  }

  let dir = false;
  try {
    fs.symlinkSync(targetDir, dirLink);
    dir = fs.lstatSync(dirLink).isSymbolicLink();
  } catch {
    // Windows 下无 SeCreateSymbolicLinkPrivilege 时退化为 junction(同样构成目录穿透)
    try {
      fs.symlinkSync(targetDir, dirLink, 'junction');
      dir = fs.lstatSync(dirLink).isSymbolicLink();
    } catch {
      dir = false;
    }
  }

  fs.rmSync(probeDir, { recursive: true, force: true });
  return { file, dir };
}

const linkSupport = detectLinkSupport();

/**
 * 创建临时目录并立刻折叠成 native 物理长路径身份。
 *
 * 为什么必须折叠：PathSandbox 按契约用 `fs.realpathSync.native` 规范化根路径，
 * 而 Windows runner 的 `os.tmpdir()` 常是 8.3 短名（`C:\Users\RUNNER~1\…`）。
 * 测试若继续拿原始短名拼期望值，就会把"同一目录的两种写法"误判成越界或路径不等。
 */
function canonicalTempDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** 建立一个指向 target 的目录链接：优先真符号链接，Windows 无权限时退化为 junction */
function linkDirectory(target: string, linkPath: string): void {
  try {
    fs.symlinkSync(target, linkPath);
    if (fs.lstatSync(linkPath).isSymbolicLink()) return;
    fs.rmSync(linkPath, { recursive: true, force: true });
  } catch {
    // 继续尝试 junction
  }
  fs.symlinkSync(target, linkPath, 'junction');
}

describe('PathSandbox (词法校验)', () => {
  const tempDir = canonicalTempDir('kpbl-sandbox-test-');
  const sandbox = new PathSandbox({ rootDir: tempDir });

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should resolve safe relative paths inside rootDir', () => {
    const resolved = sandbox.resolveSafePath('sub/file.txt');
    expect(resolved).toBe(path.resolve(tempDir, 'sub/file.txt'));
  });

  it('should resolve safe absolute paths inside rootDir', () => {
    const inside = path.join(tempDir, 'data.json');
    const resolved = sandbox.resolveSafePath(inside);
    expect(resolved).toBe(inside);
  });

  it('should throw ToolError for path escaping via ..', () => {
    expect(() => sandbox.resolveSafePath('../secret.txt')).toThrow(ToolError);
    expect(() => sandbox.resolveSafePath('sub/../../outside.txt')).toThrow(ToolError);
  });

  it('should reject a sibling directory whose name only shares the root prefix', () => {
    const sibling = `${tempDir}-outside`;
    expect(() => sandbox.resolveSafePath(path.join(sibling, 'secret.txt'))).toThrow(ToolError);
  });

  it('should throw ToolError for empty path', () => {
    expect(() => sandbox.resolveSafePath('')).toThrow(ToolError);
  });

  it('should allow not-yet-existing paths that stay inside rootDir', () => {
    expect(sandbox.resolveSafePath('new-dir/new-file.txt')).toBe(
      path.resolve(tempDir, 'new-dir/new-file.txt'),
    );
  });
});

describe.skipIf(!linkSupport.dir)('PathSandbox (越界目录链接穿透)', () => {
  let rootDir: string;
  let outsideDir: string;

  beforeEach(() => {
    rootDir = canonicalTempDir('kpbl-sandbox-root-');
    outsideDir = canonicalTempDir('kpbl-sandbox-outside-');
    linkDirectory(outsideDir, path.join(rootDir, 'linkDir'));
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('should reject a NEW file routed through a directory link that escapes rootDir', () => {
    // P0 回归用例：目标文件尚不存在时，旧实现用 existsSync(resolvedPath) 当门禁，
    // 整段 realpath 校验会被跳过(fail-open)，越界写入畅通无阻。
    const sandbox = new PathSandbox({ rootDir });

    expect(() => sandbox.resolveSafePath('linkDir/new.txt')).toThrow(ToolError);
    expect(() => sandbox.resolveSafePath('linkDir/deep/new.txt')).toThrow(ToolError);
  });

  it('should reject an absolute path routed through an escaping directory link', () => {
    const sandbox = new PathSandbox({ rootDir });
    expect(() => sandbox.resolveSafePath(path.join(rootDir, 'linkDir', 'x.txt'))).toThrow(
      ToolError,
    );
  });

  it('should not let write_file escape the sandbox through a directory link', async () => {
    await expect(
      writeFileTool.execute({ path: 'linkDir/escaped.txt', content: 'pwned' }, { rootDir }),
    ).rejects.toThrow(ToolError);

    expect(fs.existsSync(path.join(outsideDir, 'escaped.txt'))).toBe(false);
  });

  it('should still allow directory links that resolve inside rootDir', () => {
    fs.mkdirSync(path.join(rootDir, 'real'));
    linkDirectory(path.join(rootDir, 'real'), path.join(rootDir, 'linkReal'));

    const sandbox = new PathSandbox({ rootDir });
    expect(sandbox.resolveSafePath('linkReal/file.txt')).toBe(
      path.resolve(rootDir, 'linkReal/file.txt'),
    );
  });
});

describe('PathSandbox (硬禁区)', () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = canonicalTempDir('kpbl-sandbox-protected-');
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
  });

  const blocked = [
    '.git/hooks/pre-commit',
    '.git/config',
    '.git/config.worktree',
    'nested/.git/config.worktree',
    '.git/modules/dep/config',
    '.kapibala/permissions.json',
    '.kapibala/mcp.json',
    '.env',
    '.env.local',
    '.env.production',
    'nested/.env',
    // direnv 进入目录即执行 .envrc，与 .git/hooks 同威胁级（回归：曾误列入 allowed）。
    '.envrc',
    'nested/.envrc',
  ];
  for (const target of blocked) {
    it(`rejects writes to ${target}`, () => {
      const sandbox = new PathSandbox({ rootDir });
      expect(() => sandbox.resolveSafePath(target)).toThrowError(
        expect.objectContaining({ code: 'PERMISSION_DENIED' }),
      );
    });
  }

  const allowed = ['.env.example', '.env.sample', '.env.template', '.gitignore'];
  for (const target of allowed) {
    it(`allows writes to ${target}`, () => {
      const sandbox = new PathSandbox({ rootDir });
      expect(sandbox.resolveSafePath(target)).toBe(path.resolve(rootDir, target));
    });
  }

  it('matches Windows case variants', () => {
    const sandbox = new PathSandbox({ rootDir });
    expect(() => sandbox.resolveSafePath('.GIT/HOOKS/pre-commit')).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
  });

  it('keeps protected files readable for diagnostics', () => {
    const sandbox = new PathSandbox({ rootDir });
    expect(sandbox.resolveSafePath('.git/config', { mode: 'read' })).toBe(
      path.resolve(rootDir, '.git/config'),
    );
  });

  it('extends the list with workspace-relative prefixes', () => {
    const sandbox = new PathSandbox({ rootDir, protectedPaths: ['secrets'] });
    expect(() => sandbox.resolveSafePath('secrets/token.txt')).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
    expect(sandbox.resolveSafePath('secrets-notes.txt')).toBe(
      path.resolve(rootDir, 'secrets-notes.txt'),
    );
  });

  it('exposes the pure matcher for shell-side reuse', () => {
    expect(isProtectedWorkspacePath('a/.git/hooks/x')).toBe(true);
    expect(isProtectedWorkspacePath('.env.local')).toBe(true);
    expect(isProtectedWorkspacePath('.env ')).toBe(true);
    expect(isProtectedWorkspacePath('.env...')).toBe(true);
    expect(isProtectedWorkspacePath('.env.example')).toBe(false);
    expect(isProtectedWorkspacePath('.envrc')).toBe(true);
    expect(isProtectedWorkspacePath('nested/.envrc')).toBe(true);
    expect(isProtectedWorkspacePath('.git')).toBe(true);
    expect(isProtectedWorkspacePath('nested/.git')).toBe(true);
    expect(isProtectedWorkspacePath('.GIT')).toBe(true);
    expect(isProtectedWorkspacePath('.git/config.worktree')).toBe(true);
    expect(isProtectedWorkspacePath('nested/.git/config.worktree')).toBe(true);
    expect(isProtectedWorkspacePath('.git/worktrees/wt-1/config.worktree')).toBe(true);
    expect(isProtectedWorkspacePath('.git/worktrees/wt-1/commondir')).toBe(true);
    expect(isProtectedWorkspacePath('.git/info/attributes')).toBe(true);
    expect(isProtectedWorkspacePath('.git/objects/info/alternates')).toBe(true);
    expect(isProtectedWorkspacePath('.git/COMMIT_EDITMSG')).toBe(false);
    expect(isProtectedWorkspacePath('src/index.ts')).toBe(false);
  });

  it('blocks writes to linked-worktree .git pointer files even in FullAccess while keeping reads allowed', async () => {
    const { ToolRegistry } = await import('../src/capabilities/tools/registry.js');
    const { HookRegistry } = await import('../src/extensibility/hooks/registry.js');
    const { ToolExecutor } = await import('../src/runtime/executor/index.js');

    const gitFile = path.join(rootDir, '.git');
    const nestedDir = path.join(rootDir, 'packages', 'sub');
    fs.mkdirSync(nestedDir, { recursive: true });
    const nestedGitFile = path.join(nestedDir, '.git');
    fs.writeFileSync(gitFile, 'gitdir: /main/.git/worktrees/wt-1\n');
    fs.writeFileSync(nestedGitFile, 'gitdir: /main/.git/modules/sub\n');

    const sandbox = new PathSandbox({ workspaceRoot: rootDir });
    expect(() => sandbox.resolveSafePath('.git')).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
    expect(() => sandbox.resolveSafePath('packages/sub/.git')).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
    expect(sandbox.resolveSafePath('.git', { mode: 'read' })).toBe(gitFile);
    expect(sandbox.resolveSafePath('packages/sub/.git', { mode: 'read' })).toBe(nestedGitFile);

    const tools = new ToolRegistry();
    tools.register(writeFileTool);
    const hooks = new HookRegistry();
    const executor = new ToolExecutor({
      tools,
      hooks,
      workspaceRoot: rootDir,
      rootDir,
      sandbox,
      mode: 'FullAccess',
    });

    const [rootAttempt, nestedAttempt] = await executor.runAll([
      {
        type: 'tool_use',
        id: 'w-root-git',
        name: 'write_file',
        input: { path: '.git', content: 'gitdir: /evil\n' },
      },
      {
        type: 'tool_use',
        id: 'w-nested-git',
        name: 'write_file',
        input: { path: 'packages/sub/.git', content: 'gitdir: /evil\n' },
      },
    ]);

    expect(rootAttempt.isError).toBe(true);
    expect(rootAttempt.errorCode).toBe('PERMISSION_DENIED');
    expect(nestedAttempt.isError).toBe(true);
    expect(fs.readFileSync(gitFile, 'utf8')).toBe('gitdir: /main/.git/worktrees/wt-1\n');
    expect(fs.readFileSync(nestedGitFile, 'utf8')).toBe('gitdir: /main/.git/modules/sub\n');
  });

  it('rejects NTFS alternate/default data stream suffixes (::$DATA) on new files and escape paths', async () => {
    const { inspectFileWriteTarget, isEscapeClassPath } = await import(
      '../src/capabilities/security/escape-paths.js'
    );
    const sandbox = new PathSandbox({ rootDir });
    for (const target of [
      '.env::$DATA',
      '.envrc::$DATA',
      '.git/config::$DATA',
      'nested/.env:secret',
    ]) {
      expect(() => sandbox.resolveSafePath(target)).toThrowError(
        expect.objectContaining({ code: 'PERMISSION_DENIED' }),
      );
      expect(inspectFileWriteTarget(target, rootDir, sandbox).protectedTarget).toBeDefined();
    }
    expect(isEscapeClassPath('.npmrc::$DATA')).toBe(true);
    expect(isEscapeClassPath('.github/workflows/ci.yml::$DATA')).toBe(true);
    expect(() => sandbox.resolveSafePath('.npmrc::$DATA')).toThrowError(
      expect.objectContaining({ code: 'PERMISSION_DENIED' }),
    );
  });
});

describe.skipIf(!linkSupport.file)('PathSandbox (越界文件符号链接穿透)', () => {
  let rootDir: string;
  let outsideDir: string;

  beforeEach(() => {
    rootDir = canonicalTempDir('kpbl-sandbox-file-root-');
    outsideDir = canonicalTempDir('kpbl-sandbox-file-outside-');
  });

  afterEach(() => {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it('should reject an existing file symlink that points outside rootDir', () => {
    const outsideFile = path.join(outsideDir, 'secret.txt');
    fs.writeFileSync(outsideFile, 'sensitive');
    fs.symlinkSync(outsideFile, path.join(rootDir, 'link.txt'));

    const sandbox = new PathSandbox({ rootDir });
    expect(() => sandbox.resolveSafePath('link.txt')).toThrow(ToolError);
  });

  it('should reject a broken symlink whose target lives outside rootDir', () => {
    // 悬挂符号链接同样危险：writeFileSync 会顺着它把文件创建到 root 之外
    fs.symlinkSync(path.join(outsideDir, 'does-not-exist.txt'), path.join(rootDir, 'broken'));

    const sandbox = new PathSandbox({ rootDir });
    expect(() => sandbox.resolveSafePath('broken')).toThrow(ToolError);
  });
});
