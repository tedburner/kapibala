import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LIMITS,
  PROTOCOL_VERSION,
  negotiateProtocol,
  parseWireMessage,
  toWireErrorCode,
  validateEvent,
  validateRequest,
  validateResponse,
  wireCodeForRpcCode,
} from '../src/protocol/index.js';

const request = (method: string, params: unknown) => ({
  jsonrpc: '2.0',
  id: 'c:1',
  method,
  params,
});
const offer = { major: 1, minMinor: 0, maxMinor: 0, clientName: 'test', capabilities: [] };
const control = { sessionId: 'session', streamEpoch: 'stream', controlEpoch: 'control' };

describe('local wire protocol', () => {
  it('publishes independent protocol version and finite resource budgets', () => {
    expect(PROTOCOL_VERSION).toEqual({ major: 1, minor: 0 });
    expect(DEFAULT_LIMITS).toMatchObject({
      maxFrameBytes: 1048576,
      initializationTimeoutMs: 5000,
      maxConnections: 16,
      maxOpenSessions: 8,
      maxConcurrentRuns: 4,
      maxPendingApprovals: 128,
      maxSnapshotBytes: 8388608,
      maxSendQueueBytes: 4194304,
      maxOperationIds: 1024,
      approvalTimeoutMs: 120000,
    });
  });

  it('negotiates a common minor and refuses unsupported versions without throwing', () => {
    expect(negotiateProtocol(offer)).toMatchObject({ ok: true, value: { major: 1, minor: 0 } });
    for (const invalid of [
      { ...offer, major: 2 },
      { ...offer, minMinor: 1, maxMinor: 2 },
    ]) {
      expect(negotiateProtocol(invalid)).toMatchObject({
        ok: false,
        error: { data: { code: 'PROTOCOL_MISMATCH' } },
      });
    }
    expect(negotiateProtocol({ ...offer, minMinor: 2, maxMinor: 1 })).toMatchObject({ ok: false });
  });

  it('accepts only implemented capabilities and echoes the required set', () => {
    expect(negotiateProtocol({ ...offer, capabilities: ['sessions', 'approval'] })).toMatchObject({
      ok: true,
      value: { capabilities: ['sessions', 'approval'] },
    });
    expect(negotiateProtocol({ ...offer, capabilities: ['replay'] })).toMatchObject({
      ok: false,
      error: { data: { code: 'PROTOCOL_MISMATCH' } },
    });
    expect(negotiateProtocol({ ...offer, capabilities: 'sessions' as never })).toMatchObject({
      ok: false,
      error: { code: -32602 },
    });
  });

  const fixtures: [string, unknown][] = [
    ['initialize', offer],
    ['ping', {}],
    ['session/list', { workspaceRoot: '/project' }],
    ['session/create', { workspaceRoot: '/project' }],
    ['session/open', { workspaceRoot: '/project', conversationId: 'conversation' }],
    ['session/attach', { sessionId: 'session', mode: 'control' }],
    ['session/detach', { sessionId: 'session' }],
    ['session/close', control],
    ['session/snapshot', { sessionId: 'session' }],
    ['run/start', { ...control, clientOperationId: 'operation', input: '你好' }],
    ['run/cancel', { ...control, runId: 'run' }],
    ['host/shutdown', {}],
    [
      'approval/request',
      {
        ...control,
        approvalId: 'approval',
        runId: 'run',
        toolName: 'write_file',
        target: 'write /project/a',
        sessionAllowed: false,
        expiresAt: 1,
      },
    ],
  ];
  it.each(fixtures)('round-trips the %s request with a validated payload', (method, params) => {
    const original = request(method, params);
    if (method === 'approval/request') original.id = 's:1';
    expect(parseWireMessage(JSON.stringify(original))).toEqual({ ok: true, value: original });
  });

  it('rejects malformed envelopes, batches, unknown methods and forged parameters', () => {
    for (const invalid of [
      null,
      [],
      [request('ping', {})],
      { ...request('ping', {}), id: 1 },
      request('unknown', {}),
      request('run/start', { ...control, input: 'no id' }),
      request('session/attach', { sessionId: 's', mode: 'owner' }),
      request('session/attach', { sessionId: 's', mode: 'control', afterSeq: 1 }),
      request('session/list', { workspaceRoot: '/p', limit: -1 }),
      { ...request('ping', {}), extra: 'secret' },
      request('ping', { secret: 'must not echo' }),
      request('initialize', { ...offer, major: 1.5 }),
      request('approval/request', { ...control }),
    ]) {
      const result = validateRequest(invalid);
      expect(result.ok).toBe(false);
      expect(JSON.stringify(result)).not.toContain('must not echo');
    }
    expect(validateRequest(request('unknown', {}))).toMatchObject({
      ok: false,
      error: { code: -32601 },
    });
    expect(parseWireMessage('{not JSON')).toMatchObject({ ok: false, error: { code: -32700 } });
  });

  it('rejects non JSON values without invoking accessors or toJSON hooks', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    let invoked = false;
    const getter = Object.defineProperty({}, 'x', {
      enumerable: true,
      get() {
        invoked = true;
        return 1;
      },
    });
    const hook = {
      toJSON() {
        invoked = true;
        return {};
      },
    };
    for (const params of [
      cyclic,
      getter,
      hook,
      { value: undefined },
      { value: Number.NaN },
      { value: 1n },
      new Date(),
    ]) {
      expect(validateRequest(request('ping', params)).ok).toBe(false);
    }
    expect(invoked).toBe(false);
  });

  it('validates response envelopes and the five approval choices without accepting new inputs', () => {
    for (const choice of ['allow_once', 'allow_session', 'deny_once', 'deny_session', 'cancel']) {
      expect(
        validateResponse({ jsonrpc: '2.0', id: 's:1', result: { choice } }, 'approval/request').ok,
      ).toBe(true);
    }
    expect(
      validateResponse(
        { jsonrpc: '2.0', id: 's:1', result: { choice: 'allow_once', input: {} } },
        'approval/request',
      ).ok,
    ).toBe(false);
    expect(validateResponse({ jsonrpc: '2.0', id: 'c:1', result: {}, error: {} }).ok).toBe(false);
    expect(
      validateResponse({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Invalid JSON' },
      }).ok,
    ).toBe(true);
    expect(
      validateResponse({
        jsonrpc: '2.0',
        id: 'c:1',
        error: { code: Number.NaN, message: 'invalid' },
      }).ok,
    ).toBe(false);
  });

  it('collapses handler errors to stable public codes without leaking messages', () => {
    expect(toWireErrorCode(new Error('SESSION_BUSY'))).toBe('SESSION_BUSY');
    expect(toWireErrorCode(new Error('WORKSPACE_ROOT_REQUIRED'))).toBe('WORKSPACE_ROOT_REQUIRED');
    expect(toWireErrorCode(new Error('Session locked by a live or unknown owner (pid=1)'))).toBe(
      'SESSION_BUSY',
    );
    expect(toWireErrorCode(new Error('Session not found: abc'))).toBe('SESSION_NOT_FOUND');
    expect(toWireErrorCode(new Error('History page must be a positive integer'))).toBe(
      'INVALID_PARAMS',
    );
    expect(toWireErrorCode(new Error('raw secret must not escape'))).toBe('INTERNAL_ERROR');
    expect(toWireErrorCode('not an error')).toBe('INTERNAL_ERROR');
    expect(wireCodeForRpcCode(-32700)).toBe('PARSE_ERROR');
    expect(wireCodeForRpcCode(-32600)).toBe('INVALID_REQUEST');
    expect(wireCodeForRpcCode(-32601)).toBe('METHOD_NOT_FOUND');
    expect(wireCodeForRpcCode(-32602)).toBe('INVALID_PARAMS');
  });

  it('validates event identity and rejects private or unknown payload variants', () => {
    const event = {
      serverInstanceId: 'instance',
      sessionId: 'session',
      streamEpoch: 'stream',
      seq: 1,
      runId: 'run',
      type: 'text_delta',
      payload: { text: '你好' },
    };
    expect(validateEvent(event)).toEqual({ ok: true, value: event });
    for (const invalid of [
      { ...event, seq: 0 },
      { ...event, seq: 1.5 },
      { ...event, type: 'encrypted_thinking' },
      { ...event, payload: { text: 'text', signature: 'private' } },
    ]) {
      expect(validateEvent(invalid).ok).toBe(false);
    }
  });
});
