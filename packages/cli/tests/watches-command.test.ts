import type { WatchService, WatchView } from '@kiturone/kapibala-host/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../src/commands/dispatcher.js';
import { watchesCommand } from '../src/commands/watches.js';
import { setActiveWatchService } from '../src/watch-context.js';

/** 捕获命令输出；只关心可见正文，不涉及样式与流选择。 */
function context(): { ctx: CommandContext; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const ctx = {
    output: {
      log: (message: string) => lines.push(message),
      error: (message: string) => errors.push(message),
      write: () => {},
    },
  } as unknown as CommandContext;
  return { ctx, lines, errors };
}

function fakeService(views: WatchView[]): WatchService & { cancelled: string[] } {
  const cancelled: string[] = [];
  const service = {
    list: () => views,
    cancel: async (watchId: string) => {
      if (watchId === 'missing') throw new Error('未找到该监视');
      cancelled.push(watchId);
    },
    dispose: () => {},
    cancelled,
  };
  return service as unknown as WatchService & { cancelled: string[] };
}

function view(overrides: Partial<WatchView> & Pick<WatchView, 'watchId' | 'state'>): WatchView {
  return {
    kind: 'file_change',
    target: 'src/a.ts',
    armedAt: 1,
    deadlineAt: Date.now() + 120_000,
    lastSeenAt: 1,
    ...overrides,
  };
}

describe('/watches', () => {
  afterEach(() => {
    setActiveWatchService(undefined);
  });

  it('当前宿主没有监视服务时明确说明原因', async () => {
    const { ctx, lines } = context();
    setActiveWatchService(undefined);
    await watchesCommand([], ctx);
    expect(lines.join('\n')).toContain('没有布置监视触发源');
  });

  it('按五态展示监视列表', async () => {
    const { ctx, lines } = context();
    setActiveWatchService(
      fakeService([
        view({ watchId: 'w1', state: 'armed' }),
        view({
          watchId: 'w2',
          state: 'fired',
          kind: 'port_ready',
          target: '8787',
          detail: '端口已就绪',
        }),
        view({ watchId: 'w3', state: 'timeout', kind: 'process_exit', target: '4242' }),
        view({ watchId: 'w4', state: 'cancelled' }),
        view({ watchId: 'w5', state: 'orphaned' }),
      ]),
    );
    await watchesCommand([], ctx);
    const text = lines.join('\n');
    expect(text).toContain('共 5 个');
    expect(text).toContain('监视中');
    expect(text).toContain('已触发');
    expect(text).toContain('已超时');
    expect(text).toContain('已取消');
    expect(text).toContain('已失联');
    expect(text).toContain('端口已就绪');
  });

  it('空列表不伪造监听中的条目', async () => {
    const { ctx, lines } = context();
    setActiveWatchService(fakeService([]));
    await watchesCommand([], ctx);
    expect(lines.join('\n')).toContain('没有登记任何监视');
  });

  it('取消一条监视并报告失败原因', async () => {
    const service = fakeService([view({ watchId: 'w1', state: 'armed' })]);
    setActiveWatchService(service);
    const ok = context();
    await watchesCommand(['cancel', 'w1'], ok.ctx);
    expect(ok.lines.join('\n')).toContain('已取消监视: w1');
    expect(service.cancelled).toEqual(['w1']);

    const failed = context();
    await watchesCommand(['cancel', 'missing'], failed.ctx);
    expect(failed.errors.join('\n')).toContain('未找到该监视');
  });

  it('参数不完整时只给用法', async () => {
    const { ctx, lines } = context();
    const service = fakeService([]);
    setActiveWatchService(service);
    await watchesCommand(['cancel'], ctx);
    expect(lines.join('\n')).toContain('用法: /watches cancel <watchId>');
    expect(service.cancelled).toEqual([]);
    expect(vi.isMockFunction(service.cancel)).toBe(false);
  });
});
