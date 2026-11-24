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
  saveBuiltinHarnessOverride,
  upsertCustomExternalHarness,
} from '../src/host/internal.js';
import { createUserSettingsSkeleton, trustProject } from '../src/host/settings.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fakeClaudeScript = path.join(__dirname, 'fixtures', 'fake-claude-cli.mjs');
const fakeCodexScript = path.join(__dirname, 'fixtures', 'fake-codex-app-server.mjs');
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
});
