import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionManager } from '@kiturone/kapibala';
import type { AgentSession } from '@kiturone/kapibala';
import type { ManagedHostSession, ManagedSessionOptions } from '@kiturone/kapibala-host/host';
import { type PresentationEvent, createPresentation } from '@kiturone/kapibala-host/view-model';
import { afterEach, expect, it, vi } from 'vitest';
import { DesktopHost } from '../src/agent-host/desktop-host.js';
import type { Notification, Output } from '../src/shared/contracts.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});
function fixture(assemble: (options: ManagedSessionOptions) => Promise<ManagedHostSession>) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-host-archive-'));
  homes.push(home);
  const events: Notification[] = [];
  const host = new DesktopHost(
    home,
    async (event) => {
      events.push(event);
    },
    assemble,
  );
  const workspace = host.workspaces.openDefault();
  host.workspaces.confirm(workspace.id, workspace.trustToken, true);
  return { host, home, workspace, events };
}
/**
 * 假句柄：conversationId 与真实桶内会话一致，才能验证「关闭句柄后删除真实文件」这条链路。
 * run 由测试给出，默认立即完成；需要「运行中」时传一个不落地的 Promise。
 */
function fakeHandle(conversationId: string, run: () => Promise<void> = async () => {}) {
  const state = createPresentation({ conversationId, branchId: 'main', viewEpoch: 1 });
  return {
    conversationId,
    session: {} as AgentSession,
    runSkill: vi.fn(async () => {}),
    runWithReferences: vi.fn(async () => {}),
    run: vi.fn(run),
    cancel: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    isBusy: (): boolean => false,
    configure: async () => {},
    // 打开中的会话改名/置顶应走句柄；用 mock 记录调用，验证没有重新抢锁。
    rename: vi.fn(async (_title: string) => {}),
    setPinned: vi.fn(async (_pinned: boolean) => {}),
    createBranchWithSummary: vi.fn(async (branchId: string) => ({ branchId, summary: '' })),
    forgetDelegation: vi.fn(),
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
    watches: () => [],
    cancelWatch: vi.fn(async () => {}),
    subscribeWatches: () => () => {},
    evidence: async () => ({
      summary: {
        additions: 0,
        deletions: 0,
        truncatedFiles: 0,
        missingFiles: 0,
        references: 0,
        mcpCalls: 0,
        mcpFailures: 0,
        runningDelegations: 0,
      },
      changes: [],
      references: [],
      mcp: [],
      delegations: [],
    }),
    checkpoints: async () => [],
    checkpointDiff: async () => ({
      available: false,
      files: [],
      additions: 0,
      deletions: 0,
      truncated: false,
    }),
    restoreCheckpoint: async () => ({
      status: 'noop' as const,
      restoredFiles: [],
      deletedFiles: [],
    }),
    worktree: () => undefined,
  } satisfies ManagedHostSession;
}
/** 用 Core 在默认空间的桶里落一条真实会话，避免假句柄绕开文件系统。 */
async function seedConversation(
  root: string,
  home: string,
  options: { text?: string; timestamp?: number } = {},
): Promise<string> {
  const manager = new SessionManager({
    workspaceRoot: root,
    homeDirectory: home,
    projectRootMode: 'exact',
  });
  const session = await manager.create();
  await session.store.append({
    id: 'msg-1',
    role: 'user',
    timestamp: options.timestamp ?? Date.now(),
    content: [{ type: 'text', text: options.text ?? '归档与删除的样例对话' }],
  });
  const conversationId = session.conversationId;
  await session.release();
  await manager.close();
  return conversationId;
}

it('归档隐藏会话并可恢复：活跃列表不再出现，归档页可读', async () => {
  const { host, home, workspace } = fixture(async () => fakeHandle('unused'));
  const conversationId = await seedConversation(workspace.root, home);

  expect(
    ((await host.dispatch('session.list', { workspaceId: workspace.id })) as Output<'session.list'>)
      .total,
  ).toBe(1);

  await host.dispatch('session.archive', { workspaceId: workspace.id, conversationId });
  expect(
    ((await host.dispatch('session.list', { workspaceId: workspace.id })) as Output<'session.list'>)
      .total,
  ).toBe(0);
  const archived = (await host.dispatch('session.archived', {
    workspaceId: workspace.id,
  })) as Output<'session.archived'>;
  expect(archived.total).toBe(1);
  expect(archived.items[0].conversationId).toBe(conversationId);

  await host.dispatch('session.restore', { workspaceId: workspace.id, conversationId });
  expect(
    ((await host.dispatch('session.list', { workspaceId: workspace.id })) as Output<'session.list'>)
      .total,
  ).toBe(1);
  await host.disconnect();
});

it('删除空闲会话会先关闭句柄再物理删除：正文与索引都不再存在', async () => {
  const { host, home, workspace } = fixture(async (options) =>
    fakeHandle(options.conversationId ?? 'unused'),
  );
  const conversationId = await seedConversation(workspace.root, home);
  const opened = (await host.dispatch('session.open', {
    workspaceId: workspace.id,
    conversationId,
  })) as Output<'session.open'>;
  expect(host.counts().sessions).toBe(1);

  await host.dispatch('session.delete', { workspaceId: workspace.id, conversationId });
  expect(host.counts().sessions).toBe(0);
  const leftovers = fs
    .readdirSync(path.join(home, '.kapibala', 'sessions'), { recursive: true, encoding: 'utf8' })
    .filter((name) => name.includes(conversationId));
  expect(leftovers).toEqual([]);
  expect(opened.conversationId).toBe(conversationId);
  await host.disconnect();
});

it('运行中的会话拒绝归档与删除，不打断在途任务', async () => {
  let finish!: () => void;
  const { host, home, workspace, events } = fixture(async (options) =>
    fakeHandle(
      options.conversationId ?? 'unused',
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
  );
  const conversationId = await seedConversation(workspace.root, home);
  const opened = (await host.dispatch('session.open', {
    workspaceId: workspace.id,
    conversationId,
  })) as Output<'session.open'>;
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
  await host.dispatch('run.start', { ...scope, input: 'long task', operationId: randomUUID() });

  for (const method of ['session.archive', 'session.delete'] as const)
    await expect(
      host.dispatch(method, { workspaceId: workspace.id, conversationId }),
    ).rejects.toThrow('SESSION_IN_USE');
  expect(host.counts().sessions).toBe(1);
  expect(
    fs
      .readdirSync(path.join(home, '.kapibala', 'sessions'), { recursive: true, encoding: 'utf8' })
      .some((name) => name.includes(conversationId)),
  ).toBe(true);

  // 收尾：让在途运行落地，否则 disconnect 会等一个永不结束的 Promise。
  finish();
  await vi.waitFor(() => expect(host.counts().runs).toBe(0));
  await host.disconnect();
});

it('未打开会话的重命名写进正文：列表标题更新，且不残留写锁', async () => {
  const { host, home, workspace } = fixture(async () => fakeHandle('unused'));
  const conversationId = await seedConversation(workspace.root, home, { text: '旧的默认标题' });

  await host.dispatch('session.rename', {
    workspaceId: workspace.id,
    conversationId,
    title: '  发布前检查  ',
  });
  const list = (await host.dispatch('session.list', {
    workspaceId: workspace.id,
  })) as Output<'session.list'>;
  expect(list.items[0].title).toBe('发布前检查');

  // 改名若把句柄留在写锁上，紧接着的删除会以 SESSION_LOCKED 失败。
  await host.dispatch('session.delete', { workspaceId: workspace.id, conversationId });
  expect(
    ((await host.dispatch('session.list', { workspaceId: workspace.id })) as Output<'session.list'>)
      .total,
  ).toBe(0);
  await host.disconnect();
});

it('置顶把会话移到列表首位并可取消：不改活动时间，取消后回到原有次序', async () => {
  const { host, home, workspace } = fixture(async () => fakeHandle('unused'));
  const older = await seedConversation(workspace.root, home, {
    text: '更早的对话',
    timestamp: Date.now() - 60_000,
  });
  const newer = await seedConversation(workspace.root, home, {
    text: '更新的对话',
    timestamp: Date.now(),
  });
  const ids = async () =>
    (
      (await host.dispatch('session.list', {
        workspaceId: workspace.id,
      })) as Output<'session.list'>
    ).items.map((item) => item.conversationId);

  expect(await ids()).toEqual([newer, older]);

  await host.dispatch('session.pin', {
    workspaceId: workspace.id,
    conversationId: older,
    pinned: true,
  });
  const pinned = (await host.dispatch('session.list', {
    workspaceId: workspace.id,
  })) as Output<'session.list'>;
  expect(pinned.items.map((item) => item.conversationId)).toEqual([older, newer]);
  expect(pinned.items[0].pinned).toBe(true);
  expect(pinned.items[0].lastActivityAt).toBeLessThan(pinned.items[1].lastActivityAt);

  await host.dispatch('session.pin', {
    workspaceId: workspace.id,
    conversationId: older,
    pinned: false,
  });
  expect(await ids()).toEqual([newer, older]);
  await host.disconnect();
});

it('已打开（含运行中）的会话改名与置顶走句柄，不重新抢锁也不关闭会话', async () => {
  let assembled: ReturnType<typeof fakeHandle> | undefined;
  const { host, home, workspace } = fixture(async (options) => {
    assembled = fakeHandle(options.conversationId ?? 'unused');
    return assembled;
  });
  const conversationId = await seedConversation(workspace.root, home);
  await host.dispatch('session.open', { workspaceId: workspace.id, conversationId });

  await host.dispatch('session.rename', {
    workspaceId: workspace.id,
    conversationId,
    title: '运行中改名',
  });
  await host.dispatch('session.pin', { workspaceId: workspace.id, conversationId, pinned: true });

  expect(assembled?.rename).toHaveBeenCalledWith('运行中改名');
  expect(assembled?.setPinned).toHaveBeenCalledWith(true);
  // 句柄未被关闭：改名与置顶都不需要先停止任务。
  expect(host.counts().sessions).toBe(1);
  await host.disconnect();
});

it('session.readArchived 只读读取已归档对话正文与工具摘要，保持归档态不变且不残留写锁', async () => {
  const { host, home, workspace } = fixture(async () => fakeHandle('unused'));
  const manager = new SessionManager({
    workspaceRoot: workspace.root,
    homeDirectory: home,
    projectRootMode: 'exact',
  });
  const created = await manager.create();
  const conversationId = created.conversationId;
  await created.store.append({
    id: 'u-1',
    role: 'user',
    timestamp: 1_700_000_010_000,
    content: [{ type: 'text', text: '请帮我检查登录超时问题' }],
  });
  await created.store.append({
    id: 'a-1',
    role: 'assistant',
    timestamp: 1_700_000_020_000,
    content: [
      {
        type: 'tool_use',
        id: 'call-1',
        name: 'read_file',
        input: { path: 'src/auth.ts' },
      },
    ],
  });
  await created.store.append({
    id: 't-1',
    role: 'tool',
    timestamp: 1_700_000_021_000,
    content: [
      {
        type: 'tool_result',
        toolUseId: 'call-1',
        content: 'timeout = 5000',
        isError: false,
      },
    ],
  });
  await created.store.append({
    id: 'a-2',
    role: 'assistant',
    timestamp: 1_700_000_030_000,
    content: [{ type: 'text', text: '已确认 `src/auth.ts` 超时配置为 5s，建议放宽至 30s。' }],
  });
  await created.release();
  await manager.close();

  await host.dispatch('session.archive', { workspaceId: workspace.id, conversationId });

  const preview = (await host.dispatch('session.readArchived', {
    workspaceId: workspace.id,
    conversationId,
  })) as Output<'session.readArchived'>;

  expect(preview.conversationId).toBe(conversationId);
  expect(preview.archived).toBe(true);
  expect(preview.items).toHaveLength(2);
  expect(preview.items[0]?.role).toBe('user');
  expect(preview.items[0]?.text).toContain('请帮我检查登录超时问题');
  expect(preview.items[1]?.role).toBe('assistant');
  expect(preview.items[1]?.text).toContain('已确认 `src/auth.ts` 超时配置为 5s');
  expect(preview.items[1]?.toolSummaries).toEqual([
    { name: 'read_file', summary: 'src/auth.ts', isError: false },
  ]);

  // 读取归档内容后会话仍保持在归档列表，且未残留写锁（紧接着可正常恢复或删除）。
  expect(
    ((await host.dispatch('session.list', { workspaceId: workspace.id })) as Output<'session.list'>)
      .total,
  ).toBe(0);
  expect(
    (
      (await host.dispatch('session.archived', {
        workspaceId: workspace.id,
      })) as Output<'session.archived'>
    ).total,
  ).toBe(1);
  await host.dispatch('session.delete', { workspaceId: workspace.id, conversationId });
  await host.disconnect();
});
