import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { WorkspaceLeaseCoordinator } from '../src/capabilities/security/lease.js';
import {
  DEFAULT_MAX_SUBAGENT_DEPTH,
  type ParentPolicySnapshot,
  deriveChildPolicy,
} from '../src/capabilities/security/subagent-policy.js';
import type { Tool } from '../src/capabilities/tools/index.js';
import { AgentRuntime } from '../src/runtime/agent/runtime.js';
import { MAX_ACTIVE_TASKS_PER_TREE, MAX_TOTAL_TASKS_PER_TREE } from '../src/runtime/agent/types.js';

/**
 * 任务树用的工作区身份必须是当前平台真实的绝对路径：写死盘符（如 `F:/Project`）在 POSIX runner 上
 * 不是绝对路径，会先在 toNativePhysicalPath 处以 CONFIG_INVALID 失败，测不到容量与深度熔断本身。
 */
const treeWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-agent-tree-'));

afterAll(() => {
  fs.rmSync(treeWorkspaceRoot, { recursive: true, force: true });
});

describe('Agent 任务树容量槽位与深度熔断', () => {
  it('原子容量槽位与累计上限熔断：满 4 槽拒绝并发，满 16 累计永久拒绝', async () => {
    const finishCallbacks: Array<() => void> = [];
    const runtime = new AgentRuntime({
      runner: () =>
        new Promise<{ summary: string }>((resolve) => {
          finishCallbacks.push(() => resolve({ summary: 'done' }));
        }),
    });
    const preparedIds: string[] = [];

    const baseContext = {
      leaseCoordinator: new WorkspaceLeaseCoordinator(),
      sessionId: 'root-session',
      rootTaskId: 'tree-1',
      branchId: 'main',
      runId: 'run-1',
      toolCallId: 'call_root',
      depth: 0,
      workspaceRoot: treeWorkspaceRoot,
      executionCwd: treeWorkspaceRoot,
    };

    // 1. 连续预留 4 个活动槽位（达到单树上限）
    for (let i = 0; i < MAX_ACTIVE_TASKS_PER_TREE; i++) {
      const receipt = await runtime.prepareSpawn(
        { ...baseContext, toolCallId: `call_${i}` },
        {
          role: 'explore',
          description: `Task ${i}`,
          prompt: `Do ${i}`,
        },
      );
      preparedIds.push(receipt.agentId);
      await runtime.activateSpawn(receipt.agentId);
    }

    // 2. 尝试抢第 5 个活动槽位，必须被立即拒绝
    await expect(
      runtime.prepareSpawn(
        { ...baseContext, toolCallId: 'call_overflow' },
        {
          role: 'explore',
          description: 'Overflow task',
          prompt: 'Do overflow',
        },
      ),
    ).rejects.toThrowError(/capacity exceeded/i);

    // 3. 终结其中一个任务，释放活动槽位
    const finishFirst = finishCallbacks.shift()!;
    finishFirst();
    // 等待微任务处理完成
    await new Promise((r) => setTimeout(r, 10));

    // 4. 现在可以成功预留第 5 个
    const receipt5 = await runtime.prepareSpawn(
      { ...baseContext, toolCallId: 'call_5' },
      {
        role: 'explore',
        description: 'Task 5',
        prompt: 'Do 5',
      },
    );
    expect(receipt5.agentId).toBeDefined();
    await runtime.activateSpawn(receipt5.agentId);

    // 5. 释放当前所有运行中的任务，并模拟累计创建达到 16 个上限
    while (finishCallbacks.length > 0) {
      finishCallbacks.shift()!();
    }
    await new Promise((r) => setTimeout(r, 10));

    // 已经有了 5 个累计，再制造 11 个并完成
    for (let i = 5; i < MAX_TOTAL_TASKS_PER_TREE; i++) {
      const it = await runtime.prepareSpawn(
        { ...baseContext, toolCallId: `call_cum_${i}` },
        {
          role: 'explore',
          description: `Cum Task ${i}`,
          prompt: `Do cum ${i}`,
        },
      );
      await runtime.activateSpawn(it.agentId);
      // 立即结束该任务
      const cb = finishCallbacks.pop()!;
      cb();
      await new Promise((r) => setTimeout(r, 5));
    }

    // 此时虽然活动槽位为 0，但累计已达 16，必须永久拒绝
    await expect(
      runtime.prepareSpawn(
        { ...baseContext, toolCallId: 'call_cum_exceeded' },
        {
          role: 'explore',
          description: 'Exceeded cum task',
          prompt: 'Do fail',
        },
      ),
    ).rejects.toThrowError(/capacity exceeded/i);
  });

  it('深度熔断：达到最大深度自动剔除 spawn_agent 工具并禁止派生', () => {
    const mockTools: Tool[] = [
      {
        name: 'read_file',
        description: 'Read file',
        parameters: { type: 'object', properties: {} },
        metadata: { permissions: ['fs:read'] },
        execute: async () => ({ success: true }),
      },
      {
        name: 'spawn_agent',
        description: 'Spawn child',
        parameters: { type: 'object', properties: {} },
        metadata: { permissions: ['agent:spawn'] },
        execute: async () => ({ success: true }),
      },
    ];

    const baseSnapshot: ParentPolicySnapshot = {
      mode: 'Auto',
      rules: [],
      availableTools: mockTools,
      workspaceRoot: treeWorkspaceRoot,
      executionCwd: treeWorkspaceRoot,
      currentDepth: 0,
      maxDepth: DEFAULT_MAX_SUBAGENT_DEPTH, // 3
    };

    // 深度 0 -> 派生深度 1：custom 角色允许 spawn_agent
    const policy1 = deriveChildPolicy(baseSnapshot, {
      role: 'custom',
      allowedTools: ['read_file', 'spawn_agent'],
    });
    expect(policy1.depth).toBe(1);
    expect(policy1.canSpawnSubagent).toBe(true);
    expect(policy1.allowedTools).toContain('spawn_agent');

    // 深度 2 -> 派生深度 3（已达到 maxDepth 3）：强制剔除 spawn_agent
    const policy3 = deriveChildPolicy(
      { ...baseSnapshot, currentDepth: 2 },
      {
        role: 'custom',
        allowedTools: ['read_file', 'spawn_agent'],
      },
    );
    expect(policy3.depth).toBe(3);
    expect(policy3.canSpawnSubagent).toBe(false);
    expect(policy3.allowedTools).not.toContain('spawn_agent');
    expect(policy3.allowedCapabilities).not.toContain('agent:spawn');
  });
});
