import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ToolError } from '../src/errors/index.js';
import { PathSandbox } from '../src/security/sandbox.js';
import { writeFileTool } from '../src/tools/builtin/fs.js';

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-sandbox-test-'));
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
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-sandbox-root-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-sandbox-outside-'));
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

describe.skipIf(!linkSupport.file)('PathSandbox (越界文件符号链接穿透)', () => {
  let rootDir: string;
  let outsideDir: string;

  beforeEach(() => {
    rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-sandbox-file-root-'));
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-sandbox-file-outside-'));
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
