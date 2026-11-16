import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRuntime, AgentSession, type ModelProfile, SessionManager } from '@kiturone/kapibala';
import { listDelegationSessions } from '@kiturone/kapibala-host/internal';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionController } from '../src/active-session.js';
import { delegateCommand, parseDelegateInput } from '../src/commands/delegate.js';
import { delegationsCommand } from '../src/commands/delegations.js';
import type { CommandContext } from '../src/commands/dispatcher.js';

const directories: string[] = [];

const dummyProfile = (): ModelProfile => ({
  id: 'dummy',
  name: 'Dummy',
  provider: 'openai-compatible',
  baseURL: 'http://localhost:11434',
  apiKeyEnv: 'NONE',
  modelName: 'dummy',
});

describe('v0.1.3 /delegate and /delegations', () => {
  let root: string;
  let manager: SessionManager;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-delegate-commands-'));
    directories.push(root);
    manager = new SessionManager({
      workspaceRoot: root,
      cwd: root,
      homeDirectory: root,
      projectRootMode: 'exact',
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await manager.close();
    vi.restoreAllMocks();
    for (const directory of directories.splice(0))
      fs.rmSync(directory, { recursive: true, force: true });
  });

  const createContext = async (runtime?: AgentRuntime): Promise<CommandContext> => {
    const handle = await manager.create();
    await manager.rename(handle.conversationId, 'Parent Session');
    const session = new AgentSession({
      workspaceRoot: root,
      store: handle.store,
      conversationId: handle.conversationId,
      defaultProfile: dummyProfile(),
      defaultProvider: { chatCompletions: async function* () {} } as never,
      loggingDirectory: path.join(root, '.kapibala'),
      auditRecoveryDirectory: path.join(root, '.kapibala/audit'),
    });
    await session.init();
    const controller = {
      manager,
      session,
      handle,
      resume: async () => {},
    } as unknown as ActiveSessionController;
    return {
      session,
      controller,
      ...(runtime ? { runtime } : {}),
      settings: {} as never,
      onModelSwitched: () => {},
      onExit: () => {},
    };
  };

  it('parses task text with role/model/name flags in any order', () => {
    expect(
      parseDelegateInput('梳理模块 --role explore --name 模块梳理 --model deepseek-flash'),
    ).toEqual({
      task: '梳理模块',
      role: 'explore',
      name: '模块梳理',
      model: 'deepseek-flash',
    });
    expect(parseDelegateInput('--role implement 修复构建')).toEqual({
      task: '修复构建',
      role: 'implement',
    });
    expect(
      parseDelegateInput(
        '排查网络故障 --name "网络 故障 排查" --role "advisor" --model="custom-model"',
      ),
    ).toEqual({
      task: '排查网络故障',
      role: 'advisor',
      name: '网络 故障 排查',
      model: 'custom-model',
    });
  });

  it('/delegate 派发 detached 会话，/delegations 列表、详情与删除可用', async () => {
    const runtime = new AgentRuntime({
      runner: async (task, _signal, context) => {
        const child = await manager.create({
          delegation: {
            kind: 'delegation',
            parentSessionId: task.origin.parentSessionId,
            ...(task.description ? { parentTitle: 'Parent Session' } : {}),
            taskName: task.description,
            createdAt: Date.now(),
          },
        });
        context.onSessionCreated?.(child.conversationId);
        await child.store.appendRecord('title', { title: `${task.description} · Parent Session` });
        await child.release();
        return { summary: 'delegated result', sessionId: child.conversationId };
      },
    });
    const ctx = await createContext(runtime);

    await delegateCommand(['梳理模块 --role explore --name 模块梳理'], ctx);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('已派发委派任务'));

    await vi.waitFor(async () => {
      expect((await listDelegationSessions(manager)).length).toBe(1);
    });
    const [delegation] = await listDelegationSessions(manager);

    logSpy.mockClear();
    await delegationsCommand([], ctx);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(delegation.sessionId));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('模块梳理'));

    logSpy.mockClear();
    await delegationsCommand(['show', delegation.sessionId.slice(0, 8)], ctx);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('── 委派会话详情'));

    await runtime.waitAgents([...runtime.listTasks().map((task) => task.agentId)], 5_000);
    logSpy.mockClear();
    await delegationsCommand(['delete', delegation.sessionId], ctx);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('已删除委派会话'));
    expect(await listDelegationSessions(manager)).toHaveLength(0);
    await runtime.close();
  });

  it('没有运行时不静默降级：/delegate 明确提示未启用调度器', async () => {
    const ctx = await createContext();
    await delegateCommand(['任意任务'], ctx);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('未启用子代理后台调度器'));
  });
});
