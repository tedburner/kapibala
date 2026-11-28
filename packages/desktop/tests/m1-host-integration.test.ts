import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type AgentSession, type ApprovalChannel, SessionManager } from '@kiturone/kapibala';
import type { ManagedHostSession, ManagedSessionOptions } from '@kiturone/kapibala-host/host';
import { type PresentationEvent, createPresentation } from '@kiturone/kapibala-host/view-model';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DesktopHost } from '../src/agent-host/desktop-host.js';
import {
  type Notification,
  type Output,
  PresentationEventSchema,
  PresentationStateSchema,
} from '../src/shared/contracts.js';
import { InspectionSchema } from '../src/shared/observations.js';

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function createFakeHandle(
  conversationId: string,
  overrides: Partial<ManagedHostSession> = {},
): ManagedHostSession {
  const state = createPresentation({ conversationId, branchId: 'main', viewEpoch: 1 });
  return {
    conversationId,
    session: {} as AgentSession,
    runSkill: vi.fn(async () => {}),
    runWithReferences: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    isBusy: (): boolean => false,
    configure: async () => {},
    rename: vi.fn(async () => {}),
    setPinned: vi.fn(async () => {}),
    createBranchWithSummary: vi.fn(async (branchId: string) => ({ branchId, summary: '' })),
    forgetDelegation: vi.fn(),
    snapshot: () => state,
    subscribeEvents: (_listener: (event: PresentationEvent) => void) => () => {},
    configuration: () => ({
      profileId: 'deepseek-flash',
      role: 'default' as const,
      mode: 'Approval' as const,
    }),
    status: () => ({ phase: 'idle' as const }),
    inspection: () => ({
      status: {
        phase: 'idle' as const,
        tasks: [
          {
            agentId: 'sub-1',
            sessionId: 'delegated-conv-1',
            description: '检查类型边界',
            role: 'explore',
            status: 'running' as const,
            originBranchId: 'main',
            isOtherBranch: false,
            delivery: 'not-ready' as const,
          },
        ],
      },
      skills: { enabled: true, entries: [], diagnostics: [], omitted: 0, diagnosticsOmitted: 0 },
      mcp: { enabled: false, servers: [], diagnostics: [], omitted: 0, diagnosticsOmitted: 0 },
      tasksOmitted: 0,
      truncated: false,
    }),
    subscribeInspection: () => () => {},
    watches: () => [],
    cancelWatch: vi.fn(async () => {}),
    subscribeWatches: () => () => {},
    evidence: async () => ({
      summary: {
        additions: 0,
        deletions: 0,
        truncatedFiles: 0,
        missingFiles: 0,
        references: 0,
        mcpCalls: 0,
        mcpFailures: 0,
        runningDelegations: 0,
      },
      changes: [],
      references: [],
      mcp: [],
      delegations: [],
    }),
    checkpoints: async () => [],
    checkpointDiff: async () => ({
      available: false,
      files: [],
      additions: 0,
      deletions: 0,
      truncated: false,
    }),
    restoreCheckpoint: async () => ({
      status: 'noop' as const,
      restoredFiles: [],
      deletedFiles: [],
    }),
    worktree: () => undefined,
    ...overrides,
  };
}

describe('Desktop M1 契约与宿主集成（重试状态、子代理空闲期冒泡审批、委派元数据与引用 RPC）', () => {
  it('PresentationStateSchema、PresentationEventSchema 与 InspectionSchema 严格校验 retryStatus、stream_reset 及任务 sessionId', () => {
    const identity = { conversationId: 'conv-1', branchId: 'main', viewEpoch: 1 };
    const retryStatus = {
      step: 1,
      attempt: 1,
      maxRetries: 2,
      delayMs: 1000,
      nextRetryAt: Date.now() + 1000,
      category: 'rate_limit',
      message: '请求受限，1s 后自动重试',
    };
    const parsedState = PresentationStateSchema.parse({
      ...createPresentation(identity),
      retryStatus,
    });
    expect(parsedState.retryStatus).toEqual(retryStatus);

    expect(
      PresentationEventSchema.parse({
        ...identity,
        sequence: 1,
        operationId: 'op-1',
        change: { type: 'stream_reset', messageId: 'prov-1' },
      }).change.type,
    ).toBe('stream_reset');

    expect(
      PresentationEventSchema.parse({
        ...identity,
        sequence: 2,
        operationId: 'op-1',
        change: { type: 'retry_status_changed', retryStatus },
      }).change.type,
    ).toBe('retry_status_changed');

    const inspection = InspectionSchema.parse({
      revision: 1,
      status: {
        phase: 'idle',
        tasks: [
          {
            agentId: 'a-1',
            sessionId: 'child-session-1',
            description: '任务',
            role: 'implement',
            status: 'completed',
            originBranchId: 'main',
            isOtherBranch: false,
            delivery: 'pending',
          },
        ],
      },
      skills: { enabled: true, entries: [], diagnostics: [], omitted: 0, diagnosticsOmitted: 0 },
      mcp: { enabled: false, servers: [], diagnostics: [], omitted: 0, diagnosticsOmitted: 0 },
      tasksOmitted: 0,
      truncated: false,
    });
    expect(inspection.status.tasks?.[0]?.sessionId).toBe('child-session-1');
  });

  it('DesktopHost 支持父轮次已结束（idle）后的后台子代理冒泡审批，并在关闭会话时安全中止挂起审批', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-desktop-m1-app-'));
    homes.push(fs.realpathSync.native(home));
    const events: Notification[] = [];
    let capturedApproval: ApprovalChannel | undefined;

    const handle = createFakeHandle('parent-conv');
    const host = new DesktopHost(
      home,
      async (event) => {
        events.push(event);
      },
      async (opts: ManagedSessionOptions) => {
        capturedApproval = opts.approvalChannel;
        return handle;
      },
    );
    const ws = host.workspaces.openDefault();
    host.workspaces.confirm(ws.id, ws.trustToken, true);

    const opened = (await host.dispatch('session.create', {
      workspaceId: ws.id,
    })) as Output<'session.create'>;

    // 挂载视图订阅以完成一次正常父轮次并回到 idle
    const subId = randomUUID();
    await host.dispatch('presentation.subscribe', {
      workspaceId: ws.id,
      sessionId: opened.sessionId,
      subscriptionId: subId,
    });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'presentation.chunk')).toBe(true));
    const chunk = events.find((e) => e.type === 'presentation.chunk') as Extract<
      Notification,
      { type: 'presentation.chunk' }
    >;
    await host.dispatch('presentation.installed', {
      workspaceId: ws.id,
      sessionId: opened.sessionId,
      subscriptionId: subId,
      snapshotId: chunk.snapshotId,
      sequence: chunk.sequence,
    });

    await host.dispatch('run.start', {
      workspaceId: ws.id,
      sessionId: opened.sessionId,
      operationId: randomUUID(),
      input: '启动后台委派',
    });
    await vi.waitFor(async () => {
      const status = (await host.dispatch('run.status', {
        workspaceId: ws.id,
        sessionId: opened.sessionId,
      })) as Output<'run.status'>;
      expect(status?.phase).toBe('idle');
    });

    // 父轮次处于 idle 时，后台子代理冒泡第一次审批 -> 用户回复 allow_session
    const choicePromise = capturedApproval!.requestApproval({
      toolName: 'run_command',
      capabilities: ['exec'],
      input: { command: 'pnpm test' },
      rootDir: ws.root,
      sessionAllowed: true,
      subagentOrigin: {
        agentId: 'agent-bg-42',
        role: 'implement',
        description: '验证桌面测试',
        childSessionId: 'child-conv-42',
        parentSessionId: 'parent-conv',
      },
    });

    await vi.waitFor(() => expect(events.some((e) => e.type === 'approval.requested')).toBe(true));
    const requested = events.find((e) => e.type === 'approval.requested') as Extract<
      Notification,
      { type: 'approval.requested' }
    >;
    expect(requested.runId).toBe('subagent:agent-bg-42');
    expect(requested.subagentOrigin).toEqual({
      agentId: 'agent-bg-42',
      role: 'implement',
      description: '验证桌面测试',
      childSessionId: 'child-conv-42',
      parentSessionId: 'parent-conv',
    });

    await host.dispatch('approval.reply', {
      workspaceId: ws.id,
      sessionId: opened.sessionId,
      approvalId: requested.approvalId,
      runId: requested.runId,
      choice: 'allow_session',
    });
    expect(await choicePromise).toBe('allow_session');

    // 第二次挂起的后台子代理审批在关闭父会话槽位时立即以 aborted 收口，不残留泄漏
    events.length = 0;
    const hangingApproval = capturedApproval!.requestApproval({
      toolName: 'write_file',
      capabilities: ['fs:write'],
      input: { path: 'x.ts' },
      rootDir: ws.root,
      sessionAllowed: true,
      subagentOrigin: {
        agentId: 'agent-bg-43',
        role: 'implement',
        description: '挂起写入',
        parentSessionId: 'parent-conv',
      },
    });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'approval.requested')).toBe(true));
    await host.dispatch('session.close', {
      workspaceId: ws.id,
      sessionId: opened.sessionId,
    });
    expect(await hangingApproval).toBe('deny_once');
    expect(events.some((e) => e.type === 'approval.closed' && e.reason === 'aborted')).toBe(true);
    expect(host.counts().approvals).toBe(0);
    await host.disconnect();
  });

  it('DesktopHost 透传委派元数据、删除联动 forgetDelegation，并打通 reference.* 与 run.start.references', async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-desktop-m1-ref-'));
    const realHome = fs.realpathSync.native(home);
    homes.push(realHome);
    const events: Notification[] = [];

    const parentHandle = createFakeHandle('parent-live');
    const host = new DesktopHost(
      realHome,
      async (event) => {
        events.push(event);
      },
      async () => parentHandle,
    );
    const ws = host.workspaces.openDefault();
    host.workspaces.confirm(ws.id, ws.trustToken, true);

    // 种入源会话与委派子会话
    const mgr = new SessionManager({
      workspaceRoot: ws.root,
      homeDirectory: realHome,
      projectRootMode: 'exact',
    });
    const refConv = await mgr.create();
    await refConv.store.appendRecord('title', { title: '数据库索引设计' });
    await refConv.store.append({
      id: 'u-idx',
      role: 'user',
      timestamp: Date.now() - 3000,
      content: [{ type: 'text', text: '联合索引顺序采用 (workspace_id, updated_at)' }],
    });
    const refRecords = await refConv.store.readRecords();
    const rec = refRecords.find((r) => r.type === 'message')!;
    await refConv.release();

    const childConv = await mgr.create({
      delegation: {
        kind: 'delegation',
        parentSessionId: 'parent-live',
        parentTitle: '主设计会话',
        taskName: '基准压测脚本',
        createdAt: Date.now() - 1000,
      },
    });
    await childConv.store.appendRecord('title', { title: '基准压测脚本 · 主设计会话' });
    await childConv.release();
    await mgr.close();

    // 打开父会话句柄并安装视图
    const opened = (await host.dispatch('session.create', {
      workspaceId: ws.id,
    })) as Output<'session.create'>;
    const subId = randomUUID();
    await host.dispatch('presentation.subscribe', {
      workspaceId: ws.id,
      sessionId: opened.sessionId,
      subscriptionId: subId,
    });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'presentation.chunk')).toBe(true));
    const chunk = events.find((e) => e.type === 'presentation.chunk') as Extract<
      Notification,
      { type: 'presentation.chunk' }
    >;
    await host.dispatch('presentation.installed', {
      workspaceId: ws.id,
      sessionId: opened.sessionId,
      subscriptionId: subId,
      snapshotId: chunk.snapshotId,
      sequence: chunk.sequence,
    });

    // 1. session.list 包含 delegation 字段
    const list = (await host.dispatch('session.list', {
      workspaceId: ws.id,
      page: 1,
    })) as Output<'session.list'>;
    const childEntry = list.items.find((i) => i.conversationId === childConv.conversationId);
    expect(childEntry?.delegation).toEqual({
      parentSessionId: 'parent-live',
      parentTitle: '主设计会话',
      taskName: '基准压测脚本',
    });

    // 2. reference.candidates / search / read
    const candidates = (await host.dispatch('reference.candidates', {
      workspaceId: ws.id,
    })) as Output<'reference.candidates'>;
    expect(candidates.items.some((i) => i.sessionId === refConv.conversationId)).toBe(true);
    expect(
      candidates.items.find((i) => i.sessionId === childConv.conversationId)?.isDelegation,
    ).toBe(true);

    const search = (await host.dispatch('reference.search', {
      workspaceId: ws.id,
      query: '联合索引',
    })) as Output<'reference.search'>;
    expect(search.hits).toHaveLength(1);
    expect(search.hits[0]?.sessionId).toBe(refConv.conversationId);
    expect(search.hits[0]?.recordId).toBe(rec.recordId);

    const read = (await host.dispatch('reference.read', {
      workspaceId: ws.id,
      sessionId: refConv.conversationId,
      recordIds: [rec.recordId],
    })) as Output<'reference.read'>;
    expect(read.records[0]?.text).toContain('workspace_id');

    // 3. run.start 携带 references 时调用 handle.runWithReferences
    await host.dispatch('run.start', {
      workspaceId: ws.id,
      sessionId: opened.sessionId,
      operationId: randomUUID(),
      input: '按引用方案落地',
      references: [{ sessionId: refConv.conversationId, recordId: rec.recordId }],
    });
    expect(parentHandle.runWithReferences).toHaveBeenCalledWith('按引用方案落地', [
      { sessionId: refConv.conversationId, recordIds: [rec.recordId] },
    ]);

    // 4. session.delete 删除委派子会话时联动通知已打开的父会话句柄 forgetDelegation
    await host.dispatch('session.delete', {
      workspaceId: ws.id,
      conversationId: childConv.conversationId,
    });
    expect(parentHandle.forgetDelegation).toHaveBeenCalledWith(childConv.conversationId);

    await host.disconnect();
  });
});
