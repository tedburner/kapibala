import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '@kiturone/kapibala';
import { createUserSettingsSkeleton } from '@kiturone/kapibala-host/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandOutput } from '../src/command-output.js';
import { COMMAND_CATALOG } from '../src/commands/catalog.js';
import type { CommandContext } from '../src/commands/dispatcher.js';
import { CommandDispatcher } from '../src/commands/dispatcher.js';
import { mcpCommand, parseMcpConfigArgs } from '../src/commands/mcp.js';

const dirs: string[] = [];
const originalEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
beforeEach(() => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-mcp-home-'));
  dirs.push(home);
  process.env.USERPROFILE = home;
  process.env.HOME = home;
});
afterEach(() => {
  process.env.USERPROFILE = originalEnv.USERPROFILE;
  process.env.HOME = originalEnv.HOME;
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const homeDir = (): string => dirs[dirs.length - 1]!;
function tempProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-mcp-project-'));
  dirs.push(dir);
  return fs.realpathSync.native(dir);
}

function output(): CommandOutput & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: (message) => lines.push(message),
    error: (message) => lines.push(message),
    write: (text) => lines.push(text),
  };
}

function context(projectRoot?: string, trusted = false): CommandContext & { out: string[] } {
  const out = output();
  const settings = createUserSettingsSkeleton();
  if (projectRoot && trusted) settings.trustedProjects = [projectRoot];
  return {
    session: { isBusy: () => false } as unknown as AgentSession,
    settings,
    output: out,
    onModelSwitched: () => {},
    onExit: () => {},
    projectRoot,
    out: out.lines,
  };
}

function readGlobalConfig(): { mcpServers?: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(path.join(homeDir(), '.kapibala', 'mcp.json'), 'utf8')) as {
    mcpServers?: Record<string, unknown>;
  };
}

describe('parseMcpConfigArgs', () => {
  it('解析 stdio / http 选项与重复参数', () => {
    const stdio = parseMcpConfigArgs([
      'demo',
      '--transport',
      'stdio',
      '--command',
      'npx',
      '--arg',
      '-y',
      '--arg',
      'pkg',
      '--env',
      'TOKEN=a=b',
    ]);
    expect(stdio.options).toEqual({
      scope: 'global',
      transport: 'stdio',
      command: 'npx',
      args: ['-y', 'pkg'],
      env: { TOKEN: 'a=b' },
      headers: {},
      disabled: false,
      enabled: false,
    });
    const http = parseMcpConfigArgs(['api', '--url', 'https://x.test/mcp', '--header', 'X-Key=v']);
    expect(http.options?.headers).toEqual({ 'X-Key': 'v' });
    expect(parseMcpConfigArgs(['demo', '--project']).options?.scope).toBe('project');
  });
  it('拒绝未知选项、非法键与缺值', () => {
    expect(parseMcpConfigArgs(['demo', '--nope']).error).toContain('未知选项');
    expect(parseMcpConfigArgs(['demo', '--env', '1BAD=1']).error).toContain('非法环境变量名');
    expect(parseMcpConfigArgs(['demo', '--env', 'NOVALUE']).error).toContain('KEY=VALUE');
    expect(parseMcpConfigArgs(['demo', '--transport', 'sse']).error).toContain('stdio 或 http');
  });
  it('未知选项提示空白切分限制，--enabled 与 --disabled 互斥', () => {
    // 分发器按空白切分，含空格的值必然碎成未知 token；错误信息必须指路其他编辑通道。
    const unknown = parseMcpConfigArgs(['demo', '--env', 'MSG=hello', 'world']);
    expect(unknown.error).toContain('未知选项: world');
    expect(unknown.error).toContain('空白切分');
    expect(unknown.error).toContain('mcp.json');
    const both = parseMcpConfigArgs(['demo', '--enabled', '--disabled']);
    expect(both.error).toContain('--enabled 与 --disabled 不能同时使用');
    const single = parseMcpConfigArgs(['demo', '--disabled']);
    expect(single.error).toBeUndefined();
  });
});

describe('/mcp 配置命令', () => {
  it('add 写入全局 mcp.json，重复 add 明确失败', async () => {
    const ctx = context();
    await mcpCommand(
      [
        'add',
        'demo',
        '--transport',
        'stdio',
        '--command',
        'npx',
        '--arg',
        '-y',
        '--env',
        'TOKEN=1',
      ],
      ctx,
    );
    expect(ctx.out.join('\n')).toContain('已写入全局 MCP 配置');
    expect(readGlobalConfig().mcpServers?.demo).toMatchObject({
      type: 'stdio',
      command: 'npx',
      args: ['-y'],
      env: { TOKEN: '1' },
    });

    const duplicate = context();
    await mcpCommand(['add', 'demo', '--command', 'other'], duplicate);
    expect(duplicate.out.join('\n')).toContain('已存在');
    expect(readGlobalConfig().mcpServers?.demo).toMatchObject({ command: 'npx' });
  });

  it('edit 只改传入字段并保留其余配置', async () => {
    const ctx = context();
    await mcpCommand(['add', 'demo', '--command', 'npx', '--arg', '-y'], ctx);
    const edited = context();
    await mcpCommand(['edit', 'demo', '--command', 'uvx', '--env', 'A=1'], edited);
    expect(readGlobalConfig().mcpServers?.demo).toMatchObject({
      command: 'uvx',
      args: ['-y'],
      env: { A: '1' },
    });
    const disabled = context();
    await mcpCommand(['edit', 'demo', '--disabled'], disabled);
    expect(readGlobalConfig().mcpServers?.demo).toMatchObject({ enabled: false });
  });

  it('remove 移除声明，未知名称失败', async () => {
    await mcpCommand(['add', 'demo', '--command', 'npx'], context());
    const removed = context();
    await mcpCommand(['remove', 'demo'], removed);
    expect(readGlobalConfig().mcpServers ?? {}).toEqual({});
    const missing = context();
    await mcpCommand(['remove', 'demo'], missing);
    expect(missing.out.join('\n')).toContain('不存在');
  });

  it('未信任项目拒绝项目级写入，已信任项目写入项目文件', async () => {
    const project = tempProject();
    const untrusted = context(project, false);
    await mcpCommand(['add', 'demo', '--command', 'npx', '--project'], untrusted);
    expect(untrusted.out.join('\n')).toContain('项目未被信任');
    expect(fs.existsSync(path.join(project, '.kapibala', 'mcp.json'))).toBe(false);

    const trusted = context(project, true);
    await mcpCommand(['add', 'demo', '--command', 'npx', '--project'], trusted);
    const file = path.join(project, '.kapibala', 'mcp.json');
    expect(fs.existsSync(file)).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers.demo.command).toBe('npx');
  });

  it('http 传输必须有 url', async () => {
    const ctx = context();
    await mcpCommand(['add', 'api', '--transport', 'http'], ctx);
    expect(ctx.out.join('\n')).toContain('--url');
    expect(fs.existsSync(path.join(homeDir(), '.kapibala', 'mcp.json'))).toBe(false);
  });

  // 回归：跨传输字段曾静默丢弃（http 忽略 --env、stdio 忽略 --header），现在必须显式报错并列出被拒字段。
  it('跨传输字段显式报错，不静默丢弃也不改写原配置', async () => {
    const ctx = context();
    await mcpCommand(
      ['add', 'api', '--transport', 'http', '--url', 'https://x.test/mcp', '--env', 'A=1'],
      ctx,
    );
    expect(ctx.out.join('\n')).toContain('http 传输不接受 --env');
    expect(fs.existsSync(path.join(homeDir(), '.kapibala', 'mcp.json'))).toBe(false);

    await mcpCommand(['add', 'demo', '--command', 'npx', '--arg', '-y'], context());
    const edit = context();
    await mcpCommand(['edit', 'demo', '--header', 'X-Key=1'], edit);
    expect(edit.out.join('\n')).toContain('stdio 传输不接受 --header');
    expect(edit.out.join('\n')).toContain('/mcp remove');
    expect(readGlobalConfig().mcpServers?.demo).toMatchObject({ command: 'npx', args: ['-y'] });
  });

  // 回归：edit stdio 传 --url 曾隐式转 http 并静默丢掉 command/args/env；转换保留但必须明示。
  it('edit stdio 传 --url 显式转为 http，成功输出明示旧字段已移除', async () => {
    await mcpCommand(
      ['add', 'demo', '--command', 'npx', '--arg', '-y', '--env', 'TOKEN=1'],
      context(),
    );
    const ctx = context();
    await mcpCommand(['edit', 'demo', '--url', 'https://x.test/mcp'], ctx);
    const text = ctx.out.join('\n');
    expect(text).toContain('已写入全局 MCP 配置');
    expect(text).toContain('已从 stdio 转为 http，原 command/args/env 已移除');
    const config = readGlobalConfig().mcpServers?.demo as Record<string, unknown>;
    expect(config).toMatchObject({ type: 'http', url: 'https://x.test/mcp' });
    expect(config.command).toBeUndefined();
    expect(config.args).toBeUndefined();
    expect(config.env).toBeUndefined();
  });

  // 设计 011 D4：批准界面不打印密文。redactCommonSecrets 拦不住 `--token abc123` 空格传参，
  // 批准输出必须对凭据语义 flag 的后继参数整值替换为 [REDACTED]。
  it('approve 输出对空格分隔的凭据 flag 脱敏', async () => {
    await mcpCommand(
      [
        'add',
        'demo',
        '--command',
        'node',
        '--arg',
        'server.js',
        '--arg',
        '--token',
        '--arg',
        'abc123',
        '--env',
        'TOKEN=1',
      ],
      context(),
    );
    const approved = context();
    await mcpCommand(['approve', 'demo'], approved);
    const text = approved.out.join('\n');
    expect(text).toContain('--token [REDACTED]');
    expect(text).not.toContain('abc123');
    expect(text).not.toContain('TOKEN=1');
    expect(text).toContain('env:TOKEN');
  });

  it('approve 绑定当前配置摘要，配置变化后摘要随之改变', async () => {
    await mcpCommand(['add', 'demo', '--command', 'npx', '--env', 'TOKEN=1'], context());
    const approved = context();
    await mcpCommand(['approve', 'demo'], approved);
    expect(approved.out.join('\n')).toContain("已批准 MCP 服务 'demo'");
    expect(approved.out.join('\n')).toContain('env:TOKEN');
    expect(approved.out.join('\n')).not.toContain('TOKEN=1');
    expect(approved.out.join('\n')).not.toContain('TOKEN: 1');
    const file = path.join(homeDir(), '.kapibala', 'mcp-approvals.json');
    const first = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      approvals: Record<string, { digest: string }>;
    };
    expect(Object.keys(first.approvals)).toEqual(['global:demo']);

    await mcpCommand(['edit', 'demo', '--env', 'TOKEN=2'], context());
    await mcpCommand(['approve', 'demo'], context());
    const second = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      approvals: Record<string, { digest: string }>;
    };
    expect(second.approvals['global:demo']?.digest).not.toBe(
      first.approvals['global:demo']?.digest,
    );

    const revoked = context();
    await mcpCommand(['revoke', 'demo'], revoked);
    expect(revoked.out.join('\n')).toContain('已撤销');
    const cleared = JSON.parse(fs.readFileSync(file, 'utf8')) as { approvals: object };
    expect(cleared.approvals).toEqual({});
  });

  it('approve 未知服务明确失败，不创建批准记录', async () => {
    const ctx = context();
    await mcpCommand(['approve', 'missing'], ctx);
    expect(ctx.out.join('\n')).toContain('未知 MCP 服务');
    expect(fs.existsSync(path.join(homeDir(), '.kapibala', 'mcp-approvals.json'))).toBe(false);
  });

  // 回归：approve/revoke 必须经 COMMAND_CATALOG 的 validate 白名单到达 handler。
  // 直接调用 mcpCommand 绕过了 catalog 校验，曾导致两子命令在真实分发路径不可达。
  it('/mcp approve|revoke 经 dispatcher 真实分发路径可达', async () => {
    const dispatcher = new CommandDispatcher();
    dispatcher.registerDefinition(
      COMMAND_CATALOG.find((definition) => definition.name === 'mcp')!,
      mcpCommand,
    );
    const approved = context();
    await dispatcher.dispatch('/mcp approve missing', approved);
    expect(approved.out.join('\n')).toContain('未知 MCP 服务');
    expect(approved.out.join('\n')).not.toContain('命令执行失败');

    const revoked = context();
    await dispatcher.dispatch('/mcp revoke missing', revoked);
    expect(revoked.out.join('\n')).toContain('未找到');

    // 参数缺失仍被 validate 拦下，给出与 handler 一致的用法提示。
    const bare = context();
    await dispatcher.dispatch('/mcp approve', bare);
    expect(bare.out.join('\n')).toContain('命令执行失败: 用法: /mcp approve');
  });
});
