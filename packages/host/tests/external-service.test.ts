import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ExternalSessionRegistry } from '../src/host/external/registry.js';
import { ExternalSessionService } from '../src/host/external/service.js';
import { createUserSettingsSkeleton, trustProject } from '../src/host/settings.js';
import type { ViewMessage } from '../src/view-model/index.js';

const fixtureScript = fileURLToPath(new URL('./fixtures/fake-acp-agent.mjs', import.meta.url));

const tempDirs: string[] = [];
const activeServices: ExternalSessionService[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

afterEach(async () => {
  for (const svc of activeServices.splice(0)) {
    await svc.dispose().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('ExternalSessionRegistry 只读快照归档与容量边界', () => {
  it('原子落盘只读展示快照并自动脱敏，超过 160 条消息时裁剪旧消息且空数组不覆盖既有快照', () => {
    const homeDir = makeTempDir('kpbl-ext-reg-home-');
    const workspaceRoot = makeTempDir('kpbl-ext-reg-ws-');
    const registry = new ExternalSessionRegistry({ homeDir });

    registry.upsertRecord({
      id: 'ext-1',
      harnessId: 'opencode',
      harnessName: 'OpenCode',
      transport: 'acp',
      workspaceRoot,
      configDigest: 'sha256:demo',
      title: '测试外部归档',
      status: 'ended',
      resumable: true,
      createdAt: 1_000,
      updatedAt: 2_000,
    });

    const manyMessages: ViewMessage[] = Array.from({ length: 170 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      state: 'completed',
      persisted: true,
      blocks: [
        {
          id: `m-${index}:b0`,
          kind: 'text',
          text:
            index === 169
              ? '最后一条含凭据 Authorization: Bearer secretToken123456'
              : `消息正文 ${index}`,
          state: 'completed',
          revision: 0,
        },
      ],
    }));

    registry.saveArchive('ext-1', { messages: manyMessages }, ['extra-secret-val']);
    // 空消息写入不得抹掉已有非空归档
    registry.saveArchive('ext-1', { messages: [] });

    const archive = registry.readArchive('ext-1');
    expect(archive).toBeDefined();
    expect(archive?.truncated).toBe(true);
    expect(archive?.messages).toHaveLength(160);
    expect(archive?.messages[0]?.id).toBe('m-10');
    expect(archive?.messages.at(-1)?.blocks[0]?.text).toContain('Bearer [REDACTED]');
  });

  it('满 50 条时自动淘汰最早终态记录及快照，但全部处于活跃态时拒绝新增防静默丢会话', () => {
    const homeDir = makeTempDir('kpbl-ext-reg-cap-');
    const workspaceRoot = makeTempDir('kpbl-ext-reg-cap-ws-');
    const registry = new ExternalSessionRegistry({ homeDir });

    for (let i = 1; i <= 50; i++) {
      registry.upsertRecord({
        id: `ext-${i}`,
        harnessId: 'opencode',
        harnessName: 'OpenCode',
        transport: 'acp',
        workspaceRoot,
        configDigest: 'sha256:demo',
        title: `任务 ${i}`,
        status: i === 1 ? 'ended' : 'idle',
        resumable: false,
        createdAt: i,
        updatedAt: i,
      });
    }
    registry.saveArchive('ext-1', {
      messages: [
        {
          id: 'm1',
          role: 'user',
          state: 'completed',
          persisted: true,
          blocks: [{ id: 'b1', kind: 'text', text: 'bye', state: 'completed', revision: 0 }],
        },
      ],
    });
    expect(registry.hasArchive('ext-1')).toBe(true);

    // 存在终态项 ext-1 时自动淘汰 ext-1 并清理其快照
    registry.upsertRecord({
      id: 'ext-51',
      harnessId: 'opencode',
      harnessName: 'OpenCode',
      transport: 'acp',
      workspaceRoot,
      configDigest: 'sha256:demo',
      title: '触发淘汰最旧终态',
      status: 'idle',
      resumable: false,
      createdAt: 51,
      updatedAt: 51,
    });
    expect(registry.getRecord('ext-1')).toBeUndefined();
    expect(registry.hasArchive('ext-1')).toBe(false);

    // 此时 50 条全部为活跃 idle，再新增第 52 条必须抛 EXTERNAL_CAPACITY
    expect(() =>
      registry.upsertRecord({
        id: 'ext-52',
        harnessId: 'opencode',
        harnessName: 'OpenCode',
        transport: 'acp',
        workspaceRoot,
        configDigest: 'sha256:demo',
        title: '全部活跃不可淘汰',
        status: 'starting',
        resumable: false,
        createdAt: 52,
        updatedAt: 52,
      }),
    ).toThrowError(expect.objectContaining({ code: 'EXTERNAL_CAPACITY' }));
  });
});

describe('ExternalSessionService 会话编排、审批、空闲回收与 configDigest 连续性门禁', () => {
  it('未信任工作区硬拒全部外部会话启动与探测请求', async () => {
    const homeDir = makeTempDir('kpbl-ext-svc-untrust-home-');
    const untrustedWs = makeTempDir('kpbl-ext-svc-untrust-ws-');
    const service = new ExternalSessionService({ homeDir });
    activeServices.push(service);

    await expect(
      service.startSession({
        workspaceRoot: untrustedWs,
        harnessId: 'opencode',
        prompt: '你好',
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_UNTRUSTED_WORKSPACE' });
  });

  it('完整闭环：自定义 ACP 注册 → 握手探测 → 启动与审批交互 → 空闲自动回收 → 校验 configDigest 恢复或只读锁定', async () => {
    const homeDir = makeTempDir('kpbl-ext-svc-flow-home-');
    const workspaceRoot = makeTempDir('kpbl-ext-svc-flow-ws-');
    trustProject(createUserSettingsSkeleton(), workspaceRoot, { homeDir });

    const service = new ExternalSessionService({
      homeDir,
      idleTimeoutMs: 120,
      approvalTimeoutMs: 5_000,
    });
    activeServices.push(service);

    service.saveCustomHarness({
      id: 'fake-opencode',
      name: 'Fake OpenCode',
      command: process.execPath,
      args: [fixtureScript, '--mode=normal'],
      flavor: 'opencode',
      enabled: true,
    });

    const probe = await service.testHarness('fake-opencode', workspaceRoot);
    expect(probe.status).toBe('ready');
    expect(probe.version).toBe('1.19.3');

    const snapshots: string[] = [];
    const started = await service.openSession({
      workspaceRoot,
      harnessId: 'fake-opencode',
      title: '带审批的外部任务',
    });

    const unsub = service.subscribeSession(started.session.id, (snap) => {
      snapshots.push(snap.session.status);
      if (snap.approvals.length > 0) {
        void service.approveSession({
          sessionId: started.session.id,
          approvalId: snap.approvals[0]!.approvalId,
          optionId: 'allow-session',
        });
      }
    });

    await service.promptSession({
      sessionId: started.session.id,
      text: 'NEED_APPROVAL',
    });
    unsub();

    const afterTurn = service.getSnapshot(started.session.id);
    expect(afterTurn.session.status).toBe('idle');
    expect(afterTurn.session.canContinue).toBe(true);
    expect(afterTurn.messages).toHaveLength(2);
    expect(snapshots).toContain('waiting_approval');

    // 等待空闲回收触发（120ms）：子进程关闭，但历史展示快照仍可读且 canContinue 保持 true
    await new Promise((resolve) => setTimeout(resolve, 260));
    const afterIdleReap = service.getSnapshot(started.session.id);
    expect(afterIdleReap.session.status).toBe('ended');
    expect(afterIdleReap.session.hasArchive).toBe(true);
    expect(afterIdleReap.session.canContinue).toBe(true);
    expect(afterIdleReap.messages).toHaveLength(2);

    // 未改配置时直接发新轮次：透明走 session/load 自动拉起续聊
    await service.promptSession({
      sessionId: started.session.id,
      text: '第二轮追问',
    });
    const afterResume = service.getSnapshot(started.session.id);
    expect(afterResume.session.status).toBe('idle');
    expect(afterResume.messages.length).toBeGreaterThanOrEqual(4);

    // 手动关闭后修改代理启动参数 → configDigest 漂移 → canContinue 变 false，拒绝盲目续聊但保留只读历史
    await service.closeSession(started.session.id);
    service.saveCustomHarness({
      id: 'fake-opencode',
      name: 'Fake OpenCode',
      command: process.execPath,
      args: [fixtureScript, '--mode=normal', '--extra-flag'],
      flavor: 'opencode',
      enabled: true,
    });

    const lockedSnap = service.getSnapshot(started.session.id);
    expect(lockedSnap.session.canContinue).toBe(false);
    expect(lockedSnap.messages.length).toBeGreaterThanOrEqual(4);

    await expect(
      service.promptSession({
        sessionId: started.session.id,
        text: '篡改配置后继续',
      }),
    ).rejects.toThrow(/只读历史归档/);
  });

  it('同工作区禁止两个外部会话同时处于运行态（EXTERNAL_WORKSPACE_BUSY），审批超时自动按取消收口', async () => {
    const homeDir = makeTempDir('kpbl-ext-svc-busy-home-');
    const workspaceRoot = makeTempDir('kpbl-ext-svc-busy-ws-');
    trustProject(createUserSettingsSkeleton(), workspaceRoot, { homeDir });

    const service = new ExternalSessionService({
      homeDir,
      approvalTimeoutMs: 80,
    });
    activeServices.push(service);

    service.saveCustomHarness({
      id: 'fake-opencode',
      name: 'Fake OpenCode',
      command: process.execPath,
      args: [fixtureScript, '--mode=normal'],
      flavor: 'opencode',
      enabled: true,
    });

    const s1 = await service.openSession({ workspaceRoot, harnessId: 'fake-opencode' });
    const s2 = await service.openSession({ workspaceRoot, harnessId: 'fake-opencode' });

    // s1 进入审批等待（占用同工作区活跃运行槽），且不人工点击让其在 80ms 后自动超时取消
    const p1 = service.promptSession({ sessionId: s1.session.id, text: 'NEED_APPROVAL' });
    await new Promise((resolve) => setTimeout(resolve, 30));

    await expect(
      service.promptSession({ sessionId: s2.session.id, text: '并发抢占同工作区' }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_WORKSPACE_BUSY' });

    await p1;
    const snap1 = service.getSnapshot(s1.session.id);
    expect(snap1.approvals).toHaveLength(0);
    expect(snap1.notices.some((n) => n.text.includes('超时'))).toBe(true);
  });

  it('保留显式自定义标题、脱敏 envFrom 注入凭据、输错审批选项不误毁审批单，且同工作区忙时 startSession 不泄漏子进程', async () => {
    const homeDir = makeTempDir('kpbl-ext-svc-guard-home-');
    const workspaceRoot = makeTempDir('kpbl-ext-svc-guard-ws-');
    trustProject(createUserSettingsSkeleton(), workspaceRoot, { homeDir });

    const envSecretValue = 'dsh_super_secret_env_token_778899';
    const service = new ExternalSessionService({
      homeDir,
      hostEnv: { DEEPSEEK_API_KEY: envSecretValue },
    });
    activeServices.push(service);

    service.saveCustomHarness({
      id: 'fake-opencode',
      name: 'Fake OpenCode',
      command: process.execPath,
      args: [fixtureScript, '--mode=normal'],
      flavor: 'opencode',
      envFrom: ['DEEPSEEK_API_KEY'],
      enabled: true,
    });

    const s1 = await service.openSession({
      workspaceRoot,
      harnessId: 'fake-opencode',
      title: `自定义标题 ${envSecretValue}`,
    });
    expect(s1.session.title).toBe('自定义标题 [REDACTED]');

    // 启动带挂起审批的轮次
    const runningTurn = service.promptSession({
      sessionId: s1.session.id,
      text: 'NEED_APPROVAL',
    });
    await new Promise((resolve) => setTimeout(resolve, 40));

    // 此时只有 1 个子进程；同工作区调用 startSession 应前置拦截 EXTERNAL_WORKSPACE_BUSY，绝不多拉起第 2 个空闲进程
    expect(service.getActiveSessionPids()).toHaveLength(1);
    await expect(
      service.startSession({
        workspaceRoot,
        harnessId: 'fake-opencode',
        prompt: '并发抢跑',
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_WORKSPACE_BUSY' });
    expect(service.getActiveSessionPids()).toHaveLength(1);

    // 传入非法审批 optionId 应抛错但保留原审批单，随后正确选择 allow-once 仍可顺利放行
    const apr = service.getSnapshot(s1.session.id).approvals[0]!;
    await expect(
      service.approveSession({
        sessionId: s1.session.id,
        approvalId: apr.approvalId,
        optionId: 'non-existent-option',
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_CONFIG_INVALID' });
    expect(service.getSnapshot(s1.session.id).approvals).toHaveLength(1);

    await service.approveSession({
      sessionId: s1.session.id,
      approvalId: apr.approvalId,
      optionId: 'allow-once',
    });
    const finished = await runningTurn;
    // 自定义标题不被首轮输入 NEED_APPROVAL 覆盖
    expect(finished.session.title).toBe('自定义标题 [REDACTED]');
  });
});
