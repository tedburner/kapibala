import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileLogSink, recoverIncompleteAudit } from '../src/logging/file-sink.js';
import type { LogEvent } from '../src/logging/index.js';

describe('audit crash recovery', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('marks an unclosed operation unknown with its original toolUseId once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-recovery-'));
    dirs.push(dir);
    const sink = new FileLogSink({ directory: dir, prefix: 'audit' });
    const base: LogEvent = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      channel: 'audit',
      level: 'info',
      event: 'tool.requested',
      sessionId: 'old-session',
      runId: 'old-run',
      operationId: 'old-operation',
      toolUseId: 'tool-use-1',
      fields: {},
    };
    await sink.write(base);
    await sink.write({ ...base, event: 'tool.decided' });
    await sink.write({ ...base, event: 'tool.started' });
    expect(await recoverIncompleteAudit(dir)).toBe(1);
    expect(await recoverIncompleteAudit(dir)).toBe(0);
    const lines = fs
      .readdirSync(dir)
      .flatMap((name) => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n'));
    const last = JSON.parse(lines.at(-1)!) as LogEvent;
    expect(last).toMatchObject({
      event: 'audit.outcome_unknown',
      operationId: 'old-operation',
      toolUseId: 'tool-use-1',
    });
  });

  it('treats both pre-start and post-decision crashes as unknown, but leaves finished calls closed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-recovery-stages-'));
    dirs.push(dir);
    const sink = new FileLogSink({ directory: dir, prefix: 'audit' });
    const base: LogEvent = {
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      channel: 'audit',
      level: 'info',
      event: 'tool.requested',
      sessionId: 's',
      runId: 'r',
      operationId: 'request-only',
      toolUseId: 'use-request',
      fields: {},
    };
    await sink.write(base);
    await sink.write({ ...base, operationId: 'decided-only', toolUseId: 'use-decided' });
    await sink.write({ ...base, operationId: 'decided-only', event: 'tool.decided' });
    await sink.write({ ...base, operationId: 'finished', toolUseId: 'use-finished' });
    await sink.write({ ...base, operationId: 'finished', event: 'tool.finished' });
    expect(await recoverIncompleteAudit(dir)).toBe(2);
    const recovered = fs.readdirSync(dir).flatMap((name) =>
      fs
        .readFileSync(path.join(dir, name), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as LogEvent)
        .filter((event) => event.event === 'audit.outcome_unknown'),
    );
    expect(recovered.map((event) => [event.operationId, event.toolUseId])).toEqual([
      ['request-only', 'use-request'],
      ['decided-only', 'use-decided'],
    ]);
  });

  it('does not mark an operation from a still-running process as crashed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-recovery-live-'));
    dirs.push(dir);
    const sink = new FileLogSink({ directory: dir, prefix: 'audit' });
    await sink.write({
      schemaVersion: 1,
      timestamp: new Date().toISOString(),
      channel: 'audit',
      level: 'info',
      event: 'tool.requested',
      sessionId: 'live-session',
      operationId: 'live-operation',
      toolUseId: 'live-use',
      fields: { processId: process.pid },
    });
    expect(await recoverIncompleteAudit(dir)).toBe(0);
  });
});
