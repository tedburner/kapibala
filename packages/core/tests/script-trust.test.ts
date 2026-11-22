import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assessScriptTrust } from '../src/capabilities/shell/script-trust.js';

const directories: string[] = [];
function temp(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-script-trust-'));
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** 初始化仓库并提交当前全部文件；git 缺失时返回 false，由用例跳过。 */
function commitAll(root: string): boolean {
  try {
    const options = { cwd: root, stdio: 'ignore' as const, windowsHide: true };
    execFileSync('git', ['init', '--quiet'], options);
    execFileSync('git', ['add', '-A'], options);
    execFileSync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-qm', 'init'],
      options,
    );
    return true;
  } catch {
    return false;
  }
}

describe('assessScriptTrust', () => {
  it('returns undefined when no script or manifest is involved', () => {
    const root = temp();
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    expect(assessScriptTrust('ls -la', root, root)).toBeUndefined();
    expect(assessScriptTrust('git status', root, root)).toBeUndefined();
  });

  it('treats a workspace without git as unknown', () => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'run.mjs'), 'console.log(1)');
    expect(assessScriptTrust('node scripts/run.mjs', root, root)).toBe('unknown');
  });

  it('marks model-written scripts dirty and committed scripts clean', (context) => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'scripts'));
    const script = path.join(root, 'scripts', 'run.mjs');
    fs.writeFileSync(script, 'console.log(1)');
    if (!commitAll(root)) {
      context.skip();
      return;
    }
    // 说明：commitAll 已把脚本提交；再写入即 dirty，恢复原文即 clean。
    const committed = fs.readFileSync(script, 'utf8');
    expect(assessScriptTrust('node scripts/run.mjs', root, root)).toBe('clean');
    fs.writeFileSync(script, `${committed}\n// edited`);
    expect(assessScriptTrust('node scripts/run.mjs', root, root)).toBe('dirty');
    fs.writeFileSync(script, committed);
    expect(assessScriptTrust('node scripts/run.mjs', root, root)).toBe('clean');
    fs.writeFileSync(path.join(root, 'scripts', 'extra.mjs'), 'console.log(2)');
    expect(assessScriptTrust('node scripts/extra.mjs', root, root)).toBe('dirty');
  });

  it('binds package manager scripts to the nearest manifest state', (context) => {
    const root = temp();
    const manifest = path.join(root, 'package.json');
    fs.writeFileSync(manifest, JSON.stringify({ scripts: { test: 'node -e ""' } }));
    if (!commitAll(root)) {
      context.skip();
      return;
    }
    expect(assessScriptTrust('pnpm test', root, root)).toBe('clean');
    fs.writeFileSync(manifest, JSON.stringify({ scripts: { test: 'node evil.mjs' } }));
    expect(assessScriptTrust('pnpm test', root, root)).toBe('dirty');
  });

  it('fails closed for inline code and missing scripts', (context) => {
    const root = temp();
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    if (!commitAll(root)) {
      context.skip();
      return;
    }
    expect(assessScriptTrust('node -e "console.log(1)"', root, root)).toBe('unknown');
    expect(assessScriptTrust('node scripts/missing.mjs', root, root)).toBe('unknown');
    expect(assessScriptTrust('node /tmp/outside.mjs', root, root)).toBe('unknown');
  });

  it('keeps the git result stable across repeated calls within the cache window', (context) => {
    const root = temp();
    fs.mkdirSync(path.join(root, 'scripts'));
    const script = path.join(root, 'scripts', 'run.mjs');
    fs.writeFileSync(script, 'console.log(1)');
    if (!commitAll(root)) {
      context.skip();
      return;
    }
    // 同 stat 签名的两次裁决走 TTL 缓存：结果一致且不重复拉起 git 进程。
    expect(assessScriptTrust('node scripts/run.mjs', root, root)).toBe('clean');
    expect(assessScriptTrust('node scripts/run.mjs', root, root)).toBe('clean');
    // 文件被改写后 stat 签名变化，缓存必须失效并识别为 dirty（安全关键方向不得被 TTL 掩盖）。
    fs.writeFileSync(script, 'console.log(1);\nconsole.log(2);');
    expect(assessScriptTrust('node scripts/run.mjs', root, root)).toBe('dirty');
  });

  it('rejects gitignored scripts, preload hooks, env hijacks and dirty build configs', (context) => {
    const root = temp();
    fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\nignored.mjs\n');
    fs.mkdirSync(path.join(root, 'scripts'));
    fs.writeFileSync(path.join(root, 'scripts', 'app.mjs'), 'console.log(1)');
    fs.writeFileSync(path.join(root, 'Makefile'), 'all:\n\t@echo ok\n');
    if (!commitAll(root)) {
      context.skip();
      return;
    }
    // 1. gitignored 文件未入 git 索引，不得返回 clean。
    fs.mkdirSync(path.join(root, 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node_modules', 'evil.mjs'), 'console.log("pwn")');
    fs.writeFileSync(path.join(root, 'ignored.mjs'), 'console.log("pwn")');
    expect(assessScriptTrust('node node_modules/evil.mjs', root, root)).toBe('dirty');
    expect(assessScriptTrust('node ignored.mjs', root, root)).toBe('dirty');

    // 2. `--require=` 预加载钩子为未跟踪文件时，即使主脚本干净也必须返回 dirty。
    fs.writeFileSync(path.join(root, 'scripts', 'hook.mjs'), 'console.log("hook")');
    expect(assessScriptTrust('node --require=./scripts/hook.mjs scripts/app.mjs', root, root)).toBe(
      'dirty',
    );

    // 3. 高危前导环境变量返回 unknown。
    expect(
      assessScriptTrust(
        'NODE_OPTIONS=--require=./scripts/hook.mjs node scripts/app.mjs',
        root,
        root,
      ),
    ).toBe('unknown');

    // 4. Makefile / vitest.config.ts：已提交为 clean，模型新写或改动为 dirty。
    expect(assessScriptTrust('make', root, root)).toBe('clean');
    fs.writeFileSync(path.join(root, 'vitest.config.ts'), 'export default {}');
    expect(assessScriptTrust('vitest run', root, root)).toBe('dirty');
  });
});
