import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digestServerConfig } from '../src/host/resource/mcp-approval.js';
import {
  MCP_PROVENANCE_FILE,
  importMcpServers,
  readImportedMcpProvenance,
  scanImportableMcpServers,
} from '../src/host/resource/mcp-import.js';

const dirs: string[] = [];
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** 写入 JSON 文件并自动创建父目录。 */
function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** Linux 平台的 Claude Desktop 配置路径；测试用固定平台避免受宿主机影响。 */
function claudeDesktopConfig(home: string): string {
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

const base = { projectTrusted: false, platform: 'linux' as const };

describe('scanImportableMcpServers', () => {
  it('识别 Claude Desktop 的 stdio 声明并脱敏目标', () => {
    const home = temp('kpbl-mcp-import-desktop-');
    const project = temp('kpbl-mcp-import-desktop-proj-');
    writeJson(claudeDesktopConfig(home), {
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
          env: { API_KEY: 'sk-secret' },
        },
      },
    });
    const scan = scanImportableMcpServers({ homeDir: home, projectRoot: project, ...base });
    const candidate = scan.candidates.find((item) => item.name === 'filesystem');
    expect(candidate?.harness).toBe('claude-desktop');
    expect(candidate?.transport).toBe('stdio');
    expect(candidate?.target).toBe('npx -y @modelcontextprotocol/server-filesystem /tmp');
    expect(candidate?.hasSecretSurface).toBe(true);
    expect(candidate?.config).toEqual({
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { API_KEY: 'sk-secret' },
    });
    expect(candidate?.conflict).toBe('none');
    expect(candidate?.nameProblem).toBeUndefined();
  });

  it('识别 Claude Code 的用户级、项目级与项目 .mcp.json 三个位置', () => {
    const home = temp('kpbl-mcp-import-cc-');
    const project = temp('kpbl-mcp-import-cc-proj-');
    writeJson(path.join(home, '.claude.json'), {
      mcpServers: { globalTool: { command: 'node', args: ['global.js'] } },
      projects: {
        [project]: { mcpServers: { projectTool: { command: 'node', args: ['p.js'] } } },
      },
    });
    writeJson(path.join(project, '.mcp.json'), {
      mcpServers: { fileTool: { command: 'python', args: ['tool.py'] } },
    });
    const scan = scanImportableMcpServers({
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      platform: 'linux',
    });
    const byName = new Map(scan.candidates.map((item) => [item.name, item]));
    expect(byName.get('globalTool')?.origin).toBe('global');
    expect(byName.get('projectTool')?.origin).toBe('project');
    expect(byName.get('fileTool')?.origin).toBe('project');
    expect(byName.get('fileTool')?.config).toMatchObject({ command: 'python', args: ['tool.py'] });
  });

  it('识别 Cursor 的 url 声明并折叠为 http 传输', () => {
    const home = temp('kpbl-mcp-import-cursor-');
    const project = temp('kpbl-mcp-import-cursor-proj-');
    writeJson(path.join(home, '.cursor', 'mcp.json'), {
      mcpServers: {
        remote: { url: 'https://example.test/mcp', headers: { Authorization: 'Bearer abc' } },
      },
    });
    const scan = scanImportableMcpServers({ homeDir: home, projectRoot: project, ...base });
    const candidate = scan.candidates.find((item) => item.name === 'remote');
    expect(candidate?.transport).toBe('http');
    expect(candidate?.target).toBe('https://example.test/mcp');
    expect(candidate?.hasSecretSurface).toBe(true);
    expect(candidate?.config).toEqual({
      type: 'http',
      url: 'https://example.test/mcp',
      headers: { Authorization: 'Bearer abc' },
    });
  });

  it('未信任项目不扫描仓库内的 .mcp.json 与 .cursor/mcp.json', () => {
    const home = temp('kpbl-mcp-import-untrusted-');
    const project = temp('kpbl-mcp-import-untrusted-proj-');
    writeJson(path.join(project, '.mcp.json'), {
      mcpServers: { repo: { command: 'sh', args: ['-c', 'echo hi'] } },
    });
    writeJson(path.join(project, '.cursor', 'mcp.json'), {
      mcpServers: { repoCursor: { command: 'sh' } },
    });
    const scan = scanImportableMcpServers({ homeDir: home, projectRoot: project, ...base });
    expect(scan.candidates).toHaveLength(0);
    expect(
      scan.sources.every((source) => source.files.every((file) => file.origin === 'global')),
    ).toBe(true);
  });

  it('非法的服务名与缺少传输字段的声明进入预览但标记为不可导入', () => {
    const home = temp('kpbl-mcp-import-invalid-');
    const project = temp('kpbl-mcp-import-invalid-proj-');
    writeJson(claudeDesktopConfig(home), {
      mcpServers: {
        'bad name': { command: 'node' },
        empty: { env: { A: 'b' } },
      },
    });
    const scan = scanImportableMcpServers({ homeDir: home, projectRoot: project, ...base });
    expect(scan.candidates.find((item) => item.name === 'bad name')?.nameProblem).toBeTruthy();
    expect(scan.candidates.find((item) => item.name === 'empty')?.configDigest).toBe('');
  });

  it('来源 JSON 损坏时只记诊断，不影响其它来源', () => {
    const home = temp('kpbl-mcp-import-corrupt-src-');
    const project = temp('kpbl-mcp-import-corrupt-src-proj-');
    fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(home, '.cursor', 'mcp.json'), '{not json', 'utf8');
    writeJson(claudeDesktopConfig(home), {
      mcpServers: { ok: { command: 'node' } },
    });
    const scan = scanImportableMcpServers({ homeDir: home, projectRoot: project, ...base });
    expect(scan.candidates.map((item) => item.name)).toEqual(['ok']);
    expect(scan.diagnostics.some((item) => item.code === 'MCP_IMPORT_SOURCE_UNREADABLE')).toBe(
      true,
    );
  });
});

describe('importMcpServers', () => {
  it('把来源写入全局配置并记录溯源', () => {
    const home = temp('kpbl-mcp-import-run-');
    const project = temp('kpbl-mcp-import-run-proj-');
    writeJson(claudeDesktopConfig(home), {
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', 'server'], env: { TOKEN: 'x' } },
      },
    });
    const result = importMcpServers({ homeDir: home, projectRoot: project, ...base });
    expect(result.imported).toBe(1);
    expect(result.items[0]?.status).toBe('imported');
    const config = readJson(path.join(home, '.kapibala', 'mcp.json')) as {
      mcpServers: Record<string, unknown>;
    };
    expect(config.mcpServers.filesystem).toMatchObject({
      command: 'npx',
      args: ['-y', 'server'],
      env: { TOKEN: 'x' },
    });
    const provenance = readImportedMcpProvenance({ homeDir: home, scope: 'global' });
    expect(provenance.filesystem?.harness).toBe('claude-desktop');
    expect(provenance.filesystem?.sourceRef).toBe(claudeDesktopConfig(home));
    expect(provenance.filesystem?.installedDigest).toMatch(/^sha256:/);
    expect(fs.existsSync(path.join(home, '.kapibala', MCP_PROVENANCE_FILE))).toBe(true);
  });

  it('同名服务默认跳过，显式覆盖才替换', () => {
    const home = temp('kpbl-mcp-import-conflict-');
    const project = temp('kpbl-mcp-import-conflict-proj-');
    writeJson(path.join(home, '.kapibala', 'mcp.json'), {
      mcpServers: { filesystem: { command: 'old-binary' } },
    });
    writeJson(claudeDesktopConfig(home), {
      mcpServers: { filesystem: { command: 'new-binary' } },
    });
    const skipped = importMcpServers({ homeDir: home, projectRoot: project, ...base });
    expect(skipped.skippedConflict).toBe(1);
    expect(
      (
        readJson(path.join(home, '.kapibala', 'mcp.json')) as {
          mcpServers: Record<string, { command: string }>;
        }
      ).mcpServers.filesystem.command,
    ).toBe('old-binary');

    const replaced = importMcpServers({
      homeDir: home,
      projectRoot: project,
      overwrite: true,
      ...base,
    });
    expect(replaced.imported).toBe(1);
    expect(
      (
        readJson(path.join(home, '.kapibala', 'mcp.json')) as {
          mcpServers: Record<string, { command: string }>;
        }
      ).mcpServers.filesystem.command,
    ).toBe('new-binary');
  });

  it('目标内容一致时返回 unchanged 且不重写溯源时间', () => {
    const home = temp('kpbl-mcp-import-unchanged-');
    const project = temp('kpbl-mcp-import-unchanged-proj-');
    writeJson(claudeDesktopConfig(home), {
      mcpServers: { fs: { command: 'npx', args: ['-y', 'server'] } },
    });
    const first = importMcpServers({ homeDir: home, projectRoot: project, ...base });
    const installedAt = readImportedMcpProvenance({
      homeDir: home,
      scope: 'global',
    }).fs?.installedAt;
    const second = importMcpServers({ homeDir: home, projectRoot: project, ...base });
    expect(first.imported).toBe(1);
    expect(second.unchanged).toBe(1);
    expect(readImportedMcpProvenance({ homeDir: home, scope: 'global' }).fs?.installedAt).toBe(
      installedAt,
    );
  });

  it('未信任项目拒绝项目级导入，且不写入任何文件', () => {
    const home = temp('kpbl-mcp-import-scope-');
    const project = temp('kpbl-mcp-import-scope-proj-');
    writeJson(claudeDesktopConfig(home), { mcpServers: { fs: { command: 'npx' } } });
    expect(() =>
      importMcpServers({ homeDir: home, projectRoot: project, scope: 'project', ...base }),
    ).toThrow(/未信任/);
    expect(fs.existsSync(path.join(project, '.kapibala', 'mcp.json'))).toBe(false);
  });

  it('已信任项目可写入项目级配置与项目级溯源', () => {
    const home = temp('kpbl-mcp-import-project-');
    const project = temp('kpbl-mcp-import-project-proj-');
    writeJson(path.join(project, '.mcp.json'), {
      mcpServers: { repo: { command: 'node', args: ['server.js'] } },
    });
    const result = importMcpServers({
      homeDir: home,
      projectRoot: project,
      projectTrusted: true,
      scope: 'project',
      platform: 'linux',
    });
    expect(result.imported).toBe(1);
    expect(fs.existsSync(path.join(project, '.kapibala', 'mcp.json'))).toBe(true);
    const provenance = readImportedMcpProvenance({
      homeDir: home,
      projectRoot: project,
      scope: 'project',
    });
    expect(provenance.repo?.harness).toBe('claude-code');
    expect(fs.existsSync(path.join(home, '.kapibala', 'mcp.json'))).toBe(false);
  });

  it('目标配置损坏时整批失败，原文件不被覆盖', () => {
    const home = temp('kpbl-mcp-import-target-corrupt-');
    const project = temp('kpbl-mcp-import-target-corrupt-proj-');
    const target = path.join(home, '.kapibala', 'mcp.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{broken', 'utf8');
    writeJson(claudeDesktopConfig(home), { mcpServers: { fs: { command: 'npx' } } });
    const result = importMcpServers({ homeDir: home, projectRoot: project, ...base });
    expect(result.failed).toBe(1);
    expect(fs.readFileSync(target, 'utf8')).toBe('{broken');
    expect(fs.existsSync(path.join(home, '.kapibala', MCP_PROVENANCE_FILE))).toBe(false);
  });

  it('未审阅过的来源身份变化时拒绝导入', () => {
    const home = temp('kpbl-mcp-import-toctou-');
    const project = temp('kpbl-mcp-import-toctou-proj-');
    writeJson(claudeDesktopConfig(home), { mcpServers: { fs: { command: 'npx' } } });
    const scan = scanImportableMcpServers({ homeDir: home, projectRoot: project, ...base });
    const result = importMcpServers({
      homeDir: home,
      projectRoot: project,
      items: [
        {
          harness: 'claude-desktop',
          name: 'fs',
          expectedSourceRef: path.join(home, 'elsewhere.json'),
        },
      ],
      ...base,
    });
    expect(scan.candidates).toHaveLength(1);
    expect(result.failed).toBe(1);
    expect(fs.existsSync(path.join(home, '.kapibala', 'mcp.json'))).toBe(false);
  });

  it('导入成功后溯源文件与 mcp.json 一致（每条记录都能对上落盘配置）', () => {
    const home = temp('kpbl-mcp-import-consistency-');
    const project = temp('kpbl-mcp-import-consistency-proj-');
    writeJson(claudeDesktopConfig(home), {
      mcpServers: {
        alpha: { command: 'node', args: ['a.js'], env: { TOKEN: 'x' } },
        beta: { url: 'https://example.test/mcp' },
      },
    });
    const result = importMcpServers({ homeDir: home, projectRoot: project, ...base });
    expect(result.imported).toBe(2);
    const config = readJson(path.join(home, '.kapibala', 'mcp.json')) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const provenance = readImportedMcpProvenance({ homeDir: home, scope: 'global' });
    for (const [name, raw] of Object.entries(config.mcpServers)) {
      // 溯源摘要与落盘配置同源计算：两者逐条对得上，并发导入才不会溯源漂移。
      expect(provenance[name]?.installedDigest).toBe(digestServerConfig(raw as never));
    }
    expect(Object.keys(provenance).sort()).toEqual(Object.keys(config.mcpServers).sort());
  });

  it('配置锁被占用时整批失败，溯源文件不被触碰', () => {
    const home = temp('kpbl-mcp-import-busy-');
    const project = temp('kpbl-mcp-import-busy-proj-');
    const target = path.join(home, '.kapibala', 'mcp.json');
    const lock = path.join(home, '.kapibala', 'mcp.json.lock');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`, 'utf8');
    // 模拟另一宿主正在事务中持锁：导入必须整批失败且不产生任何伴生写入。
    fs.writeFileSync(lock, JSON.stringify({ owner: 'other-host', pid: 999999 }));
    writeJson(claudeDesktopConfig(home), { mcpServers: { fs: { command: 'npx' } } });
    const result = importMcpServers({ homeDir: home, projectRoot: project, ...base });
    expect(result.failed).toBe(1);
    expect(result.items[0]?.message).toContain('MCP_CONFIG_BUSY');
    expect(fs.readFileSync(target, 'utf8')).toBe(
      `${JSON.stringify({ mcpServers: {} }, null, 2)}\n`,
    );
    expect(fs.existsSync(path.join(home, '.kapibala', MCP_PROVENANCE_FILE))).toBe(false);
    expect(fs.existsSync(lock)).toBe(true);
  });
});
