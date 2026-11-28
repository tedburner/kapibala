import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type ApprovalRequest,
  SessionApprovalCache,
  type SubagentApprovalOrigin,
} from '../src/capabilities/security/approval.js';
import { WorkspaceLeaseCoordinator } from '../src/capabilities/security/lease.js';
import { CrossProjectSessionCatalog } from '../src/context/catalog.js';
import { SessionManager } from '../src/context/session-manager.js';
import { AgentSession } from '../src/context/session/index.js';
import { computeProjectKey } from '../src/context/workspace.js';
import { assembleCanonicalToolResults } from '../src/models/index.js';
import {
  AgentRuntime,
  type AgentTaskStatus,
  type SpawnContext,
  type SubagentWorktreeProvider,
} from '../src/runtime/agent/index.js';
import type { SessionWorktreeBinding } from '../src/types/index.js';

describe('Subagent approval origin, timeout pause, and worktree provider hook', () => {
  let directory: string;
  let homeDirectory: string;

  beforeEach(() => {
    directory = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-subagent-wt-')));
    homeDirectory = path.join(directory, 'home');
    fs.mkdirSync(homeDirectory, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  const makeContext = (overrides?: Partial<SpawnContext>): SpawnContext => ({
    leaseCoordinator: new WorkspaceLeaseCoordinator(),
    sessionId: 'parent-session-1',
    branchId: 'main',
    runId: 'run-1',
    toolCallId: 'call-1',
    depth: 0,
    workspaceRoot: directory,
    executionCwd: directory,
    ...overrides,
  });

  it('carries SubagentApprovalOrigin on ApprovalRequest without fragmenting SessionApprovalCache keys', () => {
    const originA: SubagentApprovalOrigin = {
      agentId: 'agent-leaf-b',
      role: 'implement',
      description: 'Update config',
      childSessionId: 'child-ses-b',
      parentSessionId: 'parent-ses-root',
    };
    const originB: SubagentApprovalOrigin = {
      agentId: 'agent-sibling-c',
      role: 'implement',
      description: 'Sibling task',
      parentSessionId: 'parent-ses-root',
    };
    const reqA: ApprovalRequest = {
      toolName: 'write_file',
      capabilities: ['fs:write'],
      input: { path: 'src/a.ts', content: '1' },
      rootDir: directory,
      sessionAllowed: true,
      subagentOrigin: originA,
    };
    const reqB: ApprovalRequest = {
      ...reqA,
      subagentOrigin: originB,
    };

    const cache = new SessionApprovalCache();
    cache.set(reqA, 'allow');
    expect(reqA.subagentOrigin).toEqual(originA);
    expect(cache.get(reqB)).toBe('allow');
  });

  it('freezes runTask wall-clock timeout across concurrent approvals and re-arms remaining budget on resume', async () => {
    let approval1Resume!: () => void;
    let approval2Resume!: () => void;
    let postApprovalGate!: () => void;

    const runtime = new AgentRuntime({
      runner: async (_record, _signal, context) => {
        const resume1 = context.pauseTimeout();
        const resume2 = context.pauseTimeout();
        await Promise.all([
          new Promise<void>((resolve) => {
            approval1Resume = () => {
              resume1();
              // Idempotent: calling the same token twice must not double-decrement pausedCount
              resume1();
              resolve();
            };
          }),
          new Promise<void>((resolve) => {
            approval2Resume = () => {
              resume2();
              resolve();
            };
          }),
        ]);
        await new Promise<void>((resolve) => {
          postApprovalGate = resolve;
        });
        return { summary: 'Approved and completed' };
      },
    });

    const receipt = await runtime.prepareSpawn(makeContext(), {
      description: 'Task needing approval',
      prompt: 'Edit file',
      role: 'implement',
      limits: { timeoutMs: 80 },
    });
    await runtime.activateSpawn(receipt.agentId);

    // Wait 120ms (> 80ms timeout!) while both approvals are paused — task MUST still be running!
    await new Promise((r) => setTimeout(r, 120));
    expect(runtime.getTask(receipt.agentId)?.status).toBe('running');

    // Release first approval only (pausedCount drops 2 -> 1, still paused!)
    approval1Resume();
    await new Promise((r) => setTimeout(r, 90));
    expect(runtime.getTask(receipt.agentId)?.status).toBe('running');

    // Release second approval (pausedCount drops 1 -> 0, timer re-arms) and complete quickly
    approval2Resume();
    await new Promise((r) => setTimeout(r, 10));
    postApprovalGate();
    await runtime.waitAgents([receipt.agentId], 1_000);
    expect(runtime.getTask(receipt.agentId)?.status).toBe('completed');

    // Verify re-armed timeout still fires if task hangs AFTER approval resumes
    const hangingRuntime = new AgentRuntime({
      runner: async (_record, signal, context) => {
        const resume = context.pauseTimeout();
        await new Promise((r) => setTimeout(r, 100));
        resume();
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return { summary: 'late' };
      },
    });
    const hangReceipt = await hangingRuntime.prepareSpawn(makeContext(), {
      description: 'Hangs after approval',
      prompt: 'Run',
      role: 'implement',
      limits: { timeoutMs: 60 },
    });
    await hangingRuntime.activateSpawn(hangReceipt.agentId);
    await hangingRuntime.waitAgents([hangReceipt.agentId], 1_000);
    expect(hangingRuntime.getTask(hangReceipt.agentId)?.status).toBe('failed');
    expect(hangingRuntime.getTask(hangReceipt.agentId)?.error).toMatch(/timeout/i);

    await runtime.close();
    await hangingRuntime.close();
  });

  it('allocates and releases worktree via SubagentWorktreeProvider and persists SessionWorktreeBinding in header/sidecars', async () => {
    const worktreeRoot = path.join(directory, 'wt-a3f9');
    const subDir = path.join(directory, 'packages', 'sub');
    const worktreeSubDir = path.join(worktreeRoot, 'packages', 'sub');
    fs.mkdirSync(subDir, { recursive: true });
    fs.mkdirSync(worktreeSubDir, { recursive: true });

    const binding: SessionWorktreeBinding = {
      id: 'wt-a3f9',
      projectRoot: directory,
      worktreePath: worktreeRoot,
      branch: 'kpbl/fix-auth-a3f9',
      baseRef: 'main',
      baseCommit: '0123456789abcdef',
      createdAt: 1764200000000,
    };

    const allocations: Array<Record<string, unknown>> = [];
    const releases: Array<{
      binding: SessionWorktreeBinding;
      mode: string;
      status: AgentTaskStatus;
    }> = [];

    const worktreeProvider: SubagentWorktreeProvider = {
      async allocate(input) {
        allocations.push(input);
        return {
          binding,
          workspaceRoot: worktreeRoot,
          cwd: worktreeSubDir,
        };
      },
      async release(input) {
        releases.push(input);
      },
    };

    let observedWorkspaceRoot = '';
    let observedCwd = '';
    let observedBinding: SessionWorktreeBinding | undefined;

    const runtime = new AgentRuntime({
      worktreeProvider,
      runner: async (task) => {
        observedWorkspaceRoot = task.workspaceRoot;
        observedCwd = task.executionCwd;
        observedBinding = task.worktree;
        return { summary: 'Isolated worktree run done' };
      },
    });

    const receipt = await runtime.prepareSpawn(makeContext(), {
      description: 'Fix auth in worktree',
      prompt: 'Implement fix',
      role: 'implement',
      isolation: 'worktree',
      cwd: 'packages/sub',
    });
    expect(receipt.status).toBe('accepted');
    await runtime.activateSpawn(receipt.agentId);
    await runtime.waitAgents([receipt.agentId], 2_000);

    expect(allocations).toHaveLength(1);
    expect(allocations[0]).toMatchObject({
      agentId: receipt.agentId,
      projectRoot: directory,
      relativeCwd: path.join('packages', 'sub'),
      description: 'Fix auth in worktree',
      mode: 'ephemeral',
    });
    expect(observedWorkspaceRoot).toBe(worktreeRoot);
    expect(observedCwd).toBe(worktreeSubDir);
    expect(observedBinding).toEqual(binding);
    expect(releases).toEqual([
      {
        binding,
        mode: 'ephemeral',
        status: 'completed',
      },
    ]);
    await runtime.close();

    // Verify SessionHeader + SessionManager sidecar + CrossProjectSessionCatalog reconstruction
    const manager = new SessionManager({
      workspaceRoot: directory,
      homeDirectory,
    });
    const managed = await manager.create({ worktree: binding });
    expect(managed.header.worktree).toEqual(binding);
    expect(managed.metadata?.worktree).toEqual(binding);
    expect(managed.branchDrift).toBeUndefined();
    const metaPath = managed.metadataPath;
    const convId = managed.conversationId;
    await managed.release();

    const reopened = await manager.open(convId);
    expect(reopened.branchDrift).toBeUndefined();
    await reopened.release();

    // Delete sidecar and verify SessionManager rebuilds worktree from header
    fs.unlinkSync(metaPath);
    const listed = await manager.list(1);
    expect(listed.items.find((item) => item.conversationId === convId)?.worktree).toEqual(binding);

    // Delete sidecar again and verify CrossProjectSessionCatalog inline scan also rebuilds worktree
    fs.unlinkSync(metaPath);
    const catalog = new CrossProjectSessionCatalog({ homeDirectory });
    const scanned = await catalog.scanSessions({ projectRoot: directory });
    expect(scanned.find((item) => item.conversationId === convId)?.worktree).toEqual(binding);
    await manager.close();
  });

  it('freezes ancestor subagent timeout across depth-2 root -> A -> B when B pauses for human approval', async () => {
    let agentBId = '';
    const sharedCoordinator = new WorkspaceLeaseCoordinator();

    const runtime = new AgentRuntime({
      runner: async (record, _signal, context) => {
        if (record.origin.depth === 1) {
          const childReceipt = await runtime.prepareSpawn(
            makeContext({
              leaseCoordinator: context.leaseCoordinator,
              rootTaskId: record.origin.rootTaskId,
              sessionId: 'session-agent-a',
              depth: 1,
              agentId: record.agentId,
              generation: record.origin.generation,
            }),
            {
              description: 'Leaf task B needing human approval',
              prompt: 'Apply change with approval',
              role: 'implement',
              limits: { timeoutMs: 100 },
            },
          );
          agentBId = childReceipt.agentId;
          await runtime.activateSpawn(childReceipt.agentId);
          return { summary: 'Agent A spawned B and is waiting for children' };
        }

        // Depth-2 child B pauses approval for 200ms (> 100ms timeout of both A and B)
        const resumeApproval = context.pauseTimeout();
        await new Promise((resolve) => setTimeout(resolve, 200));
        resumeApproval();
        return { summary: 'Agent B completed after approval' };
      },
    });

    const receiptA = await runtime.prepareSpawn(
      makeContext({ leaseCoordinator: sharedCoordinator }),
      {
        description: 'Parent subagent A',
        prompt: 'Delegate to B',
        role: 'implement',
        limits: { timeoutMs: 100 },
      },
    );
    await runtime.activateSpawn(receiptA.agentId);

    await runtime.waitAgents([receiptA.agentId], 2_000);
    expect(agentBId).not.toBe('');
    expect(runtime.getTask(agentBId)?.status).toBe('completed');
    expect(runtime.getTask(receiptA.agentId)?.status).toBe('completed');

    await runtime.close();
  });

  it('aborts cleanly without invoking runner and releases worktree when cancelled while worktreeProvider.allocate is in flight', async () => {
    const worktreeRoot = path.join(directory, 'wt-cancel-inflight');
    fs.mkdirSync(worktreeRoot, { recursive: true });

    const binding: SessionWorktreeBinding = {
      id: 'wt-cancel',
      projectRoot: directory,
      worktreePath: worktreeRoot,
      branch: 'kpbl/cancel-inflight',
      baseRef: 'main',
      baseCommit: 'abcdef0123456789',
      createdAt: 1764200001000,
    };

    let notifyAllocateEntered!: () => void;
    const allocateEntered = new Promise<void>((resolve) => {
      notifyAllocateEntered = resolve;
    });
    let finishAllocate!: () => void;
    const releases: Array<{
      binding: SessionWorktreeBinding;
      mode: string;
      status: AgentTaskStatus;
    }> = [];
    let runnerCalled = false;

    const worktreeProvider: SubagentWorktreeProvider = {
      async allocate() {
        notifyAllocateEntered();
        await new Promise<void>((resolve) => {
          finishAllocate = resolve;
        });
        return {
          binding,
          workspaceRoot: worktreeRoot,
          cwd: worktreeRoot,
        };
      },
      async release(input) {
        releases.push(input);
      },
    };

    const runtime = new AgentRuntime({
      worktreeProvider,
      runner: async () => {
        runnerCalled = true;
        return { summary: 'Should never run', sessionId: 'detached-ses-1' };
      },
    });

    const receipt = await runtime.prepareSpawn(makeContext(), {
      description: 'Detached worktree cancelled during allocate',
      prompt: 'Do work',
      role: 'implement',
      mode: 'detached',
      isolation: 'worktree',
    });
    await runtime.activateSpawn(receipt.agentId);
    await allocateEntered;

    const cancelPromise = runtime.cancelTask(receipt.agentId, 'Cancelled during worktree setup');
    finishAllocate();
    await cancelPromise;

    expect(runnerCalled).toBe(false);
    expect(runtime.getTask(receipt.agentId)?.status).toBe('cancelled');
    expect(releases).toEqual([
      {
        binding,
        mode: 'detached',
        status: 'cancelled',
      },
    ]);

    await runtime.close();
  });

  it('loads AGENTS.md from external linked worktree in AgentSession while keeping projectKey anchored to main projectRoot', async () => {
    const externalWorktreeRoot = path.join(homeDirectory, 'worktrees', 'wt-linked');
    const externalWorktreeSubdir = path.join(externalWorktreeRoot, 'packages', 'app');
    fs.mkdirSync(externalWorktreeSubdir, { recursive: true });
    const worktreeAgentsMd = path.join(externalWorktreeRoot, 'AGENTS.md');
    fs.writeFileSync(worktreeAgentsMd, '# Worktree Instructions\nFollow worktree isolation.\n');

    const session = new AgentSession({
      projectRoot: directory,
      workspaceRoot: externalWorktreeRoot,
      executionCwd: externalWorktreeSubdir,
      userInstructionsPath: path.join(homeDirectory, 'nonexistent-user-AGENTS.md'),
      defaultProfile: {
        id: 'wt-session-model',
        name: 'WT Model',
        provider: 'openai-compatible',
        baseURL: 'https://example.test/v1',
        apiKeyEnv: 'NONE',
        modelName: 'wt-model',
        contextWindow: 32_000,
      },
      defaultProvider: {
        name: 'wt-mock',
        assembleToolResults: assembleCanonicalToolResults,
        async *create() {
          yield { type: 'text_delta', text: 'Worktree turn ok' };
          yield { type: 'message_stop', finishReason: 'stop' };
        },
      },
    });

    await session.init();
    expect(session.projectKey).toBe(computeProjectKey(directory));
    expect(session.getInstructionSources()).toContain(fs.realpathSync.native(worktreeAgentsMd));

    for await (const _ of session.run('Verify refresh inside runOperation')) {
      // consume
    }
    expect(session.getHistory()).toHaveLength(2);
    await session.destroy();
  });
});
