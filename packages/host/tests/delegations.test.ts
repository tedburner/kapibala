import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type AgentTaskRecord,
  SessionManager,
  WorkspaceLeaseCoordinator,
} from '@kiturone/kapibala';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_RETAINED_DELEGATIONS,
  countRetainedDelegations,
  listDelegationSessions,
  readDelegationRequestEntries,
} from '../src/host/delegations.js';
import { createCliSubagentRunner } from '../src/host/subagent-runner.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

function createManager(): { manager: SessionManager; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-delegations-'));
  directories.push(root);
  const manager = new SessionManager({
    workspaceRoot: root,
    cwd: root,
    homeDirectory: root,
    projectRootMode: 'exact',
  });
  return { manager, root };
}

/** 直接构造任务记录，只提供保留预算检查所需字段。 */
function createTask(overrides: Partial<AgentTaskRecord> = {}): AgentTaskRecord {
  return {
    agentId: 'agent-limit',
    origin: {
      rootTaskId: 'tree',
      parentSessionId: 'parent',
      originBranchId: 'main',
      originRunId: 'run',
      spawnToolCallId: 'spawn',
      generation: 1,
      depth: 1,
    },
    role: 'explore',
    description: 'Retention probe',
    prompt: 'Probe',
    status: 'preparing',
    createdAt: Date.now(),
    childAgentIds: new Set(),
    workspaceRoot: '/tmp',
    executionCwd: '/tmp',
    limits: { maxSteps: 1, timeoutMs: 1_000 },
    mode: 'detached',
    runGeneration: 1,
    ...overrides,
  };
}

describe('delegation host helpers', () => {
  it('只列出委派会话并统计保留预算', async () => {
    const { manager } = createManager();
    await manager.create();
    const delegation = await manager.create({
      delegation: {
        kind: 'delegation',
        parentSessionId: 'parent-1',
        parentTitle: 'Parent',
        taskName: 'Task',
        createdAt: Date.now(),
      },
    });
    await delegation.store.appendRecord('title', { title: 'Task · Parent' });
    await delegation.release();

    const sessions = await listDelegationSessions(manager);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      sessionId: delegation.conversationId,
      taskName: 'Task',
      parentSessionId: 'parent-1',
      parentTitle: 'Parent',
    });
    expect(await countRetainedDelegations(manager)).toBe(1);
  });

  it('从委派头重建 requestId 幂等条目，缺少快照的会话被跳过', async () => {
    const { manager } = createManager();
    const withReceipt = await manager.create({
      delegation: {
        kind: 'delegation',
        parentSessionId: 'parent-1',
        taskName: 'Task',
        createdAt: Date.now(),
        requestId: 'request-1',
        requestSignature: 'signature-1',
        requestReceipt: {
          agentId: 'agent-1',
          status: 'accepted',
          role: 'explore',
          description: 'Task',
          depth: 1,
          rootTaskId: 'tree',
          modelRole: 'inherit',
          workspaceRoot: '/tmp',
          executionCwd: '/tmp',
        },
      },
    });
    await withReceipt.release();
    const withoutReceipt = await manager.create({
      delegation: {
        kind: 'delegation',
        parentSessionId: 'parent-1',
        taskName: 'No receipt',
        createdAt: Date.now(),
        requestId: 'request-2',
        requestSignature: 'signature-2',
      },
    });
    await withoutReceipt.release();

    const entries = readDelegationRequestEntries(manager);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      requestId: 'request-1',
      signature: 'signature-1',
      receipt: {
        agentId: 'agent-1',
        rootTaskId: 'tree',
        // 回执快照未携带 sessionId，重建时以 header.conversationId 补齐。
        sessionId: withReceipt.conversationId,
      },
    });
  });

  it('保留预算达上限时拒绝新建 detached 会话，且不消耗 runner 资源', async () => {
    const { manager } = createManager();
    for (let index = 0; index < MAX_RETAINED_DELEGATIONS; index++) {
      const handle = await manager.create({
        delegation: {
          kind: 'delegation',
          parentSessionId: 'parent',
          taskName: `Task ${index}`,
          createdAt: Date.now(),
        },
      });
      await handle.release();
    }

    const leases = new WorkspaceLeaseCoordinator();
    const runner = createCliSubagentRunner({
      manager,
      models: {} as never,
      settings: {} as never,
      leaseCoordinator: leases,
    });
    await expect(
      runner(
        createTask({ workspaceRoot: manager.project.projectRoot }),
        new AbortController().signal,
        { leaseCoordinator: leases },
      ),
    ).rejects.toMatchObject({ code: 'DELEGATION_LIMIT_EXCEEDED' });
  });
});
