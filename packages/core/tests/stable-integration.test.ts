import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceLeaseCoordinator } from '../src/capabilities/security/lease.js';
import { defineTool } from '../src/capabilities/tools/index.js';
import { AgentSession } from '../src/context/session/index.js';
import { AgentRuntime } from '../src/runtime/agent/runtime.js';
import { ScriptedProvider } from './helpers/mock.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const workspace = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-integration-'));
  roots.push(root);
  return root;
};
const profile = {
  id: 'fixture',
  name: 'fixture',
  provider: 'openai-compatible' as const,
  baseURL: 'http://127.0.0.1:9',
  modelName: 'fixture',
  apiKeyEnv: 'NONE',
};

describe('stable workspace and runner contracts', () => {
  it('preserves rootDir-only construction and rejects conflicting explicit roots', async () => {
    const root = workspace();
    const session = new AgentSession({
      rootDir: root,
      defaultProfile: profile,
      defaultProvider: new ScriptedProvider([]),
    });
    expect(session.workspaceRoot).toBe(fs.realpathSync.native(root));
    expect(
      () =>
        new AgentSession({
          rootDir: root,
          workspaceRoot: workspace(),
          defaultProfile: profile,
          defaultProvider: new ScriptedProvider([]),
        }),
    ).toThrow(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    await session.destroy();
  });

  it('passes distinct owned coordinators to independent sessions and preserves explicit sharing', async () => {
    const root = workspace();
    const seen: unknown[] = [];
    const shared = new WorkspaceLeaseCoordinator();
    for (const coordinator of [undefined, undefined, shared, shared]) {
      const session = new AgentSession({
        workspaceRoot: root,
        defaultProfile: profile,
        defaultProvider: new ScriptedProvider([
          [
            { type: 'tool_call_finish', id: 'inspect', name: 'inspect', input: {} },
            { type: 'message_stop' },
          ],
          [{ type: 'message_stop' }],
        ]),
        leaseCoordinator: coordinator,
        loggingDirectory: path.join(root, 'logs'),
        auditRecoveryDirectory: path.join(root, 'audit'),
      });
      session.tools.register(
        defineTool({
          name: 'inspect',
          description: '读取执行上下文',
          parameters: { type: 'object' },
          metadata: { source: 'builtin', permissions: ['fs:read'] },
          async execute(_input, context) {
            seen.push((context as unknown as { leaseCoordinator: unknown }).leaseCoordinator);
            return 'ok';
          },
        }),
      );
      for await (const _event of session.run('inspect')) {
        /* 完整消费以等待清理。 */
      }
      await session.destroy();
    }
    expect(seen).toHaveLength(4);
    expect(seen[0]).toBeInstanceOf(WorkspaceLeaseCoordinator);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen.slice(2)).toEqual([shared, shared]);
  });

  it('rejects missing spawn coordination before admitting a task', async () => {
    const root = workspace();
    const runtime = new AgentRuntime();
    await expect(
      runtime.prepareSpawn(
        {
          sessionId: 's',
          branchId: 'main',
          runId: 'r',
          toolCallId: 't',
          depth: 0,
          workspaceRoot: root,
          executionCwd: root,
        } as never,
        { description: 'inspect', prompt: 'inspect', role: 'explore' },
      ),
    ).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(runtime.listTasks()).toEqual([]);
    await runtime.close();
  });

  it('passes parent coordination only through runner memory, never task snapshots', async () => {
    const root = workspace();
    const coordinator = new WorkspaceLeaseCoordinator();
    let observed: unknown;
    const runtime = new AgentRuntime({
      runner: async (record, _signal, context) => {
        observed = context.leaseCoordinator;
        expect(JSON.stringify(record)).not.toContain('leaseCoordinator');
        return { summary: 'done' };
      },
    });
    const receipt = await runtime.prepareSpawn(
      {
        leaseCoordinator: coordinator,
        sessionId: 's',
        branchId: 'main',
        runId: 'r',
        toolCallId: 't',
        depth: 0,
        workspaceRoot: root,
        executionCwd: root,
      },
      { description: 'inspect', prompt: 'inspect', role: 'explore' },
    );
    await runtime.activateSpawn(receipt.agentId);
    await runtime.waitAgents([receipt.agentId], 1000);
    expect(observed).toBe(coordinator);
    expect(JSON.stringify(runtime.listTasks())).not.toContain('leaseCoordinator');
    await runtime.close();
  });

  it('accepts a usable coordinator from another realm without replacing its identity', async () => {
    const root = workspace();
    const delegate = new WorkspaceLeaseCoordinator();
    const ForeignCoordinator = vm.runInNewContext(`(class {
      constructor(delegate) { this.delegate = delegate; }
      isLocked(...args) { return this.delegate.isLocked(...args); }
      getActiveLease(...args) { return this.delegate.getActiveLease(...args); }
      tryAcquire(...args) { return this.delegate.tryAcquire(...args); }
      acquire(...args) { return this.delegate.acquire(...args); }
    })`);
    const coordinator = new ForeignCoordinator(delegate);
    expect(coordinator).not.toBeInstanceOf(WorkspaceLeaseCoordinator);
    let observed: unknown;
    const runtime = new AgentRuntime({
      runner: async (_record, _signal, context) => {
        observed = context.leaseCoordinator;
        const lease = await context.leaseCoordinator.acquire(root, 'foreign');
        expect(delegate.isLocked(root)).toBe(true);
        lease.release();
        return { summary: 'done' };
      },
    });
    try {
      const receipt = await runtime.prepareSpawn(
        {
          leaseCoordinator: coordinator,
          sessionId: 's',
          branchId: 'main',
          runId: 'r',
          toolCallId: 't',
          depth: 0,
          workspaceRoot: root,
          executionCwd: root,
        },
        { description: 'inspect', prompt: 'inspect', role: 'explore' },
      );
      await runtime.activateSpawn(receipt.agentId);
      await runtime.waitAgents([receipt.agentId], 1000);
      expect(observed).toBe(coordinator);
      expect(delegate.isLocked(root)).toBe(false);
    } finally {
      await runtime.close();
    }
  });
});
