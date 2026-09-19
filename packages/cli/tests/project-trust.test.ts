import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveProjectTrust } from '../src/project-trust.js';
import { loadSettings } from '../src/settings.js';

const temporaryDirectories: string[] = [];

function createWorkspace(): { homeDir: string; projectDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kapibala-trust-'));
  temporaryDirectories.push(root);
  const homeDir = path.join(root, 'home');
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(path.join(homeDir, '.kapibala'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '.kapibala'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, '.kapibala', 'settings.json'),
    JSON.stringify({ defaultModel: 'gpt-4o' }),
  );
  return { homeDir, projectDir };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('resolveProjectTrust', () => {
  it('persists trust and reloads project settings after explicit approval', async () => {
    const { homeDir, projectDir } = createWorkspace();
    const choose = vi.fn(async () => 'trust' as const);

    const result = await resolveProjectTrust(loadSettings({ homeDir, cwd: projectDir }), {
      homeDir,
      cwd: projectDir,
      interactive: true,
      choose,
    });

    expect(choose).toHaveBeenCalledOnce();
    expect(result.status).toBe('trusted');
    if (result.status !== 'trusted') throw new Error('expected trusted result');
    expect(result.loaded.settings.defaultModel).toBe('gpt-4o');
  });

  it('rejects without persisting trust when the user declines', async () => {
    const { homeDir, projectDir } = createWorkspace();

    const result = await resolveProjectTrust(loadSettings({ homeDir, cwd: projectDir }), {
      homeDir,
      cwd: projectDir,
      interactive: true,
      choose: async () => 'reject',
    });

    expect(result).toEqual({ status: 'rejected' });
    expect(loadSettings({ homeDir, cwd: projectDir }).pendingProject).toBeDefined();
  });

  it('rejects an untrusted project without prompting in non-interactive mode', async () => {
    const { homeDir, projectDir } = createWorkspace();
    const choose = vi.fn(async () => 'trust' as const);

    const result = await resolveProjectTrust(loadSettings({ homeDir, cwd: projectDir }), {
      homeDir,
      cwd: projectDir,
      interactive: false,
      choose,
    });

    expect(result).toEqual({ status: 'non_interactive' });
    expect(choose).not.toHaveBeenCalled();
  });
});
