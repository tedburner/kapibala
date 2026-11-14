import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-cmd-surface-'));
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
  return { host, workspace, events, home };
}
function handle() {
  const state = createPresentation({
    conversationId: 'conversation',
    branchId: 'main',
    viewEpoch: 1,
  });
  return {
    conversationId: 'conversation',
    session: {} as AgentSession,
    runSkill: vi.fn(async () => {}),
    run: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    isBusy: (): boolean => false,
    configure: () => {},
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

it('命令目录与 CLI 同源：/skills 存在；桌面不承接的命令被过滤', async () => {
  const { host } = fixture(async () => handle());
  const list = (await host.dispatch('run.commandList', {})) as Output<'run.commandList'>;
  const skills = list.commands.find((command) => command.name === 'skills');
  expect(skills?.interactionLevel).toBe('none');
  // model/exit/prompt 依赖 CLI 宿主回调或收据管线适配，桌面未接入——
  // 补全目录不展示它们，避免出现点了会假成功的条目。
  expect(list.commands.find((command) => command.name === 'model')).toBeUndefined();
  expect(list.commands.find((command) => command.name === 'exit')).toBeUndefined();
  expect(list.commands.find((command) => command.name === 'prompt')).toBeUndefined();
});

it('门禁命令给出明确反馈且不产生模型运行', async () => {
  const resource = handle();
  const { host, workspace } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  const result = (await host.dispatch('run.command', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
    input: '/model deepseek-flash',
  })) as Output<'run.command'>;
  expect(result.handled).toBe(true);
  expect(result.feedback.join('\n')).toContain('设置面板');
  expect(resource.run).not.toHaveBeenCalled();
  // 裸退出别名同样被拦截（exit/quit 白名单语义与 CLI 一致）
  const quit = (await host.dispatch('run.command', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
    input: 'quit',
  })) as Output<'run.command'>;
  expect(quit.handled).toBe(true);
  expect(quit.feedback.join('\n')).toContain('关闭窗口');
});

it('run.skillCatalog 按可调用口径过滤', async () => {
  const skill = (overrides: Record<string, unknown>) => ({
    name: 's',
    description: '',
    scope: 'global',
    userInvocable: true,
    available: true,
    disabled: false,
    ...overrides,
  });
  const resource = handle();
  const withSkills = {
    ...resource,
    session: {
      getSkills: () => ({
        skills: [
          skill({ name: 'ok-skill', description: '可调用技能', scope: 'project' }),
          skill({ name: 'off-skill', disabled: true }),
          skill({ name: 'model-only', userInvocable: false }),
          skill({ name: 'untrusted', available: false, unavailableReason: '项目技能尚未信任' }),
          skill({ name: 'long-desc', description: 'x'.repeat(300) }),
        ],
      }),
    } as unknown as AgentSession,
  };
  const { host, workspace } = fixture(async () => withSkills);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  const result = (await host.dispatch('run.skillCatalog', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
  })) as Output<'run.skillCatalog'>;
  expect(result.installed).toBe(true);
  expect(result.truncated).toBe(false);
  // 禁用 / 非用户可调用 / 不可用三项全部排除，与 CLI `/skill ` 名字补全同口径
  expect(result.skills.map((skill) => skill.name)).toEqual(['ok-skill', 'long-desc']);
  // 超长描述宿主侧截断（256 字符 + 省略号）
  const long = result.skills.find((skill) => skill.name === 'long-desc');
  expect(long?.description.length).toBe(257);
  expect(long?.description.endsWith('…')).toBe(true);
});

it('run.skillCatalog 空目录如实上报并支持截断', async () => {
  const empty = handle();
  const { host, workspace } = fixture(async () => ({
    ...empty,
    session: {
      getSkills: () => ({ skills: [] }),
    } as unknown as AgentSession,
  }));
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  const result = (await host.dispatch('run.skillCatalog', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
  })) as Output<'run.skillCatalog'>;
  expect(result.installed).toBe(false);
  expect(result.skills).toEqual([]);

  const flooded = handle();
  const { host: host2, workspace: workspace2 } = fixture(async () => ({
    ...flooded,
    session: {
      getSkills: () => ({
        skills: Array.from({ length: 501 }, (_, index) => ({
          name: `skill-${index}`,
          description: '',
          scope: 'global',
          userInvocable: true,
          available: true,
          disabled: false,
        })),
      }),
    } as unknown as AgentSession,
  }));
  const opened2 = (await host2.dispatch('session.create', {
    workspaceId: workspace2.id,
  })) as Output<'session.create'>;
  const floodedResult = (await host2.dispatch('run.skillCatalog', {
    workspaceId: opened2.workspaceId,
    sessionId: opened2.sessionId,
  })) as Output<'run.skillCatalog'>;
  expect(floodedResult.skills).toHaveLength(500);
  expect(floodedResult.truncated).toBe(true);
});

it('run.skillCatalog 会话归属校验：跨会话拒绝', async () => {
  const resource = handle();
  const { host, workspace } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  await expect(
    host.dispatch('run.skillCatalog', {
      workspaceId: opened.workspaceId,
      sessionId: randomUUID(),
    }),
  ).rejects.toThrow();
});

it('/skill 直发：start 门禁拒绝必须以命令反馈可见，不能静默消失', async () => {
  // 未完成 presentation 握手（renderer 未 installed）→ start 抛 PRESENTATION_STALE。
  // 回归用户报障场景：fire-and-forget 时代该失败被静默吞掉，用户看到「什么都没发生」。
  const resource = handle();
  const { host, workspace } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  const result = (await host.dispatch('run.command', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
    input: '/skill demo-skill 整理周报',
  })) as Output<'run.command'>;
  expect(result.handled).toBe(true);
  expect(result.feedback.join('\n')).toContain('PRESENTATION_STALE');
  expect(resource.runSkill).not.toHaveBeenCalled();
});

/** presentation 握手：subscribe → 快照分块投递完成（posted）→ installed 确认。 */
async function installPresentation(
  host: DesktopHost,
  opened: Output<'session.create'>,
  events: Notification[],
): Promise<void> {
  const subscriptionId = randomUUID();
  await host.dispatch('presentation.subscribe', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
    subscriptionId,
  });
  await vi.waitFor(() => {
    const chunks = events.filter((event) => event.type === 'presentation.chunk');
    const last = chunks.at(-1);
    if (!last || !(last as { count: number; index: number }).count) throw new Error('not posted');
    expect((last as { index: number; count: number }).index).toBe(
      (last as { index: number; count: number }).count - 1,
    );
  });
  const last = (
    events.filter((event) => event.type === 'presentation.chunk') as Extract<
      Notification,
      { type: 'presentation.chunk' }
    >[]
  ).at(-1);
  if (!last) throw new Error('presentation chunks not posted');
  await host.dispatch('presentation.installed', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
    subscriptionId,
    snapshotId: last.snapshotId,
    sequence: last.sequence,
  });
}

it('/skill 直发走收据管线：握手后 runSkill 收到名称与任务', async () => {
  const resource = handle();
  const { host, workspace, events } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  await installPresentation(host, opened, events);
  const result = (await host.dispatch('run.command', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
    input: '/skill demo-skill 整理周报',
  })) as Output<'run.command'>;
  expect(result.handled).toBe(true);
  expect(result.feedback).toEqual([]);
  // commandContext.runSkill 经收据管线启动后异步调用 handle.runSkill
  await vi.waitFor(() => expect(resource.runSkill).toHaveBeenCalledWith('demo-skill', '整理周报'));
  const receipt = (await host.dispatch('run.status', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
  })) as Output<'run.status'>;
  expect(receipt).not.toBeNull();
});

it('/skill <名称> 无任务直发：合成启动任务走收据管线', async () => {
  const resource = handle();
  const { host, workspace, events } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  await installPresentation(host, opened, events);
  const result = (await host.dispatch('run.command', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
    input: '/skill demo-skill',
  })) as Output<'run.command'>;
  // 桌面「选技能即跑」：不命中 CLI 的非空任务校验，直接进收据管线
  expect(result.handled).toBe(true);
  expect(result.feedback).toEqual([]);
  await vi.waitFor(() =>
    expect(resource.runSkill).toHaveBeenCalledWith('demo-skill', '开始执行该技能。'),
  );
  const receipt = (await host.dispatch('run.status', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
  })) as Output<'run.status'>;
  expect(receipt).not.toBeNull();
});

it('未知命令被分发器闭合为 handled=true 并给出反馈', async () => {
  const resource = handle();
  const { host, workspace } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  const result = (await host.dispatch('run.command', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
    input: '/nosuchcmd',
  })) as Output<'run.command'>;
  // 分发器把未知命令闭合为 true + 反馈：绝不回落到模型（CLI 同语义）
  expect(result.handled).toBe(true);
  expect(result.feedback.join('\n')).toContain('未知命令');
  expect(resource.run).not.toHaveBeenCalled();
});

it('/help 输出命令反馈且不发给模型', async () => {
  const resource = handle();
  const { host, workspace } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  const result = (await host.dispatch('run.command', {
    workspaceId: opened.workspaceId,
    sessionId: opened.sessionId,
    input: '/help',
  })) as Output<'run.command'>;
  expect(result.handled).toBe(true);
  expect(result.feedback.length).toBeGreaterThan(0);
  expect(resource.run).not.toHaveBeenCalled();
});

it('listFiles 只返回沙箱内相对路径并排除忽略目录', async () => {
  const { host, workspace, home } = fixture(async () => handle());
  // 默认空间的物理根是 home/.kapibala/workspaces/default
  const root = path.join(home, '.kapibala/workspaces/default');
  fs.mkdirSync(path.join(root, 'src/nested'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src/nested/a.ts'), 'x');
  fs.mkdirSync(path.join(root, 'node_modules/pkg'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/pkg/index.js'), 'x');
  fs.mkdirSync(path.join(root, '.git/objects'), { recursive: true });
  const list = (await host.dispatch('workspace.listFiles', {
    workspaceId: workspace.id,
  })) as Output<'workspace.listFiles'>;
  expect(list.files).toContain(path.join('src', 'nested', 'a.ts'));
  expect(list.files.every((file) => !file.includes('node_modules'))).toBe(true);
  expect(list.files.every((file) => !file.includes('.git'))).toBe(true);
  expect(list.truncated).toBe(false);
});

it('未信任工作区拒绝枚举', async () => {
  const { host } = fixture(async () => handle());
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-cmd-untrust-'));
  homes.push(project);
  const space = host.workspaces.registerProject(project);
  await expect(host.dispatch('workspace.listFiles', { workspaceId: space.id })).rejects.toThrow(
    /TRUST_REQUIRED/,
  );
});

it('run.command 会话归属校验：跨会话拒绝', async () => {
  const resource = handle();
  const { host, workspace } = fixture(async () => resource);
  const opened = (await host.dispatch('session.create', {
    workspaceId: workspace.id,
  })) as Output<'session.create'>;
  await expect(
    host.dispatch('run.command', {
      workspaceId: opened.workspaceId,
      sessionId: randomUUID(),
      input: '/help',
    }),
  ).rejects.toThrow();
});
