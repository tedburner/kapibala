import { expect, it } from 'vitest';
import { createPresentation } from '../../cli/src/view-model/index.js';
import { LIMITS, encodedBytes } from '../src/shared/contracts.js';
import { SnapshotAssembler, snapshotChunks } from '../src/shared/snapshots.js';
import { BoundedPeer } from '../src/shared/transport.js';

it('独立控制通道可穿过正文拥塞，旧代次与越界 ACK 不释放额度', async () => {
  const frames: string[] = [];
  let closed = '';
  const peer = new BoundedPeer(
    { hostInstanceId: 'host', controlEpoch: 1 },
    (frame) => frames.push(frame),
    () => {},
    (reason) => {
      closed = reason;
    },
  );
  const pending = peer.send({ text: 'x'.repeat(900_000) });
  void pending.catch(() => {});
  expect(peer.pendingBytes('data')).toBeGreaterThan(900_000);
  const control = peer.send({ method: 'run.cancel' }, 'control');
  void control.catch(() => {});
  expect(frames.map((frame) => JSON.parse(frame).lane)).toEqual(['data', 'control']);
  await peer.receive(
    JSON.stringify({
      kind: 'ack',
      hostInstanceId: 'host',
      controlEpoch: 0,
      lane: 'data',
      sequence: 1,
    }),
  );
  expect(peer.pendingBytes('data')).toBeGreaterThan(900_000);
  await peer.receive(
    JSON.stringify({
      kind: 'ack',
      hostInstanceId: 'host',
      controlEpoch: 1,
      lane: 'data',
      sequence: 2,
    }),
  );
  expect(closed).toBe('INVALID_ACK');
  await expect(pending).rejects.toThrow();
});
it('5-8 MiB 中文快照逐块接收 ACK，4 MiB 发送窗口不等待完整安装', async () => {
  const state = createPresentation({ conversationId: 'c', branchId: 'main', viewEpoch: 1 }, [
    {
      id: 'message',
      role: 'user',
      state: 'completed',
      persisted: true,
      blocks: [
        {
          id: 'block',
          kind: 'text',
          text: '中文🙂'.repeat(600_000),
          state: 'completed',
          revision: 0,
        },
      ],
    },
  ]);
  expect(encodedBytes(state)).toBeGreaterThan(5 * 1024 * 1024);
  const assembler = new SnapshotAssembler();
  let installed: unknown;
  const a = new BoundedPeer(
    { hostInstanceId: 'host', controlEpoch: 1 },
    (frame) => {
      queueMicrotask(() => void b.receive(frame));
    },
    () => {},
  );
  const b = new BoundedPeer(
    { hostInstanceId: 'host', controlEpoch: 1 },
    (frame) => {
      queueMicrotask(() => void a.receive(frame));
    },
    (body) => {
      const result = assembler.accept(body);
      if (result) installed = result;
    },
  );
  for (const chunk of snapshotChunks(
    { workspaceId: 'w', sessionId: 's', subscriptionId: 'subscription' },
    'snapshot',
    state,
  ))
    await a.send(chunk);
  expect(installed).toEqual(state);
  expect(a.pendingBytes('data')).toBe(0);
  a.close();
  b.close();
});
it('分块乱序、重复和超限拒绝，不能安装半份快照', () => {
  const state = createPresentation({ conversationId: 'c', branchId: 'main', viewEpoch: 1 });
  const [chunk] = [
    ...snapshotChunks(
      { workspaceId: 'w', sessionId: 's', subscriptionId: 'subscription' },
      'snapshot',
      state,
    ),
  ];
  expect(() => new SnapshotAssembler().accept({ ...chunk, index: 1 })).toThrow();
  expect(() =>
    new SnapshotAssembler().accept({ ...chunk, totalBytes: LIMITS.snapshot + 1 }),
  ).toThrow();
});
it('快照校验失败清空暂存，不允许混用订阅身份或留下半份状态', () => {
  const state = createPresentation({ conversationId: 'c', branchId: 'main', viewEpoch: 1 }, [
    {
      id: 'm',
      role: 'user',
      state: 'completed',
      persisted: true,
      blocks: [
        { id: 'b', kind: 'text', text: 'x'.repeat(300_000), state: 'completed', revision: 0 },
      ],
    },
  ]);
  const chunks = [
    ...snapshotChunks({ workspaceId: 'w', sessionId: 's', subscriptionId: 'a' }, 'snapshot', state),
  ];
  const assembler = new SnapshotAssembler();
  assembler.accept(chunks[0]);
  expect(() => assembler.accept({ ...chunks[1], subscriptionId: 'b' })).toThrow();
  expect(assembler.accept(chunks[0])).toBeUndefined();
  expect(assembler.accept(chunks[1])).toEqual(state);
});
