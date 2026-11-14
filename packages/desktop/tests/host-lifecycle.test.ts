import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ManagedHostSession, ManagedSessionOptions } from '@kiturone/kapibala-cli/host';
import { type PresentationEvent, createPresentation } from '@kiturone/kapibala-cli/view-model';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopHost } from '../src/agent-host/desktop-host.js';
import { LIMITS, type Notification, type Output } from '../src/shared/contracts.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function fixture(
  assemble: (options: ManagedSessionOptions) => Promise<ManagedHostSession>,
  onNotify?: (event: Notification) => Promise<void>,
) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-host-life-'));
  homes.push(home);
  const events: Notification[] = [];
  const host = new DesktopHost(
    home,
    async (event) => {
      events.push(event);
      await onNotify?.(event);
    },
    assemble,
  );
  const workspace = host.workspaces.openDefault();
  host.workspaces.confirm(workspace.id, workspace.trustToken, true);
  return { host, workspace, events };
}
function handle() {
  const state = createPresentation({
    conversationId: 'conversation',
    branchId: 'main',
    viewEpoch: 1,
  });
  return {
    conversationId: 'conversation',
    run: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    // 显式放宽可变写的签名：字面量推断出的窄类型（如 () => false）会让测试覆盖重写时类型失配。
    isBusy: (): boolean => false,
    configure: () => {},
    // 重命名与置顶只写控制记录：本层测试不落盘，签名满足受管会话即可。
    rename: vi.fn(async () => {}),
    setPinned: vi.fn(async () => {}),
    snapshot: () => state,
    subscribeEvents: (_listener: (event: PresentationEvent) => void) => () => {},
    configuration: () => ({
      profileId: 'deepseek-flash',
      role: 'default' as const,
      mode: 'Approval' as const,
    }),
    status: () => ({ phase: 'idle' as const }),
    inspection: () => ({
      status: { phase: 'idle' as const },
      skills: { enabled: true, entries: [], diagnostics: [], omitted: 0, diagnosticsOmitted: 0 },
      mcp: { enabled: false, servers: [], diagnostics: [], omitted: 0, diagnosticsOmitted: 0 },
      tasksOmitted: 0,
      truncated: false,
    }),
    subscribeInspection: () => () => {},
  } satisfies ManagedHostSession;
}
it('断开等待正在装配的会话释放，未释放前不得宣告 cleaned', async () => {
  let assembled!: (value: ManagedHostSession) => void;
  let released!: () => void;
  const resource = handle();
  resource.dispose = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        released = resolve;
      }),
  );
  const { host, workspace } = fixture(
    () =>
      new Promise((resolve) => {
        assembled = resolve;
      }),
  );
  const opening = host.dispatch('session.create', { workspaceId: workspace.id });
  void opening.catch(() => {});
  let cleaned = false;
  const closing = host.disconnect().then(() => {
    cleaned = true;
  });
  assembled(resource);
  await vi.waitFor(() => expect(resource.dispose).toHaveBeenCalledOnce());
  expect(cleaned).toBe(false);
  released();
  await closing;
  await expect(opening).rejects.toThrow('HOST_UNAVAILABLE');
  expect(host.counts().sessions).toBe(0);
});
it('清理失败保留句柄并允许重试，不释放可再次运行的资源', async () => {
  const resource = handle();
  resource.dispose.mockRejectedValueOnce(new Error('cleanup-failed'));
  const { host, workspace } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  const scope = { workspaceId: opened.workspaceId, sessionId: opened.sessionId };
  await expect(host.dispatch('session.close', scope)).rejects.toThrow('cleanup-failed');
  expect(host.counts().sessions).toBe(1);
  await expect(
    host.dispatch('run.start', { ...scope, input: 'unsafe-reuse', operationId: randomUUID() }),
  ).rejects.toThrow('SESSION_CLEANUP_FAILED');
  await expect(host.dispatch('session.configure', { ...scope, mode: 'Plan' })).rejects.toThrow(
    'SESSION_CLEANUP_FAILED',
  );
  await expect(
    host.dispatch('session.open', {
      workspaceId: workspace.id,
      conversationId: opened.conversationId,
    }),
  ).rejects.toThrow('SESSION_CLEANUP_FAILED');
  await host.dispatch('session.close', scope);
  expect(host.counts().sessions).toBe(0);
  await host.disconnect();
});
it('同一个操作 ID 只执行一次，内容冲突与跨空间句柄必须拒绝', async () => {
  const resource = handle();
  const { host, workspace, events } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  const scope = { workspaceId: opened.workspaceId, sessionId: opened.sessionId };
  const subscriptionId = randomUUID();
  await host.dispatch('presentation.subscribe', { ...scope, subscriptionId });
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === 'presentation.chunk')).toBe(true),
  );
  const chunk = events.find((event) => event.type === 'presentation.chunk')! as Extract<
    Notification,
    { type: 'presentation.chunk' }
  >;
  await host.dispatch('presentation.installed', {
    ...scope,
    subscriptionId,
    snapshotId: chunk.snapshotId,
    sequence: chunk.sequence,
  });
  const input = { ...scope, input: 'hello', operationId: randomUUID() };
  const first = await host.dispatch('run.start', input);
  const second = await host.dispatch('run.start', input);
  expect((first as { runId: string }).runId).toBe((second as { runId: string }).runId);
  expect(resource.run).toHaveBeenCalledOnce();
  await expect(host.dispatch('run.start', { ...input, input: 'different' })).rejects.toThrow(
    'OPERATION_CONFLICT',
  );
  await expect(host.dispatch('run.status', { ...scope, workspaceId: 'other' })).rejects.toThrow(
    'SESSION_NOT_FOUND',
  );
  await host.disconnect();
});
it('审批绑定会话与运行，禁止会话级扩权，断开默认拒绝且不留下审批', async () => {
  let approved: string | undefined;
  const resource = handle();
  const { host, workspace, events } = fixture(async (options) => {
    resource.run.mockImplementation(async () => {
      approved = await options.approvalChannel.requestApproval({
        toolName: 'write_file',
        capabilities: [],
        input: { path: 'proof.txt' },
        rootDir: options.workspaceRoot,
        sessionAllowed: false,
      });
    });
    return resource;
  });
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  const scope = { workspaceId: workspace.id, sessionId: opened.sessionId };
  const subscriptionId = randomUUID();
  await host.dispatch('presentation.subscribe', { ...scope, subscriptionId });
  const chunk = events.find((event) => event.type === 'presentation.chunk')! as Extract<
    Notification,
    { type: 'presentation.chunk' }
  >;
  await host.dispatch('presentation.installed', {
    ...scope,
    subscriptionId,
    snapshotId: chunk.snapshotId,
    sequence: chunk.sequence,
  });
  await host.dispatch('run.start', { ...scope, input: 'approval', operationId: randomUUID() });
  const approval = events.find((event) => event.type === 'approval.requested')! as Extract<
    Notification,
    { type: 'approval.requested' }
  >;
  const reply = {
    ...scope,
    runId: approval.runId,
    approvalId: approval.approvalId,
    choice: 'allow_once',
  };
  await expect(host.dispatch('approval.reply', { ...reply, runId: 'other' })).rejects.toThrow(
    'APPROVAL_EXPIRED',
  );
  await expect(
    host.dispatch('approval.reply', { ...reply, choice: 'allow_session' }),
  ).rejects.toThrow('FORBIDDEN');
  await host.disconnect();
  expect(approved).toBe('deny_once');
  expect(host.counts().approvals).toBe(0);
  expect(host.counts().sessions).toBe(0);
});
it('后台摘要不依赖正文订阅，显式关闭后释放槽位且旧退订不能停止新摘要', async () => {
  const resource = handle();
  const { host, workspace, events } = fixture(async () => resource);
  const subscriptionId = randomUUID();
  const initial = (await host.dispatch('session.runtimeSubscribe', { subscriptionId })) as {
    revision: number;
    items: unknown[];
  };
  expect(initial.items).toEqual([]);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === 'session.runtimeChanged')).toBe(true),
  );
  const snapshot = events
    .filter((event) => event.type === 'session.runtimeChanged')
    .at(-1)! as Extract<Notification, { type: 'session.runtimeChanged' }>;
  expect(snapshot.snapshot.items[0].sessionId).toBe(opened.sessionId);
  const second = randomUUID();
  await host.dispatch('session.runtimeSubscribe', { subscriptionId: second });
  await host.dispatch('session.runtimeUnsubscribe', { subscriptionId });
  await host.dispatch('session.close', { workspaceId: workspace.id, sessionId: opened.sessionId });
  await vi.waitFor(() =>
    expect(events.filter((event) => event.type === 'session.runtimeChanged').at(-1)).toMatchObject({
      subscriptionId: second,
      snapshot: { items: [] },
    }),
  );
  expect(JSON.stringify(snapshot)).not.toContain('hello');
  await host.disconnect();
});
it('八句柄与四运行预算独立；正文退订和摘要拥塞不阻止取消，连续重同步不重放', async () => {
  const resources: ReturnType<typeof handle>[] = [];
  const releases: Array<() => void> = [];
  let acknowledge!: () => void;
  const congestion = new Promise<void>((resolve) => {
    acknowledge = resolve;
  });
  const { host, workspace, events } = fixture(
    async () => {
      const resource = handle();
      resource.conversationId = randomUUID();
      resource.run.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            releases.push(resolve);
          }),
      );
      resource.cancel.mockImplementation(async () => {
        releases.shift()?.();
      });
      resources.push(resource);
      return resource;
    },
    async (event) => {
      if (event.type === 'session.runtimeChanged') await congestion;
    },
  );
  await host.dispatch('session.runtimeSubscribe', { subscriptionId: randomUUID() });
  const opened: Output<'session.create'>[] = [];
  for (let i = 0; i < 8; i++)
    opened.push(
      (await host.dispatch('session.create', {
        workspaceId: workspace.id,
      })) as Output<'session.create'>,
    );
  await expect(host.dispatch('session.create', { workspaceId: workspace.id })).rejects.toThrow(
    'SESSION_LIMIT',
  );
  const install = async (row: Output<'session.create'>) => {
    const scope = {
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      subscriptionId: randomUUID(),
    };
    await host.dispatch('presentation.subscribe', scope);
    const chunk = events
      .filter(
        (event) =>
          event.type === 'presentation.chunk' && event.subscriptionId === scope.subscriptionId,
      )
      .at(-1)! as Extract<Notification, { type: 'presentation.chunk' }>;
    await host.dispatch('presentation.installed', {
      ...scope,
      snapshotId: chunk.snapshotId,
      sequence: chunk.sequence,
    });
    return scope;
  };
  const subscriptions = [];
  for (const row of opened.slice(0, 5)) subscriptions.push(await install(row));
  for (const row of opened.slice(0, 4))
    await host.dispatch('run.start', {
      workspaceId: row.workspaceId,
      sessionId: row.sessionId,
      input: 'pressure',
      operationId: randomUUID(),
    });
  await expect(
    host.dispatch('run.start', {
      workspaceId: workspace.id,
      sessionId: opened[4].sessionId,
      input: 'fifth',
      operationId: randomUUID(),
    }),
  ).rejects.toThrow('RUN_LIMIT');
  await host.dispatch('presentation.unsubscribe', subscriptions[0]);
  for (let i = 0; i < 30; i++) await install(opened[1]);
  expect(resources[1].run).toHaveBeenCalledOnce();
  const receipt = (await host.dispatch('run.status', {
    workspaceId: workspace.id,
    sessionId: opened[0].sessionId,
  })) as Output<'run.status'>;
  await host.dispatch('run.cancel', {
    workspaceId: workspace.id,
    sessionId: opened[0].sessionId,
    runId: receipt!.runId,
  });
  await vi.waitFor(() => expect(host.counts().runs).toBe(3));
  expect(resources[0].cancel).toHaveBeenCalledOnce();
  for (const release of releases.splice(0)) release();
  acknowledge();
  await host.disconnect();
  expect(host.counts().sessions).toBe(0);
});
it('安装确认前的增量被缓冲，确认后按序重放并与快照序号连续', async () => {
  const resource = handle();
  let emit: ((event: PresentationEvent) => void) | undefined;
  resource.subscribeEvents = (listener) => {
    emit = listener;
    return () => {};
  };
  const { host, workspace, events } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  const scope = { workspaceId: opened.workspaceId, sessionId: opened.sessionId };
  const subscriptionId = randomUUID();
  await host.dispatch('presentation.subscribe', { ...scope, subscriptionId });
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === 'presentation.chunk')).toBe(true),
  );
  const delta = (sequence: number, change: PresentationEvent['change']): PresentationEvent => ({
    conversationId: 'conversation',
    branchId: 'main',
    viewEpoch: 1,
    sequence,
    operationId: 'op-1',
    change,
  });
  // 快照水位之后的增量在安装确认前只缓冲不下发。
  emit!(delta(1, { type: 'operation_started' }));
  emit!(delta(2, { type: 'append', messageId: 'm1', blockId: 'b1', kind: 'text', text: 'hello' }));
  emit!(delta(3, { type: 'block_stopped', blockId: 'b1' }));
  expect(events.some((event) => event.type === 'presentation.event')).toBe(false);
  const chunk = events.find((event) => event.type === 'presentation.chunk')! as Extract<
    Notification,
    { type: 'presentation.chunk' }
  >;
  await host.dispatch('presentation.installed', {
    ...scope,
    subscriptionId,
    snapshotId: chunk.snapshotId,
    sequence: chunk.sequence,
  });
  await vi.waitFor(() =>
    expect(events.filter((event) => event.type === 'presentation.event')).toHaveLength(3),
  );
  expect(
    events
      .filter((event) => event.type === 'presentation.event')
      .map(
        (event) => (event as Extract<Notification, { type: 'presentation.event' }>).event.sequence,
      ),
  ).toEqual([1, 2, 3]);
  // 重放后安装完成，运行入口恢复可用。
  const started = (await host.dispatch('run.start', {
    ...scope,
    input: 'ready',
    operationId: randomUUID(),
  })) as Output<'run.start'>;
  expect(started.phase).toBe('running');
  await new Promise((resolve) => setImmediate(resolve));
  await host.disconnect();
});
it('清理完成后 settling 收据在读取入口自动收口，会话可再次运行', async () => {
  const resource = handle();
  let busy = false;
  resource.isBusy = (): boolean => busy;
  const releases: Array<() => void> = [];
  let rejectCancel!: (reason: Error) => void;
  resource.run.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        releases.push(resolve);
      }),
  );
  resource.cancel.mockImplementation(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectCancel = reject;
      }),
  );
  const { host, workspace, events } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  const scope = { workspaceId: opened.workspaceId, sessionId: opened.sessionId };
  const subscriptionId = randomUUID();
  await host.dispatch('presentation.subscribe', { ...scope, subscriptionId });
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === 'presentation.chunk')).toBe(true),
  );
  const chunk = events.find((event) => event.type === 'presentation.chunk')! as Extract<
    Notification,
    { type: 'presentation.chunk' }
  >;
  await host.dispatch('presentation.installed', {
    ...scope,
    subscriptionId,
    snapshotId: chunk.snapshotId,
    sequence: chunk.sequence,
  });
  const started = (await host.dispatch('run.start', {
    ...scope,
    input: 'cancel-me',
    operationId: randomUUID(),
  })) as Output<'run.start'>;
  // 模拟清理在途：取消清理失败后收据停在 settling，此时没有任何事件会再推进它。
  busy = true;
  await host.dispatch('run.cancel', { ...scope, runId: started.runId });
  rejectCancel(new Error('cleanup-stuck'));
  const stuck = (await host.dispatch('run.status', scope)) as Output<'run.status'>;
  expect(stuck!.phase).toBe('settling');
  // 清理完成后，读取入口复查即可收口，不需要关闭会话。
  busy = false;
  const healed = (await host.dispatch('run.status', scope)) as Output<'run.status'>;
  expect(healed!.phase).toBe('idle');
  expect(healed!.settledAt).toBeTypeOf('number');
  for (const release of releases.splice(0)) release();
  await new Promise((resolve) => setImmediate(resolve));
  const next = (await host.dispatch('run.start', {
    ...scope,
    input: 'again',
    operationId: randomUUID(),
  })) as Output<'run.start'>;
  expect(next.phase).toBe('running');
  expect(resource.run).toHaveBeenCalledTimes(2);
  for (const release of releases.splice(0)) release();
  await new Promise((resolve) => setImmediate(resolve));
  await host.disconnect();
});
it('终态操作记录按容量淘汰，长期使用不会触达 OPERATION_LIMIT', async () => {
  const resource = handle();
  const { host, workspace, events } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  const scope = { workspaceId: opened.workspaceId, sessionId: opened.sessionId };
  const subscriptionId = randomUUID();
  await host.dispatch('presentation.subscribe', { ...scope, subscriptionId });
  await vi.waitFor(() =>
    expect(events.some((event) => event.type === 'presentation.chunk')).toBe(true),
  );
  const chunk = events.find((event) => event.type === 'presentation.chunk')! as Extract<
    Notification,
    { type: 'presentation.chunk' }
  >;
  await host.dispatch('presentation.installed', {
    ...scope,
    subscriptionId,
    snapshotId: chunk.snapshotId,
    sequence: chunk.sequence,
  });
  const first = (await host.dispatch('run.start', {
    ...scope,
    input: 'load',
    operationId: randomUUID(),
  })) as Output<'run.start'>;
  const firstOperationId = first.operationId;
  for (let i = 1; i < LIMITS.operations; i++) {
    // 先排空上一轮运行收口的微任务链，确保本轮 start 读到 idle 相位。
    await new Promise((resolve) => setImmediate(resolve));
    await host.dispatch('run.start', { ...scope, input: 'load', operationId: randomUUID() });
  }
  await new Promise((resolve) => setImmediate(resolve));
  expect(host.counts().operations).toBeLessThanOrEqual(LIMITS.operations);
  // 恰好达到容量：终态记录被淘汰，新发送继续成功（旧实现在此永久抛 OPERATION_LIMIT）。
  const after = (await host.dispatch('run.start', {
    ...scope,
    input: 'load',
    operationId: randomUUID(),
  })) as Output<'run.start'>;
  expect(after.phase).toBe('running');
  // 尚未淘汰的记录保持幂等；被淘汰的旧 ID 重放等同新发送。
  const replay = (await host.dispatch('run.start', {
    ...scope,
    input: 'load',
    operationId: after.operationId,
  })) as Output<'run.start'>;
  expect(replay.runId).toBe(after.runId);
  await new Promise((resolve) => setImmediate(resolve));
  const replayed = (await host.dispatch('run.start', {
    ...scope,
    input: 'load',
    operationId: firstOperationId,
  })) as Output<'run.start'>;
  expect(replayed.runId).not.toBe(first.runId);
  await new Promise((resolve) => setImmediate(resolve));
  await host.disconnect();
}, 60_000);
