import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ExternalSessionService,
  createUserSettingsSkeleton,
  trustProject,
} from '@kiturone/kapibala-host/internal';
import { matchCommandCandidates } from '@kiturone/kapibala-host/view-model';
import { afterEach, describe, expect, it } from 'vitest';
import { createDefaultCommandDispatcher } from '../src/commands/assemble.js';
import { COMMAND_CATALOG } from '../src/commands/catalog.js';
import type { CommandContext } from '../src/commands/dispatcher.js';

const fakeAcpScript = fileURLToPath(
  new URL('../../host/tests/fixtures/fake-acp-agent.mjs', import.meta.url),
);

const tempDirs: string[] = [];
const services: ExternalSessionService[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return fs.realpathSync.native(dir);
}

afterEach(async () => {
  for (const svc of services.splice(0)) {
    await svc.dispose().catch(() => {});
  }
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

describe('/external CLI 命令组与补全兼容', () => {
  it('斜杠前缀补全区分 /exit 与 /external，互不遮蔽且精确命中优先', () => {
    const candidates = COMMAND_CATALOG.map((d, index) => ({
      id: d.name,
      kind: 'command' as const,
      baseOrder: index,
      name: d.name,
      aliases: d.aliases ?? [],
      description: d.description,
      sourceLabel: '内置命令',
    }));

    const exMatches = matchCommandCandidates(candidates, 'ex').map((m) => m.candidate.name);
    expect(exMatches).toContain('exit');
    expect(exMatches).toContain('external');

    const exitExact = matchCommandCandidates(candidates, 'exit');
    expect(exitExact[0]?.candidate.name).toBe('exit');

    const extPrefix = matchCommandCandidates(candidates, 'ext');
    expect(extPrefix[0]?.candidate.name).toBe('external');
    expect(extPrefix[0]?.match).toBe('prefix');
  });

  it('跑通 /external harnesses、harness add/test/disable/enable、start、show、prompt、close 与 delete 全链路', async () => {
    const homeDir = makeTempDir('kpbl-cli-ext-home-');
    const workspaceRoot = makeTempDir('kpbl-cli-ext-ws-');
    const settings = createUserSettingsSkeleton();
    trustProject(settings, workspaceRoot, { homeDir });

    const external = new ExternalSessionService({ homeDir });
    services.push(external);

    const logs: string[] = [];
    const errors: string[] = [];
    const dispatcher = createDefaultCommandDispatcher();
    const ctx: CommandContext = {
      session: { isBusy: () => false } as unknown as CommandContext['session'],
      settings,
      homeDir,
      projectRoot: workspaceRoot,
      external,
      output: {
        log: (msg) => {
          logs.push(msg);
        },
        error: (msg) => {
          errors.push(msg);
        },
        write: (msg, stream) => {
          (stream === 'stderr' ? errors : logs).push(msg);
        },
      },
      onModelSwitched: () => {},
      onExit: () => {},
    };

    await dispatcher.dispatch('/external harnesses', ctx);
    expect(logs.join('\n')).toContain('claude-code');
    expect(logs.join('\n')).toContain('antigravity');
    logs.length = 0;

    await dispatcher.dispatch(
      `/external harness add cli-acp ${JSON.stringify(process.execPath)} ${JSON.stringify(fakeAcpScript)} --mode=normal`,
      ctx,
    );
    expect(logs.join('\n')).toContain('已保存自定义外部代理: cli-acp');
    logs.length = 0;

    await dispatcher.dispatch('/external harness test cli-acp', ctx);
    expect(logs.join('\n')).toContain('ready');
    logs.length = 0;

    await dispatcher.dispatch('/external harness disable cli-acp', ctx);
    await dispatcher.dispatch('/external harness enable cli-acp', ctx);
    expect(logs.join('\n')).toContain('已启用外部代理: cli-acp');
    logs.length = 0;

    await dispatcher.dispatch('/external start cli-acp 帮我检查项目结构', ctx);
    expect(errors).toEqual([]);
    const startOutput = logs.join('\n');
    expect(startOutput).toContain('收到:帮我检查项目结构');
    logs.length = 0;

    const sessions = external.listSessions(workspaceRoot);
    expect(sessions).toHaveLength(1);
    const shortId = sessions[0]!.id.slice(0, 10);

    await dispatcher.dispatch(`/external show ${shortId}`, ctx);
    expect(logs.join('\n')).toContain('帮我检查项目结构');
    logs.length = 0;

    await dispatcher.dispatch(`/external prompt ${shortId} 继续补充结论`, ctx);
    expect(logs.join('\n')).toContain('收到:继续补充结论');
    logs.length = 0;

    await dispatcher.dispatch(`/external close ${shortId}`, ctx);
    expect(logs.join('\n')).toContain('已关闭外部会话进程');
    logs.length = 0;

    await dispatcher.dispatch(`/external delete ${shortId}`, ctx);
    expect(logs.join('\n')).toContain('已删除外部会话');
    expect(external.listSessions(workspaceRoot)).toHaveLength(0);
  });

  it('支持未信任普通目录交互式信任引导、start 轮次内实时 select 审批闭环，以及缺参/越界序号安全拦截', async () => {
    const homeDir = makeTempDir('kpbl-cli-ext-interactive-home-');
    const untrustedRepo = makeTempDir('kpbl-cli-ext-untrusted-repo-');
    const settings = createUserSettingsSkeleton();

    const external = new ExternalSessionService({ homeDir });
    services.push(external);
    external.saveCustomHarness({
      id: 'cli-apr-acp',
      name: 'CLI Approval ACP',
      command: process.execPath,
      args: [fakeAcpScript, '--mode=normal'],
      flavor: 'opencode',
      enabled: true,
    });

    const logs: string[] = [];
    const errors: string[] = [];
    let confirmCalls = 0;
    let selectCalls = 0;

    const dispatcher = createDefaultCommandDispatcher();
    const ctx: CommandContext = {
      session: { isBusy: () => false } as unknown as CommandContext['session'],
      settings,
      homeDir,
      projectRoot: untrustedRepo,
      external,
      confirm: async () => {
        confirmCalls += 1;
        return true;
      },
      select: async (config) => {
        selectCalls += 1;
        const allowSession = config.options.find((o) => String(o.value) === 'allow-session');
        return (allowSession?.value ?? config.options[0]?.value ?? null) as never;
      },
      output: {
        log: (msg) => logs.push(msg),
        error: (msg) => errors.push(msg),
        write: (msg, stream) => (stream === 'stderr' ? errors : logs).push(msg),
      },
      onModelSwitched: () => {},
      onExit: () => {},
    };

    // 1. 缺参或未闭合引号不抛 TypeError 崩溃
    await dispatcher.dispatch('/external harness', ctx);
    await dispatcher.dispatch('/external start "unclosed', ctx);
    expect(logs.join('\n')).toContain('命令执行失败');
    logs.length = 0;

    // 2. 在未信任普通仓库执行 /external start：先触发 confirm 落盘信任，再在轮次内触发 select 实时审批
    await dispatcher.dispatch('/external start cli-apr-acp NEED_APPROVAL', ctx);
    expect(confirmCalls).toBe(1);
    expect(selectCalls).toBe(1);
    expect(logs.join('\n')).toContain('已信任工作区');
    expect(logs.join('\n')).toContain('执行完毕（allow-session）');
  });
});
