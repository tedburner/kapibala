import { expect, it, vi } from 'vitest';
import { RpcEndpoint } from '../src/shared/rpc.js';

it('业务请求满额后仍保留停止与状态的控制容量', async () => {
  const frames: string[] = [];
  const rpc = new RpcEndpoint(
    { hostInstanceId: 'host', controlEpoch: 1 },
    (frame) => frames.push(frame),
    () => {},
  );
  for (let index = 0; index < 64; index++) void rpc.call('settings.read', {}).catch(() => {});
  const stop = rpc.call('run.cancel', { workspaceId: 'w', sessionId: 's', runId: 'r' });
  void stop.catch(() => {});
  expect(frames.some((frame) => JSON.parse(frame).body?.method === 'run.cancel')).toBe(true);
  rpc.peer.close();
  await expect(stop).rejects.toThrow('CONTROL_CLOSED');
});
it('等待会话清理的控制请求不阻塞其它会话状态查询', async () => {
  let release!: () => void;
  const left = new RpcEndpoint(
    { hostInstanceId: 'host', controlEpoch: 1 },
    (frame) => queueMicrotask(() => void right.peer.receive(frame)),
    () => {},
  );
  const right = new RpcEndpoint(
    { hostInstanceId: 'host', controlEpoch: 1 },
    (frame) => queueMicrotask(() => void left.peer.receive(frame)),
    () => {},
    async (method) => {
      if (method === 'session.close') {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return {};
      }
      return null;
    },
  );
  const closing = left.call('session.close', { workspaceId: 'w', sessionId: 's' });
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  let queried = false;
  const status = left.call('run.status', { workspaceId: 'w', sessionId: 'other' }).then(() => {
    queried = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(queried).toBe(true);
  release();
  await closing;
  await status;
  left.peer.close();
  right.peer.close();
});

it('app.downloadUpdate 不被常规 30s RPC 请求超时截断', async () => {
  vi.useFakeTimers();
  try {
    let releaseDownload!: () => void;
    const left = new RpcEndpoint(
      { hostInstanceId: 'host', controlEpoch: 1 },
      (frame) => queueMicrotask(() => void right.peer.receive(frame)),
      () => {},
    );
    const right = new RpcEndpoint(
      { hostInstanceId: 'host', controlEpoch: 1 },
      (frame) => queueMicrotask(() => void left.peer.receive(frame)),
      () => {},
      async (method) => {
        if (method === 'app.downloadUpdate') {
          await new Promise<void>((resolve) => {
            releaseDownload = resolve;
          });
          return { status: 'cancelled' };
        }
        if (method === 'app.checkUpdate') {
          await new Promise<void>(() => {});
        }
        return null;
      },
    );

    const normal = left.call('app.checkUpdate', {});
    const download = left.call('app.downloadUpdate', {});
    await vi.advanceTimersByTimeAsync(10);

    // 推进 35s：普通请求已在 30s 超时，而安装包下载仍保持在途等待完成。
    const normalOutcome = normal.then(
      () => 'ok',
      (error: Error) => error.message,
    );
    await vi.advanceTimersByTimeAsync(35_000);
    await expect(normalOutcome).resolves.toBe('REQUEST_TIMEOUT');

    releaseDownload();
    await vi.advanceTimersByTimeAsync(10);
    await expect(download).resolves.toEqual({ status: 'cancelled' });

    left.peer.close();
    right.peer.close();
  } finally {
    vi.useRealTimers();
  }
});
