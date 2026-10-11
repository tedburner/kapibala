import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SkillRegistry } from '../src/capabilities/skills/registry.js';
import { scanSkillRoot } from '../src/capabilities/skills/scanner.js';

const dirs: string[] = [];
async function temp() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kpbl-skills-'));
  dirs.push(dir);
  return dir;
}
async function skill(root: string, name: string, extra = '', body = 'Follow the workflow.') {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Help with ${name}\n${extra}---\n${body}`,
  );
  return dir;
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});

describe('bounded skill discovery', () => {
  it('bounds entry and directory enumeration, retaining other independently scanned roots', async () => {
    const oversized = await temp();
    const directories = await temp();
    const good = await temp();
    await skill(good, 'good');
    for (let offset = 0; offset < 2000; offset += 50)
      await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          fs.mkdir(path.join(directories, `d-${offset + index}`)),
        ),
      );
    const original = fs.opendir.bind(fs);
    const fake = {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 20001; i++) yield { name: `entry-${i}` };
      },
    };
    vi.spyOn(fs, 'opendir').mockImplementation(async (target, options) =>
      String(target) === oversized
        ? (fake as unknown as Awaited<ReturnType<typeof fs.opendir>>)
        : original(target, options),
    );
    const registry = new SkillRegistry({
      roots: [
        { path: oversized, scope: 'global' },
        { path: directories, scope: 'global' },
        { path: good, scope: 'global' },
      ],
    });
    await registry.refresh();
    expect(registry.list('model').map((item) => item.name)).toEqual(['good']);
    expect(registry.diagnostics.filter((item) => item.code === 'SKILL_SCAN_LIMIT')).toHaveLength(2);
  }, 45000);
  it('falls back after an unreadable root without pretending it was empty', async () => {
    const denied = await temp();
    const good = await temp();
    await skill(good, 'good');
    const original = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation(async (target, options) => {
      if (String(target) === denied) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return original(target, options);
    });
    const registry = new SkillRegistry({
      roots: [
        { path: denied, scope: 'global' },
        { path: good, scope: 'global' },
      ],
    });
    await registry.refresh();
    expect(registry.list('model').map((item) => item.name)).toEqual(['good']);
    expect(registry.diagnostics.some((item) => item.code === 'SKILL_SCAN_FAILED')).toBe(true);
  });
  it('digests original UTF-8 bytes including BOM and CRLF', async () => {
    const root = await temp();
    const dir = await skill(root, 'review');
    const raw = '\uFEFF---\r\nname: review\r\ndescription: Review code\r\n---\r\nbody';
    await fs.writeFile(path.join(dir, 'SKILL.md'), raw);
    const result = await scanSkillRoot({ path: root, scope: 'global' });
    expect(result.skills[0]?.contentDigest).toBe(createHash('sha256').update(raw).digest('hex'));
  });
  it('stops at skill package boundary and discovers a root skill itself', async () => {
    const root = await temp();
    const parent = await skill(root, 'review');
    await skill(path.join(parent, 'references'), 'nested');
    expect(
      (await scanSkillRoot({ path: root, scope: 'global' })).skills.map((s) => s.name),
    ).toEqual(['review']);
    expect(
      (await scanSkillRoot({ path: parent, scope: 'global' })).skills.map((s) => s.name),
    ).toEqual(['review']);
  });
  it('does not execute untrusted project skills without settings', async () => {
    const root = await temp();
    await skill(root, 'review');
    const result = await scanSkillRoot({ path: root, scope: 'project' });
    expect(result.skills[0]?.available).toBe(false);
    expect(result.diagnostics.some((d) => d.code === 'SKILL_UNTRUSTED')).toBe(true);
  });
  it('isolates ignore rules and does not scan excluded parents', async () => {
    const root = await temp();
    await fs.mkdir(path.join(root, 'a'));
    await fs.mkdir(path.join(root, 'b'));
    await fs.writeFile(path.join(root, '.gitignore'), 'skip/\n!skip/review/\n[unsupported]\n');
    await fs.writeFile(path.join(root, 'a', '.gitignore'), 'review/\n');
    await skill(path.join(root, 'a'), 'review');
    await skill(path.join(root, 'b'), 'review');
    await skill(path.join(root, 'skip'), 'review');
    const result = await scanSkillRoot({ path: root, scope: 'global' });
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0]?.filePath).toContain(`${path.sep}b${path.sep}`);
    expect(result.diagnostics.some((d) => d.code === 'SKILL_IGNORE_UNSUPPORTED')).toBe(true);
  });
  it('applies anchored inherited ignores to lexical paths through in-root junctions', async () => {
    const root = await temp();
    const scanRoot = path.join(root, 'skills');
    await fs.mkdir(scanRoot);
    const physical = path.join(root, 'z-target');
    await skill(physical, 'review');
    await fs.symlink(physical, path.join(scanRoot, 'a-alias'), 'junction');
    await fs.writeFile(path.join(scanRoot, '.gitignore'), '/a-alias/review/\n');
    const result = await scanSkillRoot({
      path: scanRoot,
      scope: 'project',
      trusted: true,
      boundary: root,
    });
    expect(result.skills).toHaveLength(0);
  });
  it('rejects oversized files without preventing other skills', async () => {
    const root = await temp();
    const bad = await skill(root, 'bad');
    await fs.writeFile(path.join(bad, 'SKILL.md'), 'x'.repeat(128 * 1024 + 1));
    await skill(root, 'good');
    const result = await scanSkillRoot({ path: root, scope: 'global' });
    expect(result.skills.map((s) => s.name)).toEqual(['good']);
    expect(result.diagnostics.some((d) => d.code === 'SKILL_INVALID')).toBe(true);
  });
  it('bounds depth and rejects links outside the root while avoiding loops', async () => {
    const root = await temp();
    const outside = await temp();
    await skill(outside, 'external');
    await skill(path.join(root, ...Array.from({ length: 7 }, (_, i) => `d${i}`)), 'too-deep');
    await fs.symlink(outside, path.join(root, 'external-link'), 'junction');
    await fs.symlink(root, path.join(root, 'loop'), 'junction');
    const result = await scanSkillRoot({ path: root, scope: 'global' });
    expect(result.skills).toHaveLength(0);
    expect(result.diagnostics.some((d) => d.code === 'SKILL_PATH_DENIED')).toBe(true);
    expect(result.diagnostics.some((d) => d.code === 'SKILL_SCAN_LIMIT')).toBe(true);
  });
});

describe('skill registry snapshot', () => {
  it('rejects repointed and broken discovery roots even when skill bytes are identical', async () => {
    const first = await temp();
    const second = await temp();
    const holder = await temp();
    await skill(first, 'review');
    await skill(second, 'review');
    const alias = path.join(holder, 'root');
    await fs.symlink(first, alias, 'junction');
    const registry = new SkillRegistry({ roots: [{ path: alias, scope: 'global' }] });
    await registry.refresh();
    await fs.unlink(alias);
    await fs.symlink(second, alias, 'junction');
    await expect(registry.load('review', 'model')).rejects.toMatchObject({ code: 'SKILL_CHANGED' });
    await fs.unlink(alias);
    await expect(registry.load('review', 'model')).rejects.toMatchObject({ code: 'SKILL_CHANGED' });
  });
  it('uses all five precedence levels and keeps low aliases from changing physical project identity', async () => {
    const native = await temp();
    const agents = await temp();
    const global = await temp();
    const globalAgents = await temp();
    const builtins = await temp();
    const aliasParent = await temp();
    const alias = path.join(aliasParent, 'alias');
    for (const root of [native, agents, global, globalAgents, builtins])
      await skill(root, 'review');
    await fs.symlink(native, alias, 'junction');
    const sources = [
      { path: builtins, scope: 'builtin' as const },
      { path: alias, scope: 'global' as const, kind: 'agents' as const },
      { path: globalAgents, scope: 'global' as const, kind: 'agents' as const },
      { path: global, scope: 'global' as const },
      { path: agents, scope: 'project' as const, kind: 'agents' as const, trusted: true },
      { path: native, scope: 'project' as const, trusted: true },
    ];
    const registry = new SkillRegistry({ roots: sources });
    await registry.refresh();
    expect(registry.get('review')).toMatchObject({
      scope: 'project',
      priority: 0,
      sourceRoot: await fs.realpath(native),
    });
    expect(registry.list()).toHaveLength(1);
    const snapshot = registry.get('review')!;
    snapshot.description = 'changed externally';
    expect(registry.get('review')!.description).not.toBe(snapshot.description);
    await fs.appendFile(path.join(native, 'review/SKILL.md'), '\nchanged');
    const independent = new SkillRegistry({ roots: sources });
    await independent.refresh();
    expect(independent.get('review')!.contentDigest).not.toBe(
      registry.get('review')!.contentDigest,
    );
  });
  it('uses native project priority and exposes shadows', async () => {
    const global = await temp();
    const agents = await temp();
    const native = await temp();
    await skill(global, 'review');
    await skill(agents, 'review');
    await skill(native, 'review');
    const registry = new SkillRegistry({
      roots: [
        { path: global, scope: 'global' },
        { path: agents, scope: 'project', kind: 'agents', trusted: true },
        { path: native, scope: 'project', trusted: true },
      ],
    });
    await registry.refresh();
    expect(registry.get('review')?.sourceRoot).toBe(await fs.realpath(native));
    expect(registry.diagnostics.some((d) => d.code === 'SKILL_SHADOWED')).toBe(true);
  });
  it('falls back past invalid or untrusted candidates but keeps explicit disabling', async () => {
    const global = await temp();
    const project = await temp();
    await skill(global, 'review');
    await skill(project, 'review');
    const registry = new SkillRegistry({
      roots: [
        { path: project, scope: 'project' },
        { path: global, scope: 'global' },
      ],
    });
    await registry.refresh();
    expect(registry.get('review')?.scope).toBe('global');
    const disabled = new SkillRegistry({
      roots: [{ path: global, scope: 'global' }],
      disabled: ['review'],
    });
    await disabled.refresh();
    expect(disabled.list('model')).toHaveLength(0);
    expect(disabled.get('review')?.disabled).toBe(true);
  });
  it('detects changed content within a snapshot and refreshes on the next run', async () => {
    const root = await temp();
    const dir = await skill(root, 'review');
    const registry = new SkillRegistry({ roots: [{ path: root, scope: 'global' }] });
    await registry.refresh();
    const oldDigest = registry.get('review')!.contentDigest;
    expect(registry.get('review')).not.toHaveProperty('body');
    expect((await registry.load('review', 'model')).body).toBe('Follow the workflow.');
    await fs.appendFile(path.join(dir, 'SKILL.md'), '\nChanged');
    await expect(registry.load('review', 'model')).rejects.toMatchObject({ code: 'SKILL_CHANGED' });
    await registry.refresh();
    expect((await registry.load('review', 'model')).contentDigest).not.toBe(oldDigest);
  });
});
