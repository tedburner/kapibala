import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  KapibalaError,
  SessionBusyError,
  WorkspaceLeaseCoordinator,
  createDelegationError,
} from '@kiturone/kapibala';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CheckpointService,
  ExecutionRootCoordinator,
  ExternalHarnessError,
  ExternalSessionService,
  PresentationStore,
  WorktreeService,
  createManagedSession,
  trustProject,
  upsertCustomExternalHarness,
} from '../src/host/internal.js';
import type {
  ExternalDriverOpenResult,
  ExternalHarnessDriver,
  UserSettings,
} from '../src/host/internal.js';
import { toWireErrorCode } from '../src/protocol/errors.js';

const tempDirs: string[] = [];
const cleanups: Array<() => Promise<void>> = [];

function makeTempDir(prefix: string): string {
  const raw = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(raw);
  return fs.realpathSync.native(raw);
}

function gitCleanTestEnv(): NodeJS.ProcessEnv {
  const allowedKeys = [
    'PATH',
    'Path',
    'SYSTEMROOT',
    'SystemRoot',
    'COMSPEC',
    'ComSpec',
    'PATHEXT',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'LANG',
    'LC_ALL',
  ];
  const env: NodeJS.ProcessEnv = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }
  return env;
}

function initGitRepo(repoDir: string): void {
  const env = gitCleanTestEnv();
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, env, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Kapibala Test'], {
    cwd: repoDir,
    env,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.email', 'test@kapibala.local'], {
    cwd: repoDir,
    env,
    stdio: 'pipe',
  });
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# Demo Repo\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, env, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'chore: initial commit'], {
    cwd: repoDir,
    env,
    stdio: 'pipe',
  });
}

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('M2 Host 集成：ManagedHostSession 自动检查点/证据联动与 ExternalSessionService 同仓多树并发', () => {
  it('ManagedHostSession 自动捕获轮次首尾检查点、将 run_command 变更纳入 evidence()，并在 regenerate(restoreFiles) 时支持冲突拦截与强制回滚', async () => {
    const homeDir = makeTempDir('kpbl-m2-host-home-');
    const repoDir = makeTempDir('kpbl-m2-host-repo-');
    initGitRepo(repoDir);

    let modelCallIndex = 0;
    const server = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      void Buffer.concat(chunks);

      const currentCall = modelCallIndex++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });

      if (currentCall === 0) {
        // 第 0 轮第 1 步：调用 run_command 在工作区生成新文件（非 write_file 工具）
        const toolCallChunk = {
          id: 'chatcmpl-0',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_shell_1',
                    type: 'function',
                    function: {
                      name: 'run_command',
                      arguments: JSON.stringify({
                        command:
                          "node -e \"require('node:fs').writeFileSync('shell-generated.txt', 'alpha\\nbeta\\n', 'utf8')\"",
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 15, total_tokens: 35 },
        };
        res.write(`data: ${JSON.stringify(toolCallChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      // 第 0 轮第 2 步及后续 regenerate 重跑：直接返回文本总结
      const textChunk = {
        id: `chatcmpl-${currentCall}`,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              content:
                currentCall === 1 ? '已通过脚本生成文件。' : '重生后的纯净回答（未生成文件）。',
            },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 25, completion_tokens: 12, total_tokens: 37 },
      };
      res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const port = (server.address() as AddressInfo).port;

    const settings: UserSettings = {
      defaultModel: 'mock-local',
      permissionMode: 'FullAccess',
      profiles: [
        {
          id: 'mock-local',
          name: 'Mock Local',
          provider: 'openai-compatible',
          modelName: 'mock-gpt',
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'NONE',
          apiKey: 'test-dummy-token',
        },
      ],
    };
    fs.mkdirSync(path.join(homeDir, '.kapibala'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify(settings, null, 2),
      'utf8',
    );
    trustProject(settings, repoDir, { homeDir });

    const coordinator = new ExecutionRootCoordinator();
    const checkpoints = new CheckpointService({ homeDir });
    const worktrees = new WorktreeService({ homeDir, coordinator });
    const leases = new WorkspaceLeaseCoordinator();

    const managed = await createManagedSession({
      projectRoot: repoDir,
      workspaceRoot: repoDir,
      homeDirectory: homeDir,
      checkpoints,
      worktrees,
      executionCoordinator: coordinator,
      leaseCoordinator: leases,
      approvalChannel: { requestApproval: async () => 'allow_once' },
    });
    cleanups.push(() => managed.dispose());

    await managed.configure({ mode: 'FullAccess' });
    await managed.run('请用命令生成 shell-generated.txt');

    const targetFile = path.join(repoDir, 'shell-generated.txt');
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('alpha\nbeta\n');

    // 1. 检查点自动捕获且 PresentationState.diffSummary 已同步
    const cpList = await managed.checkpoints();
    expect(cpList).toHaveLength(1);
    expect(cpList[0]?.ordinal).toBe(0);
    expect(cpList[0]?.additions).toBe(2);
    expect(cpList[0]?.changedFilesCount).toBe(1);
    expect(managed.snapshot().diffSummary).toEqual({ additions: 2, deletions: 0 });

    // 2. evidence() 包含 run_command 造成的真实磁盘变更
    const evidence = await managed.evidence();
    expect(evidence.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'shell-generated.txt',
          status: 'recorded',
          additions: 2,
          deletions: 0,
        }),
      ]),
    );
    expect(evidence.summary.additions).toBe(2);

    // 3. 模拟用户事后手动编辑该文件：不带 forceRestore 的 regenerate(restoreFiles: true) 必须在回退分支前报错拦截
    fs.writeFileSync(targetFile, 'user manual modification\n', 'utf8');
    const historyCountBeforeConflict = managed.snapshot().messages.length;

    await expect(
      managed.run('重试', undefined, { regenerate: true, restoreFiles: true }),
    ).rejects.toMatchObject({
      code: 'CHECKPOINT_RESTORE_CONFLICT',
    });

    // 确认手动修改与分支消息均未被破坏
    expect(fs.readFileSync(targetFile, 'utf8')).toBe('user manual modification\n');
    expect(managed.snapshot().messages).toHaveLength(historyCountBeforeConflict);

    // 4. 显式传入 forceRestore: true 时先原子还原（删除第 0 轮新增的文件）再回退重跑
    await managed.run('重试', undefined, {
      regenerate: true,
      restoreFiles: true,
      forceRestore: true,
    });

    expect(fs.existsSync(targetFile)).toBe(false);
    const messagesAfterRegen = managed.snapshot().messages;
    expect(
      messagesAfterRegen.some((msg) => msg.blocks.some((b) => b.text.includes('重生后的纯净回答'))),
    ).toBe(true);
  });

  it('ExternalSessionService 同仓库双受管 Worktree 100% 并行执行不触发 EXTERNAL_WORKSPACE_BUSY，且统一归属 projectRoot', async () => {
    const homeDir = makeTempDir('kpbl-m2-ext-home-');
    const repoDir = makeTempDir('kpbl-m2-ext-repo-');
    initGitRepo(repoDir);

    const settings: UserSettings = {
      defaultModel: 'deepseek-flash',
      profiles: [],
    };
    fs.mkdirSync(path.join(homeDir, '.kapibala'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify(settings, null, 2),
      'utf8',
    );
    trustProject(settings, repoDir, { homeDir });

    upsertCustomExternalHarness(
      {
        id: 'parallel-acp',
        name: 'Parallel ACP',
        command: process.execPath,
        args: ['-v'],
        enabled: true,
      },
      { homeDir },
    );

    const coordinator = new ExecutionRootCoordinator();
    const checkpoints = new CheckpointService({ homeDir });
    const worktrees = new WorktreeService({ homeDir, coordinator });

    const wtA = await worktrees.create({ projectRoot: repoDir, name: 'worker-a' });
    const wtB = await worktrees.create({ projectRoot: repoDir, name: 'worker-b' });

    let activePrompts = 0;
    let maxConcurrentPrompts = 0;
    let releaseBarrier!: () => void;
    let notifyBothRunning!: () => void;
    const bothRunning = new Promise<void>((resolve) => {
      notifyBothRunning = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });

    const parallelDriver: ExternalHarnessDriver = {
      transport: 'acp',
      inspect: async () => ({ available: true, status: 'ready', loadSupported: true }),
      open: async (params): Promise<ExternalDriverOpenResult> => {
        const cwd = params.workspaceRoot;
        return {
          resumable: true,
          nativeSessionId: `native-${path.basename(cwd)}-${Math.random().toString(36).slice(2, 6)}`,
          handle: {
            pid: undefined,
            prompt: async (text: string) => {
              activePrompts += 1;
              maxConcurrentPrompts = Math.max(maxConcurrentPrompts, activePrompts);
              if (activePrompts === 2) {
                notifyBothRunning();
              }
              try {
                await barrier;
                const fileName = text.includes('任务A') ? 'from-a.txt' : 'from-b.txt';
                fs.writeFileSync(path.join(cwd, fileName), `${text}\nline2\n`, 'utf8');
                params.onEvent({ type: 'text_delta', text: `已完成: ${fileName}` });
                return { stopReason: 'completed' };
              } finally {
                activePrompts -= 1;
              }
            },
            cancel: async () => {},
            close: async () => {},
          },
        };
      },
    };

    const external = new ExternalSessionService({
      homeDir,
      checkpoints,
      worktrees,
      executionCoordinator: coordinator,
      drivers: { acp: parallelDriver },
    });
    cleanups.push(() => external.dispose());

    const openedA = await external.openSession({
      projectRoot: repoDir,
      workspaceRoot: wtA.binding.worktreePath,
      worktree: wtA.binding,
      harnessId: 'parallel-acp',
      title: 'Worktree A 会话',
    });
    const openedB = await external.openSession({
      projectRoot: repoDir,
      workspaceRoot: wtB.binding.worktreePath,
      worktree: wtB.binding,
      harnessId: 'parallel-acp',
      title: 'Worktree B 会话',
    });

    // 同时在两个不同受管工作树中发起长轮次
    const runA = external.promptSession({
      sessionId: openedA.session.id,
      text: '执行任务A',
      expectedWorkspaceRoot: repoDir,
    });
    const runB = external.promptSession({
      sessionId: openedB.session.id,
      text: '执行任务B',
      expectedWorkspaceRoot: repoDir,
    });

    await bothRunning;
    expect(maxConcurrentPrompts).toBe(2);

    // 同一工作树 wtA 内再次新建要求空闲目录的会话仍应精确拦截为 EXTERNAL_WORKSPACE_BUSY
    await expect(
      external.openSession({
        projectRoot: repoDir,
        workspaceRoot: wtA.binding.worktreePath,
        worktree: wtA.binding,
        harnessId: 'parallel-acp',
        requireIdleWorkspace: true,
      }),
    ).rejects.toThrow(ExternalHarnessError);

    // 放行屏障等待双会话并发收口
    releaseBarrier();
    const [snapA, snapB] = await Promise.all([runA, runB]);

    expect(snapA.worktree?.id).toBe(wtA.binding.id);
    expect(snapB.worktree?.id).toBe(wtB.binding.id);
    expect(snapA.diffSummary).toEqual({ additions: 2, deletions: 0 });
    expect(snapB.diffSummary).toEqual({ additions: 2, deletions: 0 });

    // 物理隔离：各自文件仅存在于对应工作树，主仓零污染
    expect(fs.existsSync(path.join(wtA.binding.worktreePath, 'from-a.txt'))).toBe(true);
    expect(fs.existsSync(path.join(wtA.binding.worktreePath, 'from-b.txt'))).toBe(false);
    expect(fs.existsSync(path.join(wtB.binding.worktreePath, 'from-b.txt'))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, 'from-a.txt'))).toBe(false);

    // 列表按主项目根归组：两个位于 ~/.kapibala/worktrees 下的会话均出现在 repoDir 列表中
    const listed = external.listSessions(repoDir);
    expect(listed.map((item) => item.id).sort()).toEqual(
      [openedA.session.id, openedB.session.id].sort(),
    );

    // 外部会话检查点 Diff 与回滚可用
    const extDiffA = await external.diffSessionCheckpoints({
      sessionId: openedA.session.id,
      expectedWorkspaceRoot: repoDir,
    });
    expect(extDiffA.available).toBe(true);
    expect(extDiffA.files.map((f) => f.path)).toEqual(['from-a.txt']);
  });

  it('regenerating a turn that skipped checkpointing preserves earlier turns committed files, blocks restoreCheckpoint during active runs, and scopes PresentationStore.reload by conversationId', async () => {
    const homeDir = makeTempDir('kpbl-m2-skip-home-');
    const repoDir = makeTempDir('kpbl-m2-skip-repo-');
    initGitRepo(repoDir);

    let callSeq = 0;
    const server = http.createServer(async (req, res) => {
      for await (const _ of req) {
        /* drain */
      }
      const idx = callSeq++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });

      if (idx === 0) {
        // Turn 0 step 1: 创建 turn0-preserved.txt
        const toolChunk = {
          id: 'chatcmpl-t0-0',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_t0_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({
                        path: 'turn0-preserved.txt',
                        content: 'must-keep-turn-0\n',
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        };
        res.write(`data: ${JSON.stringify(toolChunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const replyByIdx: Record<number, string> = {
        1: '第 0 轮已完成写入。',
        2: '第 1 轮首次回答（检查点超时跳过）。',
        3: '第 1 轮重生后的新回答。',
      };
      const textChunk = {
        id: `chatcmpl-${idx}`,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: replyByIdx[idx] ?? 'ok' },
            finish_reason: 'stop',
          },
        ],
      };
      res.write(`data: ${JSON.stringify(textChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const port = (server.address() as AddressInfo).port;

    const settings: UserSettings = {
      defaultModel: 'mock-skip',
      permissionMode: 'FullAccess',
      profiles: [
        {
          id: 'mock-skip',
          name: 'Mock Skip',
          provider: 'openai-compatible',
          modelName: 'mock-gpt',
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'NONE',
          apiKey: 'dummy-secret-token',
        },
      ],
    };
    fs.mkdirSync(path.join(homeDir, '.kapibala'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify(settings, null, 2),
      'utf8',
    );
    trustProject(settings, repoDir, { homeDir });

    const coordinator = new ExecutionRootCoordinator();
    const checkpoints = new CheckpointService({ homeDir });
    const worktrees = new WorktreeService({ homeDir, coordinator });
    const wt = await worktrees.create({ projectRoot: repoDir, name: 'skip-regen' });

    const managed = await createManagedSession({
      projectRoot: repoDir,
      workspaceRoot: repoDir,
      homeDirectory: homeDir,
      checkpoints,
      worktrees,
      executionCoordinator: coordinator,
      leaseCoordinator: new WorkspaceLeaseCoordinator(),
      approvalChannel: { requestApproval: async () => 'allow_once' },
    });
    cleanups.push(() => managed.dispose());
    await managed.configure({ mode: 'FullAccess' });

    // Turn 0：正常捕获 ordinal 0 检查点并写入 turn0-preserved.txt
    await managed.run('执行第 0 轮');
    const preservedFile = path.join(repoDir, 'turn0-preserved.txt');
    expect(fs.readFileSync(preservedFile, 'utf8')).toBe('must-keep-turn-0\n');
    expect((await managed.checkpoints()).map((c) => c.ordinal)).toEqual([0]);

    // Turn 1：模拟前置采样因慢盘超时被跳过（无 ordinal 1 检查点）
    const preSpy = vi
      .spyOn(checkpoints, 'capturePreTurn')
      .mockResolvedValueOnce({ captured: false, skipped: true, reason: 'timeout' });
    await managed.run('执行第 1 轮');
    preSpy.mockRestore();
    expect((await managed.checkpoints()).map((c) => c.ordinal)).toEqual([0]);

    // 重生第 1 轮并开启 restoreFiles: true：绝不能回退抹掉第 0 轮已提交的 turn0-preserved.txt！
    await managed.run('重试第 1 轮', undefined, { regenerate: true, restoreFiles: true });
    expect(fs.existsSync(preservedFile)).toBe(true);
    expect(fs.readFileSync(preservedFile, 'utf8')).toBe('must-keep-turn-0\n');
    expect(
      managed
        .snapshot()
        .messages.some((m) => m.blocks.some((b) => b.text.includes('第 1 轮重生后的新回答'))),
    ).toBe(true);

    // 同一执行根存在跨子系统活动运行时，restoreCheckpoint 必须以 SessionBusyError 拒绝并映射为 SESSION_BUSY。
    const externalRun = coordinator.trackActiveRun({
      executionRoot: repoDir,
      ownerId: 'ext-active',
      kind: 'external',
    });
    try {
      await expect(managed.restoreCheckpoint(-1)).rejects.toBeInstanceOf(SessionBusyError);
    } finally {
      externalRun.release();
    }

    // 验证错误码协议映射与 PresentationStore 跨会话 reload 清理
    expect(toWireErrorCode(new SessionBusyError('restore checkpoint'))).toBe('SESSION_BUSY');
    expect(toWireErrorCode(new KapibalaError('lease timeout', { code: 'LEASE_TIMEOUT' }))).toBe(
      'SESSION_BUSY',
    );
    expect(toWireErrorCode(createDelegationError('DELEGATION_LIMIT_EXCEEDED', 'limit'))).toBe(
      'RESOURCE_LIMIT',
    );
    expect(toWireErrorCode(createDelegationError('DELEGATION_NOT_FOUND', 'missing'))).toBe(
      'SESSION_NOT_FOUND',
    );

    const pStore = new PresentationStore(
      { conversationId: 'conv-a', branchId: 'main', viewEpoch: 1 },
      [],
      undefined,
      {
        worktree: {
          id: wt.binding.id,
          projectRoot: wt.binding.projectRoot,
          worktreePath: wt.binding.worktreePath,
          branch: wt.binding.branch,
          baseRef: wt.binding.baseRef,
          baseCommit: wt.binding.baseCommit,
          createdAt: wt.binding.createdAt,
        },
        diffSummary: { additions: 5, deletions: 1 },
      },
    );
    pStore.reload({ conversationId: 'conv-a', branchId: 'fork-1', viewEpoch: 2 }, []);
    expect(pStore.snapshot().worktree?.id).toBe(wt.binding.id);
    expect(pStore.snapshot().diffSummary).toEqual({ additions: 5, deletions: 1 });

    pStore.reload({ conversationId: 'conv-b', branchId: 'main', viewEpoch: 3 }, []);
    expect(pStore.snapshot().worktree).toBeUndefined();
    expect(pStore.snapshot().diffSummary).toBeUndefined();
  });

  it('opens a session with a deleted worktree in read-only history mode and blocks runs until execution root is rebound', async () => {
    const homeDir = makeTempDir('kpbl-m2-missing-wt-home-');
    const repoDir = makeTempDir('kpbl-m2-missing-wt-repo-');
    initGitRepo(repoDir);

    let callCount = 0;
    const replies = ['工作树内的回答。', '重新绑定主仓后的续聊回答。'];
    const server = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* consume */
      }
      const text = replies[callCount++] ?? '完成。';
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(
        `data: ${JSON.stringify({
          id: `m-${callCount}`,
          object: 'chat.completion.chunk',
          choices: [
            { index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 },
        })}\n\n`,
      );
      res.write('data: [DONE]\n\n');
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    );
    const port = (server.address() as AddressInfo).port;
    const settings: UserSettings = {
      defaultModel: 'mock-wt',
      permissionMode: 'Auto',
      profiles: [
        {
          id: 'mock-wt',
          name: 'Mock WT',
          provider: 'openai-compatible',
          modelName: 'mock-wt',
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'NONE',
          apiKey: 'dummy',
        },
      ],
    };
    fs.mkdirSync(path.join(homeDir, '.kapibala'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify(settings, null, 2),
      'utf8',
    );
    trustProject(settings, repoDir, { homeDir });

    const allowAll = { requestApproval: async () => 'allow_once' as const };
    const coordinator = new ExecutionRootCoordinator();
    const worktrees = new WorktreeService({ homeDir, coordinator });
    const checkpoints = new CheckpointService({ homeDir });
    const wt = await worktrees.create({ projectRoot: repoDir, name: 'ephemeral-deleted' });

    const created = await createManagedSession({
      workspaceRoot: wt.binding.worktreePath,
      projectRoot: repoDir,
      worktree: wt.binding,
      homeDirectory: homeDir,
      approvalChannel: allowAll,
      leaseCoordinator: new WorkspaceLeaseCoordinator(),
      checkpoints,
      worktrees,
      executionCoordinator: coordinator,
    });
    const convId = created.conversationId;
    await created.run('首轮在工作树执行');
    await created.dispose();

    // 删除该会话绑定的工作树目录
    await worktrees.remove({ id: wt.binding.id, force: true });
    expect(fs.existsSync(wt.binding.worktreePath)).toBe(false);

    // 重新打开历史会话：允许只读查看历史，但严禁向主仓续跑或还原检查点
    const readonlySession = await createManagedSession({
      workspaceRoot: repoDir,
      projectRoot: repoDir,
      conversationId: convId,
      homeDirectory: homeDir,
      approvalChannel: allowAll,
      leaseCoordinator: new WorkspaceLeaseCoordinator(),
      checkpoints,
      worktrees,
      executionCoordinator: coordinator,
    });
    cleanups.push(() => readonlySession.dispose().catch(() => {}));

    expect(readonlySession.worktree()?.missing).toBe(true);
    expect(readonlySession.snapshot().messages.length).toBeGreaterThanOrEqual(2);
    await expect(readonlySession.run('尝试直接续聊')).rejects.toMatchObject({
      code: 'WORKTREE_MISSING',
    });
    await expect(readonlySession.restoreCheckpoint(-1)).rejects.toMatchObject({
      code: 'WORKTREE_MISSING',
    });

    // 显式重新绑定到主仓并重开后即可恢复续聊
    expect(readonlySession.rebindExecutionRoot).toBeTypeOf('function');
    await readonlySession.rebindExecutionRoot!({ mode: 'project_root' });
    await readonlySession.dispose();

    const reboundSession = await createManagedSession({
      workspaceRoot: repoDir,
      projectRoot: repoDir,
      conversationId: convId,
      homeDirectory: homeDir,
      approvalChannel: allowAll,
      leaseCoordinator: new WorkspaceLeaseCoordinator(),
      checkpoints,
      worktrees,
      executionCoordinator: coordinator,
    });
    cleanups.push(() => reboundSession.dispose().catch(() => {}));

    expect(reboundSession.worktree()).toBeUndefined();
    await reboundSession.run('重绑定后续聊');
    expect(
      reboundSession
        .snapshot()
        .messages.some((m) =>
          m.blocks.some((b) => b.kind === 'text' && b.text.includes('重新绑定主仓后的续聊回答')),
        ),
    ).toBe(true);
  });
});
