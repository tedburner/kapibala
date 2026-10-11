import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PromptAssembler } from '../src/capabilities/prompt/index.js';
import { formatSkillCatalog } from '../src/capabilities/skills/catalog.js';
import { SkillRuntime } from '../src/capabilities/skills/loader.js';
import { SkillRegistry } from '../src/capabilities/skills/registry.js';
import { defineTool } from '../src/capabilities/tools/index.js';
import { ToolRegistry } from '../src/capabilities/tools/registry.js';
import { UnicodeTokenEstimator } from '../src/context/budget.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await fs.rm(dir, { recursive: true, force: true });
});
async function registry(count = 8) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kpbl-catalog-'));
  dirs.push(root);
  for (let i = 0; i < count; i++) {
    const name = `skill-${i}`;
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(
      path.join(root, name, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${'中文技能用途<&>'.repeat(50)}\n---\nbody`,
    );
  }
  const result = new SkillRegistry({ roots: [{ path: root, scope: 'global' }] });
  await result.refresh();
  return result;
}
describe('skill prompt catalog', () => {
  it('requires the genuine visible loader and omits user-only skills', async () => {
    const skills = await registry(2);
    const hidden = skills.get('skill-1')!;
    await fs.writeFile(
      hidden.filePath,
      '---\nname: skill-1\ndescription: explicit only\ndisable-model-invocation: true\n---\nbody',
    );
    await skills.refresh();
    const tools = new ToolRegistry();
    const runtime = new SkillRuntime(skills, tools);
    runtime.syncTools();
    const loader = tools.get('load_skill')!;
    const options = { rootDir: '.', tools, skills, skillLoader: loader, contextWindow: 32000 };
    const catalog = new PromptAssembler(options).getSkillCatalog().text;
    expect(catalog).toContain('skill-0');
    expect(catalog).not.toContain('skill-1');
    expect(new PromptAssembler({ ...options, visibleTools: [] }).getSkillCatalog().text).toBe('');
    tools.unregister('load_skill');
    tools.register(
      defineTool({
        name: 'load_skill',
        description: 'plugin',
        parameters: { type: 'object' },
        execute: async () => 'fake',
      }),
    );
    expect(new PromptAssembler(options).getSkillCatalog().text).toBe('');
  });
  it('counts the complete escaped Chinese catalog within 1% of a 32K window', async () => {
    const skills = await registry();
    const result = formatSkillCatalog(skills.list('model'), 32000);
    expect(result.text).toContain('&lt;&amp;&gt;');
    expect(result.text).toContain('</available_skills>');
    expect(
      new UnicodeTokenEstimator().estimate({ systemPrompt: result.text, messages: [] }).system,
    ).toBeLessThanOrEqual(320);
    expect(result.omitted).toBeGreaterThan(0);
  });
  it('omits a catalog that cannot fit and never splits tags or Unicode characters', async () => {
    const skills = await registry();
    expect(formatSkillCatalog(skills.list('model'), 32000, 1).text).toBe('');
    expect(formatSkillCatalog([], 32000).text).toBe('');
    expect(formatSkillCatalog(skills.list('model'), 32000).text).toBe(
      formatSkillCatalog(skills.list('model'), 32000).text,
    );
  });
  it('finds omitted skills through bounded pages and rejects stale cursors', async () => {
    const skills = await registry(25);
    const first = skills.queryModel({ limit: 3 });
    expect(first.skills).toHaveLength(3);
    expect(first.nextCursor).toBeDefined();
    const second = skills.queryModel({ limit: 3, cursor: first.nextCursor });
    expect(second.skills[0]?.name).not.toBe(first.skills[0]?.name);
    expect(skills.queryModel({ query: 'skill-24' }).skills[0]?.name).toBe('skill-24');
    const removed = skills.get('skill-0')!;
    await fs.appendFile(removed.filePath, '\nnew');
    await skills.refresh();
    expect(() => skills.queryModel({ cursor: first.nextCursor })).toThrow(
      expect.objectContaining({ code: 'SKILL_CURSOR_EXPIRED' }),
    );
  });
});
