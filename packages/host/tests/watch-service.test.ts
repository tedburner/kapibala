import path from 'node:path';
import type { WatchNotification, WatchState } from '@kiturone/kapibala';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WATCH_RESUME_INPUT,
  type WatchFileSystem,
  WatchService,
  type WatchStateStore,
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
  fileSystem: ReturnType<typeof memoryFileSystem>;
  delivered: WatchNotification[];
  resumes: string[];
  notified: WatchNotification[];
  setIdle(value: boolean): void;
}

function harness(
  options: {
    store?: ReturnType<typeof memoryStore>;
    fileSystem?: ReturnType<typeof memoryFileSystem>;
    isOwnedProcess?: (pid: number) => boolean;
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
    ...(options.isOwnedProcess ? { isOwnedProcess: options.isOwnedProcess } : {}),
    ...(options.probePort ? { probePort: options.probePort } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  return {
    service,
    store,
    fileSystem,
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
    const env = harness({ now: () => now });
    const view = await env.service.register({
      kind: 'file_change',
      target: 'a.txt',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    expect(view.state).toBe('armed');

    env.fileSystem.write('a.txt', 'changed');
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
    const env = harness({ now: () => now, fileSystem: memoryFileSystem({ 'b.txt': '' }) });
    await env.service.register({
      kind: 'file_change',
      target: 'b.txt',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    // 内容不变、mtime 前进：签名变了但哈希一致，应判为无变化。
    env.fileSystem.write('b.txt', '');
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
    const env = harness({ now: () => now });
    const view = await env.service.register({
      kind: 'port_ready',
      target: '8787',
      intervalMs: 2_000,
      deadlineAt: now + 60_000,
    });
    await env.service.cancel(view.watchId);
    expect(env.service.list()[0].state).toBe('cancelled');
    env.fileSystem.write('anything', 'x');
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

  it('process_exit 只监视本会话子进程，句柄失效标记 orphaned', async () => {
    let now = 1_000_000;
    let owned = true;
    const env = harness({ now: () => now, isOwnedProcess: () => owned });
    await env.service.register({
      kind: 'process_exit',
      target: '4242',
      deadlineAt: now + 60_000,
    });
    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(env.delivered).toHaveLength(0);
    owned = false;
    now += 5_000;
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(1);
    expect(env.delivered[0].state).toBe('orphaned');
    env.service.dispose();
  });

  it('拒绝越界路径与非本会话进程', async () => {
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
    await expect(
      env.service.register({ kind: 'process_exit', target: '1', deadlineAt: 2_000_000 }),
    ).rejects.toMatchObject({ code: 'WATCH_PROCESS_NOT_OWNED' });
    env.service.dispose();
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
});
