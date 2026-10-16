import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findCoreHostBoundaryViolations,
  scanCoreHostBoundary,
} from '../scripts/check-host-boundary.js';

describe('Headless Core architecture boundary', () => {
  it('rejects runtime dependencies on concrete context implementations', () => {
    expect(
      findCoreHostBoundaryViolations([
        {
          file: 'src/runtime/loop/index.ts',
          source: "import { ContextManager } from '../../context/manager.js';",
        },
      ]),
    ).toMatchObject([{ rule: 'runtime-context' }]);
  });

  it('rejects implicit process.cwd() usage in Core', () => {
    expect(
      findCoreHostBoundaryViolations([
        {
          file: 'src/context/some-file.ts',
          source: 'const current = process.cwd();',
        },
      ]),
    ).toMatchObject([{ rule: 'runtime-context' }]);
  });
  it('detects terminal rendering and CLI dependencies', () => {
    const violations = findCoreHostBoundaryViolations([
      { file: 'stdout.ts', source: 'process.stdout.write("hello");' },
      { file: 'console.ts', source: 'console.log("hello");' },
      { file: 'stdin.ts', source: "import { stdin } from 'node:process';" },
      { file: 'cli.ts', source: "import type { Cli } from '@kiturone/kapibala-cli';" },
      { file: 'side-effect-cli.ts', source: "import '@kiturone/kapibala-cli';" },
      { file: 'relative-cli.ts', source: "import { render } from '../../../cli/src/ui.js';" },
      { file: 'ansi.ts', source: String.raw`const red = '\x1b[31m';` },
    ]);

    expect(violations.map((violation) => violation.rule)).toEqual([
      'terminal-io',
      'terminal-io',
      'terminal-io',
      'cli-dependency',
      'cli-dependency',
      'cli-dependency',
      'terminal-rendering',
    ]);
  });

  it('detects stderr as direct terminal IO', () => {
    const violations = findCoreHostBoundaryViolations([
      { file: 'stderr.ts', source: 'process.stderr.write("failure");' },
      { file: 'stderr-import.ts', source: "import { stderr } from 'node:process';" },
    ]);

    expect(violations.map((violation) => violation.rule)).toEqual(['terminal-io', 'terminal-io']);
  });

  it('detects CommonJS and TypeScript require dependencies on the CLI', () => {
    const violations = findCoreHostBoundaryViolations([
      {
        file: 'require-cli.cts',
        source: "const cli = require('@kiturone/kapibala-cli');",
      },
      {
        file: 'import-equals-cli.cts',
        source: "import cli = require('@kiturone/kapibala-cli');",
      },
    ]);

    expect(violations.map((violation) => violation.rule)).toEqual([
      'cli-dependency',
      'cli-dependency',
    ]);
  });

  it('keeps the current Core source independent from host UI concerns', () => {
    const coreSourceDir = path.resolve('packages/core/src');

    expect(scanCoreHostBoundary(coreSourceDir)).toEqual([]);
  });

  it('scans every TypeScript source extension that can enter the Core build', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kapibala-core-boundary-'));
    try {
      for (const extension of ['tsx', 'mts', 'cts']) {
        fs.writeFileSync(path.join(tempDir, `host-ui.${extension}`), 'process.stdout.write("x");');
      }

      const violations = scanCoreHostBoundary(tempDir);

      expect(violations.map((violation) => path.extname(violation.file)).sort()).toEqual([
        '.cts',
        '.mts',
        '.tsx',
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('detects Core dependencies on MCP package or MCP sources', () => {
    const violations = findCoreHostBoundaryViolations([
      {
        file: 'mcp-import.ts',
        source: "import { createMcpPlugin } from '@kiturone/kapibala-mcp';",
      },
      {
        file: 'relative-mcp.ts',
        source: "import { McpServerManager } from '../../../mcp/src/manager.js';",
      },
    ]);

    expect(violations.map((violation) => violation.rule)).toEqual([
      'mcp-dependency',
      'mcp-dependency',
    ]);
  });

  it('detects MCP dependencies on CLI, Core internal private paths, and direct terminal IO', async () => {
    const { findMcpBoundaryViolations } = await import('../scripts/check-host-boundary.js');
    const violations = findMcpBoundaryViolations([
      { file: 'mcp-cli.ts', source: "import { main } from '@kiturone/kapibala-cli';" },
      {
        file: 'mcp-core-internal.ts',
        source: "import { AgentSession } from '@kiturone/kapibala/src/context/session/index.js';",
      },
      {
        file: 'mcp-core-rel.ts',
        source: "import { AgentSession } from '../../core/src/index.js';",
      },
      { file: 'mcp-terminal.ts', source: 'console.log("mcp terminal log");' },
      { file: 'mcp-stdout.ts', source: 'process.stdout.write("hello");' },
    ]);

    expect(violations.map((violation) => violation.rule)).toEqual([
      'cli-dependency',
      'core-internal',
      'core-internal',
      'terminal-io',
      'terminal-io',
    ]);
  });

  it('verifies that Core has zero runtime dependencies in package.json', async () => {
    const { checkCoreZeroRuntimeDependencies } = await import('../scripts/check-host-boundary.js');
    const corePkgPath = path.resolve('packages/core/package.json');
    const result = checkCoreZeroRuntimeDependencies(corePkgPath);
    expect(result.valid).toBe(true);
    expect(result.dependencies).toEqual([]);
  });

  it('keeps current MCP source independent from CLI and internal Core imports', async () => {
    const { scanMcpBoundary } = await import('../scripts/check-host-boundary.js');
    const mcpSourceDir = path.resolve('packages/mcp/src');
    expect(scanMcpBoundary(mcpSourceDir)).toEqual([]);
  });
});
