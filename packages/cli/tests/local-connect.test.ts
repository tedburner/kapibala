import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runConnectedClient } from '../src/local-host/connect.js';
import { parseLocalCommand } from '../src/local-host/entry.js';

const daemon = vi.hoisted(() => ({ connectDaemon: vi.fn() }));
vi.mock('../src/local-host/daemon.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/local-host/daemon.js')>()),
  connectDaemon: daemon.connectDaemon,
}));

describe('local CLI command routing', () => {
  it('keeps ordinary CLI input and --help in the existing entry', () => {
    expect(parseLocalCommand(['--help'])).toBeUndefined();
    expect(parseLocalCommand(['请解释当前代码'])).toBeUndefined();
  });
  it('requires explicit stdio or daemon child mode and rejects unsupported flags', () => {
    expect(parseLocalCommand(['serve', '--stdio'])).toMatchObject({
      command: 'serve',
      stdio: true,
    });
    expect(() => parseLocalCommand(['serve'])).toThrow();
    expect(() => parseLocalCommand(['serve', '--stdio', '--port', '3000'])).toThrow();
    expect(() => parseLocalCommand(['daemon', 'delete'])).toThrow();
    expect(parseLocalCommand(['daemon', 'status'])).toMatchObject({
      command: 'daemon',
      action: 'status',
    });
  });
  it('parses a connected one-shot without broadening to arbitrary Slash commands', () => {
    expect(parseLocalCommand(['connect', '--workspace', '/project', '-p', 'hello'])).toMatchObject({
      command: 'connect',
      workspace: '/project',
      prompt: 'hello',
    });
    expect(() => parseLocalCommand(['connect', '--permission', 'full-access'])).toThrow();
  });
  it('applies attach-time text after the attach response instead of printing ahead of history', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-connect-order-'));
    const order: string[] = [];
    const listeners = new Set<
      (event: { type: string; runId?: string; payload?: unknown }) => void
    >();
    const client = {
      call: vi.fn(async (method: string) => {
        if (method === 'session/create') return { sessionId: 'session', conversationId: 'conv' };
        if (method === 'session/attach') {
          order.push('attach:start');
          for (const listener of listeners)
            listener({ type: 'text_delta', runId: 'prior', payload: { text: 'early' } });
          order.push('attach:end');
          return {
            sessionId: 'session',
            streamEpoch: 'stream',
            controlEpoch: 'control',
            serverInstanceId: 'instance',
            seq: 1,
            history: [],
          };
        }
        if (method === 'run/start') {
          queueMicrotask(() => {
            for (const listener of listeners)
              listener({ type: 'run_settled', runId: 'run', payload: { outcome: 'completed' } });
          });
          return { runId: 'run' };
        }
        if (method === 'session/snapshot') return { history: [], openSessions: 1 };
        if (method === 'session/close') return { closed: true };
        return {};
      }),
      subscribe: (
        listener: (event: { type: string; runId?: string; payload?: unknown }) => void,
      ) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: vi.fn(async () => {}),
      whenClosed: new Promise<void>(() => {}),
    };
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      order.push(`write:${String(chunk)}`);
      return true;
    });
    daemon.connectDaemon.mockResolvedValueOnce(client);
    try {
      await runConnectedClient({ prompt: 'hello', workspace: root });
      expect(order.indexOf('attach:end')).toBeGreaterThanOrEqual(0);
      expect(order.indexOf('write:early')).toBeGreaterThan(order.indexOf('attach:end'));
    } finally {
      write.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('closes a one-shot session before disconnecting so repeated runs cannot exhaust the quota', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-connect-'));
    const calls: string[] = [];
    const listeners = new Set<
      (event: { type: string; runId?: string; payload?: unknown }) => void
    >();
    const client = {
      call: vi.fn(async (method: string) => {
        calls.push(method);
        if (method === 'session/create') return { sessionId: 'session', conversationId: 'conv' };
        if (method === 'session/attach')
          return {
            sessionId: 'session',
            streamEpoch: 'stream',
            controlEpoch: 'control',
            serverInstanceId: 'instance',
            seq: 0,
            history: [],
          };
        if (method === 'run/start') {
          queueMicrotask(() => {
            for (const listener of listeners)
              listener({ type: 'run_settled', runId: 'run', payload: { outcome: 'completed' } });
          });
          return { runId: 'run' };
        }
        if (method === 'session/snapshot') return { history: [], openSessions: 1 };
        if (method === 'session/close') return { closed: true };
        return {};
      }),
      subscribe: (
        listener: (event: { type: string; runId?: string; payload?: unknown }) => void,
      ) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close: vi.fn(async () => {}),
      whenClosed: new Promise<void>(() => {}),
    };
    daemon.connectDaemon.mockResolvedValueOnce(client);
    try {
      await runConnectedClient({ prompt: 'hello', workspace: root });
      expect(calls).toEqual([
        'session/create',
        'session/attach',
        'run/start',
        'session/snapshot',
        'session/close',
      ]);
      expect(client.close).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
