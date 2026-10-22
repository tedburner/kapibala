import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { LocalClient } from '../src/client/index.js';
import { SnapshotPager } from '../src/local-host/snapshots.js';
import {
  DEFAULT_LIMITS,
  type JsonValue,
  toWireErrorCode,
  validateMethodResult,
  validateSnapshotBody,
} from '../src/protocol/index.js';
import { RpcPeer } from '../src/transport/rpc.js';
import { createStdioTransport } from '../src/transport/stdio.js';

const offer = { major: 1, minMinor: 0, maxMinor: 0, clientName: 'contract-test', capabilities: [] };
const initialized = {
  major: 1,
  minor: 0,
  capabilities: [],
  serverInstanceId: 'i',
  clientId: 'c',
  limits: { ...DEFAULT_LIMITS },
};
const first = {
  serverInstanceId: 'i',
  sessionId: 's',
  streamEpoch: 'e',
  controlEpoch: '',
  seq: 0,
  conversationId: 'conv',
  runId: null,
  pendingApprovals: [],
  openSessions: 1,
  maxOpenSessions: 8,
  chunk: JSON.stringify({ history: [], live: [] }),
  cursor: null,
};
const pair = () => {
  const a = new PassThrough();
  const b = new PassThrough();
  return [createStdioTransport(a, b), createStdioTransport(b, a)] as const;
};

describe('request-aware result contracts', () => {
  it('reattaches a paged history larger than the single-frame JSON node budget', async () => {
    const history = Array.from({ length: 13_000 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? 'assistant' : 'user',
      state: 'completed',
      blocks: [{ kind: 'text', text: 'ok' }],
    }));
    const body = { history, live: [] };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(DEFAULT_LIMITS.maxSnapshotBytes);
    const pager = new SnapshotPager();
    const [wire, remote] = pair();
    const server = new RpcPeer(remote, {
      prefix: 's',
      request: async (request): Promise<JsonValue> => {
        if (request.method === 'initialize') return initialized;
        if (request.method === 'ping') return { alive: true, serverInstanceId: 'i' };
        if (request.method === 'session/snapshot' && request.params.cursor)
          return { ...pager.read('s', request.params.cursor) };
        return { ...first, ...pager.capture('s', body) };
      },
    });
    const client = await LocalClient.connect(wire, offer);
    try {
      const snapshot = await client.call('session/attach', { sessionId: 's', mode: 'observe' });
      expect(snapshot.history).toEqual(history);
      expect(await client.call('ping', {})).toEqual({ alive: true, serverInstanceId: 'i' });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it('rejects non-data snapshot containers without invoking accessors', () => {
    const getter = vi.fn(() => []);
    const rootAccessor = Object.defineProperty({ live: [] }, 'history', {
      enumerable: true,
      get: getter,
    });
    const entryAccessor = Object.defineProperty([], '0', { enumerable: true, get: getter });
    const sparse = new Array(1);
    const invalid = [
      rootAccessor,
      { history: entryAccessor, live: [] },
      { history: sparse, live: [] },
      { history: [], live: [], [Symbol('extra')]: true },
      Object.assign(Object.create({ inherited: true }), { history: [], live: [] }),
      { history: [], live: [{ type: 'unknown' }] },
    ];
    for (const body of invalid) expect(validateSnapshotBody(body)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(validateSnapshotBody({ history: [], live: [] })).toBe(true);
  });

  it('maps known structured codes before legacy messages and hides unknown exceptions', () => {
    for (const code of [
      'SESSION_LOCKED',
      'SESSION_RECOVERY_IN_PROGRESS',
      'SESSION_LOCK_OWNER_CHANGED',
    ])
      expect(toWireErrorCode(Object.assign(new Error('different private text'), { code }))).toBe(
        'SESSION_BUSY',
      );
    expect(
      toWireErrorCode(Object.assign(new Error('arbitrary'), { code: 'SESSION_ID_AMBIGUOUS' })),
    ).toBe('SESSION_NOT_FOUND');
    expect(
      toWireErrorCode(Object.assign(new Error('private credential'), { code: 'UNRECOGNIZED' })),
    ).toBe('INTERNAL_ERROR');
  });
  it('selects the snapshot result from the original request, never the response shape', () => {
    expect(validateMethodResult('session/snapshot', { sessionId: 's' }, first).ok).toBe(true);
    expect(
      validateMethodResult('session/snapshot', { sessionId: 's' }, { chunk: 'tail', cursor: null })
        .ok,
    ).toBe(false);
    expect(
      validateMethodResult(
        'session/snapshot',
        { sessionId: 's', cursor: 'rev:1' },
        { chunk: 'tail', cursor: null },
      ).ok,
    ).toBe(true);
    expect(
      validateMethodResult('session/snapshot', { sessionId: 's', cursor: 'rev:1' }, first).ok,
    ).toBe(false);
    expect(
      validateMethodResult('session/attach', { sessionId: 's', mode: 'observe' }, first).ok,
    ).toBe(true);
  });
  it('requires every initialization limit and rejects extra success fields', () => {
    expect(validateMethodResult('initialize', offer, initialized).ok).toBe(true);
    const { approvalTimeoutMs: _, ...limits } = initialized.limits;
    expect(validateMethodResult('initialize', offer, { ...initialized, limits }).ok).toBe(false);
    expect(
      validateMethodResult('ping', {}, { alive: true, serverInstanceId: 'i', secret: 'hidden' }).ok,
    ).toBe(false);
  });
  it('returns a raw continuation page instead of attempting JSON reassembly', async () => {
    const [wire, remote] = pair();
    const server = new RpcPeer(remote, {
      prefix: 's',
      request: async (request) =>
        request.method === 'initialize' ? initialized : { chunk: 'tail-is-not-json', cursor: null },
    });
    const client = await LocalClient.connect(wire, offer);
    try {
      expect(await client.call('session/snapshot', { sessionId: 's', cursor: 'rev:1' })).toEqual({
        chunk: 'tail-is-not-json',
        cursor: null,
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('fails attach when buffered events have a gap and never publishes the partial replay', async () => {
    const [wire, remote] = pair();
    let server: RpcPeer;
    server = new RpcPeer(remote, {
      prefix: 's',
      request: async (request) => {
        if (request.method === 'initialize') return initialized;
        for (const seq of [1, 3])
          server.notify({
            serverInstanceId: 'i',
            sessionId: 's',
            streamEpoch: 'e',
            seq,
            type: 'text_delta',
            payload: { text: 'must-not-publish' },
          });
        return first;
      },
    });
    const client = await LocalClient.connect(wire, offer);
    const seen: unknown[] = [];
    client.subscribe((e) => seen.push(e));
    try {
      await expect(
        client.call('session/attach', { sessionId: 's', mode: 'observe' }),
      ).rejects.toThrow();
      expect(seen).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('rejects any server limit above the client hard cap, including timeouts', async () => {
    const [wire, remote] = pair();
    const server = new RpcPeer(remote, {
      prefix: 's',
      request: async () => ({
        ...initialized,
        limits: { ...DEFAULT_LIMITS, approvalTimeoutMs: DEFAULT_LIMITS.approvalTimeoutMs + 1 },
      }),
    });
    await expect(LocalClient.connect(wire, offer)).rejects.toThrow('PROTOCOL_MISMATCH');
    await server.close();
  });
  it('rejects snapshot live events from another stream and a mismatched expected instance', async () => {
    for (const response of [
      {
        ...first,
        chunk: JSON.stringify({
          history: [],
          live: [
            {
              serverInstanceId: 'i',
              sessionId: 'other',
              streamEpoch: 'e',
              seq: 1,
              type: 'text_delta',
              payload: { text: 'hidden' },
            },
          ],
        }),
      },
      { ...first, serverInstanceId: 'other' },
    ]) {
      const [wire, remote] = pair();
      const server = new RpcPeer(remote, {
        prefix: 's',
        request: async (request) => (request.method === 'initialize' ? initialized : response),
      });
      const client = await LocalClient.connect(wire, offer);
      try {
        await expect(
          client.call('session/attach', { sessionId: 's', mode: 'observe', serverInstanceId: 'i' }),
        ).rejects.toThrow();
      } finally {
        await client.close();
        await server.close();
      }
    }
  });
  it('rejects a repeated continuation cursor instead of looping', async () => {
    const [wire, remote] = pair();
    const server = new RpcPeer(remote, {
      prefix: 's',
      request: async (request) =>
        request.method === 'initialize'
          ? initialized
          : request.method === 'session/attach'
            ? { ...first, cursor: 'rev:1' }
            : { chunk: '', cursor: 'rev:1' },
    });
    const client = await LocalClient.connect(wire, offer);
    try {
      await expect(
        client.call('session/attach', { sessionId: 's', mode: 'observe' }),
      ).rejects.toThrow('RESYNC_REQUIRED');
    } finally {
      await client.close();
      await server.close();
    }
  });
  it('enforces the advertised smaller snapshot limit during reassembly', async () => {
    const [wire, remote] = pair();
    const server = new RpcPeer(remote, {
      prefix: 's',
      request: async (request) =>
        request.method === 'initialize'
          ? { ...initialized, limits: { ...DEFAULT_LIMITS, maxSnapshotBytes: 64 } }
          : {
              ...first,
              chunk: JSON.stringify({ history: [], live: [], padding: 'x'.repeat(100) }),
            },
    });
    const client = await LocalClient.connect(wire, offer);
    try {
      await expect(
        client.call('session/attach', { sessionId: 's', mode: 'observe' }),
      ).rejects.toThrow();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
