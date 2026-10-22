import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalClient } from '../src/client/index.js';
import {
  getDaemonStatus,
  getLocalRuntimeDirectory,
  readDaemonMetadata,
  startDaemon,
  stopDaemon,
} from '../src/local-host/daemon.js';
import * as socket from '../src/transport/socket.js';
import type { LocalTransport } from '../src/transport/types.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
describe('daemon metadata boundary', () => {
  it.each([
    { pid: 0, serverInstanceId: '' },
    { pid: 17, serverInstanceId: 'previous-instance' },
  ])('does not report healthy using a superseded metadata snapshot %j', async (initial) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-daemon-snapshot-'));
    roots.push(root);
    const file = path.join(fs.realpathSync.native(root), 'daemon.json');
    const metadata = {
      ...initial,
      token: 'a'.repeat(64),
      nonce: 'b'.repeat(32),
      endpoint: { type: 'pipe', path: '\\\\.\\pipe\\kpbl-snapshot-fixture' },
    };
    const live = { ...metadata, pid: 42, serverInstanceId: 'live-instance' };
    fs.writeFileSync(file, JSON.stringify(metadata), { mode: 0o600 });
    const nativeRead = fs.readFileSync.bind(fs);
    let updated = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((target, options) => {
      if (target === file && !updated) {
        updated = true;
        fs.writeFileSync(file, JSON.stringify(live), { mode: 0o600 });
        return JSON.stringify(metadata);
      }
      return nativeRead(target, options);
    }) as typeof fs.readFileSync);
    vi.spyOn(socket, 'connectLocal').mockResolvedValue({} as LocalTransport);
    const close = vi.fn(async () => {});
    const call = vi.fn(async (method: string) => {
      if (method === 'host/shutdown') fs.unlinkSync(file);
      return { alive: true, serverInstanceId: live.serverInstanceId };
    });
    vi.spyOn(LocalClient, 'connect').mockResolvedValue({ call, close } as unknown as LocalClient);
    expect(await getDaemonStatus({ runtimeDir: root })).toMatchObject({
      running: false,
      state: 'unreachable',
    });
    expect(await getDaemonStatus({ runtimeDir: root })).toMatchObject({
      running: true,
      pid: 42,
      serverInstanceId: 'live-instance',
    });
    expect(close).toHaveBeenCalledTimes(2);
    updated = false;
    fs.writeFileSync(file, JSON.stringify(metadata), { mode: 0o600 });
    call.mockClear();
    await expect(stopDaemon({ runtimeDir: root })).rejects.toThrow('Daemon instance mismatch');
    expect(call.mock.calls.map(([method]) => method)).toEqual(['ping']);
  });

  it('creates private runtime directories without replacing symlinks', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-daemon-'));
    roots.push(root);
    expect(getLocalRuntimeDirectory(root)).toBe(fs.realpathSync.native(root));
    if (process.platform !== 'win32') expect(fs.statSync(root).mode & 0o777).toBe(0o700);
    const alias = `${root}-alias`;
    fs.symlinkSync(root, alias);
    try {
      expect(() => getLocalRuntimeDirectory(alias)).toThrow();
    } finally {
      fs.unlinkSync(alias);
    }
  });
  it('refuses malformed, world-readable or symlinked credential metadata', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-daemon-'));
    roots.push(root);
    fs.writeFileSync(path.join(root, 'daemon.json'), '{}', { mode: 0o600 });
    expect(() => readDaemonMetadata(root)).toThrow();
    fs.writeFileSync(path.join(root, 'daemon.json'), JSON.stringify({ token: 'never expose' }));
    expect(() => readDaemonMetadata(root)).toThrow(/metadata/i);
  });
  it('distinguishes absent, stale-lock, invalid-metadata and unreachable instances', async () => {
    const absent = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-daemon-'));
    const stale = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-daemon-'));
    const invalid = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-daemon-'));
    const unreachable = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-daemon-'));
    roots.push(absent, stale, invalid, unreachable);
    expect(await getDaemonStatus({ runtimeDir: absent })).toMatchObject({
      running: false,
      state: 'absent',
    });
    fs.mkdirSync(path.join(stale, 'daemon.lock'), { mode: 0o700 });
    expect(await getDaemonStatus({ runtimeDir: stale })).toMatchObject({
      running: false,
      state: 'stale_lock',
    });
    fs.writeFileSync(path.join(invalid, 'daemon.json'), '{}', { mode: 0o600 });
    expect(await getDaemonStatus({ runtimeDir: invalid })).toMatchObject({
      running: false,
      state: 'invalid_metadata',
    });
    fs.writeFileSync(
      path.join(unreachable, 'daemon.json'),
      JSON.stringify({
        token: 'a'.repeat(64),
        nonce: 'b'.repeat(32),
        pid: process.pid,
        serverInstanceId: 'instance',
        endpoint:
          process.platform === 'win32'
            ? { type: 'pipe', path: '\\\\.\\pipe\\kpbl-missing-endpoint' }
            : { type: 'unix', path: path.join(unreachable, 'missing.sock') },
      }),
      { mode: 0o600 },
    );
    expect(await getDaemonStatus({ runtimeDir: unreachable })).toMatchObject({
      running: false,
      state: 'unreachable',
      pid: process.pid,
      serverInstanceId: 'instance',
    });
  });

  it('captures child stderr in a private log and reports exit diagnostics', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-daemon-'));
    roots.push(root);
    const entry = path.join(root, 'fail.mjs');
    fs.writeFileSync(entry, "process.stderr.write('boot failure\\n'); process.exit(7);\n");
    await expect(startDaemon({ runtimeDir: root, entryPath: entry })).rejects.toThrow(
      /exited \(code=7\).*daemon\.log/,
    );
    const log = path.join(root, 'daemon.log');
    expect(fs.readFileSync(log, 'utf8')).toContain('boot failure');
    if (process.platform !== 'win32') expect(fs.statSync(log).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(root, 'daemon.json'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'daemon.lock'))).toBe(false);
  });
});
