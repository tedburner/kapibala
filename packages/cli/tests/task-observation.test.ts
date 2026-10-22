import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceLeaseCoordinator } from '../../core/src/capabilities/security/lease.js';
import { AgentRuntime, type SpawnContext } from '../../core/src/runtime/agent/index.js';
import { TaskObservation } from '../src/host/task-observation.js';

describe('host task observation', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-task-view-'));
  });
  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const context = (overrides?: Partial<SpawnContext>): SpawnContext => ({
    leaseCoordinator: new WorkspaceLeaseCoordinator(),
    sessionId: 'parent',
    branchId: 'main',
    rootTaskId: 'root',
    runId: 'run',
    toolCallId: 'spawn',
    depth: 0,
    workspaceRoot: directory,
    executionCwd: directory,
    ...overrides,
  });
  const params = {
    description: '\x1b[31mInspect\x1b[0m',
    prompt: 'PRIVATE PROMPT',
    role: 'explore' as const,
  };

  it('filters by parent and optional root while retaining other-branch hints and only allowed fields', async () => {
    const runtime = new AgentRuntime();
    const observation = new TaskObservation(runtime, {
      parentSessionId: 'parent',
      rootTaskId: 'root',
      branchId: 'main',
    });
    try {
      const main = await runtime.prepareSpawn(context(), params);
      await runtime.prepareSpawn(context({ branchId: 'feature' }), params);
      await runtime.prepareSpawn(context({ rootTaskId: 'another-root' }), params);
      await runtime.prepareSpawn(context({ sessionId: 'another-parent' }), params);
      const tasks = observation.snapshot();
      expect(tasks).toHaveLength(2);
      expect(tasks[0]).toMatchObject({
        agentId: main.agentId,
        description: 'Inspect',
        status: 'preparing',
        delivery: 'not-ready',
        isOtherBranch: false,
      });
      expect(tasks[1]).toMatchObject({ originBranchId: 'feature', isOtherBranch: true });
      expect(tasks[1]?.branchHint).toContain('feature');
      expect(JSON.stringify(tasks)).not.toMatch(
        /PRIVATE PROMPT|workspaceRoot|executionCwd|effectivePolicy|allowedTools/,
      );
      Reflect.set(tasks[0]!, 'description', 'host mutation');
      expect(observation.snapshot()[0]?.description).toBe('Inspect');
      observation.refresh({ parentSessionId: 'parent', branchId: 'feature' });
      expect(observation.snapshot()).toHaveLength(3);
      expect(
        observation.snapshot().find((task) => task.originBranchId === 'feature')?.isOtherBranch,
      ).toBe(false);
    } finally {
      observation.close();
      await runtime.close();
    }
  });

  it('updates idle-parent completion, preserves pending collection and refreshes ACK explicitly', async () => {
    let finish: () => void = () => {};
    const runtime = new AgentRuntime({
      runner: async () => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        return { summary: 'Public result' };
      },
    });
    const changed = vi.fn();
    const observation = new TaskObservation(
      runtime,
      { parentSessionId: 'parent', branchId: 'main' },
      changed,
    );
    try {
      const receipt = await runtime.prepareSpawn(context({ branchId: 'feature' }), params);
      await runtime.activateSpawn(receipt.agentId);
      finish();
      await runtime.waitAgents([receipt.agentId]);
      await Promise.resolve();
      expect(changed).toHaveBeenCalled();
      expect(observation.snapshot()[0]).toMatchObject({
        status: 'completed',
        delivery: 'pending',
        summary: 'Public result',
        isOtherBranch: true,
      });
      const pending = runtime.getOutbox().getPendingNotifications();
      expect(pending).toHaveLength(1);
      runtime.getOutbox().acknowledge(pending[0]!.eventId);
      observation.refresh();
      expect(observation.snapshot()[0]).toMatchObject({
        status: 'completed',
        delivery: 'collected',
        isOtherBranch: true,
      });
    } finally {
      finish();
      observation.close();
      await runtime.close();
    }
  });

  it('never infers collected from terminal state or missing outbox evidence', async () => {
    const runtime = new AgentRuntime();
    const receipt = await runtime.prepareSpawn(context(), params);
    await runtime.rollbackPreparedSpawn(receipt.agentId);
    const observation = new TaskObservation(runtime, {
      parentSessionId: 'parent',
      branchId: 'main',
    });
    try {
      expect(observation.snapshot()[0]).toMatchObject({ status: 'cancelled', delivery: 'unknown' });
      expect(runtime.getOutbox().getPendingNotifications()).toEqual([]);
    } finally {
      observation.close();
      await runtime.close();
    }
  });

  it('isolates callback failure and releases its runtime subscription on close', async () => {
    const runtime = new AgentRuntime();
    const changed = vi.fn(() => {
      throw new Error('View failed');
    });
    const observation = new TaskObservation(
      runtime,
      { parentSessionId: 'parent', branchId: 'main' },
      changed,
    );
    await runtime.prepareSpawn(context(), params);
    const calls = changed.mock.calls.length;
    observation.close();
    observation.close();
    await runtime.prepareSpawn(context(), params);
    observation.refresh({ parentSessionId: 'another-parent', branchId: 'main' });
    expect(changed).toHaveBeenCalledTimes(calls);
    expect(observation.snapshot()).toEqual([]);
    await runtime.close();
  });
});
