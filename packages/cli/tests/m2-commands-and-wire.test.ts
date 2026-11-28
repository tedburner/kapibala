import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  AgentRuntime,
  AgentSession,
  type ModelProfile,
  SessionManager,
  WorkspaceLeaseCoordinator,
} from '@kiturone/kapibala';
import { LocalClient } from '@kiturone/kapibala-host/client';
import {
  CheckpointService,
  ExecutionRootCoordinator,
  ExternalSessionService,
  WorktreeService,
  createUserSettingsSkeleton,
  trustProject,
  upsertCustomExternalHarness,
} from '@kiturone/kapibala-host/internal';
import type {
  ExternalDriverOpenResult,
  ExternalHarnessDriver,
  UserSettings,
} from '@kiturone/kapibala-host/internal';
import { PROTOCOL_VERSION, SERVER_CAPABILITIES } from '@kiturone/kapibala-host/protocol';
import { createStdioTransport } from '@kiturone/kapibala-host/transport';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActiveSessionController } from '../src/active-session.js';
import { createDefaultCommandDispatcher } from '../src/commands/assemble.js';
import type { CommandContext } from '../src/commands/dispatcher.js';
import { LocalHostServer } from '../src/local-host/server.js';
import type { SessionResources } from '../src/local-host/types.js';

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
  execFileSync('git', ['config', 'user.name', 'Kapibala CLI Test'], {
    cwd: repoDir,
    env,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.email', 'cli@kapibala.local'], {
    cwd: repoDir,
    env,
    stdio: 'pipe',
  });
  fs.writeFileSync(path.join(repoDir, 'index.ts'), 'export const v = 1;\n', 'utf8');
  execFileSync('git', ['add', 'index.ts'], { cwd: repoDir, env, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'chore: init'], { cwd: repoDir, env, stdio: 'pipe' });
}

async function connectWireClient(server: LocalHostServer, capabilities: string[]) {
  const c2s = new PassThrough();
  const s2c = new PassThrough();
  const clientTransport = createStdioTransport(s2c, c2s);
  const serverTransport = createStdioTransport(c2s, s2c);
  const acceptTask = server.accept(serverTransport);
  const client = await LocalClient.connect(clientTransport, {
    protocolVersion: PROTOCOL_VERSION,
    clientName: 'm2-wire-test',
    capabilities,
  });
  cleanups.push(async () => {
    await client.close();
    await acceptTask.catch(() => {});
  });
  return client;
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('M2 Wire v2 checkpoint / worktree 协议能力门控与全链路 RPC', () => {
  it('保持 PROTOCOL_VERSION = 2，声明 checkpoint 与 worktree 能力并完整打通创建、快照、合并与还原', async () => {
    expect(PROTOCOL_VERSION).toBe(2);
    expect(SERVER_CAPABILITIES).toContain('checkpoint');
    expect(SERVER_CAPABILITIES).toContain('worktree');

    const homeDir = makeTempDir('kpbl-m2-wire-home-');
    const repoDir = makeTempDir('kpbl-m2-wire-repo-');
    initGitRepo(repoDir);

    const settings: UserSettings = { defaultModel: 'deepseek-flash', profiles: [] };
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

    const server = new LocalHostServer({
      homeDir,
      checkpoints,
      worktrees,
      create: async (projectRoot, conversationId, _approval, hooks): Promise<SessionResources> => {
        const convId = conversationId ?? 'conv-wire-m2';
        const wtBinding = hooks?.worktree;
        const execRoot = wtBinding?.worktreePath ?? projectRoot;
        return {
          conversationId: convId,
          history: () => [],
          worktree: () => (wtBinding ? { ...wtBinding } : undefined),
          checkpoints: async () => {
            const items = await checkpoints.listCheckpoints({
              projectRoot,
              executionRoot: execRoot,
              sessionId: convId,
            });
            return items.map((rec) => ({
              ordinal: rec.ordinal,
              createdAt: rec.createdAt,
              startTree: rec.startTree,
              endTree: rec.endTree,
              additions: rec.additions,
              deletions: rec.deletions,
              changedFilesCount: rec.changedFiles.length,
              ...(rec.label ? { label: rec.label } : {}),
            }));
          },
          checkpointDiff: async (opts) => {
            const diff = await checkpoints.diff({
              projectRoot,
              executionRoot: execRoot,
              sessionId: convId,
              ...(opts?.ordinal !== undefined ? { ordinal: opts.ordinal } : {}),
            });
            return {
              available: diff.available,
              additions: diff.additions,
              deletions: diff.deletions,
              truncated: diff.truncated,
              files: diff.files.map((f) => ({
                path: f.path,
                status: f.status,
                additions: f.additions,
                deletions: f.deletions,
                binary: f.binary,
                patch: f.patch,
                truncated: f.truncated,
              })),
            };
          },
          restoreCheckpoint: (targetOrdinal, force) =>
            checkpoints.restore({
              projectRoot,
              executionRoot: execRoot,
              sessionId: convId,
              targetOrdinal,
              force,
            }),
          async *run(input) {
            const pre = await checkpoints.capturePreTurn({
              projectRoot,
              executionRoot: execRoot,
              sessionId: convId,
              ordinal: 0,
            });
            fs.writeFileSync(
              path.join(execRoot, 'wire-feature.ts'),
              `// ${input}\nexport const x = 42;\n`,
              'utf8',
            );
            if (pre.captured) {
              await checkpoints.capturePostTurn({
                projectRoot,
                executionRoot: execRoot,
                sessionId: convId,
                ordinal: 0,
                startTree: pre.startTree,
                label: input,
              });
            }
            yield { type: 'text_delta', text: '已在工作树生成文件' };
            yield {
              type: 'run_finish',
              metrics: {
                status: 'completed',
                turns: 1,
                startTime: 1,
                endTime: 10,
                totalDurationMs: 9,
                modelDurationMs: 5,
                toolDurationMs: 4,
                promptTokens: 10,
                completionTokens: 10,
                totalTokens: 20,
                toolCalls: 1,
              },
            };
          },
          dispose: async () => {},
        };
      },
    });
    cleanups.push(() => server.shutdown());

    // 未声明能力的客户端必须收到 PROTOCOL_MISMATCH
    const restrictedClient = await connectWireClient(server, ['sessions']);
    await expect(
      restrictedClient.call('worktree/list', { workspaceRoot: repoDir }),
    ).rejects.toThrow('PROTOCOL_MISMATCH');

    // 声明完整能力的客户端
    const fullClient = await connectWireClient(server, ['sessions', 'checkpoint', 'worktree']);
    const createdSession = await fullClient.call('session/create', {
      workspaceRoot: repoDir,
      worktree: { enabled: true, branch: 'kpbl/wire-m2' },
    });
    expect(createdSession.worktree?.branch).toBe('kpbl/wire-m2');
    const wtId = createdSession.worktree!.id;
    const wtPath = createdSession.worktree!.worktreePath;

    const attached = await fullClient.call('session/attach', {
      sessionId: createdSession.sessionId,
      mode: 'control',
    });

    const settledPromise = new Promise<void>((resolve) => {
      const unsub = fullClient.subscribe((evt) => {
        if (evt.sessionId === createdSession.sessionId && evt.type === 'run_settled') {
          unsub();
          resolve();
        }
      });
    });

    await fullClient.call('run/start', {
      sessionId: createdSession.sessionId,
      streamEpoch: attached.streamEpoch,
      controlEpoch: attached.controlEpoch,
      clientOperationId: 'op-wire-1',
      input: '创建新模块',
    });
    await settledPromise;

    // 1. checkpoint/list & checkpoint/diff
    const cpList = await fullClient.call('checkpoint/list', {
      sessionId: createdSession.sessionId,
    });
    expect(cpList.items).toHaveLength(1);
    expect(cpList.items[0]?.additions).toBe(2);

    const cpDiff = await fullClient.call('checkpoint/diff', {
      sessionId: createdSession.sessionId,
      ordinal: 0,
    });
    expect(cpDiff.available).toBe(true);
    expect(cpDiff.files[0]?.path).toBe('wire-feature.ts');

    // 2. worktree/status -> worktree/previewMerge -> worktree/applyMerge
    const wtStatus = await fullClient.call('worktree/status', {
      workspaceRoot: repoDir,
      id: wtId,
    });
    expect(wtStatus.dirty).toBe(true);

    const preview = await fullClient.call('worktree/previewMerge', {
      workspaceRoot: repoDir,
      id: wtId,
    });
    expect(preview.canApply).toBe(true);

    const merged = await fullClient.call('worktree/applyMerge', {
      workspaceRoot: repoDir,
      id: wtId,
      previewToken: preview.previewToken,
      commitMessage: 'feat: merge wire worktree',
    });
    expect(merged.status).toBe('merged');
    expect(fs.existsSync(path.join(repoDir, 'wire-feature.ts'))).toBe(true);

    // 3. checkpoint/restore 回滚工作树文件
    const restored = await fullClient.call('checkpoint/restore', {
      sessionId: createdSession.sessionId,
      targetOrdinal: -1,
      force: true,
    });
    expect(restored.status).toBe('restored');
    expect(fs.existsSync(path.join(wtPath, 'wire-feature.ts'))).toBe(false);

    // 4. 关闭会话后移除工作树
    await fullClient.call('session/close', {
      sessionId: createdSession.sessionId,
      streamEpoch: attached.streamEpoch,
      controlEpoch: attached.controlEpoch,
    });
    const removed = await fullClient.call('worktree/remove', {
      workspaceRoot: repoDir,
      id: wtId,
      force: true,
    });
    expect(removed.removed).toBe(true);
  }, 90_000);
});

describe('M2 CLI 斜杠命令：/checkpoints、/worktrees、/delegate --worktree、/external start --worktree 与 /branch --restore-files', () => {
  it('完整支持检查点查看/还原、工作树 CRUD/合并、独立工作树委派与分支联动回滚', async () => {
    const homeDir = makeTempDir('kpbl-m2-cli-home-');
    const repoDir = makeTempDir('kpbl-m2-cli-repo-');
    initGitRepo(repoDir);

    const settings: UserSettings = { defaultModel: 'deepseek-flash', profiles: [] };
    fs.mkdirSync(path.join(homeDir, '.kapibala'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify(settings, null, 2),
      'utf8',
    );
    trustProject(settings, repoDir, { homeDir });

    upsertCustomExternalHarness(
      {
        id: 'cli-acp',
        name: 'CLI ACP',
        command: process.execPath,
        args: ['-v'],
        enabled: true,
      },
      { homeDir },
    );

    const coordinator = new ExecutionRootCoordinator();
    const checkpoints = new CheckpointService({ homeDir });
    const worktrees = new WorktreeService({ homeDir, coordinator });
    const leases = new WorkspaceLeaseCoordinator();

    const dummyProfile: ModelProfile = {
      id: 'deepseek-flash',
      name: 'DeepSeek Flash',
      provider: 'openai-compatible',
      modelName: 'deepseek-chat',
      baseURL: 'http://127.0.0.1:9/v1',
      apiKeyEnv: 'NONE',
      apiKey: 'dummy',
    };
    const dummyProvider = {
      name: 'mock',
      async *streamChat() {
        yield { type: 'text_delta' as const, text: 'ok' };
        yield {
          type: 'finish' as const,
          finishReason: 'stop' as const,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        };
      },
    };

    const manager = new SessionManager({
      workspaceRoot: repoDir,
      homeDirectory: homeDir,
      projectRootMode: 'exact',
    });
    cleanups.push(() => manager.close());

    const handle = await manager.create();
    const makeSession = async (targetHandle: Awaited<ReturnType<SessionManager['create']>>) => {
      const s = new AgentSession({
        leaseCoordinator: leases,
        defaultProfile: dummyProfile,
        defaultProvider: dummyProvider as never,
        store: targetHandle.store,
        conversationId: targetHandle.conversationId,
        workspaceRoot: repoDir,
        executionCwd: repoDir,
        rootDir: repoDir,
        projectRoot: repoDir,
        cwd: repoDir,
      });
      await s.init();
      return s;
    };
    const initialSession = await makeSession(handle);
    const controller = new ActiveSessionController({
      manager,
      factory: makeSession,
      current: { session: initialSession, handle },
    });
    cleanups.push(() => controller.close());

    let spawnedChildBranch: string | undefined;
    const runtime = new AgentRuntime({
      worktreeProvider: worktrees.asSubagentWorktreeProvider(),
      runner: async (task) => {
        spawnedChildBranch = task.worktree?.branch;
        return {
          summary: '子任务已在独立工作树完成',
          sessionId: 'child-wt-session',
        };
      },
    });
    cleanups.push(() => runtime.close());

    const mockExtDriver: ExternalHarnessDriver = {
      transport: 'acp',
      inspect: async () => ({ available: true, status: 'ready', loadSupported: true }),
      open: async (params): Promise<ExternalDriverOpenResult> => ({
        resumable: true,
        nativeSessionId: 'ext-cli-wt-1',
        handle: {
          pid: undefined,
          prompt: async () => {
            fs.writeFileSync(path.join(params.workspaceRoot, 'ext-out.txt'), 'ok\n', 'utf8');
            params.onEvent({ type: 'text_delta', text: '外部工作树完成' });
            return { stopReason: 'completed' };
          },
          cancel: async () => {},
          close: async () => {},
        },
      }),
    };
    const external = new ExternalSessionService({
      homeDir,
      checkpoints,
      worktrees,
      executionCoordinator: coordinator,
      drivers: { acp: mockExtDriver },
    });
    cleanups.push(() => external.dispose());

    const logs: string[] = [];
    const dispatcher = createDefaultCommandDispatcher();
    const ctx: CommandContext = {
      get session() {
        return controller.session;
      },
      controller,
      dispatcher,
      runtime,
      external,
      checkpoints,
      worktrees,
      settings,
      homeDir,
      projectRoot: repoDir,
      executionRoot: repoDir,
      output: {
        log: (m) => logs.push(m),
        error: (m) => logs.push(`ERR:${m}`),
        write: (m) => logs.push(m),
      },
      onModelSwitched: () => {},
      onExit: () => {},
    };

    // 1. 产生两轮完整（user + assistant）真实检查点并测试 /checkpoints 与 /branch
    await handle.store.append({
      id: 'u-0',
      role: 'user',
      timestamp: Date.now(),
      content: [{ type: 'text', text: '第一轮' }],
    });
    const u0RecordId = (await handle.store.readRecords()).at(-1)!.recordId;

    const pre0 = await checkpoints.capturePreTurn({
      projectRoot: repoDir,
      executionRoot: repoDir,
      sessionId: handle.conversationId,
      ordinal: 0,
    });
    fs.writeFileSync(path.join(repoDir, 'turn0.txt'), 'turn0\n', 'utf8');
    if (pre0.captured) {
      await checkpoints.capturePostTurn({
        projectRoot: repoDir,
        executionRoot: repoDir,
        sessionId: handle.conversationId,
        ordinal: 0,
        startTree: pre0.startTree,
        label: '第一轮',
      });
    }
    await handle.store.append({
      id: 'a-0',
      role: 'assistant',
      timestamp: Date.now(),
      content: [{ type: 'text', text: '已完成第一轮修改' }],
    });
    const a0RecordId = (await handle.store.readRecords()).at(-1)!.recordId;

    await handle.store.append({
      id: 'u-1',
      role: 'user',
      timestamp: Date.now(),
      content: [{ type: 'text', text: '第二轮' }],
    });
    const u1RecordId = (await handle.store.readRecords()).at(-1)!.recordId;

    const pre1 = await checkpoints.capturePreTurn({
      projectRoot: repoDir,
      executionRoot: repoDir,
      sessionId: handle.conversationId,
      ordinal: 1,
    });
    fs.writeFileSync(path.join(repoDir, 'turn1.txt'), 'turn1\n', 'utf8');
    if (pre1.captured) {
      await checkpoints.capturePostTurn({
        projectRoot: repoDir,
        executionRoot: repoDir,
        sessionId: handle.conversationId,
        ordinal: 1,
        startTree: pre1.startTree,
        label: '第二轮',
      });
    }
    await handle.store.append({
      id: 'a-1',
      role: 'assistant',
      timestamp: Date.now(),
      content: [{ type: 'text', text: '已完成第二轮修改' }],
    });
    const a1RecordId = (await handle.store.readRecords()).at(-1)!.recordId;

    const { resolveTargetOrdinalAtRecord, validateBranchCommandArgs } = await import(
      '../src/commands/branch.js'
    );
    expect(await resolveTargetOrdinalAtRecord(handle.store, u0RecordId)).toBe(-1);
    expect(await resolveTargetOrdinalAtRecord(handle.store, a0RecordId)).toBe(0);
    expect(await resolveTargetOrdinalAtRecord(handle.store, u1RecordId)).toBe(0);
    expect(await resolveTargetOrdinalAtRecord(handle.store, a1RecordId)).toBe(1);
    expect(
      await resolveTargetOrdinalAtRecord(handle.store, a1RecordId, [
        { ordinal: 0 },
        { ordinal: 2 },
      ]),
    ).toBe(0);

    // 未知 --* 标志必须拒绝，--summary 与 --with-summary 同义通过，无 recordId 的 --restore-files 合法
    expect(validateBranchCommandArgs(['msg-1', '--typo'])).toContain("未知选项 '--typo'");
    expect(validateBranchCommandArgs(['--with-summary'])).toBeUndefined();
    expect(validateBranchCommandArgs(['--summary'])).toBeUndefined();
    expect(validateBranchCommandArgs(['--restore-files'])).toBeUndefined();

    logs.length = 0;
    await dispatcher.dispatch('/checkpoints', ctx);
    expect(logs.join('\n')).toContain('#0');
    expect(logs.join('\n')).toContain('#1');

    logs.length = 0;
    await dispatcher.dispatch('/checkpoints diff 1', ctx);
    expect(logs.join('\n')).toContain('turn1.txt');

    // 未信任工作区调用 --restore-files 必须拒绝
    logs.length = 0;
    const untrustedHome = makeTempDir('kpbl-untrusted-home-');
    await dispatcher.dispatch(`/branch create ${u1RecordId} blocked --restore-files`, {
      ...ctx,
      settings: createUserSettingsSkeleton(),
      homeDir: untrustedHome,
    });
    expect(logs.join('\n')).toContain('尚未被信任');
    expect(fs.existsSync(path.join(repoDir, 'turn1.txt'))).toBe(true);

    // 在第 2 轮 user 消息 u-1 处分叉（其 assistant 轮次尚未运行 -> targetOrdinal = 0）：应回滚 turn1.txt 并保留 turn0.txt
    logs.length = 0;
    await dispatcher.dispatch(`/branch create ${u1RecordId} alt --restore-files`, ctx);
    expect(fs.existsSync(path.join(repoDir, 'turn1.txt'))).toBe(false);
    expect(fs.existsSync(path.join(repoDir, 'turn0.txt'))).toBe(true);
    expect(logs.join('\n')).toContain('已成功在记录');

    // 在活动分支叶子直接执行 /branch --restore-files（不传 recordId）也应合法通过
    logs.length = 0;
    await dispatcher.dispatch('/branch --restore-files', ctx);
    expect(logs.join('\n')).toContain('已成功在记录');

    // /checkpoints restore -1 还原到首轮开始前（连 turn0.txt 一并清理）
    await dispatcher.dispatch('/checkpoints restore -1', ctx);
    expect(fs.existsSync(path.join(repoDir, 'turn0.txt'))).toBe(false);

    // 2. /worktrees create | list | status | merge | remove
    logs.length = 0;
    await dispatcher.dispatch('/worktrees create demo --branch kpbl/cli-demo', ctx);
    const createdWt = worktrees.list(repoDir).find((w) => w.branch === 'kpbl/cli-demo');
    expect(createdWt).toBeDefined();

    fs.writeFileSync(path.join(createdWt!.worktreePath, 'merged-via-cli.txt'), 'merged!\n', 'utf8');
    await dispatcher.dispatch(`/worktrees merge ${createdWt!.id} --commit "feat: cli merge"`, ctx);
    expect(
      fs.readFileSync(path.join(repoDir, 'merged-via-cli.txt'), 'utf8').replaceAll('\r\n', '\n'),
    ).toBe('merged!\n');

    await dispatcher.dispatch(`/worktrees remove ${createdWt!.id}`, ctx);
    expect(worktrees.get(createdWt!.id)).toBeUndefined();

    // 3. /delegate ... --worktree --branch kpbl/del-custom
    logs.length = 0;
    await dispatcher.dispatch('/delegate 独立修复认证 --worktree --branch kpbl/del-custom', ctx);
    await vi.waitFor(
      () => {
        expect(spawnedChildBranch).toBe('kpbl/del-custom');
      },
      { timeout: 15_000 },
    );

    // 4. /external start 支持 --worktree 出现在 <harnessId> 前或后
    logs.length = 0;
    await dispatcher.dispatch(
      '/external start --worktree --branch kpbl/ext-cli cli-acp 运行外部独立工作树',
      ctx,
    );
    await dispatcher.dispatch(
      '/external start cli-acp --worktree --branch kpbl/ext-after 后置标志外部工作树',
      ctx,
    );
    const extSessions = external.listSessions(repoDir);
    expect(extSessions).toHaveLength(2);
    expect(extSessions.map((s) => s.worktree?.branch).sort()).toEqual([
      'kpbl/ext-after',
      'kpbl/ext-cli',
    ]);
  }, 90_000);

  it('CLI -w/--worktree 参数解析、runOneShot 检查点与围栏追踪、以及 Wire v2 旧客户端字段裁剪与代际校验', async () => {
    const { extractWorktreeCliOption, validateSessionStartup } = await import(
      '../src/session-startup.js'
    );
    const { runOneShot } = await import('../src/oneshot.js');

    // 1. -w / --worktree 参数解析
    expect(extractWorktreeCliOption(['-w', '请重构目录'])).toEqual({
      normalizedArgv: ['请重构目录'],
      worktree: { enabled: true },
    });
    expect(extractWorktreeCliOption(['-w', 'feat/clean-branch', '-p', '请重构目录'])).toEqual({
      normalizedArgv: ['-p', '请重构目录'],
      worktree: { enabled: true, branch: 'feat/clean-branch' },
    });
    expect(extractWorktreeCliOption(['-w', 'feat/clean-branch', '请重构目录'])).toEqual({
      normalizedArgv: ['请重构目录'],
      worktree: { enabled: true, branch: 'feat/clean-branch' },
    });
    expect(extractWorktreeCliOption(['--worktree=feat/eq-branch', '任务'])).toEqual({
      normalizedArgv: ['任务'],
      worktree: { enabled: true, branch: 'feat/eq-branch' },
    });
    expect(extractWorktreeCliOption(['-w'])).toEqual({
      normalizedArgv: [],
      worktree: { enabled: true },
    });
    expect(() => validateSessionStartup({ continue: true, worktree: { enabled: true } })).toThrow(
      /--worktree.*--continue/,
    );
    expect(() => validateSessionStartup({ resume: 'abc', worktree: { enabled: true } })).toThrow(
      /--worktree.*--resume/,
    );

    // 2. runOneShot 记录检查点并在 ExecutionRootCoordinator 中追踪运行
    const homeDir = makeTempDir('kpbl-oneshot-home-');
    const repoDir = makeTempDir('kpbl-oneshot-repo-');
    initGitRepo(repoDir);
    const checkpoints = new CheckpointService({ homeDir });
    const coordinator = new ExecutionRootCoordinator();
    let sawActiveDuringRun = false;
    let destroyed = false;
    const fakeSession = {
      conversationId: 'oneshot-conv-1',
      workspaceRoot: repoDir,
      getHistory: () => [],
      async *run() {
        sawActiveDuringRun = coordinator.hasActiveRuns(repoDir);
        fs.writeFileSync(path.join(repoDir, 'oneshot-out.txt'), 'oneshot\n', 'utf8');
        yield {
          type: 'run_finish',
          metrics: {
            status: 'completed',
            turns: 1,
            startTime: 1,
            endTime: 2,
            totalDurationMs: 1,
            modelDurationMs: 1,
            toolDurationMs: 0,
            toolCalls: 0,
            promptTokens: 1,
            completionTokens: 1,
            totalTokens: 2,
          },
        };
      },
      destroy: async () => {
        destroyed = true;
      },
    };
    const fakeInput = {
      interactive: false,
      onInterrupt: () => () => {},
      onDetailToggle: () => () => {},
      onInteraction: () => () => {},
    };
    const fakeApproval = { bind: () => {} };
    const exitCode = await runOneShot({
      session: fakeSession as never,
      inputCoordinator: fakeInput as never,
      prompt: '生成单次文件',
      debug: false,
      outputDetail: 'summary',
      approvalChannel: fakeApproval as never,
      projectRoot: repoDir,
      checkpoints,
      executionCoordinator: coordinator,
    });
    expect(exitCode).toBe(0);
    expect(sawActiveDuringRun).toBe(true);
    expect(coordinator.hasActiveRuns(repoDir)).toBe(false);
    expect(destroyed).toBe(true);
    const recordedCps = await checkpoints.listCheckpoints({
      projectRoot: repoDir,
      executionRoot: repoDir,
      sessionId: 'oneshot-conv-1',
    });
    expect(recordedCps).toHaveLength(1);
    expect(recordedCps[0]?.changedFiles.map((f) => f.path)).toContain('oneshot-out.txt');

    // 3. Wire v2 旧客户端字段门控（delegation / worktree / diffSummary）与 checkpoint/restore 代际校验
    const settings = createUserSettingsSkeleton();
    trustProject(settings, repoDir, { homeDir });
    const mgr = new SessionManager({
      workspaceRoot: repoDir,
      homeDirectory: homeDir,
    });
    const delHandle = await mgr.create({
      delegation: {
        kind: 'delegation',
        parentSessionId: 'p-root',
        taskName: '子任务',
        createdAt: Date.now(),
      },
    });
    await delHandle.store.append({
      id: 'm-del',
      role: 'user',
      timestamp: Date.now(),
      content: [{ type: 'text', text: '委派内容' }],
    });
    await delHandle.release();
    await mgr.close();

    const wtService = new WorktreeService({ homeDir, coordinator });
    const extService = new ExternalSessionService({
      homeDir,
      checkpoints,
      worktrees: wtService,
      executionCoordinator: coordinator,
      isWorkspaceTrusted: () => true,
    });
    extService.registerDriver({
      transport: 'acp',
      inspect: async () => ({ available: true, status: 'ready', loadSupported: true }),
      open: async (): Promise<ExternalDriverOpenResult> => ({
        resumable: true,
        nativeSessionId: 'ext-wire-gate-1',
        handle: {
          pid: undefined,
          prompt: async () => ({ stopReason: 'completed' }),
          cancel: async () => {},
          close: async () => {},
        },
      }),
    });
    extService.saveCustomHarness({
      id: 'wire-acp',
      name: 'Wire ACP',
      command: process.execPath,
      args: ['--version'],
      enabled: true,
    });

    const server = new LocalHostServer({
      homeDir,
      checkpoints,
      worktrees: wtService,
      external: extService,
      create: async (projectRoot, conversationId, _approval, hooks): Promise<SessionResources> => {
        const convId = conversationId ?? 'wire-conv-1';
        const wtBinding = hooks?.worktree;
        const execRoot = wtBinding?.worktreePath ?? projectRoot;
        return {
          conversationId: convId,
          history: () => [],
          worktree: () => (wtBinding ? { ...wtBinding } : undefined),
          restoreCheckpoint: (targetOrdinal, force) =>
            checkpoints.restore({
              projectRoot,
              executionRoot: execRoot,
              sessionId: convId,
              targetOrdinal,
              force,
            }),
          async *run() {},
          dispose: async () => {},
        };
      },
    });
    cleanups.push(async () => {
      await extService.dispose();
      await server.shutdown();
    });

    const v015SessionClient = await connectWireClient(server, ['sessions']);
    const listedLegacy = await v015SessionClient.call('session/list', { workspaceRoot: repoDir });
    expect(listedLegacy.items.length).toBeGreaterThan(0);
    expect(listedLegacy.items.every((item) => !('delegation' in item))).toBe(true);

    const v016SessionClient = await connectWireClient(server, [
      'sessions',
      'worktree',
      'checkpoint',
    ]);
    const listedModern = await v016SessionClient.call('session/list', { workspaceRoot: repoDir });
    expect(listedModern.items.some((item) => Boolean(item.delegation))).toBe(true);

    const createdModern = await v016SessionClient.call('session/create', {
      workspaceRoot: repoDir,
      worktree: { enabled: true, branch: 'kpbl/wire-wt-gate' },
    });
    expect(createdModern.worktree?.branch).toBe('kpbl/wire-wt-gate');

    // checkpoint/restore 要求当前控制连接且代际有效（观察连接返回 CONTROL_REQUIRED，携带过期代际返回 STALE_CONTROL）
    const observerModern = await connectWireClient(server, ['sessions', 'checkpoint']);
    await observerModern.call('session/attach', {
      sessionId: createdModern.sessionId,
      mode: 'observe',
    });
    await expect(
      observerModern.call('checkpoint/restore', {
        sessionId: createdModern.sessionId,
        targetOrdinal: -1,
      }),
    ).rejects.toThrow('CONTROL_REQUIRED');
    const attachedModern = await v016SessionClient.call('session/attach', {
      sessionId: createdModern.sessionId,
      mode: 'control',
    });
    const { REQUEST_SCHEMAS } = await import('@kiturone/kapibala-host/protocol');
    if (
      'properties' in REQUEST_SCHEMAS['checkpoint/restore'] &&
      REQUEST_SCHEMAS['checkpoint/restore'].properties &&
      'controlEpoch' in REQUEST_SCHEMAS['checkpoint/restore'].properties
    ) {
      await expect(
        v016SessionClient.call('checkpoint/restore', {
          sessionId: createdModern.sessionId,
          targetOrdinal: -1,
          streamEpoch: attachedModern.streamEpoch,
          controlEpoch: 'stale-epoch',
        } as never),
      ).rejects.toThrow('STALE_CONTROL');
    }

    // external-session 旧客户端（未声明 worktree / checkpoint）不收到 worktree 与 diffSummary
    const createdWtForExt = await wtService.create({
      projectRoot: repoDir,
      branch: 'kpbl/ext-gate',
    });
    await extService.openSession({
      workspaceRoot: createdWtForExt.binding.worktreePath,
      projectRoot: repoDir,
      worktree: createdWtForExt.binding,
      harnessId: 'wire-acp',
      title: '外部协议门控测试',
    });
    const legacyExtClient = await connectWireClient(server, ['external-session']);
    const legacyExtList = await legacyExtClient.call('external/list', { workspaceRoot: repoDir });
    expect(legacyExtList.items).toHaveLength(1);
    expect('worktree' in legacyExtList.items[0]!).toBe(false);
    expect('diffSummary' in legacyExtList.items[0]!).toBe(false);
  }, 90_000);
});
