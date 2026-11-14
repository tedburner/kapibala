import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionManager, resolveSessionProject } from '../src/context/session-manager.js';
import { computeProjectKey } from '../src/context/workspace.js';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

describe('exact session project identity', () => {
  it('keeps nested default-space history separate from an ancestor Git repository on reopen', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-exact-root-'));
    directories.push(home);
    execFileSync('git', ['init', '--quiet', home]);
    const root = path.join(home, '.kapibala/workspaces/default');
    fs.mkdirSync(root, { recursive: true });
    const physical = fs.realpathSync.native(root);
    const options = { workspaceRoot: root, homeDirectory: home, projectRootMode: 'exact' as const };
    const manager = new SessionManager(options);
    expect(manager.project).toMatchObject({
      projectRoot: physical,
      projectKey: computeProjectKey(physical),
    });
    expect(manager.project.gitBranch).toBeUndefined();
    expect(resolveSessionProject(root).projectRoot).toBe(fs.realpathSync.native(home));
    const handle = await manager.create();
    const id = handle.conversationId;
    await handle.store.append({ role: 'user', content: [{ type: 'text', text: 'default space' }] });
    await manager.close();
    const reopened = new SessionManager(options);
    expect((await reopened.list()).items.map((item) => item.conversationId)).toEqual([id]);
    const restored = await reopened.open(id);
    expect((await restored.store.loadState()).header.projectRoot).toBe(physical);
    expect((await restored.store.load())[0].content).toEqual([
      { type: 'text', text: 'default space' },
    ]);
    await reopened.close();
    expect(
      (await new SessionManager({ workspaceRoot: home, homeDirectory: home }).list()).total,
    ).toBe(0);
  });
});
