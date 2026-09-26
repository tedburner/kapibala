import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadSettings } from '../src/settings.js';

describe('execution settings sources', () => {
  const roots: string[] = [];
  const fixture = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-execution-settings-'));
    roots.push(root);
    const homeDir = path.join(root, 'home');
    const cwd = path.join(root, 'project');
    fs.mkdirSync(path.join(homeDir, '.kapibala'), { recursive: true });
    fs.mkdirSync(path.join(cwd, '.kapibala'), { recursive: true });
    return { homeDir, cwd };
  };
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('accepts user-level shell and permission settings', () => {
    const { homeDir, cwd } = fixture();
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify({
        permissionMode: 'Auto',
        shell: { enabled: false, preference: 'pwsh' },
        permissionRules: [{ action: 'deny', tool: 'run_command' }],
      }),
    );
    expect(loadSettings({ homeDir, cwd }).settings).toMatchObject({
      permissionMode: 'Auto',
      shell: { enabled: false, preference: 'pwsh' },
      permissionRules: [{ action: 'deny', tool: 'run_command' }],
    });
  });

  it('rejects unsupported shell wildcard rules instead of ignoring them', () => {
    const { homeDir, cwd } = fixture();
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify({
        permissionRules: [{ action: 'deny', shell: { command: 'rm*', cwd, interpreter: 'bash' } }],
      }),
    );
    expect(() => loadSettings({ homeDir, cwd })).toThrow(/rule 1/i);
  });

  it('rejects project permission and shell settings even after the project is trusted', () => {
    const { homeDir, cwd } = fixture();
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify({ trustedProjects: [fs.realpathSync.native(cwd)] }),
    );
    fs.writeFileSync(
      path.join(cwd, '.kapibala', 'settings.json'),
      JSON.stringify({ shell: { enabled: true } }),
    );
    expect(() => loadSettings({ homeDir, cwd })).toThrow(/Project settings cannot define/);
  });

  it('diagnoses a trusted project FullAccess default and falls back to Approval', () => {
    const { homeDir, cwd } = fixture();
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify({ trustedProjects: [fs.realpathSync.native(cwd)], permissionMode: 'Auto' }),
    );
    fs.writeFileSync(
      path.join(cwd, '.kapibala', 'settings.json'),
      JSON.stringify({ permissionMode: 'FullAccess' }),
    );
    const diagnostics: string[] = [];
    const original = console.error;
    console.error = (message: string) => diagnostics.push(message);
    try {
      expect(loadSettings({ homeDir, cwd }).settings.permissionMode).toBe('Approval');
      expect(diagnostics.join(' ')).toMatch(/FullAccess/);
    } finally {
      console.error = original;
    }
  });

  it('diagnoses a user FullAccess default and falls back to Approval', () => {
    const { homeDir, cwd } = fixture();
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify({ permissionMode: 'FullAccess' }),
    );
    const diagnostics: string[] = [];
    const original = console.error;
    console.error = (message: string) => diagnostics.push(message);
    try {
      expect(loadSettings({ homeDir, cwd }).settings.permissionMode).toBe('Approval');
      expect(diagnostics.join(' ')).toMatch(/FullAccess/);
    } finally {
      console.error = original;
    }
  });

  it('safely loads legacy settings lacking execution fields and uses safe defaults', () => {
    const { homeDir, cwd } = fixture();
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify({ defaultModel: 'deepseek-flash', profiles: [] }),
    );
    const { settings } = loadSettings({ homeDir, cwd });
    expect(settings.permissionMode).toBeUndefined();
    expect(settings.permissionRules).toBeUndefined();
    expect(settings.shell).toBeUndefined();
  });
});
