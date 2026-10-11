import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveProjectTrust } from '../src/project-trust.js';
import { loadSettings } from '../src/settings.js';
import { getCliSkillOptions } from '../src/skills.js';

const roots: string[] = [];
function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kapibala-skills-config-'));
  roots.push(root);
  const homeDir = path.join(root, 'home');
  const cwd = path.join(root, 'project');
  for (const dir of [homeDir, cwd]) fs.mkdirSync(path.join(dir, '.kapibala'), { recursive: true });
  return { homeDir, cwd };
}
function settingsFile(dir: string, data: unknown) {
  fs.writeFileSync(path.join(dir, '.kapibala/settings.json'), JSON.stringify(data));
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CLI skill configuration and trust', () => {
  it('requires explicit trust for skills without settings and preserves raw global profiles', async () => {
    const { homeDir, cwd } = workspace();
    fs.mkdirSync(path.join(cwd, '.agents/skills'), { recursive: true });
    const choose = vi.fn(async () => 'trust' as const);
    const result = await resolveProjectTrust(loadSettings({ homeDir, cwd }), {
      homeDir,
      cwd,
      projectRoot: cwd,
      interactive: true,
      choose,
    });
    expect(choose).toHaveBeenCalledWith(fs.realpathSync.native(cwd));
    expect(result.status).toBe('trusted');
    const raw = JSON.parse(fs.readFileSync(path.join(homeDir, '.kapibala/settings.json'), 'utf8'));
    expect(raw.profiles).toEqual([]);
    expect(raw.trustedProjects).toEqual([fs.realpathSync.native(cwd)]);
  });

  it('skips untrusted project skills noninteractively while retaining global roots', async () => {
    const { homeDir, cwd } = workspace();
    fs.mkdirSync(path.join(cwd, '.kapibala/skills'));
    const choose = vi.fn();
    const result = await resolveProjectTrust(loadSettings({ homeDir, cwd }), {
      homeDir,
      cwd,
      projectRoot: cwd,
      interactive: false,
      choose,
    });
    expect(result.status).toBe('ready');
    expect(choose).not.toHaveBeenCalled();
    if (result.status !== 'ready') throw new Error('expected ready');
    const options = getCliSkillOptions(result.loaded.settings, { homeDir, cwd, projectRoot: cwd });
    expect(
      options.roots.filter((root) => root.scope === 'project').every((root) => !root.trusted),
    ).toBe(true);
    expect(
      options.roots.filter((root) => root.scope === 'global').every((root) => root.trusted),
    ).toBe(true);
    expect(fs.existsSync(path.join(homeDir, '.kapibala/settings.json'))).toBe(false);
  });

  it('merges trusted project restrictions by AND and union', () => {
    const { homeDir, cwd } = workspace();
    settingsFile(homeDir, {
      profiles: [],
      trustedProjects: [fs.realpathSync.native(cwd)],
      skills: { enabled: false, disabled: ['a'] },
    });
    settingsFile(cwd, { skills: { enabled: true, disabled: ['b', 'a'] } });
    const loaded = loadSettings({ homeDir, cwd });
    expect(loaded.settings.skills).toEqual({ enabled: false, disabled: ['a', 'b'] });
  });

  it.each([{ enabled: 'false' }, { disabled: 'a' }, { disabled: ['../bad'] }, null])(
    'fails invalid skill config %j instead of enabling defaults',
    (skills) => {
      const { homeDir, cwd } = workspace();
      settingsFile(homeDir, { profiles: [], skills });
      expect(() => loadSettings({ homeDir, cwd })).toThrow(/skills/);
    },
  );

  it('trust is exact to the Git root and project config cannot trust itself', () => {
    const { homeDir, cwd } = workspace();
    const nested = path.join(cwd, 'sub');
    fs.mkdirSync(nested);
    const options = getCliSkillOptions(
      { defaultModel: 'x', profiles: [], trustedProjects: [fs.realpathSync.native(nested)] },
      { homeDir, cwd: nested, projectRoot: cwd },
    );
    expect(
      options.roots.filter((root) => root.scope === 'project').every((root) => !root.trusted),
    ).toBe(true);
  });
});
