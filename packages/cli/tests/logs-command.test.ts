import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const directories = vi.hoisted(() => ({ operation: '', audit: '' }));
vi.mock('@kiturone/kapibala', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@kiturone/kapibala')>()),
  createDefaultLogSinks: () => ({
    operationSink: { directory: directories.operation },
    auditSink: { directory: directories.audit },
  }),
}));

import type { CommandContext } from '../src/commands/dispatcher.js';
import { logsCommand } from '../src/commands/logs.js';

describe('/logs', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });

  it('shows recent operation and audit events without reading conversation history', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-logs-command-'));
    roots.push(root);
    directories.operation = path.join(root, 'logs');
    directories.audit = path.join(root, 'audit');
    fs.mkdirSync(directories.operation);
    fs.mkdirSync(directories.audit);
    const event = (timestamp: string, channel: string, name: string) =>
      JSON.stringify({
        timestamp,
        channel,
        level: 'info',
        event: name,
        fields: { status: 'completed' },
      });
    fs.writeFileSync(
      path.join(directories.operation, 'operation-2026-09-26-001.jsonl'),
      `${event('2026-09-26T00:00:00.000Z', 'operation', 'run.started')}\n`,
    );
    fs.writeFileSync(
      path.join(directories.audit, 'audit-2026-09-26-001.jsonl'),
      `${event('2026-09-26T00:00:01.000Z', 'audit', 'tool.finished')}\n`,
    );
    const printed: string[] = [];
    const original = console.log;
    console.log = (line: string) => printed.push(line);
    try {
      logsCommand(['2'], {} as CommandContext);
      expect(printed).toHaveLength(2);
      expect(printed[0]).toContain('run.started');
      expect(printed[1]).toContain('tool.finished');
    } finally {
      console.log = original;
    }
  });
});
