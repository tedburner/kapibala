import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAX_LIVE_TERMINALS,
  MAX_SESSION_TERMINALS,
  type PtyModuleLike,
  type PtyProcessLike,
  TerminalService,
  type TerminalServiceEvent,
  buildSanitizedTerminalEnv,
} from '../src/agent-host/terminal-service.js';
import { safeError } from '../src/shared/rpc.js';

class FakePtyProcess implements PtyProcessLike {
  readonly pid: number;
  killed = false;
  cols: number;
  rows: number;
  private dataListeners: Array<(data: string) => void> = [];
  private exitListeners: Array<(event: { exitCode: number; signal?: number }) => void> = [];

  constructor(cols = 80, rows = 24, pid = 0) {
    this.cols = cols;
    this.rows = rows;
    this.pid = pid;
  }

  emitData(data: string): void {
    for (const fn of this.dataListeners) fn(data);
  }

  write(data: string): void {
    for (const fn of this.dataListeners) fn(`ECHO:${data}`);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    for (const fn of this.exitListeners) fn({ exitCode: 0 });
  }

  emitExit(exitCode: number): void {
    this.killed = true;
    for (const fn of this.exitListeners) fn({ exitCode });
  }

  onData(listener: (data: string) => void) {
    this.dataListeners.push(listener);
    return {
      dispose: () => {
        this.dataListeners = this.dataListeners.filter((item) => item !== listener);
      },
    };
  }

  onExit(listener: (event: { exitCode: number; signal?: number }) => void) {
    this.exitListeners.push(listener);
    return {
      dispose: () => {
        this.exitListeners = this.exitListeners.filter((item) => item !== listener);
      },
    };
  }
}

describe('TerminalService', () => {
  const tempDirs: string[] = [];
  const activeServices: TerminalService[] = [];

  const createTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-term-svc-'));
    tempDirs.push(dir);
    return dir;
  };

  afterEach(async () => {
    for (const svc of activeServices.splice(0)) {
      await svc.dispose();
    }
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    }
  });

  it('sanitizes Electron and harness poison variables while injecting truecolor TERM', () => {
    const clean = buildSanitizedTerminalEnv(
      {
        PATH: '/usr/bin',
        ELECTRON_RUN_AS_NODE: '1',
        NODE_OPTIONS: '--inspect',
        KPBL_EXTERNAL_FORWARDED_ENV: 'secret',
        VSCODE_PID: '999',
        CUSTOM_USER_VAR: 'kept',
      },
      'linux',
    );
    expect(clean.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(clean.NODE_OPTIONS).toBeUndefined();
    expect(clean.KPBL_EXTERNAL_FORWARDED_ENV).toBeUndefined();
    expect(clean.VSCODE_PID).toBeUndefined();
    expect(clean.CUSTOM_USER_VAR).toBe('kept');
    expect(clean.TERM).toBe('xterm-256color');
    expect(clean.COLORTERM).toBe('truecolor');
    expect(clean.LANG).toBe('en_US.UTF-8');
  });

  it('hydrates replay across ensure calls, enforces 3-per-session & 8-global caps, and cleans up by session/cwd', async () => {
    const cwdA = createTempDir();
    const cwdB = createTempDir();
    const spawned: FakePtyProcess[] = [];
    const events: TerminalServiceEvent[] = [];

    const fakeModule: PtyModuleLike = {
      spawn: (_file, _args, opts) => {
        const proc = new FakePtyProcess(opts.cols, opts.rows);
        spawned.push(proc);
        return proc;
      },
    };

    const service = new TerminalService({
      ptyLoader: async () => fakeModule,
      shellDetector: () => [
        { id: 'mock-sh', label: 'Mock Shell', executable: process.execPath, args: [] },
      ],
      onEvent: (evt) => events.push(evt),
      batchIntervalMs: 1,
    });
    activeServices.push(service);

    const first = await service.ensure({
      workspaceId: 'ws-1',
      sessionKey: 'native:ws-1:conv-1',
      cwd: cwdA,
      cwdLabel: 'feat-a',
    });
    expect(first.terminals).toHaveLength(1);
    const termId = first.terminals[0]!.id;

    service.write({
      workspaceId: 'ws-1',
      sessionKey: 'native:ws-1:conv-1',
      terminalId: termId,
      data: 'pwd\r',
    });
    await new Promise((r) => setTimeout(r, 15));

    const rehydrated = await service.ensure({
      workspaceId: 'ws-1',
      sessionKey: 'native:ws-1:conv-1',
      cwd: cwdA,
    });
    expect(rehydrated.terminals).toHaveLength(1);
    expect(rehydrated.terminals[0]!.replayBuffer).toContain('ECHO:pwd\r');
    expect(events.some((e) => e.type === 'data' && e.data.includes('ECHO:pwd'))).toBe(true);

    // Enforce MAX_SESSION_TERMINALS = 3 with readable KapibalaError / safeError
    await service.create({ workspaceId: 'ws-1', sessionKey: 'native:ws-1:conv-1', cwd: cwdA });
    await service.create({ workspaceId: 'ws-1', sessionKey: 'native:ws-1:conv-1', cwd: cwdA });
    let sessionLimitErr: unknown;
    try {
      await service.create({ workspaceId: 'ws-1', sessionKey: 'native:ws-1:conv-1', cwd: cwdA });
    } catch (err) {
      sessionLimitErr = err;
    }
    expect(safeError(sessionLimitErr)).toEqual({
      code: 'TERMINAL_LIMIT_REACHED',
      message: `单会话最多同时开启 ${MAX_SESSION_TERMINALS} 个终端。`,
    });

    // Restart exited terminal in-place via replaceTerminalId without exceeding MAX_SESSION_TERMINALS
    spawned[0]!.emitExit(42);
    expect(events.some((e) => e.type === 'exit' && e.exitCode === 42)).toBe(true);
    const restarted = await service.create({
      workspaceId: 'ws-1',
      sessionKey: 'native:ws-1:conv-1',
      cwd: cwdA,
      replaceTerminalId: termId,
    });
    expect(restarted.terminals).toHaveLength(3);
    expect(restarted.terminals[0]!.status).toBe('running');

    // Fill up to MAX_LIVE_TERMINALS = 8 across other sessions
    while (service.liveCount() < MAX_LIVE_TERMINALS) {
      await service.create({
        workspaceId: 'ws-1',
        sessionKey: `native:ws-1:extra-${service.liveCount()}`,
        cwd: cwdB,
      });
    }
    let globalLimitErr: unknown;
    try {
      await service.create({ workspaceId: 'ws-1', sessionKey: 'native:ws-1:overflow', cwd: cwdB });
    } catch (err) {
      globalLimitErr = err;
    }
    expect(safeError(globalLimitErr)).toEqual({
      code: 'TERMINAL_LIMIT_REACHED',
      message: `全局活跃终端已达上限（${MAX_LIVE_TERMINALS} 个），请先关闭闲置终端。`,
    });

    // Unknown terminal maps to TERMINAL_NOT_FOUND
    let notFoundErr: unknown;
    try {
      service.write({
        workspaceId: 'ws-1',
        sessionKey: 'native:ws-1:conv-1',
        terminalId: 'missing-id',
        data: 'ls\r',
      });
    } catch (err) {
      notFoundErr = err;
    }
    expect(safeError(notFoundErr)).toEqual({
      code: 'TERMINAL_NOT_FOUND',
      message: '目标终端不存在或已关闭。',
    });

    // Cleanup by worktree cwd frees quota immediately
    await service.closeByCwd(cwdB);
    expect(service.liveCount()).toBe(3);

    await service.closeBySession('native:ws-1:conv-1');
    expect(service.liveCount()).toBe(0);
  });

  it('degrades gracefully to status=unavailable when native PTY module fails to load', async () => {
    const cwd = createTempDir();
    const service = new TerminalService({
      ptyLoader: async () => {
        throw new Error('dlopen mock failure');
      },
      shellDetector: () => [
        { id: 'mock-sh', label: 'Mock Shell', executable: process.execPath, args: [] },
      ],
    });
    activeServices.push(service);

    const snap = await service.ensure({
      workspaceId: 'ws-1',
      sessionKey: 'native:ws-1:conv-fallback',
      cwd,
    });
    expect(snap.terminals).toHaveLength(1);
    expect(snap.terminals[0]!.status).toBe('unavailable');
    expect(snap.unavailableReason).toContain('TERMINAL_UNAVAILABLE');
    expect(service.liveCount()).toBe(0);
  });

  it('deduplicates concurrent ensure calls and prevents orphan PTY spawn after closeBySession or dispose', async () => {
    const cwd = createTempDir();
    let spawnCalls = 0;
    let releaseLoader!: () => void;
    const loaderGate = new Promise<void>((resolve) => {
      releaseLoader = resolve;
    });

    const fakeModule: PtyModuleLike = {
      spawn: (_file, _args, opts) => {
        spawnCalls += 1;
        return new FakePtyProcess(opts.cols, opts.rows);
      },
    };

    const service = new TerminalService({
      ptyLoader: async () => {
        await loaderGate;
        return fakeModule;
      },
      shellDetector: () => [
        { id: 'mock-sh', label: 'Mock Shell', executable: process.execPath, args: [] },
      ],
    });
    activeServices.push(service);

    // 1. 同一会话并发发起两次 ensure()：只应拉起 1 个底层 PTY 进程
    const p1 = service.ensure({ workspaceId: 'ws-1', sessionKey: 'native:ws-1:race', cwd });
    const p2 = service.ensure({ workspaceId: 'ws-1', sessionKey: 'native:ws-1:race', cwd });
    releaseLoader();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(spawnCalls).toBe(1);
    expect(r1.terminals).toHaveLength(1);
    expect(r2.terminals).toHaveLength(1);
    expect(r1.terminals[0]!.id).toBe(r2.terminals[0]!.id);

    // 2. 慢速 ptyLoader 已进入异步挂起尚未返回时会话关闭：恢复后绝不拉起孤儿进程
    let onEnteredLoader!: () => void;
    const enteredLoader = new Promise<void>((resolve) => {
      onEnteredLoader = resolve;
    });
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((resolve) => {
      releaseSlow = resolve;
    });
    let slowSpawns = 0;
    const closingService = new TerminalService({
      ptyLoader: async () => {
        onEnteredLoader();
        await slowGate;
        return {
          spawn: () => {
            slowSpawns += 1;
            return new FakePtyProcess();
          },
        };
      },
      shellDetector: () => [
        { id: 'mock-sh', label: 'Mock Shell', executable: process.execPath, args: [] },
      ],
    });
    activeServices.push(closingService);

    const inflightClose = closingService.create({
      workspaceId: 'ws-1',
      sessionKey: 'native:ws-1:aborted',
      cwd,
    });
    await enteredLoader;
    await closingService.closeBySession('native:ws-1:aborted');
    releaseSlow();
    const afterCloseSnap = await inflightClose;
    expect(slowSpawns).toBe(0);
    expect(afterCloseSnap.terminals).toHaveLength(0);
  });

  it('flushes pending batcher before snapshot hydration (H-10) and bounds 3-terminal snapshot JSON under 512 KiB (H-9)', async () => {
    const cwd = createTempDir();
    const spawned: FakePtyProcess[] = [];
    const emittedBatches: string[] = [];

    const service = new TerminalService({
      ptyLoader: async () => ({
        spawn: (_file, _args, opts) => {
          const proc = new FakePtyProcess(opts.cols, opts.rows);
          spawned.push(proc);
          return proc;
        },
      }),
      shellDetector: () => [
        { id: 'mock-sh', label: 'Mock Shell', executable: process.execPath, args: [] },
      ],
      onEvent: (evt) => {
        if (evt.type === 'data') emittedBatches.push(evt.data);
      },
      batchIntervalMs: 5_000, // 长合批窗口：验证 snapshotSession 主动 flush 后定时器不再重复吐出旧片段
    });
    activeServices.push(service);

    await service.ensure({ workspaceId: 'ws-1', sessionKey: 'native:ws-1:s-cap', cwd });
    await service.create({ workspaceId: 'ws-1', sessionKey: 'native:ws-1:s-cap', cwd });
    await service.create({ workspaceId: 'ws-1', sessionKey: 'native:ws-1:s-cap', cwd });

    // 向 3 个终端各灌入高膨胀率 ANSI + 中文输出（200k 字符若不截断会超过 1.8 MiB JSON）
    const heavyChunk = `${'\x1b[32m构建日志输出🚀\r\n'.repeat(12_000)}END_GUARD`;
    for (const proc of spawned) {
      proc.emitData(heavyChunk);
    }

    const batchesBeforeSnapshot = emittedBatches.length;
    const snap = await service.ensure({
      workspaceId: 'ws-1',
      sessionKey: 'native:ws-1:s-cap',
      cwd,
    });
    // snapshotSession 读取前必须已将挂起的 batcher 同步冲刷完毕，后续不应再有延迟重复帧
    expect(emittedBatches.length).toBeGreaterThanOrEqual(batchesBeforeSnapshot);
    const countAfterEnsure = emittedBatches.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(emittedBatches.length).toBe(countAfterEnsure);

    const serializedBytes = Buffer.byteLength(JSON.stringify(snap), 'utf8');
    expect(serializedBytes).toBeLessThan(512 * 1024);
    for (const term of snap.terminals) {
      expect(term.replayBuffer.endsWith('END_GUARD')).toBe(true);
    }
  });

  it('invokes async processTreeKiller even when root shell exits fast or already exited earlier (M-1)', async () => {
    const cwd = createTempDir();
    const killedPids: number[] = [];
    const spawned: FakePtyProcess[] = [];
    let nextFakePid = 70_001;

    const service = new TerminalService({
      ptyLoader: async () => ({
        spawn: (_file, _args, opts) => {
          const proc = new FakePtyProcess(opts.cols, opts.rows, nextFakePid++);
          spawned.push(proc);
          return proc;
        },
      }),
      shellDetector: () => [
        { id: 'mock-sh', label: 'Mock Shell', executable: process.execPath, args: [] },
      ],
      processTreeKiller: async (pid) => {
        killedPids.push(pid);
      },
    });
    activeServices.push(service);

    const s1 = await service.ensure({ workspaceId: 'ws-1', sessionKey: 'native:ws-1:t1', cwd });
    const s2 = await service.create({ workspaceId: 'ws-1', sessionKey: 'native:ws-1:t1', cwd });
    expect(s2.terminals).toHaveLength(2);

    // 终端 1 仍在运行时主动 close（根进程立即退出 settled=true）：仍必须清理整棵进程树
    await service.close({
      workspaceId: 'ws-1',
      sessionKey: 'native:ws-1:t1',
      terminalId: s1.terminals[0]!.id,
    });
    expect(killedPids).toEqual([70_001]);

    // 终端 2 根 Shell 提前自行退出（entry.pty 已置空），但后台子进程可能仍占着工作树 cwd：closeByCwd 仍必须按记录的 pid 清理进程树
    spawned[1]!.emitExit(0);
    await service.closeByCwd(cwd);
    expect(killedPids).toEqual([70_001, 70_002]);
  });

  it('spawns a real OS shell via node-pty on prebuilt platforms and echoes marker output', async () => {
    const cwd = createTempDir();
    const service = new TerminalService({ batchIntervalMs: 5 });
    activeServices.push(service);

    const ensured = await service.ensure({
      workspaceId: 'ws-live',
      sessionKey: 'native:ws-live:conv-live',
      cwd,
      cwdLabel: 'live-smoke',
    });

    if (process.platform === 'linux' && ensured.terminals[0]?.status === 'unavailable') {
      expect(ensured.unavailableReason).toContain('TERMINAL_UNAVAILABLE');
      return;
    }

    expect(ensured.terminals[0]?.status).toBe('running');
    const termId = ensured.terminals[0]!.id;
    const lineBreak = process.platform === 'win32' ? '\r\n' : '\n';
    service.write({
      workspaceId: 'ws-live',
      sessionKey: 'native:ws-live:conv-live',
      terminalId: termId,
      data: `echo KPBL_PTY_LIVE_ECHO_99${lineBreak}`,
    });

    const deadline = Date.now() + 8_000;
    let hydrated = '';
    while (Date.now() < deadline) {
      const snap = await service.ensure({
        workspaceId: 'ws-live',
        sessionKey: 'native:ws-live:conv-live',
        cwd,
      });
      hydrated = snap.terminals[0]?.replayBuffer ?? '';
      if (hydrated.includes('KPBL_PTY_LIVE_ECHO_99')) break;
      await new Promise((r) => setTimeout(r, 60));
    }
    expect(hydrated).toContain('KPBL_PTY_LIVE_ECHO_99');
  });
});
