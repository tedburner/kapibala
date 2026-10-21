import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkProtocolBoundary } from '../../../scripts/check-local-boundary.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const fixture = (content: string) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-protocol-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'index.ts'), content);
  return root;
};
describe('protocol dependency closure', () => {
  it('accepts a pure local dependency graph', () => {
    const root = fixture("export * from './types.js';");
    fs.writeFileSync(path.join(root, 'types.ts'), 'export type ID = string;');
    expect(checkProtocolBoundary(root)).toEqual([]);
  });
  it.each([
    "import fs from 'node:fs';",
    "export * from '../host.js';",
    "void import('node:net');",
    "const x = require('fs');",
    "const target = './x.js'; void import(target);",
  ])('rejects a dependency escape: %s', (content) => {
    expect(checkProtocolBoundary(fixture(content)).length).toBeGreaterThan(0);
  });
});
