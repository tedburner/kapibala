import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkViewModelArtifact } from '../check-view-model.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(source: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-view-model-artifact-'));
  roots.push(root);
  fs.mkdirSync(path.join(root, 'dist/view-model'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({
      type: 'module',
      main: './dist/index.js',
      bin: { kpbl: './dist/bin.js' },
      exports: {
        '.': './dist/index.js',
        './view-model': {
          types: './dist/view-model/index.d.ts',
          import: './dist/view-model/index.js',
        },
      },
    }),
  );
  fs.writeFileSync(path.join(root, 'dist/index.js'), "throw new Error('CLI root must not run');");
  fs.writeFileSync(
    path.join(root, 'dist/bin.js'),
    "#!/usr/bin/env node\nthrow new Error('CLI bin must not run');",
  );
  fs.writeFileSync(path.join(root, 'dist/view-model/index.js'), source);
  fs.writeFileSync(
    path.join(root, 'dist/view-model/index.d.ts'),
    'export declare const answer: number;',
  );
  return root;
}

describe('published ViewModel artifact validation', () => {
  it('browser-builds and imports the standalone ESM without running the CLI root or bin', async () => {
    const result = await checkViewModelArtifact(fixture('export const answer = 42;'));
    expect(result.exports).toEqual(['answer']);
    expect(result.browserBytes).toBeGreaterThan(0);
  });

  it('rejects Node imports in the browser dependency closure', async () => {
    await expect(
      checkViewModelArtifact(fixture("import fs from 'node:fs'; export const answer = fs;")),
    ).rejects.toThrow();
  });

  it('rejects shebang leakage from the CLI executable build configuration', async () => {
    await expect(
      checkViewModelArtifact(fixture('#!/usr/bin/env node\nexport const answer = 42;')),
    ).rejects.toThrow(/shebang/i);
  });

  it('detects signal registration during ESM import in a separate process', async () => {
    await expect(
      checkViewModelArtifact(fixture("process.on('SIGINT', () => {}); export const answer = 42;")),
    ).rejects.toThrow(/side.effect/i);
  });

  it('rejects a browser-compatible relative import escaping the standalone artifact directory', async () => {
    const root = fixture("export { answer } from '../host.js';");
    fs.writeFileSync(path.join(root, 'dist/host.js'), 'export const answer = 42;');
    await expect(checkViewModelArtifact(root)).rejects.toThrow(/closure/i);
  });
});
