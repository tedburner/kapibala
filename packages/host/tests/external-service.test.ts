import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpStdioDriver } from '../src/host/external/drivers/acp/acp-driver.js';
import { ExternalSessionRegistry } from '../src/host/external/registry.js';
import { ExternalSessionService } from '../src/host/external/service.js';
import { ExternalHarnessError } from '../src/host/external/types.js';
import { createUserSettingsSkeleton, trustProject } from '../src/host/settings.js';
import { toWireErrorCode } from '../src/protocol/errors.js';
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
  function createServicePair() {
    const homeDir = makeTempDir('kpbl-ext-shared-home-');
    const workspaceRoot = makeTempDir('kpbl-ext-shared-ws-');
    const attention: string[] = [];
    const options = { homeDir, isWorkspaceTrusted: (root: string) => root === workspaceRoot };
    const service = new ExternalSessionService({
      ...options,
      drivers: { acp: new AcpStdioDriver({ turnWatchdogMs: 500 }) },
      onAttentionEvent: (event) => attention.push(event.kind),
    });
    const other = new ExternalSessionService(options);
    activeServices.push(service, other);
    service.saveCustomHarness({
      id: 'fake-opencode',
      name: 'Fake OpenCode',
      command: process.execPath,
      args: [fixtureScript, '--mode=normal'],
      flavor: 'opencode',
      enabled: true,
    });
    return { service, other, attention, workspaceRoot, harnessId: 'fake-opencode' };
  }

  it('第二个宿主可查看共享归档，且在当前宿主关闭前无法续写或删除会话', async () => {
    const { service, other, workspaceRoot, harnessId } = createServicePair();
    const { session } = await service.openSession({ workspaceRoot, harnessId });
    expect(other.listSessions(workspaceRoot)).toEqual([
      expect.objectContaining({ id: session.id, status: 'idle', canContinue: false }),
    ]);
    await expect(
      other.promptSession({ sessionId: session.id, text: '续写' }),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_SESSION_BUSY',
    });
    await expect(other.deleteSession(session.id)).rejects.toMatchObject({
      code: 'EXTERNAL_SESSION_BUSY',
    });
    await service.closeSession(session.id);
    const resumed = other.promptSession({ sessionId: session.id, text: '关闭后续写' });
    await expect(
      service.promptSession({ sessionId: session.id, text: '争抢恢复' }),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_SESSION_BUSY',
    });
    await expect(resumed).resolves.toMatchObject({ session: { status: 'idle' } });
  });

  it('无响应时释放子进程槽位，并从归档恢复下一轮', async () => {
    const { service, workspaceRoot, harnessId } = createServicePair();
    const { session } = await service.openSession({ workspaceRoot, harnessId });
    await expect(
      service.promptSession({ sessionId: session.id, text: 'HANG_FOREVER' }),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_TIMEOUT',
    });
    expect(service.getActiveSessionPids()).toEqual([]);
    expect(service.getSnapshot(session.id).session).toMatchObject({
      status: 'failed',
      canContinue: true,
    });
    await expect(
      service.promptSession({ sessionId: session.id, text: '超时后继续' }),
    ).resolves.toMatchObject({
      session: { status: 'idle' },
    });
  });

  it('运行中主动关闭后保留结束归档，并抑制旧轮次的失败通知', async () => {
    const { service, attention, workspaceRoot, harnessId } = createServicePair();
    const { session } = await service.openSession({ workspaceRoot, harnessId });
    await service.dispatchPrompt({ sessionId: session.id, text: 'HANG_FOREVER' });
    await service.closeSession(session.id);
    expect(service.getSnapshot(session.id).session.status).toBe('ended');
    expect(attention).not.toContain('turn_failed');
    expect(service.getActiveSessionPids()).toEqual([]);
  });

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

  it('损坏的 sessions.json 抛 EXTERNAL_CONFIG_CORRUPT 拒绝静默清空，死进程残留锁可自愈，且超大中文归档严格控制在 680KiB 内', () => {
    const homeDir = makeTempDir('kpbl-ext-reg-hardening-');
    const workspaceRoot = makeTempDir('kpbl-ext-reg-hardening-ws-');
    const registry = new ExternalSessionRegistry({ homeDir });

    // 1. 写入死进程残留锁（PID 99999999 不存在），验证自动摘除僵尸锁并正常落盘
    fs.mkdirSync(path.dirname(registry.sessionsFilePath), { recursive: true });
    fs.writeFileSync(
      `${registry.sessionsFilePath}.lock`,
      JSON.stringify({ owner: 'stale', pid: 99_999_999 }),
    );
    registry.upsertRecord({
      id: 'ext-stale-lock-ok',
      harnessId: 'opencode',
      harnessName: 'OpenCode',
      transport: 'acp',
      workspaceRoot,
      configDigest: 'sha256:demo',
      title: '僵尸锁自愈',
      status: 'ended',
      resumable: false,
      createdAt: 1,
      updatedAt: 1,
    });
    expect(registry.getRecord('ext-stale-lock-ok')?.title).toBe('僵尸锁自愈');

    // 2. 单条包含超长多字节中文与 Emoji 的归档，UTF-8 编码体积严格不超过 680 KiB 且 JSON 合法
    const hugeCjk = '中😀'.repeat(300_000);
    registry.saveArchive('ext-stale-lock-ok', {
      messages: [
        {
          id: 'm-cjk',
          role: 'assistant',
          state: 'completed',
          persisted: true,
          blocks: [
            { id: 'b0', kind: 'text', text: hugeCjk, state: 'completed', revision: 0 },
            {
              id: 'b1',
              kind: 'tool',
              text: 'tool',
              state: 'completed',
              revision: 0,
              tool: {
                callId: 'c1',
                name: 'bash',
                displayName: '终端命令',
                invocation: '运行',
                input: hugeCjk,
                result: hugeCjk,
                status: 'succeeded',
              },
            },
          ],
        },
      ],
    });
    const savedArchive = registry.readArchive('ext-stale-lock-ok');
    expect(savedArchive?.truncated).toBe(true);
    const snapshotFiles = fs.readdirSync(registry.snapshotsDirPath);
    expect(snapshotFiles).toHaveLength(1);
    const archiveStat = fs.statSync(path.join(registry.snapshotsDirPath, snapshotFiles[0]!));
    expect(archiveStat.size).toBeLessThanOrEqual(680 * 1024);

    // 3. 顶层结构非法或版本不符的 sessions.json 必须抛 EXTERNAL_CONFIG_CORRUPT，绝不在下次写入时抹空原文件
    fs.writeFileSync(registry.sessionsFilePath, JSON.stringify({ version: 99, sessions: [] }));
    expect(() => registry.listRecords()).toThrowError(
      expect.objectContaining({ code: 'EXTERNAL_CONFIG_CORRUPT' }),
    );
    expect(() =>
      registry.upsertRecord({
        id: 'ext-2',
        harnessId: 'opencode',
        harnessName: 'OpenCode',
        transport: 'acp',
        workspaceRoot,
        configDigest: 'sha256:demo',
        title: '不应覆盖损坏文件',
        status: 'ended',
        resumable: false,
        createdAt: 2,
        updatedAt: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: 'EXTERNAL_CONFIG_CORRUPT' }));
  });

  it('修复回归：Wire 错误映射、禁用存活会话联动、失败 open 清理幽灵记录、ACP 轮中崩溃转 failed 与工具流不刷爆列表事件', async () => {
    // 1. M3: Wire 错误码精确映射 EXTERNAL_APPROVAL_EXPIRED 与 EXTERNAL_HARNESS_DISABLED
    expect(toWireErrorCode(new ExternalHarnessError('EXTERNAL_APPROVAL_EXPIRED', 'expired'))).toBe(
      'APPROVAL_EXPIRED',
    );
    expect(toWireErrorCode(new ExternalHarnessError('EXTERNAL_HARNESS_DISABLED', 'disabled'))).toBe(
      'CONFIG_REQUIRED',
    );

    const homeDir = makeTempDir('kpbl-ext-svc-reg-home-');
    const workspaceRoot = makeTempDir('kpbl-ext-svc-reg-ws-');
    const settings = createUserSettingsSkeleton();
    trustProject(settings, workspaceRoot, { homeDir });

    const service = new ExternalSessionService({
      homeDir,
      hostEnv: {},
      drivers: {
        acp: new AcpStdioDriver({ homeDir, hostEnv: {} }),
      },
    });
    activeServices.push(service);

    // 2. M2: 握手失败的新会话不得在侧边栏残留 0 消息 failed 幽灵记录
    service.saveCustomHarness({
      id: 'broken-acp',
      name: 'Broken ACP',
      command: process.execPath,
      args: [fixtureScript, '--mode=agy-auth-fail'],
      flavor: 'antigravity',
      enabled: true,
    });
    await expect(
      service.openSession({ workspaceRoot, harnessId: 'broken-acp' }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_AUTH_REQUIRED' });
    expect(service.listSessions(workspaceRoot)).toHaveLength(0);

    // 3. H6 & H3: ACP 轮中崩溃应收敛为 failed 而非 idle/ended，且高频 tool_upsert 不重复轰炸 subscribeList
    service.saveCustomHarness({
      id: 'live-acp',
      name: 'Live ACP',
      command: process.execPath,
      args: [fixtureScript, '--mode=normal'],
      flavor: 'opencode',
      enabled: true,
    });
    const crashOpened = await service.openSession({ workspaceRoot, harnessId: 'live-acp' });
    await expect(
      service.promptSession({ sessionId: crashOpened.session.id, text: 'CRASH_MID_TURN' }),
    ).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 80));
    const afterCrash = service.getSnapshot(crashOpened.session.id, workspaceRoot);
    expect(afterCrash.session.status).toBe('failed');

    // 4. M1: 设置中停用外部代理后，内存中处于 idle 的存量会话立即关闭且禁止继续发送新轮次
    const idleOpened = await service.openSession({ workspaceRoot, harnessId: 'live-acp' });
    let listNotifies = 0;
    const unsubList = service.subscribeList(() => {
      listNotifies += 1;
    });
    await service.promptSession({ sessionId: idleOpened.session.id, text: 'HUGE_OUTPUT' });
    unsubList();
    // 单轮起止只通知有限次列表状态变化（running -> idle），绝不为每次块/工具输出刷列表
    expect(listNotifies).toBeLessThanOrEqual(4);

    service.toggleHarness('live-acp', false);
    await new Promise((r) => setTimeout(r, 80));
    const disabledSnap = service.getSnapshot(idleOpened.session.id, workspaceRoot);
    expect(disabledSnap.session.canContinue).toBe(false);
    await expect(
      service.promptSession({ sessionId: idleOpened.session.id, text: 'try after disable' }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_HARNESS_DISABLED' });
  });

  it('缓存 ACP 模型目录并支持新建选模型与会话内切换模型/模式/推理档位', async () => {
    const homeDir = makeTempDir('kpbl-ext-cfg-home-');
    const workspaceRoot = makeTempDir('kpbl-ext-cfg-ws-');
    const service = new ExternalSessionService({
      homeDir,
      isWorkspaceTrusted: () => true,
      idleTimeoutMs: 0,
    });
    activeServices.push(service);

    service.saveCustomHarness({
      id: 'sync-acp',
      name: '模型切换验收 ACP',
      command: process.execPath,
      args: [fixtureScript, '--mode=opencode-model-sync'],
      flavor: 'opencode',
      enabled: true,
    });

    // 探测一次后，可用模型目录自动落盘缓存，listHarnesses() 零冷启即可返回 cachedConfigOptions
    const probe = await service.testHarness('sync-acp', workspaceRoot);
    expect(probe.available).toBe(true);
    expect(probe.configOptions?.find((opt) => opt.category === 'model')?.options).toHaveLength(3);

    const listed = service.listHarnesses().harnesses.find((item) => item.id === 'sync-acp');
    expect(typeof listed?.cachedConfigUpdatedAt).toBe('number');
    expect(
      listed?.cachedConfigOptions?.find((opt) => opt.category === 'model')?.options,
    ).toHaveLength(3);
    expect(
      listed?.cachedConfigOptions
        ?.find((opt) => opt.category === 'thought_level')
        ?.options.map((o) => o.value),
    ).toEqual(['default', 'high', 'max']);

    // 启动无推理档位的 big-pickle 会话后，全局缓存不得丢失已探明的逐模型 supportedThoughtLevels 与 thought_level 目录
    const bigPickleOpened = await service.openSession({
      workspaceRoot,
      harnessId: 'sync-acp',
      modelId: 'opencode/big-pickle',
    });
    await service.closeSession(bigPickleOpened.session.id, workspaceRoot);
    const listedAfterBigPickle = service
      .listHarnesses()
      .harnesses.find((item) => item.id === 'sync-acp');
    expect(
      listedAfterBigPickle?.cachedConfigOptions
        ?.find((opt) => opt.category === 'thought_level')
        ?.options.map((o) => o.value),
    ).toEqual(['default', 'high', 'max']);
    expect(
      listedAfterBigPickle?.cachedConfigOptions
        ?.find((opt) => opt.category === 'model')
        ?.options.find((o) => o.value === 'opencode/deepseek-v4.1-flash-free')
        ?.supportedThoughtLevels,
    ).toEqual(['default', 'high', 'max']);

    // 新建会话显式指定 modelId
    const opened = await service.openSession({
      workspaceRoot,
      harnessId: 'sync-acp',
      modelId: 'opencode/deepseek-v4.1-flash-free',
    });
    expect(opened.session.modelLabel).toBe('opencode/DeepSeek V4.1 Flash Free');
    expect(opened.configOptions?.find((opt) => opt.category === 'model')?.currentValue).toBe(
      'opencode/deepseek-v4.1-flash-free',
    );

    // 会话内切换推理档位与模式
    const withEffort = await service.setSessionConfig({
      sessionId: opened.session.id,
      configId: 'effort',
      category: 'thought_level',
      value: 'max',
      expectedWorkspaceRoot: workspaceRoot,
    });
    expect(withEffort.session.thoughtLevelLabel).toBe('Max');

    const withMode = await service.setSessionConfig({
      sessionId: opened.session.id,
      configId: 'mode',
      category: 'mode',
      value: 'plan',
      expectedWorkspaceRoot: workspaceRoot,
    });
    expect(withMode.session.modeLabel).toBe('Plan');

    // 修改代理配置后旧缓存按 configDigest 自动失效
    service.saveCustomHarness({
      id: 'sync-acp',
      name: '模型切换验收 ACP',
      command: process.execPath,
      args: [fixtureScript, '--mode=normal'],
      flavor: 'opencode',
      enabled: true,
    });
    const afterChange = service.listHarnesses().harnesses.find((item) => item.id === 'sync-acp');
    expect(afterChange?.cachedConfigOptions).toBeUndefined();
  });

  it('setSessionConfig 在途期间拒绝并发发送或重复切换，且异常失败后正确重装空闲回收定时器', async () => {
    const homeDir = makeTempDir('kpbl-ext-cfg-race-home-');
    const workspaceRoot = makeTempDir('kpbl-ext-cfg-race-ws-');
    let releaseConfig!: () => void;
    let shouldFailConfig = false;
    let closedCount = 0;

    const service = new ExternalSessionService({
      homeDir,
      isWorkspaceTrusted: () => true,
      idleTimeoutMs: 60,
    });
    activeServices.push(service);

    service.registerDriver({
      transport: 'acp',
      inspect: async () => ({ available: true, status: 'ready', loadSupported: true }),
      open: async () => ({
        resumable: true,
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            currentValue: 'm1',
            options: [
              { value: 'm1', name: 'M1' },
              { value: 'm2', name: 'M2' },
            ],
          },
        ],
        handle: {
          pid: undefined,
          prompt: async () => ({ stopReason: 'completed' }),
          setConfigOption: async ({ value }) => {
            await new Promise<void>((resolve) => {
              releaseConfig = resolve;
            });
            if (shouldFailConfig) {
              throw new Error('config switch rejected');
            }
            return { modelLabel: value.toUpperCase() };
          },
          approve: async () => {},
          cancel: async () => {},
          close: async () => {
            closedCount += 1;
          },
        },
      }),
    });
    service.saveCustomHarness({
      id: 'race-acp',
      name: '并发守卫 ACP',
      command: process.execPath,
      args: [fixtureScript],
      enabled: true,
    });

    const opened = await service.openSession({ workspaceRoot, harnessId: 'race-acp' });
    const inFlight = service.setSessionConfig({
      sessionId: opened.session.id,
      configId: 'model',
      category: 'model',
      value: 'm2',
      expectedWorkspaceRoot: workspaceRoot,
    });

    await expect(
      service.promptSession({
        sessionId: opened.session.id,
        text: 'concurrent prompt',
        expectedWorkspaceRoot: workspaceRoot,
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_SESSION_BUSY' });

    releaseConfig();
    const settled = await inFlight;
    expect(settled.session.modelLabel).toBe('M2');

    // 验证 setConfigOption 抛错后 idleTimer 仍正常重装并触发空闲回收
    shouldFailConfig = true;
    const failedSwitch = service.setSessionConfig({
      sessionId: opened.session.id,
      configId: 'model',
      category: 'model',
      value: 'bad',
      expectedWorkspaceRoot: workspaceRoot,
    });
    await new Promise((resolve) => setImmediate(resolve));
    releaseConfig();
    await expect(failedSwitch).rejects.toThrow(/config switch rejected/);

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(closedCount).toBeGreaterThanOrEqual(1);
  });
});
