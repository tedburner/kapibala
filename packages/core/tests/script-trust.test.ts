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
});
