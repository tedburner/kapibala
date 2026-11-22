import path from 'node:path';
import type { WatchNotification, WatchState } from '@kiturone/kapibala';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WATCH_RESUME_INPUT,
  type WatchFileSystem,
  WatchService,
  type WatchStateStore,
  type WatchView,
} from '../src/host/watch/service.js';

const ROOT = path.resolve('/kapibala-watch-test');
const file = (name: string) => path.resolve(ROOT, name);

/** 内存文件系统：签名由内容长度 + 单调递增 mtime 组成，足以区分同大小改动。 */
function memoryFileSystem(initial: Record<string, string> = {}): WatchFileSystem & {
  write(name: string, content: string): void;
} {
  const files = new Map<string, { content: string; mtime: number }>();
  let revision = 1;
  for (const [name, content] of Object.entries(initial))
    files.set(file(name), { content, mtime: revision++ });
  return {
    stat: (target) => {
      const entry = files.get(target);
      return entry ? { size: entry.content.length, mtimeMs: entry.mtime } : undefined;
    },
    read: (target) => {
      const entry = files.get(target);
      return entry ? Buffer.from(entry.content) : undefined;
    },
    realpath: (target) => target,
    write(name, content) {
      files.set(file(name), { content, mtime: revision++ });
    },
  };
}

/** 内存存储：只保留 watch_state 追加记录，读取时按 watchId 取最后一条。 */
function memoryStore(seed: WatchState[] = []): WatchStateStore & { states: WatchState[] } {
  const states = [...seed];
  return {
    states,
    async readWatchStates() {
      const latest = new Map<string, WatchState>();
      for (const state of states) latest.set(state.watchId, state);
      return [...latest.values()];
    },
    async appendWatchState(state) {
      states.push(state);
    },
    getActiveBranchId: () => 'main',
  };
}

interface Harness {
  service: WatchService;
  store: ReturnType<typeof memoryStore>;
  delivered: WatchNotification[];
  resumes: string[];
  notified: WatchNotification[];
  setIdle(value: boolean): void;
}

function harness(
  options: {
    store?: ReturnType<typeof memoryStore>;
    fileSystem?: WatchFileSystem;
    probePort?: (port: number) => Promise<boolean>;
    now?: () => number;
  } = {},
): Harness {
  const store = options.store ?? memoryStore();
  const fileSystem = options.fileSystem ?? memoryFileSystem();
  const delivered: WatchNotification[] = [];
  const resumes: string[] = [];
  const notified: WatchNotification[] = [];
  let idle = true;
  const service = new WatchService({
    workspaceRoot: ROOT,
    store,
    fileSystem,
    deliver: async (notification) => {
      delivered.push(notification);
      return true;
    },
    resume: async (input) => {
      resumes.push(input);
    },
    isIdle: () => idle,
    onNotify: (notification) => notified.push(notification),
    ...(options.probePort ? { probePort: options.probePort } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    service,
    store,
    delivered,
    resumes,
    notified,
    setIdle: (value) => {
      idle = value;
    },
  };
}

describe('WatchService', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('file_change 去抖后只投递一次，并自动续跑一轮', async () => {
    let now = 1_000_000;
    const files = memoryFileSystem();
    const env = harness({ now: () => now, fileSystem: files });
    const view = await env.service.register({
      kind: 'file_change',
      target: 'a.txt',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    expect(view.state).toBe('armed');

    files.write('a.txt', 'changed');
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    now += 300;
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(1);

    expect(env.delivered).toHaveLength(1);
    expect(env.delivered[0]).toMatchObject({
      watchId: view.watchId,
      eventId: view.watchId,
      kind: 'file_change',
      state: 'fired',
    });
    expect(env.resumes).toEqual([WATCH_RESUME_INPUT]);
    // 水位必须推进到事件时间，重启后不再补投。
    const latest = env.store.states.at(-1)!;
    expect(latest.state).toBe('fired');
    expect(latest.lastSeenAt).toBe(env.delivered[0].firedAt);
    env.service.dispose();
  });

  it('同内容改动不触发（size + mtime 变化但摘要一致）', async () => {
    let now = 1_000_000;
    const files = memoryFileSystem({ 'b.txt': '' });
    const env = harness({ now: () => now, fileSystem: files });
    await env.service.register({
      kind: 'file_change',
      target: 'b.txt',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    // 内容不变、mtime 前进：签名变了但哈希一致，应判为无变化。
    files.write('b.txt', '');
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(400);
    expect(env.delivered).toHaveLength(0);
    env.service.dispose();
  });

  it('到达 deadline 时投递 timeout 终态', async () => {
    let now = 1_000_000;
    const env = harness({ now: () => now });
    await env.service.register({
      kind: 'file_change',
      target: 'never.txt',
      intervalMs: 5_000,
      deadlineAt: now + 1_000,
    });
    now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.delivered).toHaveLength(1);
    expect(env.delivered[0].state).toBe('timeout');
    env.service.dispose();
  });

  it('取消后不再触发，且取消是终态', async () => {
    let now = 1_000_000;
    const files = memoryFileSystem();
    const env = harness({ now: () => now, fileSystem: files });
    const view = await env.service.register({
      kind: 'port_ready',
      target: '8787',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    await env.service.cancel(view.watchId);
    expect(env.service.list()[0].state).toBe('cancelled');
    files.write('anything', 'x');
    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.delivered.map((item) => item.state)).toEqual(['cancelled']);
    await expect(env.service.cancel(view.watchId)).rejects.toThrow(/已经结束|not armed/);
    env.service.dispose();
  });

  it('port_ready 探测成功即 fired，失败继续监视', async () => {
    let now = 1_000_000;
    let ready = false;
    const env = harness({ now: () => now, probePort: async () => ready });
    await env.service.register({
      kind: 'port_ready',
      target: '8787',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(env.delivered).toHaveLength(0);
    ready = true;
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.delivered).toHaveLength(1);
    expect(env.delivered[0].detail).toContain('端口已就绪');
    env.service.dispose();
  });

  it('watch_start 拒绝已摘除的 process_exit 并说明支持范围', async () => {
    const env = harness({ now: () => 1_000_000 });
    // 类型联合已摘除 process_exit；wire 与模型输入仍可能带来该遗留值，走字符串断言。
    await expect(
      env.service.register({
        kind: 'process_exit',
        target: '4242',
        deadlineAt: 2_000_000,
      } as unknown as Parameters<WatchService['register']>[0]),
    ).rejects.toMatchObject({ code: 'WATCH_KIND_UNSUPPORTED' });
    expect(env.service.list()).toHaveLength(0);
    env.service.dispose();
  });

  it('拒绝越界路径与被忽略目录', async () => {
    const env = harness({ now: () => 1_000_000 });
    await expect(
      env.service.register({ kind: 'file_change', target: '../escape.txt', deadlineAt: 2_000_000 }),
    ).rejects.toMatchObject({ code: 'WATCH_TARGET_OUTSIDE' });
    await expect(
      env.service.register({
        kind: 'file_change',
        target: 'node_modules/pkg/a.js',
        deadlineAt: 2_000_000,
      }),
    ).rejects.toMatchObject({ code: 'WATCH_TARGET_IGNORED' });
    env.service.dispose();
  });

  it('拒绝 NaN 与 Infinity 的轮询间隔，避免退化成忙轮询', async () => {
    const env = harness({ now: () => 1_000_000 });
    await expect(
      env.service.register({
        kind: 'port_ready',
        target: '8787',
        intervalMs: Number.NaN,
        deadlineAt: 2_000_000,
      }),
    ).rejects.toMatchObject({ code: 'WATCH_INTERVAL_INVALID' });
    await expect(
      env.service.register({
        kind: 'port_ready',
        target: '8787',
        intervalMs: Number.POSITIVE_INFINITY,
        deadlineAt: 2_000_000,
      }),
    ).rejects.toMatchObject({ code: 'WATCH_INTERVAL_INVALID' });
    env.service.dispose();
  });

  it('目标被替换为工作区外的符号链接时转 orphaned，而不是永久停留 armed', async () => {
    let now = 1_000_000;
    const base = memoryFileSystem({ 'link.txt': 'content' });
    let escapesOutside = false;
    const env = harness({
      now: () => now,
      fileSystem: {
        stat: (target) => base.stat(target),
        read: (target) => base.read(target),
        realpath: (target) => (escapesOutside ? '/outside/escape-target' : target),
      },
    });
    await env.service.register({
      kind: 'file_change',
      target: 'link.txt',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    escapesOutside = true;
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.delivered).toHaveLength(1);
    expect(env.delivered[0].state).toBe('orphaned');
    expect(env.delivered[0].detail).toContain('工作区外');
    expect(env.service.list()[0].state).toBe('orphaned');
    env.service.dispose();
  });

  it('签名未变时零读盘：两次 tick 之间文件未变则不触发读取', async () => {
    let now = 1_000_000;
    const base = memoryFileSystem({ 'c.txt': 'v1' });
    let reads = 0;
    const env = harness({
      now: () => now,
      fileSystem: {
        stat: (target) => base.stat(target),
        read: (target) => {
          reads++;
          return base.read(target);
        },
        realpath: (target) => target,
      },
    });
    await env.service.register({
      kind: 'file_change',
      target: 'c.txt',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    reads = 0;
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reads).toBe(0);
    expect(env.delivered).toHaveLength(0);
    // 签名变化后才读内容算哈希确认，并按去抖窗口投递。
    base.write('c.txt', 'v2');
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(1);
    expect(env.delivered).toHaveLength(1);
    expect(env.delivered[0].state).toBe('fired');
    env.service.dispose();
  });

  it('登记持久化失败时回滚内存条目，不占用监视上限', async () => {
    let calls = 0;
    const store = {
      states: [] as WatchState[],
      async readWatchStates() {
        return this.states;
      },
      async appendWatchState(state: WatchState) {
        calls++;
        if (calls === 1) throw new Error('disk full');
        this.states.push(state);
      },
      getActiveBranchId: () => 'main',
    };
    const env = harness({ store, now: () => 1_000_000 });
    await expect(
      env.service.register({
        kind: 'port_ready',
        target: '8787',
        deadlineAt: 1_060_000,
      }),
    ).rejects.toThrow('disk full');
    expect(env.service.list()).toHaveLength(0);
    // 回滚后同一会话仍能正常登记，未留下幽灵条目占用上限。
    const view = await env.service.register({
      kind: 'port_ready',
      target: '8788',
      deadlineAt: 1_060_000,
    });
    expect(env.service.list()).toHaveLength(1);
    expect(env.service.list()[0].watchId).toBe(view.watchId);
    env.service.dispose();
  });

  it('用户主动取消不触发自动续跑', async () => {
    let now = 1_000_000;
    const env = harness({ now: () => now });
    const view = await env.service.register({
      kind: 'port_ready',
      target: '8787',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    await env.service.cancel(view.watchId);
    now += 1_000;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.delivered).toHaveLength(1);
    expect(env.delivered[0].state).toBe('cancelled');
    expect(env.resumes).toEqual([]);
    env.service.dispose();
  });

  it('投递连续失败达到上限后放弃并转 orphaned，不再无限重试', async () => {
    let now = 1_000_000;
    let attempts = 0;
    const store = memoryStore();
    const service = new WatchService({
      workspaceRoot: ROOT,
      store,
      fileSystem: memoryFileSystem(),
      deliver: async () => {
        attempts++;
        throw new Error('inbox closed');
      },
      resume: async () => {},
      isIdle: () => true,
      probePort: async () => true,
      now: () => now,
    });
    await service.register({
      kind: 'port_ready',
      target: '8787',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(attempts).toBe(5);
    expect(service.list()[0].state).toBe('orphaned');
    expect(service.list()[0].detail).toContain('放弃');
    // 放弃后不再每秒重试。
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toBe(5);
    service.dispose();
  });

  it('终态条目超过 50 条时按关闭时间淘汰最旧，只清内存不清落盘', async () => {
    const now = 1_000_000;
    const env = harness({ now: () => now });
    const firstRoundIds: string[] = [];
    for (let round = 0; round < 7; round++) {
      const views: WatchView[] = [];
      for (let index = 0; index < 8; index++) {
        const view = await env.service.register({
          kind: 'port_ready',
          target: String(9000 + index),
          deadlineAt: now + 60_000,
        });
        views.push(view);
        if (round === 0) firstRoundIds.push(view.watchId);
      }
      for (const view of views) await env.service.cancel(view.watchId);
    }
    expect(env.service.list()).toHaveLength(50);
    // 最早的终态条目已从内存淘汰，但落盘记录保持完整。
    for (const watchId of firstRoundIds.slice(0, 6))
      expect(env.service.list().some((item) => item.watchId === watchId)).toBe(false);
    expect(env.store.states.some((state) => firstRoundIds.includes(state.watchId))).toBe(true);
    env.service.dispose();
  });

  it('dispose 会 abort 在途续跑的 abort controller', async () => {
    let now = 1_000_000;
    let releaseResume!: () => void;
    let resumeSignal: AbortSignal | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseResume = resolve;
    });
    const service = new WatchService({
      workspaceRoot: ROOT,
      store: memoryStore(),
      fileSystem: memoryFileSystem(),
      deliver: async () => true,
      resume: async (_input, signal) => {
        resumeSignal = signal;
        await gate;
      },
      isIdle: () => true,
      probePort: async () => true,
      now: () => now,
    });
    await service.register({
      kind: 'port_ready',
      target: '8787',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(1);
    // 续跑已进入并挂在门上；dispose 必须 abort，避免关闭后拉起新运行。
    expect(resumeSignal).toBeDefined();
    service.dispose();
    expect(resumeSignal?.aborted).toBe(true);
    releaseResume();
    await vi.advanceTimersByTimeAsync(1);
  });

  it('每会话最多 8 条监视', async () => {
    const now = 1_000_000;
    const env = harness({ now: () => now });
    for (let index = 0; index < 8; index++)
      await env.service.register({
        kind: 'port_ready',
        target: String(9000 + index),
        deadlineAt: now + 60_000,
      });
    await expect(
      env.service.register({ kind: 'port_ready', target: '9100', deadlineAt: now + 60_000 }),
    ).rejects.toMatchObject({ code: 'WATCH_LIMIT' });
    env.service.dispose();
  });

  it('恢复时对未确认水位的终态补投一次简报', async () => {
    const seed: WatchState = {
      watchId: 'w-restored',
      spec: { kind: 'file_change', target: 'a.txt', deadlineAt: 2_000_000 },
      state: 'fired',
      lastSeenAt: 0,
      closedAt: 1_500_000,
      branchId: 'main',
      armedAt: 1_000_000,
    };
    const env = harness({ store: memoryStore([seed]) });
    await env.service.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(env.delivered).toHaveLength(1);
    expect(env.delivered[0]).toMatchObject({ eventId: 'w-restored', state: 'fired' });
    expect(env.delivered[0].detail).toContain('补投');
    expect(env.store.states.at(-1)?.lastSeenAt).toBe(1_500_000);
    // 只续跑一次；恢复补投不产生重复通知。
    expect(env.delivered).toHaveLength(1);
    env.service.dispose();
  });

  it('忙碌时进入队列，空闲后才投递并续跑', async () => {
    let now = 1_000_000;
    const env = harness({ now: () => now, probePort: async () => true });
    env.setIdle(false);
    await env.service.register({
      kind: 'port_ready',
      target: '8787',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(env.notified).toHaveLength(1);
    // 会话仍在运行：终态已持久化，但背景消息不得抢在用户输入之前落盘。
    expect(env.delivered).toHaveLength(0);
    expect(env.store.states.at(-1)?.state).toBe('fired');

    env.setIdle(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(env.delivered).toHaveLength(1);
    expect(env.resumes).toEqual([WATCH_RESUME_INPUT]);
    env.service.dispose();
  });

  it('重启恢复 armed 的 file_change 条目时重建签名，文件未变不假触发', async () => {
    let now = 1_000_000;
    const files = memoryFileSystem({ 'stable.txt': 'initial-content' });
    const seed: WatchState = {
      watchId: 'w-armed',
      spec: { kind: 'file_change', target: 'stable.txt', intervalMs: 2_000, deadlineAt: 2_000_000 },
      state: 'armed',
      lastSeenAt: 1_000_000,
      branchId: 'main',
      armedAt: 1_000_000,
    };
    const env = harness({ store: memoryStore([seed]), fileSystem: files, now: () => now });
    await env.service.start();

    // 文件未变：多轮轮询后不得假触发。
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(400);
    expect(env.delivered).toHaveLength(0);
    expect(env.service.list()[0].state).toBe('armed');

    // 文件真实改动后正常触发 fired。
    files.write('stable.txt', 'updated-content');
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    now += 300;
    await vi.advanceTimersByTimeAsync(300);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.delivered).toHaveLength(1);
    expect(env.delivered[0].state).toBe('fired');
    env.service.dispose();
  });

  it('60s 冷却期内触发的第二条通知不丢失唤醒，冷却结束后补发一次续跑', async () => {
    let now = 1_000_000;
    const files = memoryFileSystem({ 'a.txt': '1', 'b.txt': '1' });
    const env = harness({ now: () => now, fileSystem: files });
    await env.service.register({
      kind: 'file_change',
      target: 'a.txt',
      intervalMs: 2_000,
      deadlineAt: now + 180_000,
    });
    await env.service.register({
      kind: 'file_change',
      target: 'b.txt',
      intervalMs: 2_000,
      deadlineAt: now + 180_000,
    });

    // 第一条触发并立即续跑。
    files.write('a.txt', '2');
    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    now += 300;
    await vi.advanceTimersByTimeAsync(301);
    expect(env.resumes).toHaveLength(1);

    // 10s 后（仍在 60s 冷却窗内）第二条触发：落盘但冷却期内不立即二次续跑。
    files.write('b.txt', '2');
    now += 10_000;
    await vi.advanceTimersByTimeAsync(10_000);
    now += 300;
    await vi.advanceTimersByTimeAsync(301);
    expect(env.delivered).toHaveLength(2);
    expect(env.resumes).toHaveLength(1);

    // 冷却窗口剩余时间走完后补发一次续跑。
    now += 50_000;
    await vi.advanceTimersByTimeAsync(50_000);
    expect(env.resumes).toHaveLength(2);
    env.service.dispose();
  });
});
