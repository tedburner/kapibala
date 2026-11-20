import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PathSandbox } from '../src/capabilities/security/sandbox.js';
import { readFileTool, writeFileTool } from '../src/capabilities/tools/builtin/fs.js';
import {
  cleanupManagedResults,
  fallbackToolResultsDirectory,
  removeSessionToolResults,
  sessionToolResultsDirectory,
} from '../src/context/managed-results.js';
import { SessionManager } from '../src/context/session-manager.js';
import { computeProjectKey, toNativePhysicalPath } from '../src/context/workspace.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('sessionToolResultsDirectory', () => {
  it('buckets by project key and session id', () => {
    const root = toNativePhysicalPath('/repo');
    const dir = sessionToolResultsDirectory({
      resultsRoot: '/home/.kapibala/tool-results',
      projectKey: computeProjectKey(root),
      sessionId: 'conv-1',
    });
    expect(dir).toBe(
      path.join('/home/.kapibala/tool-results', computeProjectKey(root), 'conv-1'),
    );
  });

  it('rejects unsafe session ids to prevent path injection', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', '../escape']) {
      expect(() =>
        sessionToolResultsDirectory({
          resultsRoot: '/r',
          projectKey: 'k',
          sessionId: bad,
        }),
      ).toThrow();
    }
    // 常规 ID（字母数字与 . _ -）合法，仅拒绝路径注入形态。
    expect(() =>
      sessionToolResultsDirectory({ resultsRoot: '/r', projectKey: 'k', sessionId: 'a.b_c-d' }),
    ).not.toThrow();
  });
});

describe('fallbackToolResultsDirectory', () => {
  it('stays outside any workspace and is user-scoped', () => {
    const dir = fallbackToolResultsDirectory();
    expect(path.isAbsolute(dir)).toBe(true);
    expect(dir).toContain('kapibala-tool-results');
  });
});

describe('PathSandbox read-only exemptions', () => {
  it('allows read_file inside the exemption root and denies write', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-sandbox-exempt-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-sandbox-exempt-out-'));
    directories.push(root, outside);
    // 豁免根必须位于工作区外（真实场景：~/.kapibala/tool-results/...），否则豁免无从验证。
    const exemption = path.join(outside, 'results');
    fs.mkdirSync(exemption, { recursive: true });
    const file = path.join(exemption, 'run-00000000-0000-4000-8000-000000000000.txt');
    fs.writeFileSync(file, 'full output');

    const sandbox = new PathSandbox({ workspaceRoot: root, readOnlyExemptions: () => [exemption] });
    const ctx = { rootDir: root, sandbox };

    const content = await readFileTool.execute({ path: file }, ctx as never);
    expect(content).toBe('full output');

    await expect(
      writeFileTool.execute({ path: path.join(exemption, 'evil.txt'), content: 'x' }, ctx as never),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(exemption, 'evil.txt'))).toBe(false);
  });

  it('denies sibling session directories and honors lazy re-evaluation', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-sandbox-sibling-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-sandbox-sibling-out-'));
    directories.push(root, outside);
    const own = path.join(outside, 'conv-a');
    const sibling = path.join(outside, 'conv-b');
    fs.mkdirSync(own, { recursive: true });
    fs.mkdirSync(sibling, { recursive: true });
    const siblingFile = path.join(sibling, 'run-00000000-0000-4000-8000-000000000000.txt');
    fs.writeFileSync(siblingFile, 'other session');

    // 豁免只指向本会话桶；惰性求值（会话恢复改名后豁免随当前值更新）。
    let current = own;
    const sandbox = new PathSandbox({ workspaceRoot: root, readOnlyExemptions: () => [current] });
    await expect(
      readFileTool.execute({ path: siblingFile }, { rootDir: root, sandbox } as never),
    ).rejects.toThrow();

    current = sibling;
    expect(
      await readFileTool.execute({ path: siblingFile }, { rootDir: root, sandbox } as never),
    ).toBe('other session');
  });
});

describe('managed results lifecycle', () => {
  it('cleanup removes only manifest-tracked expired files', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-mr-cleanup-'));
    directories.push(root);
    fs.mkdirSync(root, { recursive: true });
    const tracked = path.join(root, 'run-10000000-0000-4000-8000-000000000001.txt');
    const untracked = path.join(root, 'run-10000000-0000-4000-8000-000000000002.txt');
    fs.writeFileSync(tracked, 'tracked');
    fs.writeFileSync(untracked, 'untracked');
    recordForTest(root, tracked);
    const old = new Date(Date.now() - 8 * 86_400_000);
    fs.utimesSync(tracked, old, old);
    fs.utimesSync(untracked, old, old);

    cleanupManagedResults(root);
    expect(fs.existsSync(tracked)).toBe(false);
    expect(fs.existsSync(untracked)).toBe(true);
  });

  it('cleanup refuses to act when the manifest is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-mr-nomanifest-'));
    directories.push(root);
    const file = path.join(root, 'run-10000000-0000-4000-8000-000000000003.txt');
    fs.writeFileSync(file, 'data');
    const old = new Date(Date.now() - 30 * 86_400_000);
    fs.utimesSync(file, old, old);

    cleanupManagedResults(root);
    expect(fs.existsSync(file)).toBe(true);
  });

  it('removeSessionToolResults tolerates missing directories', () => {
    expect(() => removeSessionToolResults(path.join(os.tmpdir(), 'kpbl-mr-missing-xyz'))).not.toThrow();
  });
});

describe('SessionManager delete linkage', () => {
  it('removes the session results subtree on deleteSession', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-mr-home-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-mr-ws-'));
    directories.push(home, workspace);
    const resultsRoot = path.join(home, '.kapibala', 'tool-results');
    const manager = new SessionManager({
      workspaceRoot: workspace,
      homeDirectory: home,
      toolResultsDirectory: resultsRoot,
    });
    const handle = await manager.create();
    const projectKey = computeProjectKey(toNativePhysicalPath(workspace));
    const dir = path.join(resultsRoot, projectKey, handle.conversationId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run-10000000-0000-4000-8000-000000000004.txt'), 'out');
    expect(fs.existsSync(dir)).toBe(true);
    // 删除前必须释放句柄：会话在用时禁止删除（SESSION_IN_USE 保护）。
    await handle.release();

    await manager.deleteSession(handle.conversationId);
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('keeps results of other sessions when deleting one', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-mr-home2-'));
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-mr-ws2-'));
    directories.push(home, workspace);
    const resultsRoot = path.join(home, '.kapibala', 'tool-results');
    const manager = new SessionManager({
      workspaceRoot: workspace,
      homeDirectory: home,
      toolResultsDirectory: resultsRoot,
    });
    const first = await manager.create();
    const second = await manager.create();
    const projectKey = computeProjectKey(toNativePhysicalPath(workspace));
    const kept = path.join(resultsRoot, projectKey, second.conversationId);
    fs.mkdirSync(kept, { recursive: true });
    fs.writeFileSync(path.join(kept, 'run-10000000-0000-4000-8000-000000000005.txt'), 'out');
    await first.release();

    await manager.deleteSession(first.conversationId);
    expect(fs.existsSync(kept)).toBe(true);
    await second.release();
  });
});

/** 测试专用：直接写清理清单（模拟 shell 工具的登记行为）。 */
function recordForTest(directory: string, file: string): void {
  const stat = fs.statSync(file);
  fs.appendFileSync(
    path.join(directory, 'managed-results.jsonl'),
    `${JSON.stringify({ name: path.basename(file), dev: stat.dev, ino: stat.ino })}\n`,
    { mode: 0o600 },
  );
}
