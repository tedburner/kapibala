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
});
