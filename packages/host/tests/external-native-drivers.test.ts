import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ClaudeCliDriver,
  CodexAppServerDriver,
  type ExternalEvent,
  type ExternalHarnessError,
  ExternalSessionService,
  PiRpcDriver,
  saveBuiltinHarnessOverride,
  upsertCustomExternalHarness,
} from '../src/host/internal.js';
import { createUserSettingsSkeleton, trustProject } from '../src/host/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeClaudeScript = path.join(__dirname, 'fixtures', 'fake-claude-cli.mjs');
const fakeCodexScript = path.join(__dirname, 'fixtures', 'fake-codex-app-server.mjs');
const fakePiScript = path.join(__dirname, 'fixtures', 'fake-pi-rpc.mjs');
const fakeAcpScript = path.join(__dirname, 'fixtures', 'fake-acp-agent.mjs');

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('ClaudeCliDriver, CodexAppServerDriver & Multi-Workspace Concurrency (M3)', () => {
  const tempDirs: string[] = [];
  const services: ExternalSessionService[] = [];
  const closeHandles: Array<() => Promise<void>> = [];

  function makeTempDir(prefix: string): string {
    const raw = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const dir = fs.realpathSync.native(raw);
    tempDirs.push(dir);
    return dir;
  }

  afterEach(async () => {
    while (closeHandles.length > 0) {
      const fn = closeHandles.pop();
      if (fn) await fn().catch(() => {});
    }
    while (services.length > 0) {
      const svc = services.pop();
      if (svc) await svc.dispose();
    }
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ClaudeCliDriver 完整覆盖 inspect、流式输出、TodoWrite 计划、can_use_tool 允许/拒绝、中断与 --resume', async () => {
    const cwd = makeTempDir('kpbl-m3-claude-');
    const driver = new ClaudeCliDriver({ hostEnv: {} });

    const readyProbe = await driver.inspect(
      {
        id: 'claude-code',
        name: 'Claude Code',
        transport: 'claude-cli',
        command: process.execPath,
        args: [fakeClaudeScript],
        enabled: true,
      },
      cwd,
    );
    expect(readyProbe.available).toBe(true);
    expect(readyProbe.status).toBe('ready');
    expect(readyProbe.version).toBe('2.1.325');

    const loginProbe = await driver.inspect(
      {
        id: 'claude-code',
        name: 'Claude Code',
        transport: 'claude-cli',
        command: process.execPath,
        args: [fakeClaudeScript, '--auth-fail'],
        enabled: true,
      },
      cwd,
    );
    expect(loginProbe.available).toBe(false);
    expect(loginProbe.status).toBe('needs_login');
    expect(loginProbe.loginHint).toBe('claude auth login');

    const events: ExternalEvent[] = [];
    const opened = await driver.open({
      def: {
        id: 'claude-code',
        name: 'Claude Code',
        transport: 'claude-cli',
        command: process.execPath,
        args: [fakeClaudeScript],
        enabled: true,
      },
      workspaceRoot: cwd,
      onEvent: (ev) => {
        events.push(ev);
        if (ev.type === 'approval_requested') {
          if (events.filter((x) => x.type === 'approval_requested').length === 1) {
            ev.respond({ outcome: 'selected', optionId: 'allow_once' });
          } else {
            ev.respond({ outcome: 'selected', optionId: 'reject_once' });
          }
        }
      },
    });
    closeHandles.push(() => opened.handle.close());
    expect(opened.resumable).toBe(true);

    // 1. 常规流式 + TodoWrite 计划
    const res1 = await opened.handle.prompt('show plan please');
    expect(res1.stopReason).toBe('completed');
    expect(res1.usage?.totalTokens).toBe(70);
    expect(events.some((e) => e.type === 'plan_updated' && e.items.length === 2)).toBe(true);
    const cfgEv = events.find((e) => e.type === 'config_updated' && e.nativeSessionId);
    expect(cfgEv && cfgEv.type === 'config_updated' ? cfgEv.nativeSessionId : '').toContain(
      'claude-sess-',
    );
    const savedSessionId =
      cfgEv && cfgEv.type === 'config_updated' ? cfgEv.nativeSessionId : undefined;

    // 2. can_use_tool 允许（校验 updatedInput 完整回传）
    const resAllow = await opened.handle.prompt('need approval');
    expect(resAllow.stopReason).toBe('completed');
    expect(
      events.some((e) => e.type === 'text_delta' && e.text.includes('Approved and executed!')),
    ).toBe(true);

    // 3. can_use_tool 拒绝
    const resDeny = await opened.handle.prompt('need approval again');
    expect(resDeny.stopReason).toBe('completed');
    expect(
      events.some((e) => e.type === 'text_delta' && e.text.includes('Tool execution denied.')),
    ).toBe(true);

    // 4. interrupt 取消当前慢轮次
    const slowPromise = opened.handle.prompt('run slow task');
    await new Promise((r) => setTimeout(r, 80));
    await opened.handle.cancel();
    const resCancel = await slowPromise;
    expect(resCancel.stopReason).toBe('cancelled');

    await opened.handle.close();

    // 5. --resume 跨进程恢复
    const resumedTexts: string[] = [];
    const reopened = await driver.open({
      def: {
        id: 'claude-code',
        name: 'Claude Code',
        transport: 'claude-cli',
        command: process.execPath,
        args: [fakeClaudeScript],
        enabled: true,
      },
      workspaceRoot: cwd,
      nativeSessionId: savedSessionId,
      onEvent: (ev) => {
        if (ev.type === 'text_delta') resumedTexts.push(ev.text);
      },
    });
    closeHandles.push(() => reopened.handle.close());
    await reopened.handle.prompt('after resume');
    expect(resumedTexts.join('')).toContain(`[resumed:${savedSessionId}]`);
    await reopened.handle.close();
  });

  it('CodexAppServerDriver 严格走无 jsonrpc 字段的 jsonrpc_lite，覆盖探测、流式后缀去重、双向审批、中断与 thread/resume', async () => {
    const cwd = makeTempDir('kpbl-m3-codex-');
    const driver = new CodexAppServerDriver({ hostEnv: {} });

    const readyProbe = await driver.inspect(
      {
        id: 'codex',
        name: 'Codex',
        transport: 'codex-app-server',
        command: process.execPath,
        args: [fakeCodexScript],
        enabled: true,
      },
      cwd,
    );
    expect(readyProbe.available).toBe(true);
    expect(readyProbe.status).toBe('ready');
    expect(readyProbe.version).toBe('0.171.0');

    const loginProbe = await driver.inspect(
      {
        id: 'codex',
        name: 'Codex',
        transport: 'codex-app-server',
        command: process.execPath,
        args: [fakeCodexScript, '--unauthenticated'],
        enabled: true,
      },
      cwd,
    );
    expect(loginProbe.available).toBe(false);
    expect(loginProbe.status).toBe('needs_login');
    expect(loginProbe.loginHint).toBe('codex login');

    const texts: string[] = [];
    const events: ExternalEvent[] = [];
    const opened = await driver.open({
      def: {
        id: 'codex',
        name: 'Codex',
        transport: 'codex-app-server',
        command: process.execPath,
        args: [fakeCodexScript],
        enabled: true,
      },
      workspaceRoot: cwd,
      onEvent: (ev) => {
        events.push(ev);
        if (ev.type === 'text_delta') texts.push(ev.text);
        if (ev.type === 'approval_requested') {
          ev.respond({ outcome: 'selected', optionId: 'acceptForSession' });
        }
      },
    });
    closeHandles.push(() => opened.handle.close());
    expect(opened.resumable).toBe(true);
    expect(opened.nativeSessionId).toContain('codex-thread-');
    expect(opened.modelLabel).toBe('gpt-5.2-codex');
    expect(opened.modeLabel).toBe('workspaceWrite');

    // 1. 流式增量 + item/completed 尾缀补齐无重复 + 计划与 tokenUsage
    const res1 = await opened.handle.prompt('hello codex');
    expect(res1.stopReason).toBe('completed');
    expect(res1.usage?.totalTokens).toBe(90);
    expect(texts.join('')).toBe(`Codex [${opened.nativeSessionId}] reply: hello codex`);
    expect(events.some((e) => e.type === 'plan_updated' && e.items.length === 2)).toBe(true);

    // 2. 命令审批（acceptForSession）
    texts.length = 0;
    const resApr = await opened.handle.prompt('trigger approval');
    expect(resApr.stopReason).toBe('completed');
    expect(texts.join('')).toContain('Codex approved (acceptForSession)');

    // 3. turn/interrupt 取消
    const slowTurn = opened.handle.prompt('slow codex turn');
    await new Promise((r) => setTimeout(r, 80));
    await opened.handle.cancel();
    const resCancel = await slowTurn;
    expect(resCancel.stopReason).toBe('cancelled');

    const savedThreadId = opened.nativeSessionId!;
    await opened.handle.close();

    // 4. thread/resume 恢复同一 threadId
    const resumedTexts: string[] = [];
    const resumed = await driver.open({
      def: {
        id: 'codex',
        name: 'Codex',
        transport: 'codex-app-server',
        command: process.execPath,
        args: [fakeCodexScript],
        enabled: true,
      },
      workspaceRoot: cwd,
      nativeSessionId: savedThreadId,
      onEvent: (ev) => {
        if (ev.type === 'text_delta') resumedTexts.push(ev.text);
      },
    });
    closeHandles.push(() => resumed.handle.close());
    await resumed.handle.prompt('back again');
    expect(resumed.nativeSessionId).toBe(savedThreadId);
    expect(resumedTexts.join('')).toContain(`Codex [${savedThreadId}] reply: back again`);
    await resumed.handle.close();
  });

  it('三工作区三驱动（acp + claude-cli + codex-app-server）并行零串流、空闲自动回收恢复与退出零孤儿进程', async () => {
    const homeDir = makeTempDir('kpbl-m3-multi-home-');
    const wsA = makeTempDir('kpbl-m3-ws-acp-');
    const wsB = makeTempDir('kpbl-m3-ws-claude-');
    const wsC = makeTempDir('kpbl-m3-ws-codex-');
    const wsD = makeTempDir('kpbl-m3-ws-overflow-');

    const settings = createUserSettingsSkeleton();
    for (const ws of [wsA, wsB, wsC, wsD]) {
      trustProject(settings, ws, { homeDir });
    }

    upsertCustomExternalHarness(
      {
        id: 'custom-acp',
        name: 'Fake OpenCode ACP',
        command: process.execPath,
        args: [fakeAcpScript, '--mode=opencode'],
        enabled: true,
      },
      { homeDir },
    );
    saveBuiltinHarnessOverride(
      'claude-code',
      {
        command: process.execPath,
        args: [fakeClaudeScript],
        enabled: true,
      },
      { homeDir },
    );
    saveBuiltinHarnessOverride(
      'codex',
      {
        command: process.execPath,
        args: [fakeCodexScript],
        enabled: true,
      },
      { homeDir },
    );

    const service = new ExternalSessionService({
      homeDir,
      hostEnv: {},
      maxActiveProcesses: 3,
      idleTimeoutMs: 250,
    });
    services.push(service);

    const [openA, openB, openC] = await Promise.all([
      service.openSession({ workspaceRoot: wsA, harnessId: 'custom-acp' }),
      service.openSession({ workspaceRoot: wsB, harnessId: 'claude-code' }),
      service.openSession({ workspaceRoot: wsC, harnessId: 'codex' }),
    ]);

    // 全局并发进程数达上限（3）时，第 4 个工作区启动报 EXTERNAL_CAPACITY
    await expect(
      service.openSession({ workspaceRoot: wsD, harnessId: 'custom-acp' }),
    ).rejects.toMatchObject({
      code: 'EXTERNAL_CAPACITY',
    } satisfies Partial<ExternalHarnessError>);

    // 三个会话跨工作区并发执行 Prompt，断言各自输出严格隔离零串流
    const [snapA, snapB, snapC] = await Promise.all([
      service.promptSession({ sessionId: openA.session.id, text: 'task-alpha' }),
      service.promptSession({ sessionId: openB.session.id, text: 'task-bravo' }),
      service.promptSession({ sessionId: openC.session.id, text: 'task-charlie' }),
    ]);

    const bodyOf = (snap: typeof snapA) =>
      snap.messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.blocks)
        .map((b) => b.text)
        .join('');

    expect(bodyOf(snapA)).toContain('task-alpha');
    expect(bodyOf(snapA)).not.toContain('task-bravo');
    expect(bodyOf(snapA)).not.toContain('task-charlie');

    expect(bodyOf(snapB)).toContain('Claude reply: task-bravo');
    expect(bodyOf(snapB)).not.toContain('task-alpha');
    expect(bodyOf(snapB)).not.toContain('task-charlie');

    expect(bodyOf(snapC)).toContain('reply: task-charlie');
    expect(bodyOf(snapC)).not.toContain('task-alpha');
    expect(bodyOf(snapC)).not.toContain('task-bravo');

    const activePidsBeforeReap = service.getActiveSessionPids();
    expect(activePidsBeforeReap).toHaveLength(3);

    // 等待空闲回收触发（idleTimeoutMs = 250ms）：全部子进程自动优雅退出，但只读归档依然可读且可无缝恢复
    await new Promise((r) => setTimeout(r, 500));
    expect(service.getActiveSessionPids()).toHaveLength(0);
    for (const pid of activePidsBeforeReap) {
      expect(isPidAlive(pid)).toBe(false);
    }

    const archivedClaude = service.getSnapshot(openB.session.id);
    expect(archivedClaude.session.hasArchive).toBe(true);
    expect(archivedClaude.session.canContinue).toBe(true);
    expect(bodyOf(archivedClaude)).toContain('Claude reply: task-bravo');

    // 向已回收的 Claude 与 Codex 会话继续发送新轮次，验证自动拉起并走 --resume / thread/resume
    const resumedClaude = await service.promptSession({
      sessionId: openB.session.id,
      text: 'second-turn-claude',
    });
    expect(bodyOf(resumedClaude)).toContain('[resumed:');
    expect(bodyOf(resumedClaude)).toContain('second-turn-claude');

    const resumedCodex = await service.promptSession({
      sessionId: openC.session.id,
      text: 'second-turn-codex',
    });
    expect(bodyOf(resumedCodex)).toContain('second-turn-codex');

    const pidsBeforeDispose = service.getActiveSessionPids();
    expect(pidsBeforeDispose.length).toBeGreaterThan(0);

    // 宿主退出全量清理：验证零孤儿进程残留
    await service.dispose();
    expect(service.getActiveSessionPids()).toHaveLength(0);
    for (const pid of pidsBeforeDispose) {
      expect(isPidAlive(pid)).toBe(false);
    }
  });

  it('子进程异常崩溃时拒绝在途轮次并将外部会话收敛为 failed', async () => {
    const homeDir = makeTempDir('kpbl-m3-crash-home-');
    const ws = makeTempDir('kpbl-m3-crash-ws-');
    const settings = createUserSettingsSkeleton();
    trustProject(settings, ws, { homeDir });

    saveBuiltinHarnessOverride(
      'claude-code',
      {
        command: process.execPath,
        args: [fakeClaudeScript],
        enabled: true,
      },
      { homeDir },
    );

    const service = new ExternalSessionService({ homeDir, hostEnv: {} });
    services.push(service);

    const opened = await service.openSession({ workspaceRoot: ws, harnessId: 'claude-code' });
    await expect(
      service.promptSession({ sessionId: opened.session.id, text: 'please crash now' }),
    ).rejects.toThrow();

    await new Promise((r) => setTimeout(r, 60));
    const snap = service.getSnapshot(opened.session.id);
    expect(snap.session.status).toBe('failed');
  });

  it('PiRpcDriver 挂载真实受管审批守卫扩展，完整覆盖探测、只读免审、bash 允许/会话放行/拒绝、abort 取消与 --session-id 恢复', async () => {
    const homeDir = makeTempDir('kpbl-m3-pi-home-');
    const cwd = makeTempDir('kpbl-m3-pi-ws-');
    const driver = new PiRpcDriver({ homeDir, hostEnv: {} });

    const readyProbe = await driver.inspect(
      {
        id: 'pi',
        name: 'Pi Coding Agent',
        transport: 'pi-rpc',
        command: process.execPath,
        args: [fakePiScript],
        enabled: true,
      },
      cwd,
    );
    expect(readyProbe.available).toBe(true);
    expect(readyProbe.status).toBe('ready');
    expect(readyProbe.version).toBe('1.6.0');
    expect(readyProbe.loadSupported).toBe(true);

    const loginProbe = await driver.inspect(
      {
        id: 'pi',
        name: 'Pi Coding Agent',
        transport: 'pi-rpc',
        command: process.execPath,
        args: [fakePiScript, '--unauthenticated'],
        enabled: true,
      },
      cwd,
    );
    expect(loginProbe.available).toBe(false);
    expect(loginProbe.status).toBe('needs_login');

    let approvalCount = 0;
    const texts: string[] = [];
    const opened = await driver.open({
      def: {
        id: 'pi',
        name: 'Pi Coding Agent',
        transport: 'pi-rpc',
        command: process.execPath,
        args: [fakePiScript],
        enabled: true,
      },
      workspaceRoot: cwd,
      onEvent: (ev) => {
        if (ev.type === 'text_delta') texts.push(ev.text);
        if (ev.type === 'approval_requested') {
          approvalCount += 1;
          if (approvalCount === 1) {
            ev.respond({ outcome: 'selected', optionId: 'reject_once' });
          } else {
            ev.respond({ outcome: 'selected', optionId: 'allow_session' });
          }
        }
      },
    });
    closeHandles.push(() => opened.handle.close());
    expect(opened.resumable).toBe(true);
    expect(opened.nativeSessionId).toBe('11111111-2222-4333-8444-555555555555');

    // 1. 只读工具 read 不触发审批直接放行
    texts.length = 0;
    await opened.handle.prompt('READ_ONLY_TOOL');
    expect(approvalCount).toBe(0);
    expect(texts.join('')).toContain('Read README without approval.');

    // 2. 写执行工具 bash 第 1 次被拒绝，扩展返回 { block: true }
    texts.length = 0;
    await opened.handle.prompt('WRITE_APPROVAL_1');
    expect(approvalCount).toBe(1);
    expect(texts.join('')).toContain('Pi tool blocked:');

    // 3. 第 2 次选择 allow_session 放行，第 3 次同类工具在同一会话免重复弹窗
    texts.length = 0;
    await opened.handle.prompt('WRITE_APPROVAL_2');
    expect(approvalCount).toBe(2);
    expect(texts.join('')).toContain('Pi bash executed!');

    texts.length = 0;
    await opened.handle.prompt('WRITE_APPROVAL_3');
    expect(approvalCount).toBe(2);
    expect(texts.join('')).toContain('Pi bash executed!');

    // 4. abort 取消在途轮次
    const slowTurn = opened.handle.prompt('WAIT_ABORT');
    await new Promise((r) => setTimeout(r, 60));
    await opened.handle.cancel();
    const cancelRes = await slowTurn;
    expect(cancelRes.stopReason).toBe('cancelled');

    const savedId = opened.nativeSessionId!;
    await opened.handle.close();

    // 5. --session-id 恢复同一会话，且拦截恶意的 -flag 注入型会话 ID
    await expect(
      driver.open({
        def: {
          id: 'pi',
          name: 'Pi Coding Agent',
          transport: 'pi-rpc',
          command: process.execPath,
          args: [fakePiScript],
          enabled: true,
        },
        workspaceRoot: cwd,
        nativeSessionId: '--dangerously-skip-permissions',
        onEvent: () => {},
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_PROTOCOL_ERROR' });

    const resumedTexts: string[] = [];
    const resumed = await driver.open({
      def: {
        id: 'pi',
        name: 'Pi Coding Agent',
        transport: 'pi-rpc',
        command: process.execPath,
        args: [fakePiScript],
        enabled: true,
      },
      workspaceRoot: cwd,
      nativeSessionId: savedId,
      onEvent: (ev) => {
        if (ev.type === 'text_delta') resumedTexts.push(ev.text);
      },
    });
    closeHandles.push(() => resumed.handle.close());
    await resumed.handle.prompt('continue in pi');
    expect(resumedTexts.join('')).toContain(`[pi-resumed:${savedId}] Pi reply: continue in pi`);
    await resumed.handle.close();
  });

  it('Claude 多步工具调用不丢失后续非流式文本、拦截非法 --resume 参数，且 Codex 支持在 turn/start 返回前提前取消', async () => {
    const cwd = makeTempDir('kpbl-m3-edge-');
    const claudeDriver = new ClaudeCliDriver({ hostEnv: {} });

    await expect(
      claudeDriver.open({
        def: {
          id: 'claude-code',
          name: 'Claude Code',
          transport: 'claude-cli',
          command: process.execPath,
          args: [fakeClaudeScript],
          enabled: true,
        },
        workspaceRoot: cwd,
        nativeSessionId: '-p',
        onEvent: () => {},
      }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_PROTOCOL_ERROR' });

    const claudeTexts: string[] = [];
    const claudeOpened = await claudeDriver.open({
      def: {
        id: 'claude-code',
        name: 'Claude Code',
        transport: 'claude-cli',
        command: process.execPath,
        args: [fakeClaudeScript],
        enabled: true,
      },
      workspaceRoot: cwd,
      onEvent: (ev) => {
        if (ev.type === 'text_delta') claudeTexts.push(ev.text);
      },
    });
    closeHandles.push(() => claudeOpened.handle.close());
    await claudeOpened.handle.prompt('run multistep check');
    expect(claudeTexts.join('')).toBe('Step1 streamed. Step2 non-streamed!');
    await claudeOpened.handle.close();

    const codexDriver = new CodexAppServerDriver({ hostEnv: {} });
    const codexOpened = await codexDriver.open({
      def: {
        id: 'codex',
        name: 'Codex',
        transport: 'codex-app-server',
        command: process.execPath,
        args: [fakeCodexScript],
        enabled: true,
      },
      workspaceRoot: cwd,
      onEvent: () => {},
    });
    closeHandles.push(() => codexOpened.handle.close());
    const earlyCancelPromise = codexOpened.handle.prompt('delayed-start turn');
    await new Promise((r) => setTimeout(r, 25));
    await codexOpened.handle.cancel();
    const earlyCancelRes = await earlyCancelPromise;
    expect(earlyCancelRes.stopReason).toBe('cancelled');
    await codexOpened.handle.close();
  });

  it('Codex 多轮复用相同 itemId 不截断第 2 轮正文与思考，且 Claude control_cancel_request 同步清理挂起审批卡片', async () => {
    const homeDir = makeTempDir('kpbl-m3-turn2-home-');
    const cwd = makeTempDir('kpbl-m3-turn2-ws-');
    const settings = createUserSettingsSkeleton();
    trustProject(settings, cwd, { homeDir });

    // 1. H4: 同一 Codex 进程连续两轮均使用 itemId='msg-1' / 'rsn-1'
    const codexDriver = new CodexAppServerDriver({ hostEnv: {} });
    let turnTexts: string[] = [];
    let turnThoughts: string[] = [];
    const codexOpened = await codexDriver.open({
      def: {
        id: 'codex',
        name: 'Codex',
        transport: 'codex-app-server',
        command: process.execPath,
        args: [fakeCodexScript],
        enabled: true,
      },
      workspaceRoot: cwd,
      onEvent: (ev) => {
        if (ev.type === 'text_delta') turnTexts.push(ev.text);
        if (ev.type === 'thought_delta') turnThoughts.push(ev.text);
      },
    });
    closeHandles.push(() => codexOpened.handle.close());

    await codexOpened.handle.prompt('first question');
    expect(turnTexts.join('')).toBe(`Codex [${codexOpened.nativeSessionId}] reply: first question`);
    expect(turnThoughts.join('')).toBe('Thinking in Codex...');

    turnTexts = [];
    turnThoughts = [];
    await codexOpened.handle.prompt('second question');
    expect(turnTexts.join('')).toBe(
      `Codex [${codexOpened.nativeSessionId}] reply: second question`,
    );
    expect(turnThoughts.join('')).toBe('Thinking in Codex...');
    await codexOpened.handle.close();

    // 2. M4: Claude 发出 control_request 后主动发 control_cancel_request 撤回时，Service 不得残留僵尸审批卡
    saveBuiltinHarnessOverride(
      'claude-code',
      {
        command: process.execPath,
        args: [fakeClaudeScript],
        enabled: true,
      },
      { homeDir },
    );
    const service = new ExternalSessionService({ homeDir, hostEnv: {} });
    services.push(service);
    const claudeSnap1 = await service.openSession({ workspaceRoot: cwd, harnessId: 'claude-code' });
    const settled = await service.promptSession({
      sessionId: claudeSnap1.session.id,
      text: 'please cancel-approval',
    });
    expect(settled.approvals).toHaveLength(0);
    expect(settled.session.status).toBe('idle');
    expect(settled.session.resumable).toBe(true);
    expect(settled.messages.at(-1)?.blocks.some((b) => b.text.includes('Approval withdrawn'))).toBe(
      true,
    );
  });

  it('Codex / Claude Code / Pi 三大原生直连驱动均暴露可选模型与推理强度目录，并支持建会话预设与空闲态热切换', async () => {
    const homeDir = makeTempDir('kpbl-m3-cfg-home-');
    const wsCodex = makeTempDir('kpbl-m3-cfg-codex-');
    const wsClaude = makeTempDir('kpbl-m3-cfg-claude-');
    const wsPi = makeTempDir('kpbl-m3-cfg-pi-');
    const settings = createUserSettingsSkeleton();
    for (const ws of [wsCodex, wsClaude, wsPi]) {
      trustProject(settings, ws, { homeDir });
    }

    saveBuiltinHarnessOverride(
      'codex',
      { command: process.execPath, args: [fakeCodexScript], enabled: true },
      { homeDir },
    );
    saveBuiltinHarnessOverride(
      'claude-code',
      { command: process.execPath, args: [fakeClaudeScript], enabled: true },
      { homeDir },
    );
    saveBuiltinHarnessOverride(
      'pi',
      { command: process.execPath, args: [fakePiScript], enabled: true },
      { homeDir },
    );

    const service = new ExternalSessionService({ homeDir, hostEnv: {} });
    services.push(service);

    // 1. 探测阶段（testHarness）均返回结构化 configOptions 并落盘到 cachedConfigOptions
    const [codexProbe, claudeProbe, piProbe] = await Promise.all([
      service.testHarness('codex', wsCodex),
      service.testHarness('claude-code', wsClaude),
      service.testHarness('pi', wsPi),
    ]);

    const codexModelOpt = codexProbe.configOptions?.find((o) => o.category === 'model');
    expect(codexModelOpt?.options.map((c) => c.value)).toEqual([
      'gpt-5.2-codex',
      'gpt-6-astra',
      'gpt-6-luna',
    ]);
    const codexLuna = codexModelOpt?.options.find((c) => c.value === 'gpt-6-luna');
    expect(codexLuna?.supportedThoughtLevels).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(
      codexProbe.configOptions
        ?.find((o) => o.category === 'thought_level')
        ?.options.map((c) => c.name),
    ).toContain('Extra High');

    const claudeModelOpt = claudeProbe.configOptions?.find((o) => o.category === 'model');
    expect(claudeModelOpt?.options.some((c) => c.value === 'fable')).toBe(true);
    expect(claudeProbe.configOptions?.some((o) => o.category === 'thought_level')).toBe(true);
    expect(claudeProbe.configOptions?.some((o) => o.category === 'mode')).toBe(true);

    const piModelOpt = piProbe.configOptions?.find((o) => o.category === 'model');
    expect(piModelOpt?.options.map((c) => c.value)).toEqual([
      'anthropic/claude-sonnet-4-6',
      'magpie/deepseek/deepseek-flash',
    ]);
    const piFlash = piModelOpt?.options.find((c) => c.value === 'magpie/deepseek/deepseek-flash');
    expect(piFlash?.supportedThoughtLevels).toEqual(['off', 'low', 'high', 'max']);

    // 2. Codex 建会话预设模型与推理强度，并在空闲态动态切换模型与推理档位
    const codexSnap0 = await service.openSession({
      workspaceRoot: wsCodex,
      harnessId: 'codex',
      modelId: 'gpt-6-astra',
      thoughtLevel: 'high',
    });
    expect(codexSnap0.session.modelLabel).toBe('GPT-6-Astra');
    expect(codexSnap0.session.thoughtLevelLabel).toBe('High');

    const codexSnap1 = await service.promptSession({
      sessionId: codexSnap0.session.id,
      text: 'echo-config',
    });
    expect(
      codexSnap1.messages
        .at(-1)
        ?.blocks.map((b) => b.text)
        .join(''),
    ).toContain('model=gpt-6-astra, effort=high');

    const codexUpdated = await service.setSessionConfig({
      sessionId: codexSnap0.session.id,
      configId: 'thought_level',
      category: 'thought_level',
      value: 'xhigh',
      expectedWorkspaceRoot: wsCodex,
    });
    expect(codexUpdated.session.thoughtLevelLabel).toBe('Extra High');
    const codexSnap2 = await service.promptSession({
      sessionId: codexSnap0.session.id,
      text: 'echo-config',
    });
    expect(
      codexSnap2.messages
        .at(-1)
        ?.blocks.map((b) => b.text)
        .join(''),
    ).toContain('model=gpt-6-astra, effort=xhigh');

    // 3. Claude Code 建会话预设模型/推理/模式，并在空闲态热切换 set_model 与 set_permission_mode
    const claudeSnap0 = await service.openSession({
      workspaceRoot: wsClaude,
      harnessId: 'claude-code',
      modelId: 'fable',
      thoughtLevel: 'high',
      modeId: 'plan',
    });
    const claudeSnap1 = await service.promptSession({
      sessionId: claudeSnap0.session.id,
      text: 'echo-config',
    });
    expect(
      claudeSnap1.messages
        .at(-1)
        ?.blocks.map((b) => b.text)
        .join(''),
    ).toContain('model=fable, effort=high, mode=plan');

    await service.setSessionConfig({
      sessionId: claudeSnap0.session.id,
      configId: 'mode',
      category: 'mode',
      value: 'acceptEdits',
      expectedWorkspaceRoot: wsClaude,
    });
    const claudeSnap2 = await service.promptSession({
      sessionId: claudeSnap0.session.id,
      text: 'echo-config',
    });
    expect(
      claudeSnap2.messages
        .at(-1)
        ?.blocks.map((b) => b.text)
        .join(''),
    ).toContain('mode=acceptEdits');

    // 4. Pi RPC 建会话预设模型与推理档位，并在空闲态热切换
    const piSnap0 = await service.openSession({
      workspaceRoot: wsPi,
      harnessId: 'pi',
      modelId: 'magpie/deepseek/deepseek-flash',
      thoughtLevel: 'high',
    });
    expect(piSnap0.session.thoughtLevelLabel).toBe('High');
    const piSnap1 = await service.promptSession({
      sessionId: piSnap0.session.id,
      text: 'ECHO_CONFIG',
    });
    expect(
      piSnap1.messages
        .at(-1)
        ?.blocks.map((b) => b.text)
        .join(''),
    ).toContain('model=magpie/deepseek/deepseek-flash, thinking=high');

    await service.setSessionConfig({
      sessionId: piSnap0.session.id,
      configId: 'thought_level',
      category: 'thought_level',
      value: 'max',
      expectedWorkspaceRoot: wsPi,
    });
    const piSnap2 = await service.promptSession({
      sessionId: piSnap0.session.id,
      text: 'ECHO_CONFIG',
    });
    expect(
      piSnap2.messages
        .at(-1)
        ?.blocks.map((b) => b.text)
        .join(''),
    ).toContain('thinking=max');
  });
});
