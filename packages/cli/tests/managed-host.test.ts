import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentSession,
  type SessionEvent,
  SessionManager,
  WorkspaceLeaseCoordinator,
} from '@kiturone/kapibala';
import { createManagedSession } from '@kiturone/kapibala-host/internal';
import { afterEach, describe, expect, it, vi } from 'vitest';

const roots: string[] = [];
const directory = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-managed-'));
  roots.push(root);
  return root;
};
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const home = directory();
  fs.mkdirSync(path.join(home, '.kapibala'));
  const profile = {
    id: 'fixture',
    name: 'fixture',
    provider: 'openai-compatible',
    modelName: 'fixture',
    baseURL: 'http://127.0.0.1:1/v1',
    apiKey: 'fixture-credential',
    contextWindow: 32000,
  };
  const file = path.join(home, '.kapibala/settings.json');
  fs.writeFileSync(
    file,
    JSON.stringify({ defaultModel: 'fixture', shell: { enabled: false }, profiles: [profile] }),
  );
  return { home, profile, file };
}
const approval = { requestApproval: async () => 'cancel' as const };
describe('共享受管宿主', () => {
  it('精确根不提升至祖先，全部用户路径来自显式 home；只返回公共对象', async () => {
    const { home } = fixture();
    execFileSync('git', ['init', '--quiet', home]);
    const root = path.join(home, '.kapibala/workspaces/default');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(home, '.kapibala/AGENTS.md'), 'EXPLICIT_HOME_INSTRUCTION');
    let sources: string[] = [];
    const init = AgentSession.prototype.init;
    vi.spyOn(AgentSession.prototype, 'init').mockImplementation(async function (
      this: AgentSession,
    ) {
      await init.call(this);
      sources = this.getInstructionSources();
    });
    const host = await createManagedSession({
      workspaceRoot: root,
      homeDirectory: home,
      approvalChannel: approval,
      leaseCoordinator: new WorkspaceLeaseCoordinator(),
    });
    try {
      const list = await new SessionManager({
        workspaceRoot: root,
        homeDirectory: home,
        projectRootMode: 'exact',
      }).list();
      expect(list.items.map((item) => item.conversationId)).toContain(host.conversationId);
      expect(host.snapshot().identity.conversationId).toBe(host.conversationId);
      expect(host).not.toHaveProperty('session');
      expect(host).not.toHaveProperty('history');
      expect(host).not.toHaveProperty('provider');
      expect(host.status().gitBranch).toBeUndefined();
      expect(sources).toContain(fs.realpathSync.native(path.join(home, '.kapibala/AGENTS.md')));
    } finally {
      await host.dispose();
    }
  });
  it('运行保留选择，刷新密钥且旧值仍脱敏；完整流和历史 DTO 不暴露秘密', async () => {
    const { home, profile, file } = fixture();
    const root = directory();
    let active: string | undefined;
    vi.spyOn(AgentSession.prototype, 'run').mockImplementation(async function* (
      this: AgentSession,
    ) {
      active = this.getActiveProfile().id;
      yield { type: 'text_delta', text: 'fixture-' };
      yield { type: 'text_delta', text: 'credential' };
    });
    const host = await createManagedSession({
      workspaceRoot: root,
      homeDirectory: home,
      approvalChannel: approval,
      leaseCoordinator: new WorkspaceLeaseCoordinator(),
    });
    const changes: unknown[] = [];
    host.subscribeEvents((event) => changes.push(event));
    try {
      fs.writeFileSync(
        file,
        JSON.stringify({
          defaultModel: 'other',
          shell: { enabled: false },
          profiles: [
            { ...profile, apiKey: 'replacement-credential' },
            { ...profile, id: 'other' },
          ],
        }),
      );
      await host.run('go');
      expect(active).toBe('fixture');
      expect(JSON.stringify(changes)).not.toContain('fixture-credential');
      expect(JSON.stringify(host.snapshot())).not.toContain('fixture-credential');
      expect(host.status().phase).toBe('idle');
      fs.writeFileSync(
        file,
        JSON.stringify({ defaultModel: 'other', profiles: [{ ...profile, id: 'other' }] }),
      );
      await expect(host.run('again')).rejects.toThrow(/PROFILE_UNAVAILABLE/);
    } finally {
      await host.dispose();
    }
  });
  it('取消等待在途清理；清理期间保持忙碌且不能配置或启动新 run', async () => {
    const { home } = fixture();
    let cleanup!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      cleanup = resolve;
    });
    vi.spyOn(AgentSession.prototype, 'run').mockImplementation(async function* (_input, options) {
      started();
      yield { type: 'turn_start', turn: 1 };
      try {
        await new Promise<void>((resolve) => {
          if (options!.signal!.aborted) {
            resolve();
            return;
          }
          options!.signal!.addEventListener('abort', () => resolve(), { once: true });
        });
      } finally {
        await gate;
      }
    });
    const host = await createManagedSession({
      workspaceRoot: directory(),
      homeDirectory: home,
      approvalChannel: approval,
      leaseCoordinator: new WorkspaceLeaseCoordinator(),
    });
    const running = host.run('go');
    await ready;
    let cancelled = false;
    const cancellation = host.cancel().then(() => {
      cancelled = true;
    });
    try {
      await Promise.resolve();
      expect(cancelled).toBe(false);
      expect(host.isBusy()).toBe(true);
      expect(host.status().phase).toBe('cancelling');
      expect(() => host.configure({ mode: 'Plan' })).toThrow(/SESSION_BUSY/);
      await expect(host.run('overlap')).rejects.toThrow(/SESSION_BUSY/);
    } finally {
      cleanup();
      await running;
      await cancellation;
      await host.dispose();
    }
  });
});

it('观察只返回有界脱敏状态、技能与未启动 MCP，不启动服务或收集任务', async () => {
  const { home } = fixture();
  const root = directory();
  const marker = path.join(root, 'mcp-started');
  fs.writeFileSync(
    path.join(home, '.kapibala/mcp.json'),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`],
        },
      },
    }),
  );
  const host = await createManagedSession({
    workspaceRoot: root,
    homeDirectory: home,
    approvalChannel: approval,
    leaseCoordinator: new WorkspaceLeaseCoordinator(),
  });
  try {
    const snapshot = host.inspection();
    expect(snapshot.status.phase).toBe('idle');
    expect(snapshot.mcp.servers.find((server) => server.name === 'fixture')?.state).toBe(
      'deferred',
    );
    expect(snapshot.status.tasks).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain('fixture-credential');
    expect(fs.existsSync(marker)).toBe(false);
    const changes: number[] = [];
    const unsubscribe = host.subscribeInspection(() => changes.push(1));
    host.configure({ mode: 'Plan' });
    expect(changes.length).toBeGreaterThan(0);
    unsubscribe();
    await host.dispose();
  } finally {
    await host.dispose();
  }
});

it('缺少 Provider usage 的运行保持未知；真实零用量保留，部分请求缺失不伪装成完整累计', async () => {
  const { home } = fixture();
  let round = 0;
  vi.spyOn(AgentSession.prototype, 'run').mockImplementation(async function* () {
    round++;
    yield { type: 'turn_start', turn: 1 };
    yield {
      type: 'turn_finish',
      turn: 1,
      usage: round === 1 ? undefined : { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      metrics: {},
    } as SessionEvent;
    if (round === 3) yield { type: 'turn_finish', turn: 2, metrics: {} } as SessionEvent;
  });
  const host = await createManagedSession({
    workspaceRoot: directory(),
    homeDirectory: home,
    approvalChannel: approval,
    leaseCoordinator: new WorkspaceLeaseCoordinator(),
  });
  try {
    await host.run('missing');
    expect(host.status().runUsage).toBeUndefined();
    await host.run('zero');
    expect(host.status().runUsage).toEqual({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    await host.run('partial');
    expect(host.status().runUsage).toBeUndefined();
  } finally {
    await host.dispose();
  }
});
