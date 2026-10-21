import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { SessionManager } from '@kiturone/kapibala';
import { describe, expect, it, vi } from 'vitest';
import { LocalClient } from '../src/client/index.js';
import { LocalHostServer } from '../src/local-host/server.js';
import { DEFAULT_LIMITS, type JsonValue, type WireEvent } from '../src/protocol/index.js';
import { RpcPeer } from '../src/transport/rpc.js';
import { createStdioTransport } from '../src/transport/stdio.js';

const pair = () => {
  const a = new PassThrough();
  const b = new PassThrough();
  return [createStdioTransport(a, b), createStdioTransport(b, a)] as const;
};
const offer = { major: 1, minMinor: 0, maxMinor: 0, clientName: 'test', capabilities: [] };
const initialization = {
  major: 1,
  minor: 0,
  capabilities: [],
  serverInstanceId: 'i',
  clientId: 'c',
  limits: { ...DEFAULT_LIMITS },
};

describe('local client/server contract', () => {
  it('shows the shell execution scope instead of the workspace or raw input', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-approval-'));
    const cwd = path.join(root, 'nested');
    const executablePath = path.join(root, 'custom-shell');
    const targets: string[] = [];
    const server = new LocalHostServer({
      create: async (_root, _conversation, approval) => ({
        conversationId: 'conv',
        history: () => [],
        async *run(_input, signal) {
          const choice = await approval.requestApproval(
            {
              toolName: 'run_command',
              capabilities: ['exec'],
              rootDir: root,
              input: { command: 'raw input must not be displayed' },
              shell: { command: 'rm ./target', cwd, interpreter: 'bash', executablePath },
              sessionAllowed: false,
            },
            signal,
          );
          yield { type: 'text_delta' as const, text: choice };
        },
        dispose: async () => {},
      }),
    });
    const [wire, peer] = pair();
    const serving = server.accept(peer);
    const client = await LocalClient.connect(wire, offer, {
      approval: async (request) => {
        targets.push(request.target);
        return 'deny_once';
      },
    });
    try {
      const opened = await server.registry.open(root);
      const control = (await client.call('session/attach', {
        sessionId: opened.sessionId,
        mode: 'control',
      })) as {
        sessionId: string;
        streamEpoch: string;
        controlEpoch: string;
      };
      await client.call('run/start', {
        sessionId: control.sessionId,
        streamEpoch: control.streamEpoch,
        controlEpoch: control.controlEpoch,
        clientOperationId: 'approval',
        input: 'fixture',
      });
      await server.registry.get(opened.sessionId).active?.done;
      expect(targets).toHaveLength(1);
      expect(targets[0]).toContain(cwd);
      expect(targets[0]).toContain(executablePath);
      expect(targets[0]).toContain('rm ./target');
      expect(targets[0]).not.toContain('raw input');
    } finally {
      await client.close();
      await peer.close();
      await serving;
      await server.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('reports pending approvals to observers and clears them after the decision', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-pending-'));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const server = new LocalHostServer({
      create: async (_root, _conversation, approval) => ({
        conversationId: 'conv',
        history: () => [],
        async *run(_input, signal) {
          const choice = await approval.requestApproval(
            {
              toolName: 'write_file',
              capabilities: ['fs:write'],
              rootDir: root,
              input: { path: path.join(root, 'a.txt'), content: 'must not leak' },
              sessionAllowed: false,
            },
            signal,
          );
          yield { type: 'text_delta' as const, text: choice };
        },
        dispose: async () => {},
      }),
    });
    const [controlWire, controlPeer] = pair();
    const [observerWire, observerPeer] = pair();
    const servingControl = server.accept(controlPeer);
    const servingObserver = server.accept(observerPeer);
    const controlClient = await LocalClient.connect(controlWire, offer, {
      approval: async () => {
        entered();
        await gate;
        return 'deny_once';
      },
    });
    const observer = await LocalClient.connect(observerWire, offer);
    try {
      const opened = (await controlClient.call('session/create', { workspaceRoot: root })) as {
        sessionId: string;
      };
      const control = (await controlClient.call('session/attach', {
        sessionId: opened.sessionId,
        mode: 'control',
      })) as { sessionId: string; streamEpoch: string; controlEpoch: string };
      await observer.call('session/attach', {
        sessionId: opened.sessionId,
        mode: 'observe',
      });
      await controlClient.call('run/start', {
        sessionId: control.sessionId,
        streamEpoch: control.streamEpoch,
        controlEpoch: control.controlEpoch,
        clientOperationId: 'pending',
        input: 'fixture',
      });
      await waiting;
      const during = (await observer.call('session/snapshot', {
        sessionId: opened.sessionId,
      })) as { pendingApprovals: { toolName: string; target: string }[] };
      expect(during.pendingApprovals).toEqual([
        expect.objectContaining({
          toolName: 'write_file',
          target: expect.stringContaining('a.txt'),
        }),
      ]);
      expect(JSON.stringify(during.pendingApprovals)).not.toContain('must not leak');
      release();
      await server.registry.get(opened.sessionId).active?.done;
      const after = (await observer.call('session/snapshot', {
        sessionId: opened.sessionId,
      })) as { pendingApprovals: unknown[] };
      expect(after.pendingApprovals).toEqual([]);
    } finally {
      release();
      await controlClient.close();
      await observer.close();
      await controlPeer.close();
      await observerPeer.close();
      await servingControl;
      await servingObserver;
      await server.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('releases the client approval signal when the host closes that approval', async () => {
    const [wire, peer] = pair();
    const remote = new RpcPeer(peer, {
      prefix: 's',
      request: async (): Promise<JsonValue> => initialization,
    });
    let started!: () => void;
    const waiting = new Promise<void>((resolve) => {
      started = resolve;
    });
    const client = await LocalClient.connect(wire, offer, {
      approval: async (_request, signal) => {
        started();
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        );
        return 'cancel';
      },
    });
    const response = remote.call('approval/request', {
      sessionId: 's',
      streamEpoch: 'e',
      controlEpoch: 'c',
      runId: 'r',
      approvalId: 'a',
      toolName: 'write_file',
      target: '/a',
      sessionAllowed: false,
      expiresAt: 1,
    });
    await waiting;
    remote.notify({
      sessionId: 's',
      streamEpoch: 'e',
      serverInstanceId: 'i',
      seq: 1,
      type: 'approval_closed',
      payload: { approvalId: 'a' },
    });
    expect(await response).toEqual({ choice: 'cancel' });
    await client.close();
    await remote.close();
  });
  it('buffers events that arrive before an attach response', async () => {
    const [wire, peer] = pair();
    const remote = new RpcPeer(peer, {
      prefix: 's',
      request: async (request): Promise<JsonValue> => {
        if (request.method === 'initialize') return initialization;
        if (request.method === 'session/attach') {
          await peer.send({
            jsonrpc: '2.0',
            method: 'session/event',
            params: {
              serverInstanceId: 'i',
              sessionId: 's',
              streamEpoch: 'e',
              seq: 1,
              type: 'text_delta',
              payload: { text: 'early' },
            },
          });
          return { sessionId: 's', streamEpoch: 'e', serverInstanceId: 'i', seq: 0 };
        }
        return {};
      },
    });
    const client = await LocalClient.connect(wire, offer);
    const observed: string[] = [];
    client.subscribe((event) => observed.push(event.type));
    await client.call('session/attach', { sessionId: 's', mode: 'observe' });
    expect(observed).toEqual(['text_delta']);
    await client.close();
    await remote.close();
  });
  it('initializes, attaches, runs once, observes and closes without side effects', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-rpc-'));
    const run = vi.fn(async function* () {
      yield { type: 'text_delta' as const, text: 'hello' };
    });
    const server = new LocalHostServer({
      create: async () => ({
        conversationId: 'conv',
        history: () => [],
        run,
        dispose: async () => {},
      }),
    });
    const [wire, peer] = pair();
    const serving = server.accept(peer);
    const client = await LocalClient.connect(wire, offer);
    const opened = (await client.call('session/create', { workspaceRoot: root })) as {
      sessionId: string;
    };
    const control = (await client.call('session/attach', {
      sessionId: opened.sessionId,
      mode: 'control',
    })) as { sessionId: string; streamEpoch: string; controlEpoch: string };
    const observed: string[] = [];
    client.subscribe((event) => observed.push(event.type));
    const params = {
      sessionId: control.sessionId,
      streamEpoch: control.streamEpoch,
      controlEpoch: control.controlEpoch,
      clientOperationId: 'once',
      input: 'hello',
    };
    const a = await client.call('run/start', params);
    const b = await client.call('run/start', params);
    expect(a).toEqual(b);
    await vi.waitFor(() => expect(observed).toContain('run_settled'));
    expect(run).toHaveBeenCalledTimes(1);
    await client.close();
    await peer.close();
    await serving;
    await server.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('rejects wrong credentials and does not expose session methods', async () => {
    const server = new LocalHostServer({
      token: 'fixture-token',
      create: async () => {
        throw new Error('must not create');
      },
    });
    const [wire, peer] = pair();
    const serving = server.accept(peer);
    await expect(LocalClient.connect(wire, { ...offer, token: 'wrong' })).rejects.toThrow(
      /UNAUTHORIZED/,
    );
    await wire.close();
    await peer.close();
    await serving;
    await server.shutdown();
  });
  it('validates session list cursors and limits and applies the requested page size', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-list-'));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-list-home-'));
    fs.mkdirSync(path.join(home, '.kapibala'));
    fs.writeFileSync(
      path.join(home, '.kapibala/settings.json'),
      JSON.stringify({
        defaultModel: 'fixture',
        profiles: [
          {
            id: 'fixture',
            name: 'fixture',
            provider: 'openai-compatible',
            modelName: 'fixture',
            baseURL: 'http://127.0.0.1:1/v1',
            apiKey: 'fixture-credential',
            contextWindow: 32000,
          },
        ],
      }),
    );
    const manager = new SessionManager({ workspaceRoot: root, homeDirectory: home });
    const titled = await manager.create();
    await manager.rename(titled.conversationId, 'fixture-credential token=custom-value 排查');
    await manager.create();
    await manager.create();
    await manager.close();
    const server = new LocalHostServer({
      homeDir: home,
      create: async () => {
        throw new Error('session/list must not create resources');
      },
    });
    const [wire, peer] = pair();
    const serving = server.accept(peer);
    const client = await LocalClient.connect(wire, offer);
    try {
      const first = (await client.call('session/list', {
        workspaceRoot: root,
        limit: 2,
      })) as { items: unknown[]; cursor: string | null };
      expect(first.items).toHaveLength(2);
      expect(first.cursor).toBe('2');
      const second = (await client.call('session/list', {
        workspaceRoot: root,
        limit: 2,
        cursor: '2',
      })) as { items: unknown[]; cursor: string | null };
      expect(second.items).toHaveLength(1);
      expect(second.cursor).toBeNull();
      const titles = [...first.items, ...second.items].map(
        (item) => (item as { title: string }).title,
      );
      const redacted = titles.find((title) => title.includes('[REDACTED]'));
      expect(redacted).toBeDefined();
      for (const title of titles) {
        expect(title).not.toContain('fixture-credential');
        expect(title).not.toContain('custom-value');
      }
      for (const cursor of ['abc', '0', '-1', '1.5', ' 1']) {
        await expect(client.call('session/list', { workspaceRoot: root, cursor })).rejects.toThrow(
          /INVALID_PARAMS/,
        );
      }
      await expect(client.call('session/list', { workspaceRoot: 'relative' })).rejects.toThrow(
        /INVALID_PARAMS/,
      );
    } finally {
      await client.close();
      await peer.close();
      await serving;
      await server.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('rejects a client that requires an unsupported capability', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-cap-'));
    const server = new LocalHostServer({
      create: async () => ({
        conversationId: 'conv',
        history: () => [],
        async *run() {},
        dispose: async () => {},
      }),
    });
    const [wire, peer] = pair();
    const serving = server.accept(peer);
    try {
      await expect(
        LocalClient.connect(wire, {
          ...offer,
          clientName: 'needs-replay',
          capabilities: ['replay'],
        }),
      ).rejects.toThrow(/PROTOCOL_MISMATCH/);
    } finally {
      await peer.close();
      await serving;
      await server.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rejects initialization results with inflated client budgets', async () => {
    const [wire, peer] = pair();
    const server = new RpcPeer(peer, {
      prefix: 's',
      request: async () => ({
        ...initialization,
        serverInstanceId: 'instance',
        clientId: 'client',
        limits: { ...DEFAULT_LIMITS, maxFrameBytes: DEFAULT_LIMITS.maxFrameBytes + 1 },
      }),
    });
    try {
      await expect(LocalClient.connect(wire, offer)).rejects.toThrow(/PROTOCOL_MISMATCH/);
    } finally {
      await server.close();
    }
  });

  it('settles a run without a terminal event as failed with a diagnostic', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-no-finish-'));
    const server = new LocalHostServer({
      create: async () => ({
        conversationId: 'conv',
        history: () => [],
        async *run() {
          yield { type: 'text_delta' as const, text: 'partial' };
        },
        dispose: async () => {},
      }),
    });
    const [wire, peer] = pair();
    const serving = server.accept(peer);
    const client = await LocalClient.connect(wire, offer);
    const events: WireEvent[] = [];
    client.subscribe((event) => events.push(event));
    try {
      const opened = (await client.call('session/create', { workspaceRoot: root })) as {
        sessionId: string;
      };
      const control = (await client.call('session/attach', {
        sessionId: opened.sessionId,
        mode: 'control',
      })) as { sessionId: string; streamEpoch: string; controlEpoch: string };
      await client.call('run/start', {
        sessionId: control.sessionId,
        streamEpoch: control.streamEpoch,
        controlEpoch: control.controlEpoch,
        clientOperationId: 'no-finish',
        input: 'hello',
      });
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === 'run_settled')).toBe(true),
      );
      const settled = events.find((event) => event.type === 'run_settled')!;
      expect(settled.payload).toEqual({ outcome: 'failed' });
      expect(
        events.some(
          (event) => event.type === 'diagnostic' && event.payload.code === 'RUN_INCOMPLETE',
        ),
      ).toBe(true);
    } finally {
      await client.close();
      await peer.close();
      await serving;
      await server.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('projects tool targets, progress, redacted previews and diagnostics', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-tools-'));
    const server = new LocalHostServer({
      create: async () => ({
        conversationId: 'conv',
        history: () => [],
        async *run() {
          yield {
            type: 'tool_start' as const,
            id: 't1',
            name: 'write_file',
            input: { path: path.join(root, 'a.txt'), content: 'secret-body' },
          };
          yield {
            type: 'tool_progress' as const,
            id: 't1',
            name: 'write_file',
            elapsedMs: 5,
            outputBytes: 9,
          };
          yield {
            type: 'tool_finish' as const,
            id: 't1',
            name: 'write_file',
            result: `sk-abcdefgh12345678 ${'x'.repeat(5_000)}`,
            isError: false,
          };
          yield {
            type: 'error' as const,
            error: new Error('boom'),
            modelError: {
              category: 'service' as const,
              code: 'MODEL_UNAVAILABLE',
              message: '服务不可用 token=super-secret-value',
              retryPolicy: 'never' as const,
              suggestion: '稍后重试',
            },
          };
        },
        dispose: async () => {},
      }),
    });
    const [wire, peer] = pair();
    const serving = server.accept(peer);
    const client = await LocalClient.connect(wire, offer);
    const events: WireEvent[] = [];
    client.subscribe((event) => events.push(event));
    try {
      const opened = (await client.call('session/create', { workspaceRoot: root })) as {
        sessionId: string;
      };
      const control = (await client.call('session/attach', {
        sessionId: opened.sessionId,
        mode: 'control',
      })) as { sessionId: string; streamEpoch: string; controlEpoch: string };
      await client.call('run/start', {
        sessionId: control.sessionId,
        streamEpoch: control.streamEpoch,
        controlEpoch: control.controlEpoch,
        clientOperationId: 'tools',
        input: 'hello',
      });
      await vi.waitFor(() =>
        expect(events.some((event) => event.type === 'run_settled')).toBe(true),
      );
      const started = events.find((event) => event.type === 'tool_start')!;
      expect(started.payload.target).toContain('a.txt');
      expect(JSON.stringify(started.payload)).not.toContain('secret-body');
      const progress = events.find((event) => event.type === 'tool_progress')!;
      expect(progress.payload).toEqual({
        toolId: 't1',
        toolName: 'write_file',
        elapsedMs: 5,
        outputBytes: 9,
      });
      const finished = events.find((event) => event.type === 'tool_finish')!;
      expect(finished.payload.truncated).toBe(true);
      expect(finished.payload.result).toContain('[REDACTED]');
      expect(finished.payload.result).not.toContain('abcdefgh12345678');
      const diagnostic = events.find(
        (event): event is Extract<WireEvent, { type: 'diagnostic' }> =>
          event.type === 'diagnostic' && event.payload.code === 'MODEL_UNAVAILABLE',
      )!;
      expect(diagnostic.payload.message).toContain('[REDACTED]');
      expect(diagnostic.payload.message).not.toContain('super-secret-value');
    } finally {
      await client.close();
      await peer.close();
      await serving;
      await server.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('retries host shutdown after cleanup failure and keeps control traffic fenced', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-shutdown-'));
    let failures = 1;
    const dispose = vi.fn(async () => {
      if (failures-- > 0) throw new Error('resources still busy');
    });
    const server = new LocalHostServer({
      create: async () => ({
        conversationId: 'conv',
        history: () => [],
        async *run() {},
        dispose,
      }),
    });
    const [wire, peer] = pair();
    const serving = server.accept(peer);
    const client = await LocalClient.connect(wire, offer);
    try {
      await client.call('session/create', { workspaceRoot: root });
      await expect(client.call('host/shutdown', {})).rejects.toThrow(/INTERNAL_ERROR/);
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(await client.call('ping', {})).toMatchObject({ alive: true });
      await expect(client.call('session/create', { workspaceRoot: root })).rejects.toThrow(
        /SHUTTING_DOWN/,
      );
      expect(await client.call('host/shutdown', {})).toEqual({ stopped: true });
      expect(dispose).toHaveBeenCalledTimes(2);
    } finally {
      await client.close();
      await peer.close();
      await serving;
      await server.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('rolls back control when the attach snapshot exceeds the connection budget', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-attach-'));
    let huge = true;
    const server = new LocalHostServer({
      create: async () => ({
        conversationId: 'conv',
        history: () =>
          huge ? [{ role: 'user', blocks: [{ kind: 'text', text: 'x'.repeat(8_500_000) }] }] : [],
        async *run() {},
        dispose: async () => {},
      }),
    });
    const [firstWire, firstPeer] = pair();
    const [secondWire, secondPeer] = pair();
    const servingFirst = server.accept(firstPeer);
    const servingSecond = server.accept(secondPeer);
    const first = await LocalClient.connect(firstWire, offer);
    const second = await LocalClient.connect(secondWire, offer);
    try {
      const opened = (await first.call('session/create', { workspaceRoot: root })) as {
        sessionId: string;
      };
      await expect(
        first.call('session/attach', { sessionId: opened.sessionId, mode: 'control' }),
      ).rejects.toThrow(/RESOURCE_LIMIT/);
      huge = false;
      const attached = (await second.call('session/attach', {
        sessionId: opened.sessionId,
        mode: 'control',
      })) as { sessionId: string };
      expect(attached.sessionId).toBe(opened.sessionId);
      const status = (await second.call('session/snapshot', {
        sessionId: opened.sessionId,
      })) as { openSessions: number; maxOpenSessions: number };
      expect(status.openSessions).toBe(1);
      expect(status.maxOpenSessions).toBe(8);
    } finally {
      await first.close();
      await second.close();
      await firstPeer.close();
      await secondPeer.close();
      await servingFirst;
      await servingSecond;
      await server.shutdown();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('settles pending requests when closed even if peer does not reply', async () => {
    const [wire, peer] = pair();
    const reading = (async () => {
      for await (const message of peer.messages) {
        if ('method' in message && message.method === 'initialize' && 'id' in message)
          await peer.send({
            jsonrpc: '2.0',
            id: message.id,
            result: initialization,
          });
      }
    })().catch(() => {});
    const client = await LocalClient.connect(wire, offer);
    const pending = client.call('ping', {});
    const assertion = expect(pending).rejects.toThrow(/closed/);
    await client.close();
    await assertion;
    await peer.close();
    await reading;
  });
});
