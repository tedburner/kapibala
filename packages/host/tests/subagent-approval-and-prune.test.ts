import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentSession,
  type AgentTaskRecord,
  type ApprovalRequest,
  SessionManager,
  WorkspaceLeaseCoordinator,
} from '@kiturone/kapibala';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pruneDelegationSessions } from '../src/host/delegations.js';
import { CliModelBindings } from '../src/host/model-bindings.js';
import type { UserSettings } from '../src/host/settings.js';
import {
  SessionApprovalHub,
  createSubagentApprovalChannel,
} from '../src/host/subagent-approval.js';
import { createCliSubagentRunner } from '../src/host/subagent-runner.js';

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function baseApprovalRequest(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolName: 'write_file',
    capabilities: ['fs:write'],
    input: { path: 'src/index.ts', content: 'export const ok = true;' },
    rootDir: '/repo',
    sessionAllowed: true,
    ...overrides,
  };
}

describe('子代理审批冒泡、同树缓存重判、规则继承与 LIFO 淘汰', () => {
  it('多层嵌套子代理（root -> A -> B）保留最内层 subagentOrigin，并在审批挂起期暂停与恢复超时计时', async () => {
    const receivedRequests: ApprovalRequest[] = [];
    let paused = false;
    let pauseCalls = 0;
    let resumeCalls = 0;
    let resolvePrompt!: (choice: 'allow_once') => void;

    const hub = new SessionApprovalHub({
      requestApproval: (req) => {
        receivedRequests.push(req);
        expect(paused).toBe(true);
        return new Promise((resolve) => {
          resolvePrompt = resolve;
        });
      },
    });

    const channelA = createSubagentApprovalChannel({
      hub,
      origin: {
        agentId: 'agent-A',
        role: 'implement',
        description: '外层子代理 A',
        parentSessionId: 'root-session',
      },
    })!;
    const channelB = createSubagentApprovalChannel({
      parentChannel: channelA,
      origin: {
        agentId: 'agent-B',
        role: 'explore',
        description: '内层子代理 B',
        parentSessionId: 'session-A',
      },
      pauseTimeout: () => {
        pauseCalls++;
        paused = true;
        return () => {
          resumeCalls++;
          paused = false;
        };
      },
    })!;

    const pending = channelB.requestApproval(baseApprovalRequest());
    await vi.waitFor(() => expect(receivedRequests).toHaveLength(1));
    expect(receivedRequests[0]?.subagentOrigin).toEqual({
      agentId: 'agent-B',
      role: 'explore',
      description: '内层子代理 B',
      parentSessionId: 'session-A',
    });
    expect(pauseCalls).toBe(1);
    expect(resumeCalls).toBe(0);

    resolvePrompt('allow_once');
    expect(await pending).toBe('allow_once');
    expect(paused).toBe(false);
    expect(resumeCalls).toBe(1);
  });

  it('SessionApprovalHub 在 allow_session 后立即重判排队中的同指纹兄弟请求，且缩权子代理不污染父树缓存', async () => {
    const upstreamPrompts: Array<{
      req: ApprovalRequest;
      signal?: AbortSignal;
      resolve: (choice: 'allow_session' | 'allow_once') => void;
    }> = [];

    const hub = new SessionApprovalHub({
      requestApproval: (req, signal) =>
        new Promise((resolve) => {
          upstreamPrompts.push({ req, signal, resolve });
        }),
    });

    // 1. 缩权子代理（canWriteTreeCache: false）即使收到 allow_session 也不得写入父树缓存
    const restrictedChannel = createSubagentApprovalChannel({
      hub,
      canWriteTreeCache: false,
      origin: {
        agentId: 'restricted-1',
        role: 'custom',
        description: '受限子代理',
        parentSessionId: 'root',
      },
    })!;
    const restrictedReq = baseApprovalRequest({
      input: { path: 'restricted.txt', content: 'x' },
    });
    const restrictedPending = restrictedChannel.requestApproval(restrictedReq);
    await vi.waitFor(() => expect(upstreamPrompts).toHaveLength(1));
    upstreamPrompts[0]!.resolve('allow_session');
    expect(await restrictedPending).toBe('allow_session');
    expect(hub.cache.get(restrictedReq)).toBeUndefined();

    // 2. 两个正常兄弟子代理并发请求同一目标：第一个选 allow_session 后，第二个在途请求立即免答返回 allow_once 且上游 signal 被 abort
    upstreamPrompts.length = 0;
    const sibling1 = createSubagentApprovalChannel({
      hub,
      origin: {
        agentId: 'sib-1',
        role: 'implement',
        description: '兄弟 1',
        parentSessionId: 'root',
      },
    })!;
    const sibling2 = createSubagentApprovalChannel({
      hub,
      origin: {
        agentId: 'sib-2',
        role: 'implement',
        description: '兄弟 2',
        parentSessionId: 'root',
      },
    })!;

    const sharedTarget = baseApprovalRequest({
      input: { path: 'shared.ts', content: 'same' },
    });
    const p1 = sibling1.requestApproval(sharedTarget);
    const p2 = sibling2.requestApproval(sharedTarget);
    await vi.waitFor(() => expect(upstreamPrompts).toHaveLength(2));

    const secondSignal = upstreamPrompts[1]!.signal!;
    expect(secondSignal.aborted).toBe(false);

    upstreamPrompts[0]!.resolve('allow_session');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe('allow_session');
    expect(r2).toBe('allow_once');
    expect(secondSignal.aborted).toBe(true);

    // 3. 后续兄弟请求（含缩权子代理只读命中）不再触发新的上游弹窗
    const r3 = await restrictedChannel.requestApproval(sharedTarget);
    expect(r3).toBe('allow_once');
    expect(upstreamPrompts).toHaveLength(2);
  });

  it('createCliSubagentRunner 将 effectivePolicy.rules（父会话 permissionRules）透传至子 AgentSession', async () => {
    const home = makeTempDir('kpbl-subagent-rules-home-');
    const root = makeTempDir('kpbl-subagent-rules-ws-');
    const profile = {
      id: 'fixture',
      name: 'fixture',
      provider: 'openai-compatible' as const,
      modelName: 'fixture',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKey: 'fixture-key',
      apiKeyEnv: 'NONE',
      contextWindow: 32_000,
    };
    const settings: UserSettings = { defaultModel: profile.id, profiles: [profile] };
    const manager = new SessionManager({
      workspaceRoot: root,
      homeDirectory: home,
      projectRootMode: 'exact',
    });
    const leases = new WorkspaceLeaseCoordinator();

    let capturedToolNames: string[] = [];
    vi.spyOn(AgentSession.prototype, 'run').mockImplementation(async function* (
      this: AgentSession,
    ) {
      // 被父会话 deny 规则禁用的工具在子会话 getContextSnapshot / 可见工具集中应被过滤或拦截
      capturedToolNames = this.tools.list().map((t) => t.name);
      // 直接校验子会话内部携带了传入的 permissionRules
      const internalRules = (this as unknown as { permissionRules: unknown[] }).permissionRules;
      expect(internalRules).toEqual([
        { tool: 'write_file', action: 'deny' },
        { tool: 'run_command', action: 'ask' },
      ]);
      yield { type: 'turn_start', turn: 1 };
    });

    const runner = createCliSubagentRunner({
      manager,
      models: new CliModelBindings(settings, profile),
      settings,
      homeDirectory: home,
      leaseCoordinator: leases,
    });

    const task: AgentTaskRecord = {
      agentId: 'child-rules',
      origin: {
        rootTaskId: 'tree',
        parentSessionId: 'parent',
        originBranchId: 'main',
        originRunId: 'run',
        spawnToolCallId: 'spawn',
        generation: 1,
        depth: 1,
      },
      role: 'implement',
      description: '验证规则继承',
      prompt: 'test',
      status: 'running',
      createdAt: Date.now(),
      childAgentIds: new Set(),
      workspaceRoot: root,
      executionCwd: root,
      mode: 'ephemeral',
      limits: { maxSteps: 1, timeoutMs: 5_000 },
      effectivePolicy: {
        mode: 'Auto',
        allowedTools: ['read_file', 'write_file'],
        rules: [
          { tool: 'write_file', action: 'deny' },
          { tool: 'run_command', action: 'ask' },
        ],
      },
    };

    try {
      await runner(task, new AbortController().signal, {
        leaseCoordinator: leases,
        pauseTimeout: () => () => {},
      });
      expect(capturedToolNames).toContain('read_file');
    } finally {
      await manager.close();
    }
  });

  it('显式收紧 allowedTools 的父子代理 A 派生未传 allowedTools 的子级 B 时，B 仍禁止回写根会话 TreeApprovalCache', async () => {
    const home = makeTempDir('kpbl-subagent-nested-cache-home-');
    const root = makeTempDir('kpbl-subagent-nested-cache-ws-');
    const profile = {
      id: 'fixture',
      name: 'fixture',
      provider: 'openai-compatible' as const,
      modelName: 'fixture',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKey: 'fixture-key',
      apiKeyEnv: 'NONE',
      contextWindow: 32_000,
    };
    const settings: UserSettings = { defaultModel: profile.id, profiles: [profile] };
    const manager = new SessionManager({
      workspaceRoot: root,
      homeDirectory: home,
      projectRootMode: 'exact',
    });
    const leases = new WorkspaceLeaseCoordinator();
    const hub = new SessionApprovalHub({
      requestApproval: async () => 'allow_session',
    });
    const probeReq = baseApprovalRequest({
      rootDir: root,
      input: { path: 'nested-b.ts', content: 'from-b' },
    });

    vi.spyOn(AgentSession.prototype, 'run').mockImplementation(async function* (
      this: AgentSession,
    ) {
      const ch = (
        this as unknown as {
          approvalChannel?: { requestApproval: (r: ApprovalRequest) => Promise<string> };
        }
      ).approvalChannel;
      if (ch) {
        await ch.requestApproval(probeReq);
      }
      yield { type: 'turn_start', turn: 1 };
    });

    const runner = createCliSubagentRunner({
      manager,
      models: new CliModelBindings(settings, profile),
      settings,
      homeDirectory: home,
      leaseCoordinator: leases,
      approvalHub: hub,
    });

    const taskA: AgentTaskRecord = {
      agentId: 'agent-A-restricted',
      origin: {
        rootTaskId: 'tree-nested',
        parentSessionId: 'root',
        originBranchId: 'main',
        originRunId: 'run-0',
        spawnToolCallId: 'spawn-a',
        generation: 1,
        depth: 1,
      },
      role: 'implement',
      description: '受限子代理 A',
      prompt: 'run A',
      status: 'running',
      createdAt: Date.now(),
      childAgentIds: new Set(['agent-B-nested']),
      workspaceRoot: root,
      executionCwd: root,
      allowedTools: ['read_file', 'write_file', 'spawn_agent'],
      mode: 'ephemeral',
      limits: { maxSteps: 1, timeoutMs: 5_000 },
      effectivePolicy: {
        mode: 'Approval',
        allowedTools: ['read_file', 'write_file', 'spawn_agent'],
        rules: [],
      },
    };

    const taskB: AgentTaskRecord = {
      agentId: 'agent-B-nested',
      origin: {
        rootTaskId: 'tree-nested',
        parentAgentId: 'agent-A-restricted',
        parentSessionId: 'sess-a',
        originBranchId: 'main',
        originRunId: 'run-a',
        spawnToolCallId: 'spawn-b',
        generation: 2,
        depth: 2,
      },
      role: 'implement',
      description: '继承 A 的嵌套子代理 B（自身未传 allowedTools）',
      prompt: 'run B',
      status: 'running',
      createdAt: Date.now(),
      childAgentIds: new Set(),
      workspaceRoot: root,
      executionCwd: root,
      mode: 'ephemeral',
      limits: { maxSteps: 1, timeoutMs: 5_000 },
      effectivePolicy: {
        mode: 'Approval',
        allowedTools: ['read_file', 'write_file', 'spawn_agent'],
        rules: [],
      },
    };

    try {
      await runner(taskA, new AbortController().signal, {
        leaseCoordinator: leases,
        pauseTimeout: () => () => {},
      });
      expect(hub.cache.get(probeReq)).toBeUndefined();

      await runner(taskB, new AbortController().signal, {
        leaseCoordinator: leases,
        pauseTimeout: () => () => {},
      });
      // B 位于缩权祖先 A 之下，即使获得 allow_session 也不得写入根会话共享缓存！
      expect(hub.cache.get(probeReq)).toBeUndefined();
    } finally {
      await manager.close();
    }
  });

  it('pruneDelegationSessions 按最旧活动时间优先清理超期与超额委派会话，同时保护置顶与活跃会话', async () => {
    const root = makeTempDir('kpbl-prune-delegations-');
    const manager = new SessionManager({
      workspaceRoot: root,
      cwd: root,
      homeDirectory: root,
      projectRootMode: 'exact',
    });

    const now = 1_800_000_000_000;
    const eightDaysAgo = now - 8 * 24 * 60 * 60 * 1_000;
    let fakeClock = eightDaysAgo;
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => fakeClock);

    try {
      fakeClock = eightDaysAgo;
      const staleOld = await manager.create({
        delegation: {
          kind: 'delegation',
          parentSessionId: 'p1',
          taskName: '过期任务',
          createdAt: eightDaysAgo,
        },
      });
      await staleOld.store.append({
        id: 'm1',
        role: 'user',
        timestamp: eightDaysAgo,
        content: [{ type: 'text', text: 'old' }],
      });
      await staleOld.release();

      fakeClock = eightDaysAgo + 100;
      const stalePinned = await manager.create({
        delegation: {
          kind: 'delegation',
          parentSessionId: 'p1',
          taskName: '过期但置顶',
          createdAt: eightDaysAgo,
        },
      });
      await stalePinned.store.append({
        id: 'm2',
        role: 'user',
        timestamp: eightDaysAgo,
        content: [{ type: 'text', text: 'pinned' }],
      });
      await stalePinned.store.setPinnedState(true);
      await stalePinned.release();

      fakeClock = eightDaysAgo + 200;
      const activeOld = await manager.create({
        delegation: {
          kind: 'delegation',
          parentSessionId: 'p1',
          taskName: '仍在后台运行',
          createdAt: eightDaysAgo,
        },
      });
      await activeOld.store.append({
        id: 'm3',
        role: 'user',
        timestamp: eightDaysAgo,
        content: [{ type: 'text', text: 'running' }],
      });
      await activeOld.release();

      fakeClock = now - 2_000;
      const recentOlder = await manager.create({
        delegation: {
          kind: 'delegation',
          parentSessionId: 'p1',
          taskName: '近期较早',
          createdAt: now - 2_000,
        },
      });
      await recentOlder.store.append({
        id: 'm4',
        role: 'user',
        timestamp: now - 2_000,
        content: [{ type: 'text', text: 'recent-1' }],
      });
      await recentOlder.release();

      fakeClock = now - 1_000;
      const recentNewer = await manager.create({
        delegation: {
          kind: 'delegation',
          parentSessionId: 'p1',
          taskName: '近期最新',
          createdAt: now - 1_000,
        },
      });
      await recentNewer.store.append({
        id: 'm5',
        role: 'user',
        timestamp: now - 1_000,
        content: [{ type: 'text', text: 'recent-2' }],
      });
      await recentNewer.release();
      nowSpy.mockRestore();

      // maxRetained = 3：先淘汰 >7d 的 staleOld（剩 4 个：stalePinned、activeOld、recentOlder、recentNewer），
      // 再按非置顶/非活跃最旧优先淘汰 recentOlder，最终精确保留 3 个！
      const deleted = await pruneDelegationSessions(manager, {
        now,
        maxRetained: 3,
        activeSessionIds: new Set([activeOld.conversationId]),
      });

      expect(deleted).toEqual([staleOld.conversationId, recentOlder.conversationId]);
    } finally {
      await manager.close();
    }
  });
});
