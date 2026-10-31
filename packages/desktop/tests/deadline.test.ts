import { describe, expect, it, vi } from 'vitest';
import { withShutdownDeadline } from '../src/main/deadline.js';

describe('退出清理有界等待', () => {
  it('清理在期限内完成时沿用原结果，成功与失败原因都原样传播', async () => {
    await expect(withShutdownDeadline(Promise.resolve(), 50)).resolves.toBeUndefined();
    const failure = new Promise<void>((_resolve, reject) =>
      reject(new Error('SESSION_CLEANUP_FAILED')),
    );
    await expect(withShutdownDeadline(failure, 50)).rejects.toMatchObject({
      message: 'SESSION_CLEANUP_FAILED',
    });
  });

  it('卡死的等待在期限后以 SHUTDOWN_TIMEOUT 拒绝，且定时器不残留', async () => {
    vi.useFakeTimers();
    try {
      const hung = new Promise<void>(() => {});
      const pending = withShutdownDeadline(hung, 30_000);
      // 先挂上拒绝断言再推进假时钟，避免拒绝先于处理者到达被记为 unhandled rejection。
      const assertion = expect(pending).rejects.toMatchObject({ message: 'SHUTDOWN_TIMEOUT' });
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('期限前完成的等待不触发超时拒绝；非法期限立即拒绝', async () => {
    vi.useFakeTimers();
    try {
      const pending = withShutdownDeadline(Promise.resolve('ignored' as never), 30_000);
      await expect(pending).resolves.toBeUndefined();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    await expect(withShutdownDeadline(Promise.resolve(), 0)).rejects.toMatchObject({
      message: 'Shutdown deadline must be a positive safe integer',
    });
  });
});
