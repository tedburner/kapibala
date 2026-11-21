import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '@kiturone/kapibala';
import { createUserSettingsSkeleton } from '@kiturone/kapibala-host/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CommandOutput } from '../src/command-output.js';
import type { CommandContext } from '../src/commands/dispatcher.js';
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
});
