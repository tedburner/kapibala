import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// 真实文件软链验收；在支持创建文件软链的环境执行，失败不静默跳过。
const workspace = path.resolve(process.argv[2] ?? '.');
const { SkillRegistry } = await import(
  pathToFileURL(path.join(workspace, 'packages/core/dist/index.js')).href
);
const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'kpbl-v005-links-'));
try {
  const root = path.join(temporary, 'skills');
  await fs.mkdir(root);
  const body = '---\nname: guide\ndescription: linked guide\n---\nLinked body.';
  const inside = path.join(root, 'source.md');
  const outside = path.join(temporary, 'outside.md');
  await fs.writeFile(inside, body);
  await fs.writeFile(outside, body.replace('guide', 'outside'));
  for (const [name, target] of [
    ['guide', inside],
    ['outside', outside],
    ['broken', path.join(root, 'missing.md')],
  ]) {
    const directory = path.join(root, name);
    await fs.mkdir(directory);
    await fs.symlink(target, path.join(directory, 'SKILL.md'));
  }
  const registry = new SkillRegistry({ roots: [{ path: root, scope: 'global' }] });
  await registry.refresh();
  assert.deepEqual(
    registry.list('model').map((skill) => skill.name),
    ['guide'],
  );
  assert.equal((await registry.load('guide', 'model')).body, 'Linked body.');
  const file = path.join(root, 'guide/SKILL.md');
  await fs.unlink(file);
  await fs.symlink(outside, file);
  await assert.rejects(registry.load('guide', 'model'), { code: 'SKILL_CHANGED' });
  console.log(
    JSON.stringify({
      platform: process.platform,
      passed: true,
      checks: [
        'in-root-file-link',
        'outside-file-link-denied',
        'broken-file-link-excluded',
        'repointed-file-link-denied',
      ],
    }),
  );
} finally {
  assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
  assert.ok(path.basename(temporary).startsWith('kpbl-v005-links-'));
  await fs.rm(temporary, { recursive: true, force: true });
}
