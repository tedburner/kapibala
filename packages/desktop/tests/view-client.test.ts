import { createPresentation } from '@kiturone/kapibala-host/view-model';
import { expect, it, vi } from 'vitest';
import { ViewClient } from '../src/renderer/view-client.js';
import type { DesktopAPI, Notification, Params } from '../src/shared/contracts.js';
import { snapshotChunks } from '../src/shared/snapshots.js';

function fixture() {
  let receive!: (event: Notification) => void | Promise<void>;
  const subscribe = vi.fn(async (_scope: Params<'presentation.subscribe'>) => {});
  const installed = vi.fn(async (_scope: Params<'presentation.installed'>) => {});
  const start = vi.fn(async () => {
    throw new Error('REQUEST_TIMEOUT');
  });
  const api = {
    onEvent: (listener: typeof receive) => {
      receive = listener;
      return () => {};
    },
    presentation: { subscribe, unsubscribe: vi.fn(async () => {}), installed },
    run: { start },
  } as unknown as DesktopAPI;
  const client = new ViewClient(api);
  const state = createPresentation({ conversationId: 'c', branchId: 'main', viewEpoch: 1 });
  return {
    client,
    subscribe,
    installed,
    start,
    state,
    receive: (event: Notification) => receive(event),
  };
}
it('旧订阅块不安装到新视图，失效后迟到完整快照也不能恢复发送', async () => {
  const f = fixture();
  await f.client.select({ workspaceId: 'w', sessionId: 's' });
  const old = f.subscribe.mock.calls[0][0];
  await f.client.resync();
  const scope = f.subscribe.mock.calls[1][0];
  for (const chunk of snapshotChunks(old, 'old', f.state)) await f.receive(chunk);
  expect(f.client.snapshot().state).toBeUndefined();
  await f.receive({ type: 'presentation.invalidated', ...scope, reason: 'OUTPUT_CONGESTED' });
  for (const chunk of snapshotChunks(scope, 'late', f.state)) await f.receive(chunk);
  expect(f.client.snapshot().valid).toBe(false);
  expect(f.installed).not.toHaveBeenCalled();
});
it('安装确认在途失效时保持冻结，状态更新不把旧安装当作成功', async () => {
  const f = fixture();
  await f.client.select({ workspaceId: 'w', sessionId: 's' });
  const scope = f.subscribe.mock.calls[0][0];
  let acknowledge!: () => void;
  f.installed.mockImplementation(
    () =>
      new Promise((resolve) => {
        acknowledge = resolve;
      }),
  );
  const task = f.receive([...snapshotChunks(scope, 'snapshot', f.state)][0]);
  await vi.waitFor(() => expect(f.installed).toHaveBeenCalledOnce());
  await f.receive({ type: 'presentation.invalidated', ...scope, reason: 'OUTPUT_CONGESTED' });
  acknowledge();
  await task;
  expect(f.client.snapshot().valid).toBe(false);
});
it('发送超时不重试，保留状态未知并冻结再次发送', async () => {
  const f = fixture();
  await expect(f.client.start({ workspaceId: 'w', sessionId: 's' }, 'execute')).rejects.toThrow(
    'REQUEST_TIMEOUT',
  );
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.client.snapshot().valid).toBe(false);
  expect(f.client.snapshot().error).toContain('不会自动重发');
});
it('后台摘要合并允许 revision 跳号，切换详情不断订；失效后旧初始回复不能恢复信任', async () => {
  let receive!: (event: Notification) => void | Promise<void>;
  let resolve!: (snapshot: { revision: number; items: [] }) => void;
  let subscriptionId = '';
  const runtimeUnsubscribe = vi.fn(async () => {});
  const api = {
    onEvent: (listener: typeof receive) => {
      receive = listener;
      return () => {};
    },
    session: {
      runtimeSubscribe: async (id: string) => {
        subscriptionId = id;
        return new Promise<{ revision: number; items: [] }>((done) => {
          resolve = done;
        });
      },
      runtimeUnsubscribe,
    },
    presentation: { unsubscribe: async () => {} },
  } as unknown as DesktopAPI;
  const client = new ViewClient(api);
  const connecting = client.connectRuntime();
  await receive({
    type: 'session.runtimeChanged',
    subscriptionId,
    snapshot: { revision: 15, items: [] },
  });
  resolve({ revision: 0, items: [] });
  await connecting;
  expect(client.snapshot().runtime?.revision).toBe(15);
  await client.clear();
  expect(runtimeUnsubscribe).not.toHaveBeenCalled();
  await receive({ type: 'session.runtimeInvalidated', subscriptionId });
  expect(client.snapshot().runtimeValid).toBe(false);
  await receive({
    type: 'session.runtimeChanged',
    subscriptionId: 'old-subscription',
    snapshot: { revision: 99, items: [] },
  });
  expect(client.snapshot().runtime).toBeUndefined();
  await receive({
    type: 'session.runtimeChanged',
    subscriptionId,
    snapshot: { revision: 100, items: [] },
  });
  expect(client.snapshot().runtimeValid).toBe(false);
  client.close();
});
it('观察失效先于初始回复时冻结该订阅，迟到数据不能恢复旧诊断', async () => {
  let receive!: (event: Notification) => void | Promise<void>;
  let complete!: (snapshot: unknown) => void;
  let scope!: Params<'presentation.subscribe'>;
  const api = {
    onEvent: (listener: typeof receive) => {
      receive = listener;
      return () => {};
    },
    presentation: {
      subscribe: async (next: typeof scope) => {
        scope = next;
      },
      unsubscribe: async () => {},
    },
    session: {
      inspect: () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    },
  } as unknown as DesktopAPI;
  const client = new ViewClient(api);
  const selecting = client.select({ workspaceId: 'w', sessionId: 's' });
  await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
  await receive({ ...scope, type: 'session.inspectionInvalidated' });
  const snapshot = {
    revision: 1,
    status: { phase: 'idle' },
    skills: { enabled: true, entries: [], diagnostics: [], omitted: 0, diagnosticsOmitted: 0 },
    mcp: { enabled: false, servers: [], diagnostics: [], omitted: 0, diagnosticsOmitted: 0 },
    tasksOmitted: 0,
    truncated: false,
  } as const;
  complete(snapshot);
  await selecting;
  expect(client.snapshot().inspection).toBeUndefined();
  await receive({
    ...scope,
    type: 'session.inspectionChanged',
    snapshot: {
      ...snapshot,
      skills: { ...snapshot.skills, entries: [], diagnostics: [] },
      mcp: { ...snapshot.mcp, servers: [], diagnostics: [] },
    },
  });
  expect(client.snapshot().inspection).toBeUndefined();
  client.close();
});
it.each(['switch', 'resync'] as const)('旧安装确认迟到拒绝不冻结后续视图：%s', async (mode) => {
  const f = fixture();
  let rejectOld!: (reason: Error) => void;
  f.installed.mockImplementationOnce(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectOld = reject;
      }),
  );
  await f.client.select({ workspaceId: 'w', sessionId: 'old' });
  const oldScope = f.subscribe.mock.calls[0][0];
  const oldTask = f.receive([...snapshotChunks(oldScope, 'old-snapshot', f.state)][0]);
  await vi.waitFor(() => expect(rejectOld).toBeTypeOf('function'));
  if (mode === 'switch') await f.client.select({ workspaceId: 'w', sessionId: 'new' });
  else await f.client.resync();
  const currentScope = f.subscribe.mock.calls[1][0];
  rejectOld(new Error('PRESENTATION_STALE'));
  await oldTask;
  const next = createPresentation({
    conversationId: 'new-conversation',
    branchId: 'main',
    viewEpoch: 1,
  });
  await f.receive([...snapshotChunks(currentScope, 'new-snapshot', next)][0]);
  expect(f.client.snapshot()).toMatchObject({
    valid: true,
    state: { identity: { conversationId: 'new-conversation' } },
  });
  expect(f.client.snapshot().error).toBeUndefined();
});
it('当前安装确认失败仍冻结发送，不能因隔离旧视图错误而吞掉当前失败', async () => {
  const f = fixture();
  f.installed.mockRejectedValueOnce(new Error('OUTPUT_CONGESTED'));
  await f.client.select({ workspaceId: 'w', sessionId: 's' });
  const scope = f.subscribe.mock.calls[0][0];
  await f.receive([...snapshotChunks(scope, 'snapshot', f.state)][0]);
  expect(f.client.snapshot().valid).toBe(false);
  expect(f.client.snapshot().error).toContain('展示校验未通过');
});
it('安装确认在途到达的缓冲重放事件按序入列，确认后不出现断档', async () => {
  const f = fixture();
  let acknowledge!: () => void;
  f.installed.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        acknowledge = resolve;
      }),
  );
  await f.client.select({ workspaceId: 'w', sessionId: 's' });
  const scope = f.subscribe.mock.calls[0][0];
  const task = f.receive([...snapshotChunks(scope, 'snapshot', f.state)][0]);
  await vi.waitFor(() => expect(f.installed).toHaveBeenCalledOnce());
  const delta = (
    sequence: number,
    change: Extract<Notification, { type: 'presentation.event' }>['event']['change'],
  ): Notification => ({
    type: 'presentation.event',
    ...scope,
    event: {
      conversationId: 'c',
      branchId: 'main',
      viewEpoch: 1,
      sequence,
      operationId: 'op-1',
      change,
    },
  });
  // Host 在安装确认处理内先重放缓冲增量，确认应答随后才到；在途期间必须照常入列。
  await f.receive(delta(1, { type: 'operation_started' }));
  await f.receive(
    delta(2, { type: 'append', messageId: 'm1', blockId: 'b1', kind: 'text', text: 'hello' }),
  );
  expect(f.client.snapshot().state?.sequence).toBe(2);
  acknowledge();
  await task;
  expect(f.client.snapshot().valid).toBe(true);
  // 确认后的后续事件保持序号连续，不再断档冻结。
  await f.receive(delta(3, { type: 'block_stopped', blockId: 'b1' }));
  expect(f.client.snapshot().state?.sequence).toBe(3);
  expect(f.client.snapshot().valid).toBe(true);
  expect(f.client.snapshot().error).toBeUndefined();
});
