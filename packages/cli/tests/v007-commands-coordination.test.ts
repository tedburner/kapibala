import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  AgentRuntime,
  AgentSession,
  KapibalaError,
  type ModelProfile,
  SessionManager,
} from '@kiturone/kapibala';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActiveSessionController } from '../src/active-session.js';
import { agentsCommand } from '../src/commands/agents.js';
import { archiveCommand } from '../src/commands/archive.js';
import { branchCommand } from '../src/commands/branch.js';
import type { CommandContext } from '../src/commands/dispatcher.js';
import { forkCommand } from '../src/commands/fork.js';
import { historyCommand } from '../src/commands/history.js';
import { CliInputCoordinator } from '../src/input-coordinator.js';
import { createEventRenderer } from '../src/ui/events.js';

describe('v0.0.7 CLI commands and input coordination', () => {
  let tempDir: string;
  let manager: SessionManager;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  const createDummyProfile = (): ModelProfile => ({
    id: 'dummy',
    name: 'Dummy',
    provider: 'openai-compatible',
    baseURL: 'http://localhost:11434',
    apiKeyEnv: 'NONE',
    modelName: 'dummy',
  });

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-cli-v007-'));
    manager = new SessionManager({
      workspaceRoot: tempDir,
      cwd: tempDir,
    });
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await manager.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('historyCommand handles --tree, --agents, --all, and --search', async () => {
    const handle = await manager.create();
    await manager.rename(handle.conversationId, 'Searchable Session');
    const session = new AgentSession({
      workspaceRoot: tempDir,
      store: handle.store,
      conversationId: handle.conversationId,
      defaultProfile: createDummyProfile(),
      defaultProvider: {
        chatCompletions: async function* () {},
      } as any,
    });
    await session.init();

    const resumedCalls: string[] = [];
    const controller = {
      manager,
      session,
      handle,
      resume: async (id: string) => {
        resumedCalls.push(id);
      },
    } as unknown as ActiveSessionController;

    const runtime = new AgentRuntime();
    const ctx: CommandContext = {
      session,
      controller,
      runtime,
      settings: {} as any,
      onModelSwitched: () => {},
      onExit: () => {},
    };

    // 1. --tree
    await historyCommand(['--tree'], ctx);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`会话因果分支拓扑树 [${handle.conversationId}]`),
    );

    // 2. --agents
    await historyCommand(['--agents'], ctx);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('当前会话关联的子代理历史任务'));

    // 3. --all
    await historyCommand(['--all'], ctx);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('全局跨项目历史会话'));

    // 4. --search
    await historyCommand(['--search', 'Searchable'], ctx);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('全文检索 "Searchable"'));

    await runtime.close();
  });

  it('branchCommand creates branches, switches branches, and catches unclosed tool transactions', async () => {
    const handle = await manager.create();
    await manager.rename(handle.conversationId, 'Branch Test Session');
    const session = new AgentSession({
      workspaceRoot: tempDir,
      store: handle.store,
      conversationId: handle.conversationId,
      defaultProfile: createDummyProfile(),
      defaultProvider: { chatCompletions: async function* () {} } as any,
    });
    await session.init();

    const resumedIds: string[] = [];
    const controller = {
      manager,
      session,
      handle,
      resume: async (id: string) => {
        resumedIds.push(id);
      },
      reloadCurrent: async () => {
        resumedIds.push(handle.conversationId);
      },
    } as unknown as ActiveSessionController;

    const ctx: CommandContext = {
      session,
      controller,
      settings: {} as any,
      onModelSwitched: () => {},
      onExit: () => {},
    };

    // 1. 列出分支
    await branchCommand([], ctx);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('会话分支列表'));

    // 2. 在根记录处创建新分支
    const branches = await (handle.store as any).getBranches();
    const rootLeaf = branches[0].leafRecordId;
    await branchCommand(['create', rootLeaf, 'feature-x'], ctx);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('已成功在记录'));
    expect(resumedIds).toContain(handle.conversationId);

    // 3. 模拟半事务分叉拦截
    vi.spyOn(handle.store, 'selectBranch').mockImplementationOnce(() => {
      throw new KapibalaError('Cannot fork branch on unclosed tool transaction', {
        code: 'UNCLOSED_TOOL_TRANSACTION_FORK',
      });
    });
    await branchCommand(['switch', 'main'], ctx);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('禁止切换分支'));
  });

  it('forkCommand exports independent new session and switches to it', async () => {
    const handle = await manager.create();
    await manager.rename(handle.conversationId, 'Source Session');
    const session = new AgentSession({
      workspaceRoot: tempDir,
      store: handle.store,
      conversationId: handle.conversationId,
      defaultProfile: createDummyProfile(),
      defaultProvider: { chatCompletions: async function* () {} } as any,
    });
    await session.init();

    let switchedTo: string | undefined;
    const controller = {
      manager,
      session,
      handle,
      resume: async (id: string) => {
        switchedTo = id;
      },
    } as unknown as ActiveSessionController;

    const ctx: CommandContext = {
      session,
      controller,
      settings: {} as any,
      onModelSwitched: () => {},
      onExit: () => {},
    };

    await forkCommand(['Forked Title'], ctx);
    expect(switchedTo).toBeTruthy();
    expect(switchedTo).not.toBe(handle.conversationId);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`已成功从会话 ${handle.conversationId} 导出独立新会话`),
    );
  });

  it('archiveCommand prevents active session archival and restores archived sessions', async () => {
    const handleActive = await manager.create();
    await manager.rename(handleActive.conversationId, 'Active Session');
    const handleOther = await manager.create();
    await manager.rename(handleOther.conversationId, 'Other Session');

    const session = new AgentSession({
      workspaceRoot: tempDir,
      store: handleActive.store,
      conversationId: handleActive.conversationId,
      defaultProfile: createDummyProfile(),
      defaultProvider: { chatCompletions: async function* () {} } as any,
    });
    await session.init();

    const controller = {
      manager,
      session,
      handle: handleActive,
    } as unknown as ActiveSessionController;

    const ctx: CommandContext = {
      session,
      controller,
      settings: {} as any,
      onModelSwitched: () => {},
      onExit: () => {},
    };

    // 1. 尝试归档当前活动会话 -> 必须被拒绝
    await archiveCommand([handleActive.conversationId], ctx);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('当前会话正在使用中，活动会话禁止归档'),
    );

    // 2. 归档其他会话 -> 成功（先释放写者锁）
    await handleOther.release();
    await archiveCommand([handleOther.conversationId], ctx);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`已成功归档会话: ${handleOther.conversationId}`),
    );

    // 3. 查看归档列表
    await archiveCommand(['list'], ctx);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(handleOther.conversationId));

    // 4. 恢复已归档会话
    await archiveCommand(['restore', handleOther.conversationId], ctx);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`已成功恢复会话 ${handleOther.conversationId}`),
    );
  });

  it('agentsCommand inspects, shows, cancels, and validates collection branch', async () => {
    const runtime = new AgentRuntime();
    const handle = await manager.create();
    await manager.rename(handle.conversationId, 'Agent Session');
    const session = new AgentSession({
      workspaceRoot: tempDir,
      store: handle.store,
      conversationId: handle.conversationId,
      defaultProfile: createDummyProfile(),
      defaultProvider: { chatCompletions: async function* () {} } as any,
    });
    await session.init();

    const controller = {
      manager,
      session,
      handle,
    } as unknown as ActiveSessionController;

    const ctx: CommandContext = {
      session,
      controller,
      runtime,
      settings: {} as any,
      onModelSwitched: () => {},
      onExit: () => {},
    };

    // 1. 空列表
    await agentsCommand([], ctx);
    expect(logSpy).toHaveBeenCalledWith('当前没有任何后台子代理任务。');

    // 2. 创建一个任务
    const receipt = await runtime.prepareSpawn(
      {
        sessionId: handle.conversationId,
        branchId: 'feature-branch',
        runId: 'run-1',
        toolCallId: 'call-1',
        depth: 0,
        workspaceRoot: tempDir,
        executionCwd: tempDir,
      },
      {
        description: 'Analyze modules',
        prompt: 'Check dependencies',
        role: 'explore',
      },
    );

    // 3. 列出任务
    await agentsCommand([], ctx);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining(`[${receipt.agentId}] (explore)`));

    // 4. 查看详情
    await agentsCommand(['show', receipt.agentId], ctx);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`── 子代理任务详情 [${receipt.agentId}] ──`),
    );

    // 5. 跨分支收集防护：当前分支是 main，任务来源是 feature-branch
    await agentsCommand(['collect', receipt.agentId], ctx);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('请先切换至来源分支再收集: /branch switch feature-branch'),
    );

    // 6. 取消任务
    await agentsCommand(['cancel', receipt.agentId], ctx);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining(`已成功请求取消子代理任务及其所有后代: ${receipt.agentId}`),
    );

    await runtime.close();
  });

  it('CliInputCoordinator buffers background output during secret input and flushes upon finish', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let written = '';
    output.on('data', (chunk) => {
      written += chunk.toString();
    });

    const coordinator = new CliInputCoordinator({
      input,
      output,
      interactive: true,
      terminal: true,
    });

    // 启动秘密输入 (如录入 API key)
    const secretPromise = coordinator.readSecret('Enter API Key: ');
    expect(coordinator.isSecret()).toBe(true);

    // 在秘密输入期间，后台子代理有输出到达
    coordinator.writeGuarded('\n[Background Agent: Step 1 completed]\n');
    coordinator.writeGuarded('[Background Agent: Step 2 completed]\n');

    // 此时后台内容被缓冲，不应出现在输出中
    expect(written).not.toContain('[Background Agent: Step 1 completed]');
    expect(written).not.toContain('[Background Agent: Step 2 completed]');

    // 用户敲入密钥并回车
    input.write('my-secret-token\n');
    const result = await secretPromise;
    expect(result).toBe('my-secret-token');

    // 秘密输入结束后，缓冲内容被安全排空刷新至终端
    expect(written).toContain('[Background Agent: Step 1 completed]');
    expect(written).toContain('[Background Agent: Step 2 completed]');

    coordinator.close();
  });

  it('createEventRenderer shows subagent count in footer and details snapshot in toggleDetail', async () => {
    const runtime = new AgentRuntime();
    let output = '';
    const renderer = createEventRenderer({
      runtime,
      write: (chunk) => {
        output += chunk;
      },
      isTTY: true,
      columns: 120,
    });

    // 模拟子代理启动
    const receipt = await runtime.prepareSpawn(
      {
        sessionId: 'session-1',
        branchId: 'main',
        runId: 'run-1',
        toolCallId: 'call-1',
        depth: 0,
        workspaceRoot: tempDir,
        executionCwd: tempDir,
      },
      {
        description: 'Background explorer',
        prompt: 'Check files',
        role: 'explore',
      },
    );

    // 触发 run_finish
    renderer.render({
      type: 'run_finish',
      metrics: {
        startTime: Date.now() - 1500,
        endTime: Date.now(),
        totalDurationMs: 1500,
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        toolCalls: 1,
        toolDurationMs: 200,
        modelDurationMs: 1200,
        turns: 1,
        status: 'completed',
      },
    });

    expect(output).toContain('🤖 子代理: 1个运行中');

    // 触发 toggleDetail
    renderer.toggleDetail();
    expect(output).toContain('── 后台子代理任务状态 ──');
    expect(output).toContain(receipt.agentId);

    renderer.finish();
    await runtime.close();
  });
});
