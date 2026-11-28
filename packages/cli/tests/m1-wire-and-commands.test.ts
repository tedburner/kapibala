import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { PassThrough } from 'node:stream';
import {
  AgentRuntime,
  AgentSession,
  type ApprovalChannel,
  type ApprovalRequest,
  type ModelProfile,
  SessionManager,
} from '@kiturone/kapibala';
import { LocalClient, type LocalClientOptions } from '@kiturone/kapibala-host/client';
import {
  type ReferenceSelection,
  createUserSettingsSkeleton,
  trustProject,
} from '@kiturone/kapibala-host/internal';
import {
  PROTOCOL_VERSION,
  SERVER_CAPABILITIES,
  type WireEvent,
} from '@kiturone/kapibala-host/protocol';
import { createStdioTransport } from '@kiturone/kapibala-host/transport';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionController } from '../src/active-session.js';
import { branchCommand } from '../src/commands/branch.js';
import { delegationsCommand } from '../src/commands/delegations.js';
import type { CommandContext } from '../src/commands/dispatcher.js';
import { CliInputCoordinator } from '../src/input-coordinator.js';
import { ConnectedPresentation } from '../src/local-host/presentation.js';
import { LocalHostServer } from '../src/local-host/server.js';
import type { SessionResources } from '../src/local-host/types.js';
import { askWithReadline } from '../src/ui/approval.js';
import { createEventRenderer } from '../src/ui/events.js';

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

async function connectClientToServer(
  server: LocalHostServer,
  capabilities: string[],
  approval?: LocalClientOptions['approval'],
) {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const clientTransport = createStdioTransport(s2c, c2s);
  const serverTransport = createStdioTransport(c2s, s2c);
  const acceptTask = server.accept(serverTransport);
  const client = await LocalClient.connect(
    clientTransport,
    {
      protocolVersion: PROTOCOL_VERSION,
      clientName: 'm1-wire-client',
      capabilities,
    },
    approval ? { approval } : undefined,
  );
  cleanups.push(async () => {
    await client.close();
    await acceptTask.catch(() => {});
  });
  return client;
}

describe('Wire v2 retry / references / 后台子代理冒泡审批与 CLI M1 命令增强', () => {
  it('SERVER_CAPABILITIES 含 references 与 retry；未声明 retry 的观察者连接不接收重试帧且无序号缺口', async () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(SERVER_CAPABILITIES).toContain('references');
    expect(SERVER_CAPABILITIES).toContain('retry');

    const homeDir = makeTempDir('kpbl-wire-retry-home-');
    const ws = makeTempDir('kpbl-wire-retry-ws-');

    const server = new LocalHostServer({
      homeDir,
      create: async (): Promise<SessionResources> => ({
        conversationId: 'conv-retry',
        history: () => [],
        async *run() {
          yield { type: 'text_delta', text: '半截片段' };
          yield { type: 'stream_reset', step: 1, attempt: 1 };
          yield {
            type: 'retry_scheduled',
            step: 1,
            attempt: 1,
            maxRetries: 2,
            delayMs: 1500,
            nextRetryAt: Date.now() + 1500,
            category: 'network',
            message: '断流重连中',
          };
          yield { type: 'text_delta', text: '最终完整文本' };
          yield {
            type: 'run_finish',
            metrics: {
              status: 'completed',
              turns: 1,
              startTime: 1,
              endTime: 21,
              totalDurationMs: 20,
              modelDurationMs: 15,
              toolDurationMs: 0,
              toolCalls: 0,
              promptTokens: 10,
              completionTokens: 5,
              totalTokens: 15,
            },
          };
        },
        dispose: async () => {},
      }),
    });
    cleanups.push(() => server.shutdown());

    const retryClient = await connectClientToServer(server, [
      'sessions',
      'approval',
      'cancel',
      'retry',
    ]);
    const legacyClient = await connectClientToServer(server, ['sessions', 'cancel']);

    const retryEvents: WireEvent[] = [];
    const legacyEvents: WireEvent[] = [];
    retryClient.subscribe((evt) => retryEvents.push(evt));
    legacyClient.subscribe((evt) => legacyEvents.push(evt));

    const opened = await retryClient.call('session/create', { workspaceRoot: ws });
    const attached = await retryClient.call('session/attach', {
      sessionId: opened.sessionId,
      mode: 'control',
    });
    await legacyClient.call('session/attach', {
      sessionId: opened.sessionId,
      mode: 'observe',
    });

    const connected = new ConnectedPresentation(
      opened.sessionId,
      attached.serverInstanceId,
      attached.streamEpoch,
    );
    retryClient.subscribe((evt) => connected.consume(evt));

    await retryClient.call('run/start', {
      sessionId: opened.sessionId,
      streamEpoch: attached.streamEpoch,
      controlEpoch: attached.controlEpoch,
      clientOperationId: 'op-retry-1',
      input: 'hello',
    });

    await vi.waitFor(() => {
      expect(retryEvents.some((e) => e.type === 'run_settled')).toBe(true);
      expect(legacyEvents.some((e) => e.type === 'run_settled')).toBe(true);
    });

    expect(retryEvents.map((e) => e.type)).toEqual([
      'run_started',
      'text_delta',
      'stream_reset',
      'retry_scheduled',
      'text_delta',
      'run_settled',
    ]);
    expect(retryEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);

    // 未声明 'retry' 的旧客户端绝不收到 stream_reset / retry_scheduled，且 seq 严格连续 1..4（零 RESYNC_REQUIRED）
    expect(legacyEvents.map((e) => e.type)).toEqual([
      'run_started',
      'text_delta',
      'text_delta',
      'run_settled',
    ]);
    expect(legacyEvents.map((e) => e.seq)).toEqual([1, 2, 3, 4]);

    const legacySnap = await legacyClient.call('session/snapshot', { sessionId: opened.sessionId });
    expect(legacySnap.seq).toBe(4);
  });

  it('父轮次已结束处于 idle 时，后台 detached 子代理冒泡的审批仍可经控制连接送达并裁决', async () => {
    const homeDir = makeTempDir('kpbl-wire-bg-app-home-');
    const ws = makeTempDir('kpbl-wire-bg-app-ws-');
    let capturedApproval: ApprovalChannel | undefined;

    const server = new LocalHostServer({
      homeDir,
      create: async (_root, _convId, approval): Promise<SessionResources> => {
        capturedApproval = approval;
        return {
          conversationId: 'conv-bg-approval',
          history: () => [],
          async *run(_input, _signal, _references, runOptions) {
            seenRunOptions.push(runOptions);
            yield { type: 'text_delta', text: '已后台派发子代理' };
            yield {
              type: 'run_finish',
              metrics: {
                status: 'completed',
                turns: 1,
                startTime: 1,
                endTime: 6,
                totalDurationMs: 5,
                modelDurationMs: 5,
                toolDurationMs: 0,
                toolCalls: 0,
                promptTokens: 1,
                completionTokens: 1,
                totalTokens: 2,
              },
            };
          },
          dispose: async () => {},
        };
      },
    });
    cleanups.push(() => server.shutdown());

    const seenRunOptions: Array<{ allowMidStreamRetry?: boolean } | undefined> = [];
    const seenPrompts: Array<{
      runId: string;
      hasOrigin: boolean;
      subagentDescription?: string;
    }> = [];
    const client = await connectClientToServer(
      server,
      ['sessions', 'approval', 'cancel', 'retry'],
      async (prompt) => {
        seenPrompts.push({
          runId: prompt.runId,
          hasOrigin: 'subagentOrigin' in prompt,
          subagentDescription: prompt.subagentOrigin?.description,
        });
        return 'allow_session';
      },
    );

    const settledRuns: string[] = [];
    client.subscribe((evt) => {
      if (evt.type === 'run_settled' && evt.runId) settledRuns.push(evt.runId);
    });

    const opened = await client.call('session/create', { workspaceRoot: ws });
    const attached = await client.call('session/attach', {
      sessionId: opened.sessionId,
      mode: 'control',
    });
    const started = await client.call('run/start', {
      sessionId: opened.sessionId,
      streamEpoch: attached.streamEpoch,
      controlEpoch: attached.controlEpoch,
      clientOperationId: 'op-parent-turn',
      input: '派发后台任务',
    });
    await vi.waitFor(() => expect(settledRuns).toContain(started.runId));
    expect(seenRunOptions).toEqual([{ allowMidStreamRetry: true }]);

    // 此时父轮次已彻底结束（entry.active === undefined），模拟后台 detached 子代理发起 ask 审批
    const choice = await capturedApproval!.requestApproval({
      toolName: 'write_file',
      capabilities: ['fs:write'],
      input: { path: path.join(ws, 'out.txt'), content: 'bg' },
      rootDir: ws,
      sessionAllowed: true,
      subagentOrigin: {
        agentId: 'sub-bg-1',
        role: 'implement',
        description: '后台迁移数据库',
        childSessionId: 'child-conv-1',
        parentSessionId: 'conv-bg-approval',
      },
    });

    expect(choice).toBe('allow_session');
    expect(seenPrompts).toEqual([
      { runId: 'sub-bg-1', hasOrigin: true, subagentDescription: '后台迁移数据库' },
    ]);

    // 旧版客户端（未声明任何 v0.1.6 新能力）接管控制权时：禁用流中重试且裁剪 subagentOrigin
    await client.call('session/detach', { sessionId: opened.sessionId });
    const legacyPrompts: Record<string, unknown>[] = [];
    const legacyClient = await connectClientToServer(
      server,
      ['sessions', 'approval', 'cancel'],
      async (prompt) => {
        legacyPrompts.push(prompt as unknown as Record<string, unknown>);
        return 'allow_once';
      },
    );
    const legacyAttached = await legacyClient.call('session/attach', {
      sessionId: opened.sessionId,
      mode: 'control',
    });
    const legacySettled: string[] = [];
    legacyClient.subscribe((evt) => {
      if (evt.type === 'run_settled' && evt.runId) legacySettled.push(evt.runId);
    });
    const legacyStarted = await legacyClient.call('run/start', {
      sessionId: opened.sessionId,
      streamEpoch: legacyAttached.streamEpoch,
      controlEpoch: legacyAttached.controlEpoch,
      clientOperationId: 'op-legacy-turn',
      input: '旧客户端运行',
    });
    await vi.waitFor(() => expect(legacySettled).toContain(legacyStarted.runId));
    expect(seenRunOptions.at(-1)).toEqual({ allowMidStreamRetry: false });

    await capturedApproval!.requestApproval({
      toolName: 'write_file',
      capabilities: ['fs:write'],
      input: { path: path.join(ws, 'out2.txt'), content: 'legacy' },
      rootDir: ws,
      sessionAllowed: true,
      subagentOrigin: {
        agentId: 'sub-bg-2',
        role: 'implement',
        description: '旧客户端子代理',
        parentSessionId: 'conv-bg-approval',
      },
    });
    expect(legacyPrompts).toHaveLength(1);
    expect('subagentOrigin' in legacyPrompts[0]!).toBe(false);
  });

  it('Wire v2 references 校验能力协商、项目信任与同桶隔离，并在 run/start 中透传引用选择', async () => {
    const homeDir = makeTempDir('kpbl-wire-ref-home-');
    const trustedWs = makeTempDir('kpbl-wire-ref-trusted-');
    const untrustedWs = makeTempDir('kpbl-wire-ref-untrusted-');
    const otherWs = makeTempDir('kpbl-wire-ref-other-');

    trustProject(createUserSettingsSkeleton(), trustedWs, { homeDir });
    trustProject(createUserSettingsSkeleton(), otherWs, { homeDir });

    // 在 trustedWs 下种入一个普通会话与一个委派子会话
    const trustedMgr = new SessionManager({
      workspaceRoot: trustedWs,
      homeDirectory: homeDir,
      projectRootMode: 'exact',
    });
    const seed = await trustedMgr.create();
    await seed.store.appendRecord('title', { title: '认证重构讨论' });
    await seed.store.append({
      id: 'u-ref-1',
      role: 'user',
      timestamp: Date.now() - 2000,
      content: [{ type: 'text', text: '请把 JWT 刷新窗口调整为 15 分钟' }],
    });
    const seedRecords = await seed.store.readRecords();
    const userRec = seedRecords.find((r) => r.type === 'message')!;
    await seed.release();

    const delSeed = await trustedMgr.create({
      delegation: {
        kind: 'delegation',
        parentSessionId: seed.conversationId,
        parentTitle: '认证重构讨论',
        taskName: '梳理 Token 中间件',
        createdAt: Date.now() - 1000,
      },
    });
    await delSeed.store.appendRecord('title', { title: '梳理 Token 中间件 · 认证重构讨论' });
    await delSeed.release();
    await trustedMgr.close();

    // 在 otherWs 下种入另一仓库的敏感历史，确保搜索绝不串桶
    const otherMgr = new SessionManager({
      workspaceRoot: otherWs,
      homeDirectory: homeDir,
      projectRootMode: 'exact',
    });
    const otherSeed = await otherMgr.create();
    await otherSeed.store.append({
      id: 'u-other-1',
      role: 'user',
      timestamp: Date.now(),
      content: [{ type: 'text', text: 'JWT 跨项目机密配置' }],
    });
    await otherSeed.release();
    await otherMgr.close();

    let receivedReferences: readonly ReferenceSelection[] | undefined;
    const server = new LocalHostServer({
      homeDir,
      create: async (): Promise<SessionResources> => ({
        conversationId: 'conv-runner',
        history: () => [],
        async *run(_input, _signal, refs) {
          receivedReferences = refs;
          yield { type: 'text_delta', text: 'ok' };
          yield {
            type: 'run_finish',
            metrics: {
              status: 'completed',
              turns: 1,
              startTime: 1,
              endTime: 2,
              totalDurationMs: 1,
              modelDurationMs: 1,
              toolDurationMs: 0,
              toolCalls: 0,
              promptTokens: 1,
              completionTokens: 1,
              totalTokens: 2,
            },
          };
        },
        dispose: async () => {},
      }),
    });
    cleanups.push(() => server.shutdown());

    const noRefClient = await connectClientToServer(server, ['sessions']);
    await expect(
      noRefClient.call('reference/candidates', { workspaceRoot: trustedWs }),
    ).rejects.toThrow(/PROTOCOL_MISMATCH/);

    const refClient = await connectClientToServer(server, ['sessions', 'references']);

    // 未信任工作区必须返回 TRUST_REQUIRED
    await expect(
      refClient.call('reference/candidates', { workspaceRoot: untrustedWs }),
    ).rejects.toThrow(/TRUST_REQUIRED/);

    // session/list 返回 delegation 元数据
    const listed = await refClient.call('session/list', { workspaceRoot: trustedWs });
    const delItem = listed.items.find((i) => i.conversationId === delSeed.conversationId);
    expect(delItem?.delegation).toEqual({
      parentSessionId: seed.conversationId,
      parentTitle: '认证重构讨论',
      taskName: '梳理 Token 中间件',
    });

    const candidates = await refClient.call('reference/candidates', { workspaceRoot: trustedWs });
    expect(candidates.items.map((i) => i.sessionId)).toContain(seed.conversationId);
    expect(candidates.items.find((i) => i.sessionId === delSeed.conversationId)?.isDelegation).toBe(
      true,
    );

    // 搜索即使尝试在 query 中注入 project:<otherWs> 也严禁越出 trustedWs 项目桶
    const searchHits = await refClient.call('reference/search', {
      workspaceRoot: trustedWs,
      query: `JWT project:${otherWs}`,
    });
    expect(searchHits.hits).toHaveLength(1);
    expect(searchHits.hits[0]?.sessionId).toBe(seed.conversationId);
    expect(searchHits.hits[0]?.title).toBe('认证重构讨论');

    const readSnap = await refClient.call('reference/read', {
      workspaceRoot: trustedWs,
      sessionId: seed.conversationId,
      recordIds: [userRec.recordId],
    });
    expect(readSnap.records).toHaveLength(1);
    expect(readSnap.records[0]?.text).toContain('15 分钟');

    // run/start 携带 references
    const opened = await refClient.call('session/create', { workspaceRoot: trustedWs });
    const attached = await refClient.call('session/attach', {
      sessionId: opened.sessionId,
      mode: 'control',
    });
    await expect(
      noRefClient.call('run/start', {
        sessionId: opened.sessionId,
        streamEpoch: attached.streamEpoch,
        controlEpoch: attached.controlEpoch,
        clientOperationId: 'op-forbid-ref',
        input: 'hi',
        references: [{ sessionId: seed.conversationId }],
      }),
    ).rejects.toThrow(/PROTOCOL_MISMATCH/);

    await refClient.call('run/start', {
      sessionId: opened.sessionId,
      streamEpoch: attached.streamEpoch,
      controlEpoch: attached.controlEpoch,
      clientOperationId: 'op-with-ref',
      input: '继续实现',
      references: [
        { sessionId: seed.conversationId, recordId: userRec.recordId, branchId: 'main' },
      ],
    });
    await vi.waitFor(() => expect(receivedReferences).toBeDefined());
    expect(receivedReferences).toEqual([
      { sessionId: seed.conversationId, recordIds: [userRec.recordId], branchId: 'main' },
    ]);
  });

  it('CLI /branch --summary、/delegations prune、重试提示行与子代理审批前缀/排队正常工作', async () => {
    const root = makeTempDir('kpbl-cli-m1-cmds-');
    const manager = new SessionManager({
      workspaceRoot: root,
      cwd: root,
      homeDirectory: root,
      projectRootMode: 'exact',
    });
    const handle = await manager.create();
    const dummyProfile: ModelProfile = {
      id: 'dummy',
      name: 'Dummy',
      provider: 'openai-compatible',
      baseURL: 'http://127.0.0.1:1',
      apiKeyEnv: 'NONE',
      modelName: 'dummy',
    };
    const session = new AgentSession({
      workspaceRoot: root,
      store: handle.store,
      conversationId: handle.conversationId,
      defaultProfile: dummyProfile,
      defaultProvider: { create: async function* () {} } as never,
      loggingDirectory: path.join(root, '.kapibala'),
      auditRecoveryDirectory: path.join(root, '.kapibala/audit'),
    });
    await session.init();

    const logs: string[] = [];
    let reloaded = 0;
    const runtime = new AgentRuntime({ runner: async () => ({ summary: 'done' }) });
    const forgetSpy = vi.spyOn(runtime, 'forgetDelegationSession');

    const ctx: CommandContext = {
      session,
      runtime,
      controller: {
        manager,
        session,
        handle,
        reloadCurrent: async () => {
          reloaded++;
        },
      } as unknown as ActiveSessionController,
      settings: {} as never,
      output: {
        log: (m) => logs.push(m),
        error: (m) => logs.push(m),
        write: (m) => logs.push(m),
      },
      onModelSwitched: () => {},
      onExit: () => {},
    };

    try {
      // 1. /branch --summary <name>（空会话走确定性宿主摘要回退，不依赖外部模型请求）
      await branchCommand(['--summary', 'summary-branch'], ctx);
      expect(reloaded).toBe(1);
      expect(handle.store.getActiveBranchId()).toBe('summary-branch');
      expect(logs.join('\n')).toContain('summary-branch');

      // 2. /delegations prune 清理 >7 天过期委派会话并通知 runtime.forgetDelegationSession
      const realNow = Date.now();
      const oldTs = realNow - 9 * 24 * 60 * 60 * 1_000;
      const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(oldTs);
      const oldDel = await manager.create({
        delegation: {
          kind: 'delegation',
          parentSessionId: handle.conversationId,
          taskName: '陈旧子任务',
          createdAt: oldTs,
        },
      });
      await oldDel.store.append({
        id: 'old-m',
        role: 'user',
        timestamp: oldTs,
        content: [{ type: 'text', text: 'stale' }],
      });
      await oldDel.release();
      nowSpy.mockRestore();

      logs.length = 0;
      await delegationsCommand(['prune'], ctx);
      expect(logs.join('\n')).toContain('已清理 1 个');
      expect(forgetSpy).toHaveBeenCalledWith(oldDel.conversationId);
    } finally {
      await runtime.close();
      await session.destroy();
      await handle.release();
      await manager.close();
    }

    // 3. EventRenderer 渲染 retry_scheduled
    const chunks: string[] = [];
    const renderer = createEventRenderer({
      isTTY: false,
      getGitBranch: () => undefined,
      write: (c) => chunks.push(c),
    });
    renderer.render({
      type: 'retry_scheduled',
      step: 1,
      attempt: 1,
      maxRetries: 2,
      delayMs: 2_200,
      nextRetryAt: Date.now() + 2_200,
      category: 'rate_limit',
      message: '429 Too Many Requests',
    });
    renderer.finish();
    expect(chunks.join('')).toContain('⟳ 模型请求暂时受限，将在 2s 后自动重试 (1/2)…');

    // 4. askWithReadline 与 CliInputCoordinator.approve 显示 [子代理: ...] 前缀且在忙碌输入期排队
    const subReq: ApprovalRequest = {
      toolName: 'write_file',
      capabilities: ['fs:write'],
      input: { path: 'a.txt' },
      rootDir: root,
      sessionAllowed: true,
      subagentOrigin: {
        agentId: 'sub-1',
        role: 'implement',
        description: '重构路由模块',
        parentSessionId: 'p-1',
      },
    };
    const inStream = new PassThrough();
    const outStream = new PassThrough();
    let renderedPrompt = '';
    outStream.on('data', (buf: Buffer) => {
      renderedPrompt += buf.toString('utf8');
    });
    const rl = readline.createInterface({ input: inStream, output: outStream });
    const askTask = askWithReadline(rl, subReq, undefined, true);
    inStream.write('1\n');
    expect(await askTask).toBe('allow_once');
    expect(renderedPrompt).toContain('[子代理: 重构路由模块]');
    rl.close();

    // CliInputCoordinator: 正在 readSecret 时到达的子代理审批自动排队，密钥回车后再弹出审批
    const coordIn = new PassThrough();
    const coordOut = new PassThrough();
    let coordRendered = '';
    coordOut.on('data', (buf: Buffer) => {
      coordRendered += buf.toString('utf8');
    });
    const coord = new CliInputCoordinator({
      input: coordIn,
      output: coordOut,
      interactive: true,
      terminal: false,
    });
    try {
      const secretPromise = coord.readSecret('API Key: ');
      const queuedApproval = coord.approve(subReq);
      coordIn.write('sk-test-key\n');
      expect(await secretPromise).toBe('sk-test-key');
      await vi.waitFor(() => expect(coordRendered).toContain('[子代理: 重构路由模块]'));
      coordIn.write('2\n');
      expect(await queuedApproval).toBe('allow_session');
    } finally {
      coord.close();
    }
  });
});
