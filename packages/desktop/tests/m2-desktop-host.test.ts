import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { UserSettings } from '@kiturone/kapibala-host/internal';
import { afterEach, describe, expect, it } from 'vitest';
import { DesktopHost } from '../src/agent-host/desktop-host.js';
import type { Notification, Output } from '../src/shared/contracts.js';
import { safeError } from '../src/shared/rpc.js';

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
  execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: repoDir, env, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Kapibala Desktop Test'], {
    cwd: repoDir,
    env,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.email', 'desktop@kapibala.local'], {
    cwd: repoDir,
    env,
    stdio: 'pipe',
  });
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'src', 'app.ts'), 'export const app = "v1";\n', 'utf8');
  execFileSync('git', ['add', '.'], { cwd: repoDir, env, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'chore: initial'], { cwd: repoDir, env, stdio: 'pipe' });
}

afterEach(async () => {
  for (const fn of cleanups.splice(0)) {
    await fn().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('M2 DesktopHost RPCs：worktree.*、checkpoint.*、session.create(worktree)、run.regenerate 与 workspace.readFile', () => {
  it('workspace.readFile 与 workspace.listFiles 支持查询过滤、二进制识别、512KiB 截断、受管工作树读取，并严格拦截 .kapibala 与 .env 密钥文件', async () => {
    const homeDir = makeTempDir('kpbl-m2-desk-files-home-');
    const repoDir = makeTempDir('kpbl-m2-desk-files-repo-');
    initGitRepo(repoDir);

    // 写入敏感文件、模板文件、二进制文件与 >512KiB 大文本文件
    fs.mkdirSync(path.join(repoDir, '.kapibala'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, '.kapibala', 'mcp.json'), '{"mcpServers":{}}\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, '.env'), 'OPENAI_API_KEY=sk-secret-do-not-read\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, '.env.local'), 'SECRET=123\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, '.envrc'), 'export SECRET_TOKEN=1\n', 'utf8');
    fs.writeFileSync(path.join(repoDir, '.env.example'), 'OPENAI_API_KEY=\n', 'utf8');
    let hasEnvSymlink = false;
    try {
      fs.symlinkSync(path.join(repoDir, '.env'), path.join(repoDir, 'innocent-readme.txt'));
      hasEnvSymlink = true;
    } catch {
      // Windows 未开启开发者模式无文件符号链接权限时跳过文件级软链用例，仍验证目录 junction -> .kapibala。
    }
    let hasKapibalaJunction = false;
    try {
      fs.symlinkSync(
        path.join(repoDir, '.kapibala'),
        path.join(repoDir, 'linked-cfg'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      hasKapibalaJunction = true;
    } catch {
      // 忽略极端受限文件系统。
    }
    fs.writeFileSync(
      path.join(repoDir, 'logo.bin'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
    );
    fs.writeFileSync(path.join(repoDir, 'huge.md'), 'A'.repeat(540 * 1024), 'utf8');
    fs.mkdirSync(path.join(repoDir, 'packages', 'deep', 'nested'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'packages', 'deep', 'nested', 'needle-target.tsx'),
      'export const Needle = () => null;\n',
      'utf8',
    );

    const events: Notification[] = [];
    const host = new DesktopHost(homeDir, async (evt) => {
      events.push(evt);
    });
    cleanups.push(() => host.disconnect());

    const picked = (await host.dispatch('workspace.pick', {}, repoDir)) as Output<'workspace.pick'>;
    expect(picked).not.toBeNull();
    const ws = (await host.dispatch('workspace.addProject', {
      workspaceId: picked!.id,
      name: 'DemoRepo',
      trustToken: picked!.trustToken,
      acceptTrust: true,
    })) as Output<'workspace.addProject'>;

    // 1. 读取常规 TypeScript 文件与允许的 .env.example
    const appFile = (await host.dispatch('workspace.readFile', {
      workspaceId: ws.id,
      path: 'src/app.ts',
    })) as Output<'workspace.readFile'>;
    expect(appFile).toEqual({
      path: 'src/app.ts',
      content: 'export const app = "v1";\n',
      byteLength: Buffer.byteLength('export const app = "v1";\n'),
      truncated: false,
      binary: false,
      language: 'typescript',
    });

    const envExample = (await host.dispatch('workspace.readFile', {
      workspaceId: ws.id,
      path: '.env.example',
    })) as Output<'workspace.readFile'>;
    expect(envExample.binary).toBe(false);
    expect(envExample.content).toBe('OPENAI_API_KEY=\n');

    // 2. 硬禁区拦截：.kapibala/**、.env、.env.local、.envrc、软链绕过与路径穿越 ../
    const deniedTargets = [
      '.kapibala/mcp.json',
      '.env',
      '.env.local',
      '.envrc',
      '.git/config',
      ...(hasEnvSymlink ? ['innocent-readme.txt'] : []),
      ...(hasKapibalaJunction ? ['linked-cfg/mcp.json'] : []),
    ];
    for (const forbiddenPath of deniedTargets) {
      let caught: unknown;
      try {
        await host.dispatch('workspace.readFile', { workspaceId: ws.id, path: forbiddenPath });
      } catch (err) {
        caught = err;
      }
      expect(safeError(caught).code).toBe('PERMISSION_DENIED');
    }

    let escapeErr: unknown;
    try {
      await host.dispatch('workspace.readFile', { workspaceId: ws.id, path: '../outside.txt' });
    } catch (err) {
      escapeErr = err;
    }
    expect(safeError(escapeErr).code).toBe('WORKSPACE_ESCAPE');

    // 3. 二进制文件 NUL 探测与 >512KiB UTF-8 截断
    const binFile = (await host.dispatch('workspace.readFile', {
      workspaceId: ws.id,
      path: 'logo.bin',
    })) as Output<'workspace.readFile'>;
    expect(binFile.binary).toBe(true);
    expect(binFile.content).toBe('');
    expect(binFile.byteLength).toBe(6);

    const hugeFile = (await host.dispatch('workspace.readFile', {
      workspaceId: ws.id,
      path: 'huge.md',
    })) as Output<'workspace.readFile'>;
    expect(hugeFile.truncated).toBe(true);
    expect(hugeFile.byteLength).toBe(540 * 1024);
    expect(hugeFile.content.length).toBe(512 * 1024);
    expect(hugeFile.language).toBe('markdown');

    // 4. workspace.listFiles 支持 query 模糊过滤，且自动排除敏感 .env
    const allListed = (await host.dispatch('workspace.listFiles', {
      workspaceId: ws.id,
    })) as Output<'workspace.listFiles'>;
    expect(allListed.files).toContain('.env.example');
    expect(allListed.files).not.toContain('.env');
    expect(allListed.files).not.toContain('.env.local');

    const queried = (await host.dispatch('workspace.listFiles', {
      workspaceId: ws.id,
      query: 'needle-target',
    })) as Output<'workspace.listFiles'>;
    expect(queried.files[0]?.replaceAll('\\', '/')).toBe('packages/deep/nested/needle-target.tsx');

    // 5. 创建受管工作树并在指定 worktreeId 下枚举与读取隔离文件
    const wt = (await host.dispatch('worktree.create', {
      workspaceId: ws.id,
      name: 'files-wt',
      branch: 'kpbl/files-wt',
    })) as Output<'worktree.create'>;
    fs.writeFileSync(path.join(wt.worktreePath, 'only-in-wt.ts'), 'export const wt = true;\n');

    const wtFiles = (await host.dispatch('workspace.listFiles', {
      workspaceId: ws.id,
      worktreeId: wt.id,
      query: 'only-in-wt',
    })) as Output<'workspace.listFiles'>;
    expect(wtFiles.files).toEqual(['only-in-wt.ts']);

    const wtRead = (await host.dispatch('workspace.readFile', {
      workspaceId: ws.id,
      worktreeId: wt.id,
      path: 'only-in-wt.ts',
    })) as Output<'workspace.readFile'>;
    expect(wtRead.content).toBe('export const wt = true;\n');
  });

  it('session.create({ worktree: { enabled: true } }) 绑定独立工作树，打通 checkpoint.*、run.regenerate 文件冲突保护与 worktree 合并闭环', async () => {
    const homeDir = makeTempDir('kpbl-m2-desk-session-home-');
    const repoDir = makeTempDir('kpbl-m2-desk-session-repo-');
    initGitRepo(repoDir);

    let stepCounter = 0;
    const modelServer = http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      void Buffer.concat(chunks);

      const callNo = stepCounter++;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (callNo === 0) {
        const chunk = {
          id: 'c-0',
          object: 'chat.completion.chunk',
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call_wt_write',
                    type: 'function',
                    function: {
                      name: 'write_file',
                      arguments: JSON.stringify({
                        path: 'src/wt-created.ts',
                        content: 'export const fromWt = 1;\n',
                      }),
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        };
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }

      const responseContent =
        callNo === 1
          ? '完成回复 #1'
          : JSON.stringify({
              schemaVersion: 1,
              goal: '在独立工作树写入 src/wt-created.ts',
              constraints: [],
              decisions: [],
              completedWork: ['已在工作树创建 src/wt-created.ts'],
              pendingWork: [],
              references: [],
              unknownEffects: [],
            });
      const doneChunk = {
        id: `c-${callNo}`,
        object: 'chat.completion.chunk',
        choices: [
          {
            index: 0,
            delta: { role: 'assistant', content: responseContent },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
      };
      res.write(`data: ${JSON.stringify(doneChunk)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });

    await new Promise<void>((resolve) => modelServer.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          modelServer.close(() => resolve());
        }),
    );
    const port = (modelServer.address() as AddressInfo).port;

    const settings: UserSettings = {
      defaultModel: 'mock-desk',
      permissionMode: 'Auto',
      profiles: [
        {
          id: 'mock-desk',
          name: 'Mock Desk',
          provider: 'openai-compatible',
          modelName: 'mock-desk',
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'NONE',
          apiKey: 'dummy-key',
        },
      ],
    };
    fs.mkdirSync(path.join(homeDir, '.kapibala'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify(settings, null, 2),
      'utf8',
    );

    const events: Notification[] = [];
    const host = new DesktopHost(homeDir, async (evt) => {
      events.push(evt);
    });
    cleanups.push(() => host.disconnect());

    const picked = (await host.dispatch('workspace.pick', {}, repoDir)) as Output<'workspace.pick'>;
    const ws = (await host.dispatch('workspace.addProject', {
      workspaceId: picked!.id,
      name: 'SessionRepo',
      trustToken: picked!.trustToken,
      acceptTrust: true,
    })) as Output<'workspace.addProject'>;

    // 1. 新建带独立工作树的本地会话
    const created = (await host.dispatch('session.create', {
      workspaceId: ws.id,
      worktree: { enabled: true, branch: 'kpbl/desk-session-wt' },
    })) as Output<'session.create'>;
    expect(created.worktree?.branch).toBe('kpbl/desk-session-wt');
    const wtId = created.worktree!.id;
    const wtRoot = created.worktree!.worktreePath;

    // 安装展示订阅以启动会话轮次
    const subId = randomUUID();
    await host.dispatch('presentation.subscribe', {
      workspaceId: ws.id,
      sessionId: created.sessionId,
      subscriptionId: subId,
    });
    const firstChunk = events.find(
      (e): e is Extract<Notification, { type: 'presentation.chunk' }> =>
        e.type === 'presentation.chunk' && e.subscriptionId === subId,
    )!;
    await host.dispatch('presentation.installed', {
      workspaceId: ws.id,
      sessionId: created.sessionId,
      subscriptionId: subId,
      snapshotId: firstChunk.snapshotId,
      sequence: firstChunk.sequence,
    });

    await host.dispatch('run.start', {
      workspaceId: ws.id,
      sessionId: created.sessionId,
      operationId: randomUUID(),
      input: '在独立工作树写入 src/wt-created.ts',
    });

    // 等待运行进入 idle（Windows 下 Git 检查点首尾捕获需数秒，显式留足轮询预算）
    await expect
      .poll(
        async () => {
          const st = (await host.dispatch('run.status', {
            workspaceId: ws.id,
            sessionId: created.sessionId,
          })) as Output<'run.status'>;
          return st?.phase;
        },
        { timeout: 20_000 },
      )
      .toBe('idle');

    // 文件写入在独立工作树而非主工作区
    expect(fs.existsSync(path.join(wtRoot, 'src', 'wt-created.ts'))).toBe(true);
    expect(fs.existsSync(path.join(repoDir, 'src', 'wt-created.ts'))).toBe(false);

    // 2. checkpoint.list & checkpoint.diff
    const cpList = (await host.dispatch('checkpoint.list', {
      workspaceId: ws.id,
      sessionId: created.sessionId,
    })) as Output<'checkpoint.list'>;
    expect(cpList.items).toHaveLength(1);

    const cpDiff = (await host.dispatch('checkpoint.diff', {
      workspaceId: ws.id,
      sessionId: created.sessionId,
      ordinal: 0,
    })) as Output<'checkpoint.diff'>;
    expect(cpDiff.available).toBe(true);
    expect(cpDiff.files.map((f) => f.path)).toEqual(['src/wt-created.ts']);

    // 3. 手动改动引发 run.regenerate(restoreFiles: true) 同步抛 CHECKPOINT_RESTORE_CONFLICT
    fs.writeFileSync(path.join(wtRoot, 'src', 'wt-created.ts'), '// manual edit\n', 'utf8');
    let regenConflictErr: unknown;
    try {
      await host.dispatch('run.regenerate', {
        workspaceId: ws.id,
        sessionId: created.sessionId,
        restoreFiles: true,
      });
    } catch (err) {
      regenConflictErr = err;
    }
    expect(safeError(regenConflictErr).code).toBe('CHECKPOINT_RESTORE_CONFLICT');

    // 4. worktree.previewMerge + worktree.applyMerge 合入主工作区
    const preview = (await host.dispatch('worktree.previewMerge', {
      workspaceId: ws.id,
      id: wtId,
    })) as Output<'worktree.previewMerge'>;
    const merged = (await host.dispatch('worktree.applyMerge', {
      workspaceId: ws.id,
      id: wtId,
      previewToken: preview.previewToken,
      commitMessage: 'feat: desktop wt merge',
    })) as Output<'worktree.applyMerge'>;
    expect(merged.status).toBe('merged');
    expect(fs.readFileSync(path.join(repoDir, 'src', 'wt-created.ts'), 'utf8')).toBe(
      '// manual edit\n',
    );

    // 5. session.branchWithSummary 创建带摘要的新分支
    const branched = (await host.dispatch('session.branchWithSummary', {
      workspaceId: ws.id,
      conversationId: created.conversationId,
      branchName: 'experiment-branch',
    })) as Output<'session.branchWithSummary'>;
    expect(branched.branchId).toBe('experiment-branch');

    // 6. worktree.list 计算 inUse / prunable（未归档会话绑定时 inUse=true, prunable=false）
    const listWhileBound = (await host.dispatch('worktree.list', {
      workspaceId: ws.id,
    })) as Output<'worktree.list'>;
    expect(listWhileBound.items.find((w) => w.id === wtId)).toMatchObject({
      id: wtId,
      inUse: true,
      prunable: false,
    });

    // 7. worktree.remove 自动关闭绑定在该工作树上的空闲会话并安全清理目录
    const removed = (await host.dispatch('worktree.remove', {
      workspaceId: ws.id,
      id: wtId,
    })) as Output<'worktree.remove'>;
    expect(removed.removed).toBe(true);
    expect(fs.existsSync(wtRoot)).toBe(false);
  });

  it('session.delete 在无其他会话引用时自动清理干净的受管工作树，脏工作树则安全保留', async () => {
    const homeDir = makeTempDir('kpbl-m2-desk-wt-del-home-');
    const repoDir = makeTempDir('kpbl-m2-desk-wt-del-repo-');
    initGitRepo(repoDir);

    const settings: UserSettings = {
      defaultModel: 'mock-desk',
      permissionMode: 'Auto',
      profiles: [
        {
          id: 'mock-desk',
          name: 'Mock Desk',
          provider: 'openai-compatible',
          modelName: 'mock-desk',
          baseURL: 'http://127.0.0.1:9/v1',
          apiKeyEnv: 'NONE',
          apiKey: 'dummy-key',
        },
      ],
    };
    fs.mkdirSync(path.join(homeDir, '.kapibala'), { recursive: true });
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify(settings, null, 2),
      'utf8',
    );

    const host = new DesktopHost(homeDir, async () => {});
    cleanups.push(() => host.disconnect());

    const picked = (await host.dispatch('workspace.pick', {}, repoDir)) as Output<'workspace.pick'>;
    const ws = (await host.dispatch('workspace.addProject', {
      workspaceId: picked!.id,
      name: 'CleanDelRepo',
      trustToken: picked!.trustToken,
      acceptTrust: true,
    })) as Output<'workspace.addProject'>;

    // 1. 干净单主工作树会话：归档时 inUse 变为 false/prunable=true，删除会话后工作树被自动移除
    const cleanSession = (await host.dispatch('session.create', {
      workspaceId: ws.id,
      worktree: { enabled: true, branch: 'kpbl/auto-clean-wt' },
    })) as Output<'session.create'>;
    const cleanWtId = cleanSession.worktree!.id;
    const cleanWtPath = cleanSession.worktree!.worktreePath;
    expect(fs.existsSync(cleanWtPath)).toBe(true);

    await host.dispatch('session.archive', {
      workspaceId: ws.id,
      conversationId: cleanSession.conversationId,
    });
    const listAfterArchive = (await host.dispatch('worktree.list', {
      workspaceId: ws.id,
    })) as Output<'worktree.list'>;
    expect(listAfterArchive.items.find((w) => w.id === cleanWtId)).toMatchObject({
      id: cleanWtId,
      inUse: false,
      prunable: true,
    });

    await host.dispatch('session.delete', {
      workspaceId: ws.id,
      conversationId: cleanSession.conversationId,
    });
    expect(fs.existsSync(cleanWtPath)).toBe(false);

    // 2. 存在未提交改动的脏工作树会话：删除会话后保留工作树目录不丢代码
    const dirtySession = (await host.dispatch('session.create', {
      workspaceId: ws.id,
      worktree: { enabled: true, branch: 'kpbl/keep-dirty-wt' },
    })) as Output<'session.create'>;
    const dirtyWtPath = dirtySession.worktree!.worktreePath;
    fs.writeFileSync(path.join(dirtyWtPath, 'uncommitted.ts'), 'export const keep = 1;\n', 'utf8');

    await host.dispatch('session.delete', {
      workspaceId: ws.id,
      conversationId: dirtySession.conversationId,
    });
    expect(fs.existsSync(dirtyWtPath)).toBe(true);
  });
});
