import fs, { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileLogSink } from '../src/logging/file-sink.js';
import type { LogEvent } from '../src/logging/index.js';

const directories: string[] = [];

function tempDirectory(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'kapibala-logging-'));
  directories.push(directory);
  return directory;
}

function event(timestamp: string, operationId: string): LogEvent {
  return {
    schemaVersion: 1,
    timestamp,
    level: 'info',
    channel: 'operation',
    event: 'tool.finished',
    sessionId: 'session-1',
    operationId,
    fields: { status: 'success' },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('FileLogSink', () => {
  it('serializes parallel writes and rotates a file at the configured size', async () => {
    const directory = tempDirectory();
    const sink = new FileLogSink({ directory, prefix: 'operation', maxBytes: 220 });

    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        sink.write(event('2026-09-25T00:00:00.000Z', `op-${index}`)),
      ),
    );

    const files = readdirSync(directory).filter((name) => name.endsWith('.jsonl'));
    expect(files.length).toBeGreaterThan(1);
    const records = files.flatMap((name) =>
      readFileSync(path.join(directory, name), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as LogEvent),
    );
    expect(records.map((record) => record.operationId).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `op-${index}`).sort(),
    );
    expect(sink.getUsageBytes()).toBeGreaterThan(0);
  });

  it('cleans expired operation files but preserves audit files', async () => {
    const directory = tempDirectory();
    const operation = new FileLogSink({ directory, prefix: 'operation', retentionDays: 30 });
    const audit = new FileLogSink({ directory, prefix: 'audit', sync: true, retentionDays: 30 });
    await operation.write(event('2026-08-01T00:00:00.000Z', 'old'));
    await audit.write({ ...event('2026-08-01T00:00:00.000Z', 'old-audit'), channel: 'audit' });
    writeFileSync(path.join(directory, 'user-note.txt'), 'keep');

    await operation.write(event('2026-09-25T00:00:00.000Z', 'new'));
    await audit.write({ ...event('2026-09-25T00:00:00.000Z', 'new-audit'), channel: 'audit' });

    const files = readdirSync(directory);
    expect(files.some((name) => name.startsWith('operation-2026-08-01'))).toBe(false);
    expect(files.some((name) => name.startsWith('audit-2026-08-01'))).toBe(true);
    expect(files).toContain('user-note.txt');
  });

  it('rejects a write when the destination cannot be created', async () => {
    const directory = tempDirectory();
    const obstruction = path.join(directory, 'obstruction');
    writeFileSync(obstruction, 'file, not directory');
    const sink = new FileLogSink({
      directory: path.join(obstruction, 'logs'),
      prefix: 'audit',
      sync: true,
    });

    await expect(sink.write(event('2026-09-25T00:00:00.000Z', 'blocked'))).rejects.toThrow();
  });

  it('propagates a disk full error from an audit write', async () => {
    const sink = new FileLogSink({ directory: tempDirectory(), prefix: 'audit' });
    vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    });

    await expect(sink.write(event('2026-09-25T00:00:00.000Z', 'disk-full'))).rejects.toMatchObject({
      code: 'ENOSPC',
    });
  });
});
