import { afterEach, describe, expect, it, vi } from 'vitest';
import { RpcApprovalChannel } from '../src/local-host/approval.js';
import type { ApprovalPrompt } from '../src/protocol/index.js';

afterEach(() => vi.useRealTimers());
const identity = {
  sessionId: 'session',
  streamEpoch: 'stream',
  controlEpoch: 'control',
  runId: 'run',
};
const request = {
  toolName: 'write_file',
  capabilities: ['fs:write' as const],
  input: { path: '/p/a', content: 'secret' },
  rootDir: '/p',
  sessionAllowed: true,
};
const channel = (reply: (prompt: ApprovalPrompt, signal: AbortSignal) => Promise<unknown>) =>
  new RpcApprovalChannel({
    identity: () => identity,
    request: reply,
    describe: () => 'write /p/a',
  });

describe('local approval bridge', () => {
  it.each(['allow_once', 'allow_session', 'deny_once', 'deny_session', 'cancel'] as const)(
    'preserves %s without exposing raw parameters',
    async (choice) => {
      const bridge = channel(async (prompt) => {
        expect(prompt).not.toHaveProperty('input');
        expect(JSON.stringify(prompt)).not.toContain('secret');
        return { choice };
      });
      expect(await bridge.requestApproval(request)).toBe(choice);
    },
  );
  it('rejects allow_session when the request forbids session allow caching', async () => {
    expect(
      await channel(async () => ({ choice: 'allow_session' })).requestApproval({
        ...request,
        sessionAllowed: false,
      }),
    ).toBe('cancel');
  });
  it('cancels stale control, forged responses and undisplayable targets', async () => {
    expect(
      await channel(async () => {
        identity.controlEpoch = 'new';
        return { choice: 'allow_once' };
      }).requestApproval(request),
    ).toBe('cancel');
    identity.controlEpoch = 'control';
    expect(
      await channel(async () => ({ choice: 'allow_once', input: {} })).requestApproval(request),
    ).toBe('cancel');
    const bridge = new RpcApprovalChannel({
      identity: () => identity,
      request: async () => ({ choice: 'allow_once' }),
      describe: () => undefined,
    });
    expect(await bridge.requestApproval(request)).toBe('cancel');
  });
  it('settles an uncooperative peer on timeout, abort and dispose', async () => {
    vi.useFakeTimers();
    const bridge = channel(async () => new Promise(() => {}));
    const pending = bridge.requestApproval(request);
    await vi.advanceTimersByTimeAsync(120000);
    expect(await pending).toBe('cancel');
    const abort = new AbortController();
    const aborted = bridge.requestApproval(request, abort.signal);
    abort.abort();
    expect(await aborted).toBe('cancel');
    const disposed = bridge.requestApproval(request);
    bridge.dispose();
    expect(await disposed).toBe('cancel');
    expect(vi.getTimerCount()).toBe(0);
    expect(await bridge.requestApproval(request)).toBe('cancel');
  });
});
