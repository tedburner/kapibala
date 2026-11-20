import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WorkspaceLeaseCoordinator } from '../src/capabilities/security/lease.js';
import { AgentRuntime, type SpawnContext } from '../src/runtime/agent/index.js';

/**
 * 验证 v0.1.3 委派生命周期：detached 保留、send_agent 续聊、requestId 幂等与重启重建。
 * 不依赖真实模型：runner/resumer 都是可观测的桩函数。
 */
describe('delegation lifecycle (detached sessions and send_agent)', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-delegation-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const createContext = (overrides?: Partial<SpawnContext>): SpawnContext => ({
    leaseCoordinator: new WorkspaceLeaseCoordinator(),
    rootTaskId: 'tree-delegation',
    sessionId: 'session-root',
    branchId: 'main',
    runId: 'run-1',
    toolCallId: 'call-spawn-1',
    depth: 0,
    workspaceRoot: directory,
    executionCwd: directory,
    ...overrides,
  });

  const detachedRunner =
    (sessionId = 'child-session-1') =>
    async (
      _task: unknown,
      _signal: AbortSignal,
      context: { onSessionCreated?: (id: string) => void },
    ) => {
      context.onSessionCreated?.(sessionId);
      return { summary: 'first turn', modelId: 'mock-model', sessionId, title: 'Delegated' };
    };

  const spawnDetached = async (runtime: AgentRuntime, extra: Record<string, unknown> = {}) => {
    const receipt = await runtime.prepareSpawn(createContext(), {
      description: 'Delegated task',
      prompt: 'Do the work',
      role: 'explore',
      mode: 'detached',
      ...extra,
    });
    await runtime.activateSpawn(receipt.agentId);
    await runtime.waitAgents([receipt.agentId], 5_000);
    return receipt;
  };

  it('detached 终态保留子会话身份，ephemeral 维持不暴露会话', async () => {
    const runtime = new AgentRuntime({ runner: detachedRunner() });
    try {
      const receipt = await spawnDetached(runtime);
      const detached = runtime.getTask(receipt.agentId);
      expect(detached?.mode).toBe('detached');
      expect(detached?.status).toBe('completed');
      expect(detached?.sessionId).toBe('child-session-1');
      expect(detached?.runGeneration).toBe(1);

      const ephemeralReceipt = await runtime.prepareSpawn(createContext(), {
        description: 'Ephemeral task',
        prompt: 'Do the work',
        role: 'explore',
      });
      await runtime.activateSpawn(ephemeralReceipt.agentId);
      await runtime.waitAgents([ephemeralReceipt.agentId], 5_000);
      expect(runtime.getTask(ephemeralReceipt.agentId)?.sessionId).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it('物理删除委派会话后清空运行时身份：续聊报未保留，旧 requestId 不再重放回执', async () => {
    const runtime = new AgentRuntime({
      runner: detachedRunner('child-session-del'),
      resumer: async () => ({ summary: 'resumed' }),
    });
    try {
      const receipt = await spawnDetached(runtime, { requestId: 'req-del' });
      expect(runtime.getTask(receipt.agentId)?.sessionId).toBe('child-session-del');

      runtime.forgetDelegationSession('child-session-del');
      const cleared = runtime.getTask(receipt.agentId);
      expect(cleared?.sessionId).toBeUndefined();
      expect(cleared?.title).toBeUndefined();
      await expect(
        runtime.prepareResume({ agentId: receipt.agentId, prompt: 'continue' }),
      ).rejects.toMatchObject({ code: 'DELEGATION_NOT_RETAINED' });

      // 幂等条目已随会话清除：同 requestId 同参不再重放指向已删除会话的回执。
      const respawned = await runtime.prepareSpawn(createContext(), {
        description: 'Delegated task',
        prompt: 'Do the work',
        role: 'explore',
        mode: 'detached',
        requestId: 'req-del',
      });
      expect(respawned.agentId).not.toBe(receipt.agentId);
      await runtime.activateSpawn(respawned.agentId);
      await runtime.waitAgents([respawned.agentId], 5_000);
    } finally {
      await runtime.close();
    }
  });

  it('终态可续聊：runGeneration 递增、走 resumer，并以 run-N 作为通知 revision', async () => {
    const prompts: string[] = [];
    const runtime = new AgentRuntime({
      runner: detachedRunner('child-session-9'),
      resumer: async (task, prompt) => {
        prompts.push(prompt);
        expect(task.sessionId).toBe('child-session-9');
        return { summary: `resumed:${prompt}` };
      },
    });
    try {
      const receipt = await spawnDetached(runtime);
      const resumed = await runtime.prepareResume({
        agentId: receipt.agentId,
        prompt: 'next step',
      });
      expect(resumed.runGeneration).toBe(2);
      expect(resumed.sessionId).toBe('child-session-9');
      await runtime.activateResume(receipt.agentId);
      await runtime.waitAgents([receipt.agentId], 5_000);

      const task = runtime.getTask(receipt.agentId);
      expect(task?.status).toBe('completed');
      expect(task?.summary).toBe('resumed:next step');
      expect(task?.continuationOf).toBe('run-1');
      expect(prompts).toEqual(['next step']);
      expect(
        runtime
          .getOutbox()
          .getPendingNotifications()
          .map((n) => n.eventId),
      ).toContain(`${receipt.agentId}:1:run-2`);
    } finally {
      await runtime.close();
    }
  });

  it('活动态续聊直接拒绝，不排队；ephemeral 与未知任务分别报保留/找不到', async () => {
    let release: () => void = () => {};
    const runtime = new AgentRuntime({
      runner: async (_task, _signal, context) => {
        context.onSessionCreated?.('child-busy');
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { summary: 'done', sessionId: 'child-busy' };
      },
      resumer: async () => ({ summary: 'never' }),
    });
    try {
      const receipt = await runtime.prepareSpawn(createContext(), {
        description: 'Busy task',
        prompt: 'Work',
        role: 'explore',
        mode: 'detached',
      });
      await runtime.activateSpawn(receipt.agentId);
      // runner 已通过 onSessionCreated 回填身份，但任务仍在运行：续聊必须 busy 拒绝。
      await expect(
        runtime.prepareResume({ agentId: receipt.agentId, prompt: 'again' }),
      ).rejects.toMatchObject({ code: 'DELEGATION_BUSY' });
      release();
      await runtime.waitAgents([receipt.agentId], 5_000);

      const ephemeral = await runtime.prepareSpawn(createContext(), {
        description: 'Ephemeral',
        prompt: 'Work',
        role: 'explore',
      });
      await expect(
        runtime.prepareResume({ agentId: ephemeral.agentId, prompt: 'again' }),
      ).rejects.toMatchObject({ code: 'DELEGATION_NOT_RETAINED' });
      await expect(
        runtime.prepareResume({ agentId: 'missing-agent', prompt: 'again' }),
      ).rejects.toMatchObject({ code: 'DELEGATION_NOT_FOUND' });
    } finally {
      release();
      await runtime.close();
    }
  });

  it('spawn/send 的 requestId 精确幂等：同参重放原回执，异参明确冲突', async () => {
    const runtime = new AgentRuntime({
      runner: detachedRunner(),
      resumer: async (_task, prompt) => ({ summary: `resumed:${prompt}` }),
    });
    try {
      const params = {
        description: 'Idempotent task',
        prompt: 'Work',
        role: 'explore',
        mode: 'detached',
      } as const;
      const first = await runtime.prepareSpawn(createContext(), {
        ...params,
        requestId: 'spawn-1',
      });
      const replay = await runtime.prepareSpawn(createContext(), {
        ...params,
        requestId: 'spawn-1',
      });
      expect(replay.agentId).toBe(first.agentId);
      expect(runtime.listTasks({ rootTaskId: 'tree-delegation' })).toHaveLength(1);
      await expect(
        runtime.prepareSpawn(createContext(), {
          ...params,
          prompt: 'Different',
          requestId: 'spawn-1',
        }),
      ).rejects.toMatchObject({ code: 'DELEGATION_REQUEST_CONFLICT' });

      await runtime.activateSpawn(first.agentId);
      await runtime.waitAgents([first.agentId], 5_000);

      const send1 = await runtime.prepareResume({
        agentId: first.agentId,
        prompt: 'again',
        requestId: 'send-1',
      });
      const send2 = await runtime.prepareResume({
        agentId: first.agentId,
        prompt: 'again',
        requestId: 'send-1',
      });
      expect(send2.runGeneration).toBe(send1.runGeneration);
      await expect(
        runtime.prepareResume({
          agentId: first.agentId,
          prompt: 'other',
          requestId: 'send-1',
        }),
      ).rejects.toMatchObject({ code: 'DELEGATION_REQUEST_CONFLICT' });
      await runtime.activateResume(first.agentId);
      await runtime.waitAgents([first.agentId], 5_000);
    } finally {
      await runtime.close();
    }
  });

  it('重启后凭委派头快照重建索引：同一 requestId 不重复派发并返回原回执', async () => {
    const params = {
      description: 'Restart task',
      prompt: 'Work',
      role: 'explore',
      mode: 'detached',
      requestId: 'spawn-restart',
    } as const;
    const original = new AgentRuntime({ runner: detachedRunner() });
    let agentId: string;
    let signature: string;
    let storedReceipt: Record<string, unknown>;
    try {
      const receipt = await original.prepareSpawn(createContext(), params);
      agentId = receipt.agentId;
      await original.activateSpawn(receipt.agentId);
      await original.waitAgents([receipt.agentId], 5_000);
      const record = original.getTask(receipt.agentId);
      signature = record?.requestSignature ?? '';
      storedReceipt = { ...record?.requestReceipt, sessionId: record?.sessionId };
    } finally {
      await original.close();
    }
    expect(signature).not.toBe('');

    // 模拟新进程：只有落盘快照，没有内存任务记录。
    const restarted = new AgentRuntime({
      restoredRequests: [
        {
          requestId: params.requestId,
          signature,
          receipt: storedReceipt as never,
        },
      ],
    });
    try {
      const replay = await restarted.prepareSpawn(createContext(), params);
      expect(replay.agentId).toBe(agentId);
      expect(replay.sessionId).toBe('child-session-1');
      expect(restarted.listTasks()).toHaveLength(0);
      await expect(
        restarted.prepareSpawn(createContext(), { ...params, prompt: 'Different' }),
      ).rejects.toMatchObject({ code: 'DELEGATION_REQUEST_CONFLICT' });
    } finally {
      await restarted.close();
    }
  });

  it('父事务回滚续聊后恢复原终态与代次，可重新受理', async () => {
    const runtime = new AgentRuntime({
      runner: detachedRunner(),
      resumer: async (_task, prompt) => ({ summary: `resumed:${prompt}` }),
    });
    try {
      const receipt = await spawnDetached(runtime);
      const prepared = await runtime.prepareResume({
        agentId: receipt.agentId,
        prompt: 'retry me',
      });
      expect(prepared.runGeneration).toBe(2);
      expect(runtime.getTask(receipt.agentId)?.status).toBe('accepted');

      await runtime.rollbackPreparedResume(receipt.agentId);
      const reverted = runtime.getTask(receipt.agentId);
      expect(reverted?.status).toBe('completed');
      expect(reverted?.runGeneration).toBe(1);
      expect(reverted?.summary).toBe('first turn');

      const again = await runtime.prepareResume({ agentId: receipt.agentId, prompt: 'retry me' });
      expect(again.runGeneration).toBe(2);
      await runtime.activateResume(receipt.agentId);
      await runtime.waitAgents([receipt.agentId], 5_000);
      expect(runtime.getTask(receipt.agentId)?.summary).toBe('resumed:retry me');
    } finally {
      await runtime.close();
    }
  });
});
