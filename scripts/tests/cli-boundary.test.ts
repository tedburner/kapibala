import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findCliBoundaryViolations, scanCliBoundary } from '../check-cli-boundary.js';

const sourceRoot = path.resolve('packages/cli/src');
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('CLI presentation boundaries', () => {
  it.each([
    "import fs from 'node:fs';",
    "import type { AgentSession } from '@kiturone/kapibala';",
    "export { client } from '@kiturone/kapibala-mcp';",
    "import React from 'react';",
    "import { main } from '../index.js';",
    "const host = import('../host/port.js');",
    "import Host = require('../host/port.js');",
    "type Host = import('../host/port.js').Host;",
    'const module = import(target);',
  ])('rejects forbidden ViewModel dependencies: %s', (source) => {
    expect(
      findCliBoundaryViolations(
        [{ file: path.join(sourceRoot, 'view-model/bad.ts'), source }],
        sourceRoot,
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'view-model-dependency' })]));
  });

  it.each([
    'process.on("SIGINT", handler);',
    'window.location.href;',
    'document.createElement("div");',
    'globalThis["process"].cwd();',
    'console.log("side effect");',
    "const color = '\\x1b[31m';",
  ])('rejects runtime/DOM/terminal access in ViewModel: %s', (source) => {
    expect(
      findCliBoundaryViolations(
        [{ file: path.join(sourceRoot, 'view-model/bad.ts'), source }],
        sourceRoot,
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'view-model-runtime' })]));
  });

  it.each([
    "import { Session } from '../host/session.js';",
    "import type { CommandContext } from '../commands/dispatcher.js';",
    "import { main } from '../index.js';",
    "import { AgentSession as Session } from '@kiturone/kapibala';",
    "export { host } from '@kiturone/kapibala-cli';",
  ])('rejects host implementation dependencies in TUI: %s', (source) => {
    expect(
      findCliBoundaryViolations(
        [{ file: path.join(sourceRoot, 'tui/bad.tsx'), source }],
        sourceRoot,
      ),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ rule: 'tui-dependency' })]));
  });

  it('rejects direct session creation while allowing renderer and pure presentation dependencies', () => {
    const files = [
      { file: path.join(sourceRoot, 'tui/bad.ts'), source: 'new namespace.AgentSession(options);' },
      {
        file: path.join(sourceRoot, 'tui/good.tsx'),
        source:
          "import React from 'react'; import { Text } from 'ink'; import { state } from '../view-model/index.js'; import { frame } from './frame.js';",
      },
      {
        file: path.join(sourceRoot, 'view-model/good.ts'),
        source:
          "import type { View } from './types.js'; const value = { process: 'a label', document: 'metadata' }; // console.log is documentation",
      },
    ];
    expect(findCliBoundaryViolations(files, sourceRoot)).toMatchObject([{ rule: 'tui-session' }]);
  });

  it('scans multiline imports and all TypeScript/JavaScript source extensions from disk', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-cli-boundary-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'view-model'));
    for (const extension of ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs']) {
      fs.writeFileSync(
        path.join(root, `view-model/bad.${extension}`),
        "import {\n secret\n} from '../host/secret.js';",
      );
    }
    expect(scanCliBoundary(root)).toHaveLength(8);
  });

  it('keeps the current CLI layers inside the declared boundaries', () => {
    expect(scanCliBoundary(sourceRoot)).toEqual([]);
  });

  it('returns a failing process status for an on-disk negative fixture', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-cli-boundary-exit-'));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'view-model'));
    fs.writeFileSync(path.join(root, 'view-model/bad.ts'), "import 'node:fs';");
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', path.resolve('scripts/check-cli-boundary.ts'), root],
      { encoding: 'utf8', timeout: 10_000 },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('view-model-dependency');
  });
});
