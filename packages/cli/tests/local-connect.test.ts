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
      expect(daemon.connectDaemon).toHaveBeenCalledWith(
        expect.objectContaining({ capabilities: ['retry'] }),
        expect.objectContaining({ approval: expect.any(Function) }),
      );
      expect(client.close).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('renders stream_reset and retry_scheduled during a connected one-shot run', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-connect-retry-'));
    const listeners = new Set<
      (event: { type: string; runId?: string; payload?: unknown }) => void
    >();
    const client = {
      call: vi.fn(async (method: string) => {
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
            for (const listener of listeners) {
              listener({ type: 'text_delta', runId: 'run', payload: { text: 'partial' } });
              listener({ type: 'stream_reset', runId: 'run', payload: { step: 1, attempt: 1 } });
              listener({
                type: 'retry_scheduled',
                runId: 'run',
                payload: {
                  step: 1,
                  attempt: 1,
                  maxRetries: 2,
                  delayMs: 2_000,
                  nextRetryAt: Date.now() + 2_000,
                  category: 'transport',
                  message: 'network reset',
                },
              });
              listener({ type: 'text_delta', runId: 'run', payload: { text: 'recovered' } });
              listener({ type: 'run_settled', runId: 'run', payload: { outcome: 'completed' } });
            }
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
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    const writeOut = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdoutChunks.push(String(chunk));
      return true;
    });
    const writeErr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderrChunks.push(String(chunk));
      return true;
    });
    daemon.connectDaemon.mockResolvedValueOnce(client);
    try {
      await runConnectedClient({ prompt: 'hello', workspace: root });
      const out = `${stdoutChunks.join('')}\n${stderrChunks.join('')}`;
      expect(out).toContain('[流中断，已重置当前未完成片段并准备重试]');
      expect(out).toContain('将在 2s 后自动重试 (1/2)');
      expect(out).toContain('recovered');
    } finally {
      Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });
      writeOut.mockRestore();
      writeErr.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
