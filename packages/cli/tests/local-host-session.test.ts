import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionRegistry } from '../src/local-host/registry.js';
import type { SessionResources } from '../src/local-host/types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const workspace = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-host-'));
  roots.push(root);
  return root;
};
const resource = (): SessionResources => ({
  conversationId: 'conversation',
  history: () => [],
  async *run() {
    yield { type: 'text_delta', text: 'hello' };
  },
  dispose: vi.fn(async () => {}),
});

describe('local host session ownership', () => {
  it('reuses a conversation across the root and subdirectories of one Git worktree', async () => {
    const root = workspace();
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    const nested = path.join(root, 'nested');
    fs.mkdirSync(nested);
    const create = vi.fn(async () => resource());
    const registry = new SessionRegistry({ create });
    try {
      const first = await registry.open(nested, 'conversation');
      const reopened = await registry.open(root, 'conversation');
      expect(reopened).toEqual(first);
      expect(registry.get(first.sessionId).workspaceRoot).toBe(fs.realpathSync.native(root));
      expect(create).toHaveBeenCalledTimes(1);
    } finally {
      await registry.shutdown();
    }
  });
  it('detaches only the target session for a multi-session connection', async () => {
    const registry = new SessionRegistry({ create: async () => resource() });
    const a = await registry.open(workspace());
    const b = await registry.open(workspace());
    const controlA = registry.attach(a.sessionId, 'c', 'control');
    const controlB = registry.attach(b.sessionId, 'c', 'control');
    await registry.disconnect('c', a.sessionId);
    expect(() => registry.control(a.sessionId, 'c', controlA)).toThrow();
    expect(() => registry.control(b.sessionId, 'c', controlB)).not.toThrow();
    await registry.shutdown();
  });
  it('clears the active fence after cleanup failure and keeps close retryable', async () => {
    const res = resource();
    res.isBusy = () => true;
    res.run = async function* () {
      yield { type: 'text_delta', text: 'started' };
      throw new Error('cleanup failed');
    };
    const registry = new SessionRegistry({ create: async () => res });
    const opened = await registry.open(workspace());
    const control = registry.attach(opened.sessionId, 'c', 'control');
    registry.start(control, 'c', 'o', 'input');
    const entry = registry.get(opened.sessionId);
    await entry.active?.done;
    expect(entry.active).toBeUndefined();
    expect(entry.needsCleanup).toBe(true);
    expect(() => registry.start(control, 'c', 'other', 'input')).toThrow(/SESSION_BUSY/);
    await registry.close(control, 'c');
    expect(res.dispose).toHaveBeenCalledTimes(1);
    expect(() => registry.get(opened.sessionId)).toThrow(/SESSION_NOT_FOUND/);
    await registry.shutdown();
  });
  it('disconnect clears control after a busy cleanup without waiting on a rejected run', async () => {
    const res = resource();
    res.isBusy = () => true;
    res.run = async function* () {
      yield { type: 'text_delta', text: 'started' };
      throw new Error('cleanup failed');
    };
    const registry = new SessionRegistry({ create: async () => res });
    const opened = await registry.open(workspace());
    const control = registry.attach(opened.sessionId, 'c', 'control');
    registry.start(control, 'c', 'o', 'input');
    const entry = registry.get(opened.sessionId);
    await entry.active?.done;
    await registry.disconnect('c');
    expect(entry.controller).toBeUndefined();
    expect(entry.needsCleanup).toBe(true);
    await registry.shutdown();
  });
  it('shuts down unaffected sessions and retries only failed disposals', async () => {
    let firstFailures = 1;
    const first = resource();
    first.dispose = vi.fn(async () => {
      if (firstFailures-- > 0) throw new Error('cleanup failed');
    });
    const second = resource();
    const queue = [first, second];
    const registry = new SessionRegistry({ create: async () => queue.shift()! });
    await registry.open(workspace());
    await registry.open(workspace());
    await expect(registry.shutdown()).rejects.toThrow(/cleanup failed/);
    expect(first.dispose).toHaveBeenCalledTimes(1);
    expect(second.dispose).toHaveBeenCalledTimes(1);
    await registry.shutdown();
    expect(first.dispose).toHaveBeenCalledTimes(2);
    expect(second.dispose).toHaveBeenCalledTimes(1);
  });
  it('does not return a closing session while disposal is in flight', async () => {
    let release!: () => void;
    const disposing = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = resource();
    first.dispose = vi.fn(() => disposing);
    const queue = [first, resource()];
    const registry = new SessionRegistry({ create: async () => queue.shift()! });
    const opened = await registry.open(workspace(), 'conversation');
    const control = registry.attach(opened.sessionId, 'c', 'control');
    const closing = registry.close(control, 'c');
    await vi.waitFor(() => expect(first.dispose).toHaveBeenCalled());
    const reopened = await registry.open(workspace(), 'conversation');
    expect(reopened.sessionId).not.toBe(opened.sessionId);
    release();
    await closing;
    await registry.shutdown();
  });
  it('has a single controller and rejects stale epochs and observer writes', async () => {
    const registry = new SessionRegistry({ create: async () => resource() });
    const opened = await registry.open(workspace());
    const attached = registry.attach(opened.sessionId, 'client', 'control');
    expect(() => registry.attach(opened.sessionId, 'other', 'control')).toThrow(/SESSION_BUSY/);
    registry.attach(opened.sessionId, 'observer', 'observe');
    expect(() => registry.control(opened.sessionId, 'observer', attached)).toThrow(
      /CONTROL_REQUIRED/,
    );
    expect(() =>
      registry.control(opened.sessionId, 'client', { ...attached, controlEpoch: 'old' }),
    ).toThrow(/STALE_CONTROL/);
    registry.control(opened.sessionId, 'client', attached);
    await registry.shutdown();
  });
  it('normalizes symlink identity and reserves capacity while opening', async () => {
    const root = workspace();
    const alias = path.join(root, 'alias');
    fs.symlinkSync(root, alias);
    const create = vi.fn(async () => resource());
    const registry = new SessionRegistry({ create });
    const a = await registry.open(root, 'conversation');
    const b = await registry.open(alias, 'conversation');
    expect(a.sessionId).toBe(b.sessionId);
    expect(create).toHaveBeenCalledTimes(1);
    await registry.shutdown();
  });
  it('keeps a cancelling run busy until its iterator completes cleanup', async () => {
    let release!: () => void;
    const cleaning = new Promise<void>((resolve) => {
      release = resolve;
    });
    const res = resource();
    res.run = async function* (_input, signal) {
      yield { type: 'text_delta', text: 'started' };
      await new Promise<void>((resolve) =>
        signal.addEventListener('abort', () => resolve(), { once: true }),
      );
      await cleaning;
    };
    const registry = new SessionRegistry({ create: async () => res });
    const opened = await registry.open(workspace());
    const control = registry.attach(opened.sessionId, 'c', 'control');
    const run = registry.start(control, 'c', 'operation', 'input');
    await vi.waitFor(() =>
      expect(registry.get(opened.sessionId).feed.highWaterMark).toBeGreaterThan(1),
    );
    registry.cancel(control, 'c', run.runId);
    expect(() => registry.start(control, 'c', 'other', 'input')).toThrow(/SESSION_BUSY/);
    const disconnecting = registry.disconnect('c');
    expect(() => registry.attach(opened.sessionId, 'new', 'control')).toThrow(/SESSION_BUSY/);
    release();
    await disconnecting;
    expect(registry.attach(opened.sessionId, 'new', 'control').controlEpoch).not.toBe(
      control.controlEpoch,
    );
    await registry.shutdown();
  });
  it('deduplicates accepted operations and rejects changed inputs', async () => {
    const registry = new SessionRegistry({ create: async () => resource() });
    const opened = await registry.open(workspace());
    const control = registry.attach(opened.sessionId, 'c', 'control');
    const first = registry.start(control, 'c', 'operation', 'input');
    expect(registry.start(control, 'c', 'operation', 'input')).toEqual(first);
    expect(() => registry.start(control, 'c', 'operation', 'changed')).toThrow(
      /OPERATION_CONFLICT/,
    );
    await registry.shutdown();
  });
});
