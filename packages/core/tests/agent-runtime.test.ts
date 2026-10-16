import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolContext } from '../src/capabilities/tools/index.js';
import { KapibalaError } from '../src/errors/index.js';
import {
  AgentRuntime,
  type AgentTaskRecord,
  type SpawnContext,
  createCancelAgentTool,
  createListAgentsTool,
  createSpawnAgentTool,
  createWaitAgentTool,
} from '../src/runtime/agent/index.js';

describe('AgentRuntime and spawn launch transactions', () => {
  let directory: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-agent-runtime-'));
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const createDefaultContext = (overrides?: Partial<SpawnContext>): SpawnContext => ({
    sessionId: 'session-root',
    branchId: 'main',
    runId: 'run-1',
    toolCallId: 'call-spawn-1',
    depth: 0,
    workspaceRoot: directory,
    executionCwd: directory,
    ...overrides,
  });

  it('immediately returns accepted receipt and closes tool transaction before subagent finishes', async () => {
    let runnerStarted = false;
    let finishRunner: () => void = () => {};

    const runtime = new AgentRuntime({
      runner: async (_record, signal) => {
        runnerStarted = true;
        await new Promise<void>((resolve) => {
          finishRunner = resolve;
          signal.addEventListener('abort', () => resolve());
        });
        return { summary: 'Task finished' };
      },
    });

    const spawnTool = createSpawnAgentTool(runtime);
    const toolCtx: ToolContext = {
      rootDir: directory,
      workspaceRoot: directory,
      executionCwd: directory,
      sessionId: 'session-root',
      branchId: 'main',
      runId: 'run-1',
      toolCallId: 'call-1',
      depth: 0,
    };

    // Execute tool
    const receipt = await spawnTool.execute(
      {
        description: 'Explore codebase',
        prompt: 'Check files',
        role: 'explore',
      },
      toolCtx,
    );

    // Assert immediate transaction closure: returned receipt with status 'accepted'
    expect(receipt.status).toBe('accepted');
    expect(receipt.agentId).toBeTruthy();
    expect(receipt.depth).toBe(1);

    // Wait a tick for microtask activation
    await new Promise((r) => setTimeout(r, 10));
    expect(runnerStarted).toBe(true);

    const taskDuringRun = runtime.getTask(receipt.agentId);
    expect(taskDuringRun?.status).toBe('running');

    // Finish runner
    finishRunner();
    await new Promise((r) => setTimeout(r, 20));

    const finishedTask = runtime.getTask(receipt.agentId);
    expect(finishedTask?.status).toBe('completed');
    expect(finishedTask?.summary).toBe('Task finished');

    await runtime.close();
  });

  it('enforces capacity limits, depth boundaries, and workspace isolation', async () => {
    const runtime = new AgentRuntime({
      runner: async () => {
        await new Promise((r) => setTimeout(r, 100));
        return { summary: 'done' };
      },
    });

    const context = createDefaultContext({ rootTaskId: 'tree-1' });

    // 1. Validate parameter requirements
    await expect(
      runtime.prepareSpawn(context, { description: '', prompt: 'x', role: 'explore' }),
    ).rejects.toThrow(/Description is required/);

    await expect(
      runtime.prepareSpawn(context, { description: 'd', prompt: '', role: 'explore' }),
    ).rejects.toThrow(/Prompt is required/);

    // 2. Validate workspace boundary escape
    await expect(
      runtime.prepareSpawn(context, {
        description: 'd',
        prompt: 'p',
        role: 'explore',
        cwd: '../../outside-dir',
      }),
    ).rejects.toThrow(KapibalaError);

    // 3. Validate depth boundary (depth > 3 rejected)
    const deepContext = createDefaultContext({ depth: 3 });
    await expect(
      runtime.prepareSpawn(deepContext, {
        description: 'deep task',
        prompt: 'go deeper',
        role: 'explore',
      }),
    ).rejects.toThrow(KapibalaError);

    try {
      await runtime.prepareSpawn(deepContext, {
        description: 'deep task',
        prompt: 'go deeper',
        role: 'explore',
      });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as KapibalaError).code).toBe('SUBAGENT_DEPTH_EXCEEDED');
    }

    // 4. Validate active capacity per tree (max 4)
    const receipts: string[] = [];
    for (let i = 0; i < 4; i++) {
      const receipt = await runtime.prepareSpawn(context, {
        description: `task ${i}`,
        prompt: `prompt ${i}`,
        role: 'explore',
      });
      receipts.push(receipt.agentId);
    }

    // 5th spawn in same tree must throw AGENT_CAPACITY_EXCEEDED
    try {
      await runtime.prepareSpawn(context, {
        description: 'task 5',
        prompt: 'prompt 5',
        role: 'explore',
      });
      expect.fail('should have rejected 5th spawn in tree');
    } catch (err) {
      expect((err as KapibalaError).code).toBe('AGENT_CAPACITY_EXCEEDED');
    }

    await runtime.close();
  });

  it('transitions to waiting_children when parent finishes but descendants are still active', async () => {
    let finishChild: () => void = () => {};
    let finishParent: () => void = () => {};

    const runtime = new AgentRuntime({
      runner: async (task) => {
        if (task.role === 'planner') {
          // Parent planner waits until child is spawned before completing main turn
          await new Promise<void>((resolve) => {
            finishParent = resolve;
          });
          return { summary: 'Planner finished' };
        }
        // Child executor stays running until explicitly resolved
        await new Promise<void>((resolve) => {
          finishChild = resolve;
        });
        return { summary: 'Child executor finished' };
      },
    });

    const rootCtx = createDefaultContext({ rootTaskId: 'tree-parent-child' });

    // Spawn Parent (planner)
    const parentReceipt = await runtime.prepareSpawn(rootCtx, {
      description: 'Parent Planner',
      prompt: 'Plan architecture',
      role: 'planner',
    });
    await runtime.activateSpawn(parentReceipt.agentId);

    // Spawn Child from Parent
    const childCtx = createDefaultContext({
      rootTaskId: 'tree-parent-child',
      agentId: parentReceipt.agentId,
      depth: 1,
    });
    const childReceipt = await runtime.prepareSpawn(childCtx, {
      description: 'Child Executor',
      prompt: 'Execute step',
      role: 'implement',
    });
    await runtime.activateSpawn(childReceipt.agentId);

    // Allow parent to finish its main turn now that child is active
    finishParent();
    await new Promise((r) => setTimeout(r, 20));

    // Verify parent is now in 'waiting_children' state
    const parentTask = runtime.getTask(parentReceipt.agentId);
    expect(parentTask?.status).toBe('waiting_children');

    // Child is running
    const childTask = runtime.getTask(childReceipt.agentId);
    expect(childTask?.status).toBe('running');

    // Finish child
    finishChild();
    await new Promise((r) => setTimeout(r, 30));

    // Verify both parent and child reached 'completed'
    expect(runtime.getTask(childReceipt.agentId)?.status).toBe('completed');
    expect(runtime.getTask(parentReceipt.agentId)?.status).toBe('completed');

    await runtime.close();
  });

  it('cascades cancellation to all descendants when parent is cancelled', async () => {
    const runtime = new AgentRuntime({
      runner: async (_task, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve());
        });
        return { summary: 'Aborted' };
      },
    });

    const rootCtx = createDefaultContext({ rootTaskId: 'tree-cancel' });

    // Spawn Parent
    const parentReceipt = await runtime.prepareSpawn(rootCtx, {
      description: 'Parent Task',
      prompt: 'Run',
      role: 'planner',
    });
    await runtime.activateSpawn(parentReceipt.agentId);

    // Spawn Child 1
    const child1Ctx = createDefaultContext({
      rootTaskId: 'tree-cancel',
      agentId: parentReceipt.agentId,
      depth: 1,
    });
    const child1Receipt = await runtime.prepareSpawn(child1Ctx, {
      description: 'Child 1',
      prompt: 'Run C1',
      role: 'explore',
    });
    await runtime.activateSpawn(child1Receipt.agentId);

    // Spawn Grandchild 1.1
    const grandchildCtx = createDefaultContext({
      rootTaskId: 'tree-cancel',
      agentId: child1Receipt.agentId,
      depth: 2,
    });
    const grandchildReceipt = await runtime.prepareSpawn(grandchildCtx, {
      description: 'Grandchild 1.1',
      prompt: 'Run GC1',
      role: 'advisor',
    });
    await runtime.activateSpawn(grandchildReceipt.agentId);

    await new Promise((r) => setTimeout(r, 15));

    // Cancel parent
    await runtime.cancelTask(parentReceipt.agentId, 'User requested stop');

    // Verify parent and all descendants are cancelled
    expect(runtime.getTask(parentReceipt.agentId)?.status).toBe('cancelled');
    expect(runtime.getTask(child1Receipt.agentId)?.status).toBe('cancelled');
    expect(runtime.getTask(grandchildReceipt.agentId)?.status).toBe('cancelled');

    await runtime.close();
  });

  it('lists tasks and waits with wait_agent tool without killing pending tasks on timeout', async () => {
    let finishFast: () => void = () => {};

    const runtime = new AgentRuntime({
      runner: async (task, signal) => {
        if (task.description === 'Fast Task') {
          await new Promise<void>((r) => {
            finishFast = r;
          });
          return { summary: 'Fast done' };
        }
        // Slow task stays running until abort signal is received
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve());
        });
        return { summary: 'Slow done' };
      },
    });

    const ctx = createDefaultContext({ rootTaskId: 'tree-tools' });
    const fast = await runtime.prepareSpawn(ctx, {
      description: 'Fast Task',
      prompt: 'p',
      role: 'explore',
    });
    const slow = await runtime.prepareSpawn(ctx, {
      description: 'Slow Task',
      prompt: 'p',
      role: 'explore',
    });
    await runtime.activateSpawn(fast.agentId);
    await runtime.activateSpawn(slow.agentId);

    // list_agents
    const listTool = createListAgentsTool(runtime);
    const listResult = (await listTool.execute(
      {},
      { rootDir: directory, rootTaskId: 'tree-tools' },
    )) as {
      count: number;
      agents: AgentTaskRecord[];
    };
    expect(listResult.count).toBe(2);

    // Resolve fast task
    finishFast();
    await new Promise((r) => setTimeout(r, 20));

    // wait_agent with small timeout (100ms)
    const waitTool = createWaitAgentTool(runtime);
    const waitResult = (await waitTool.execute(
      { agentIds: [fast.agentId, slow.agentId], timeoutMs: 100 },
      { rootDir: directory, rootTaskId: 'tree-tools' },
    )) as { completed: string[]; pending: string[]; allCompleted: boolean };

    expect(waitResult.completed).toContain(fast.agentId);
    expect(waitResult.pending).toContain(slow.agentId);
    expect(waitResult.allCompleted).toBe(false);

    // Slow task must still be running (not killed by wait timeout)
    expect(runtime.getTask(slow.agentId)?.status).toBe('running');

    // cancel_agent
    const cancelTool = createCancelAgentTool(runtime);
    await cancelTool.execute(
      { agentId: slow.agentId, reason: 'stop slow' },
      { rootDir: directory, rootTaskId: 'tree-tools' },
    );
    expect(runtime.getTask(slow.agentId)?.status).toBe('cancelled');

    await runtime.close();
  });

  it('releases slot exactly once when cancelled while running, preventing double slot release', async () => {
    let abortReceived = false;
    const runtime = new AgentRuntime({
      runner: async (_record, signal) => {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => {
            abortReceived = true;
            resolve();
          });
        });
        return { summary: 'finished' };
      },
    });

    const rootTaskId = 'root-tree-test';
    const ctx = createDefaultContext({ rootTaskId });
    const receipt = await runtime.prepareSpawn(ctx, {
      description: 'cancel test task',
      prompt: 'do something',
      role: 'explore',
    });

    await runtime.activateSpawn(receipt.agentId);
    await new Promise((r) => setTimeout(r, 20));
    expect(runtime.getTask(receipt.agentId)?.status).toBe('running');

    // 取消任务
    await runtime.cancelTask(receipt.agentId, 'testing single slot release');
    expect(runtime.getTask(receipt.agentId)?.status).toBe('cancelled');

    // 等待微任务与 runner finally 充分结算
    await new Promise((r) => setTimeout(r, 30));
    expect(abortReceived).toBe(true);

    // 此时该树上的活动计数必须精准为 0；连续派生 4 个任务（满额 MAX_ACTIVE_TASKS_PER_TREE）均应成功
    const spawned: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await runtime.prepareSpawn(createDefaultContext({ rootTaskId }), {
        description: `sub ${i}`,
        prompt: `prompt ${i}`,
        role: 'explore',
      });
      spawned.push(r.agentId);
    }
    expect(spawned).toHaveLength(4);

    // 第 5 个必须被拒绝（AGENT_CAPACITY_EXCEEDED）
    await expect(
      runtime.prepareSpawn(createDefaultContext({ rootTaskId }), {
        description: 'sub overflow',
        prompt: 'prompt overflow',
        role: 'explore',
      }),
    ).rejects.toThrow(KapibalaError);

    await runtime.close();
  });

  it('rejects worktree isolation and invalid modelOverride before acceptance (N7)', async () => {
    const runtime = new AgentRuntime({
      validateModelOverride: (id) => id === 'valid-model-1',
    });
    const ctx = createDefaultContext();

    // Reject worktree isolation
    await expect(
      runtime.prepareSpawn(ctx, {
        description: 'worktree task',
        prompt: 'test',
        role: 'implement',
        isolation: 'worktree',
      }),
    ).rejects.toThrow(/Worktree isolation is not currently supported/);

    // Reject unrecognized modelOverride
    await expect(
      runtime.prepareSpawn(ctx, {
        description: 'bad model task',
        prompt: 'test',
        role: 'implement',
        modelOverride: 'nonexistent-model',
      }),
    ).rejects.toThrow(/Invalid model override/);

    // Accept recognized modelOverride
    const receipt = await runtime.prepareSpawn(ctx, {
      description: 'good model task',
      prompt: 'test',
      role: 'implement',
      modelOverride: 'valid-model-1',
    });
    expect(receipt.status).toBe('accepted');
    await runtime.close();
  });

  it('enforces rootTaskId requirement and hierarchy bounds in agent tools (R06)', async () => {
    const runtime = new AgentRuntime();
    const ctx = createDefaultContext({ rootTaskId: 'tree-guard-root' });
    const receipt = await runtime.prepareSpawn(ctx, {
      description: 'child task',
      prompt: 'test',
      role: 'explore',
    });

    const listTool = createListAgentsTool(runtime);
    const waitTool = createWaitAgentTool(runtime);
    const cancelTool = createCancelAgentTool(runtime);

    // Missing rootTaskId in context should throw PERMISSION_DENIED
    await expect(listTool.execute({}, { rootDir: directory })).rejects.toThrow(
      /Subagent listing requires an authorized rootTaskId/,
    );
    await expect(
      waitTool.execute({ agentIds: [receipt.agentId] }, { rootDir: directory }),
    ).rejects.toThrow(/Subagent wait requires an authorized rootTaskId/);
    await expect(
      cancelTool.execute({ agentId: receipt.agentId }, { rootDir: directory }),
    ).rejects.toThrow(/Subagent cancellation requires an authorized rootTaskId/);

    // Subagent attempting to wait or cancel an ancestor/peer outside its subtree is rejected
    await expect(
      waitTool.execute(
        { agentIds: [receipt.agentId] },
        { rootDir: directory, rootTaskId: 'tree-guard-root', agentId: 'peer-subagent-99' },
      ),
    ).rejects.toThrow(/Cannot wait task/);

    await expect(
      cancelTool.execute(
        { agentId: receipt.agentId },
        { rootDir: directory, rootTaskId: 'tree-guard-root', agentId: 'peer-subagent-99' },
      ),
    ).rejects.toThrow(/Cannot cancel task/);

    await runtime.close();
  });

  it('intersects parent policy and removes disallowed capabilities like write/exec for explore (N5)', async () => {
    const runtime = new AgentRuntime();
    const parentPolicy = {
      mode: 'Approval' as const,
      rules: [],
      availableTools: [
        { name: 'read_file', metadata: { permissions: ['fs:read' as const] } },
        { name: 'write_file', metadata: { permissions: ['fs:write' as const] } },
        { name: 'run_command', metadata: { permissions: ['exec' as const] } },
      ],
      workspaceRoot: directory,
      executionCwd: directory,
      currentDepth: 0,
    };

    const ctx = createDefaultContext({ parentPolicy });
    const receipt = await runtime.prepareSpawn(ctx, {
      description: 'explore safety test',
      prompt: 'test',
      role: 'explore',
      allowedTools: ['read_file', 'write_file'],
    });

    const task = runtime.getTask(receipt.agentId);
    expect(task).toBeDefined();
    const effective = task?.effectivePolicy as { allowedTools?: readonly string[] };
    expect(effective.allowedTools).toContain('read_file');
    // write_file must be filtered out for explore role because explore disallows fs:write
    expect(effective.allowedTools).not.toContain('write_file');

    await runtime.close();
  });
});
