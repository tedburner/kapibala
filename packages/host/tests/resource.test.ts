import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getGlobalMcpConfigPath,
  mutateGlobalMcpConfig,
  readMcpResourceSnapshot,
} from '../src/host/resource/mcp-config.js';
import { readSkillsResourceSnapshot } from '../src/host/resource/skills-catalog.js';
import { createUserSettingsSkeleton } from '../src/host/settings.js';

const dirs: string[] = [];
// 供脱敏断言使用的假密钥；分段拼接避免密钥扫描误报
const FAKE_TOKEN = ['sk', 'live', 'ABCDEFGHIJ1234567890'].join('-');
function temp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function writeSkill(root: string, name: string, frontmatter = ''): void {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Help with ${name}\n${frontmatter}---\nBody of ${name}.`,
  );
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('MCP resource snapshot', () => {
  it('空配置零开销：不产生服务器与诊断，不创建配置文件', () => {
    const home = temp('kpbl-res-mcp-empty-');
    const snapshot = readMcpResourceSnapshot({ homeDir: home, isProjectTrusted: false });
    expect(snapshot.servers).toEqual([]);
    expect(snapshot.diagnostics).toEqual([]);
    expect(fs.existsSync(getGlobalMcpConfigPath(home))).toBe(false);
  });

  it('全局清单展示类型/目标/启用状态，命令目标经脱敏', () => {
    const home = temp('kpbl-res-mcp-list-');
    const file = getGlobalMcpConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 假密钥在运行时拼接，避免源码出现可被识别的密钥字面量
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          local: { type: 'stdio', command: `node server.js --token ${FAKE_TOKEN}` },
          remote: { type: 'http', url: 'https://mcp.example.com/v1' },
          off: { type: 'stdio', command: 'echo hi', enabled: false },
        },
      }),
    );
    const snapshot = readMcpResourceSnapshot({ homeDir: home, isProjectTrusted: true });
    const byName = new Map(snapshot.servers.map((server) => [server.name, server]));
    expect(byName.get('local')?.enabled).toBe(true);
    expect(byName.get('local')?.target).not.toContain(FAKE_TOKEN);
    expect(byName.get('local')?.target).toContain('node server.js');
    // 目标串内嵌密钥触发脱敏：编辑面缺省，面板只能改名/启停，防掩码回写。
    expect(byName.get('local')?.edit).toBeUndefined();
    expect(byName.get('remote')?.type).toBe('http');
    expect(byName.get('remote')?.target).toBe('https://mcp.example.com/v1');
    // 干净 URL 提供未脱敏编辑面，编辑表单据此无损回填。
    expect(byName.get('remote')?.edit).toEqual({ url: 'https://mcp.example.com/v1' });
    // 禁用项的 normalize 配置剥离传输字段（纯禁用覆盖语义），编辑面随之缺省：
    // 启停不经过编辑表单，不受影响。
    expect(byName.get('off')?.enabled).toBe(false);
    expect(byName.get('off')?.edit).toBeUndefined();
  });

  it('未信任项目的声明以排除形态可见且不进入会话集合', () => {
    const home = temp('kpbl-res-mcp-untrust-');
    const project = temp('kpbl-res-mcp-proj-');
    fs.mkdirSync(path.join(project, '.kapibala'), { recursive: true });
    fs.writeFileSync(
      path.join(project, '.kapibala/mcp.json'),
      JSON.stringify({ mcpServers: { proj: { type: 'stdio', command: 'proj-cmd' } } }),
    );
    const untrusted = readMcpResourceSnapshot({
      homeDir: home,
      projectRoot: project,
      isProjectTrusted: false,
    });
    const excluded = untrusted.servers.find((server) => server.name === 'proj');
    expect(excluded).toBeDefined();
    expect(excluded?.source).toBe('project');
    expect(
      excluded?.diagnostics.some((diagnostic) => diagnostic.code === 'MCP_PROJECT_UNTRUSTED'),
    ).toBe(true);
    // 信任后同一声明进入生效集合且无排除诊断
    const trusted = readMcpResourceSnapshot({
      homeDir: home,
      projectRoot: project,
      isProjectTrusted: true,
    });
    const included = trusted.servers.find((server) => server.name === 'proj');
    expect(included?.enabled).toBe(true);
    expect(
      included?.diagnostics.some((diagnostic) => diagnostic.code === 'MCP_PROJECT_UNTRUSTED'),
    ).toBe(false);
  });

  it('配置损坏时快照携带诊断而非抛出', () => {
    const home = temp('kpbl-res-mcp-broken-');
    const file = getGlobalMcpConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ not json');
    const snapshot = readMcpResourceSnapshot({ homeDir: home, isProjectTrusted: true });
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(true);
  });
});

describe('mutateGlobalMcpConfig 短事务', () => {
  it('合法变更原子写回并保持 JSON 格式', () => {
    const home = temp('kpbl-res-mcp-tx-');
    mutateGlobalMcpConfig(
      (draft) => {
        draft.mcpServers = {
          ...(draft.mcpServers ?? {}),
          added: { type: 'stdio', command: 'node srv.js' },
        };
      },
      { homeDir: home },
    );
    const content = fs.readFileSync(getGlobalMcpConfigPath(home), 'utf8');
    expect(JSON.parse(content).mcpServers.added.command).toBe('node srv.js');
    expect(content.endsWith('\n')).toBe(true);
  });

  it('非法名称或非法配置拒绝整个事务且保留原文件', () => {
    const home = temp('kpbl-res-mcp-invalid-');
    mutateGlobalMcpConfig(
      (draft) => {
        draft.mcpServers = { base: { type: 'stdio', command: 'ok-cmd' } };
      },
      { homeDir: home },
    );
    const before = fs.readFileSync(getGlobalMcpConfigPath(home), 'utf8');
    expect(() =>
      mutateGlobalMcpConfig(
        (draft) => {
          draft.mcpServers = {
            base: { type: 'stdio', command: 'ok-cmd' },
            'bad name!': { type: 'stdio', command: 'x' },
          };
        },
        { homeDir: home },
      ),
    ).toThrow(/MCP_CONFIG_INVALID/);
    expect(() =>
      mutateGlobalMcpConfig(
        (draft) => {
          draft.mcpServers = { base: { type: 'http' } };
        },
        { homeDir: home },
      ),
    ).toThrow(/MCP_CONFIG_INVALID/);
    expect(fs.readFileSync(getGlobalMcpConfigPath(home), 'utf8')).toBe(before);
  });

  it('损坏文件拒绝写入而非静默重建', () => {
    const home = temp('kpbl-res-mcp-corrupt-');
    const file = getGlobalMcpConfigPath(home);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{ corrupt');
    expect(() => mutateGlobalMcpConfig(() => {}, { homeDir: home })).toThrow(/损坏/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{ corrupt');
  });

  it('并发竞争立即报 BUSY，不抢占他人锁', () => {
    const home = temp('kpbl-res-mcp-busy-');
    fs.mkdirSync(path.dirname(getGlobalMcpConfigPath(home)), { recursive: true });
    const lock = `${getGlobalMcpConfigPath(home)}.lock`;
    fs.writeFileSync(lock, JSON.stringify({ owner: 'someone-else', pid: 1 }));
    expect(() => mutateGlobalMcpConfig(() => {}, { homeDir: home })).toThrow(/MCP_CONFIG_BUSY/);
    // 他人锁保留现场
    expect(fs.existsSync(lock)).toBe(true);
  });

  it('纯禁用覆盖：禁用项无需传输字段即可通过校验', () => {
    const home = temp('kpbl-res-mcp-disable-');
    mutateGlobalMcpConfig(
      (draft) => {
        draft.mcpServers = { base: { type: 'stdio', command: 'ok-cmd' } };
      },
      { homeDir: home },
    );
    expect(() =>
      mutateGlobalMcpConfig(
        (draft) => {
          draft.mcpServers = { base: { enabled: false } };
        },
        { homeDir: home },
      ),
    ).not.toThrow();
    const snapshot = readMcpResourceSnapshot({ homeDir: home, isProjectTrusted: true });
    expect(snapshot.servers.find((server) => server.name === 'base')?.enabled).toBe(false);
  });
});

describe('skills resource snapshot', () => {
  it('清单与会话装配同源：全局技能可用、无效 frontmatter 进诊断', async () => {
    const home = temp('kpbl-res-skills-home-');
    const project = temp('kpbl-res-skills-proj-');
    writeSkill(path.join(home, '.kapibala/skills'), 'global-one');
    fs.mkdirSync(path.join(home, '.kapibala/skills/broken'), { recursive: true });
    fs.writeFileSync(path.join(home, '.kapibala/skills/broken/SKILL.md'), 'no frontmatter');
    const settings = createUserSettingsSkeleton();
    const snapshot = await readSkillsResourceSnapshot({
      settings,
      homeDir: home,
      projectRoot: project,
    });
    const good = snapshot.skills.find((skill) => skill.name === 'global-one');
    expect(good?.available).toBe(true);
    expect(good?.scope).toBe('global');
    expect(good?.description).toBe('Help with global-one');
    // 扫描器诊断统一 warn 级；断言损坏文件确实产生诊断而非被静默跳过
    expect(snapshot.diagnostics.some((diagnostic) => diagnostic.path.includes('broken'))).toBe(
      true,
    );
    // 同源：registry 根构造与 getCliSkillOptions 一致（全局根 trusted、项目根未信任）
    expect(
      snapshot.skills.every((skill) => skill.scope !== 'project' || skill.available === false),
    ).toBe(true);
  });

  it('逐技能禁用：目录内排除 + 目录外的禁用项兜底展示', async () => {
    const home = temp('kpbl-res-skills-disabled-');
    writeSkill(path.join(home, '.kapibala/skills'), 'kept');
    const settings = createUserSettingsSkeleton();
    settings.skills = { enabled: true, disabled: ['kept', 'ghost'] };
    const snapshot = await readSkillsResourceSnapshot({ settings, homeDir: home });
    const kept = snapshot.skills.find((skill) => skill.name === 'kept');
    expect(kept?.disabled).toBe(true);
    const ghost = snapshot.skills.find((skill) => skill.name === 'ghost');
    expect(ghost?.disabled).toBe(true);
    expect(ghost?.available).toBe(false);
  });

  it('全局开关关闭时快照如实反映，清单仍可查', async () => {
    const home = temp('kpbl-res-skills-off-');
    writeSkill(path.join(home, '.kapibala/skills'), 'still-listed');
    const settings = createUserSettingsSkeleton();
    settings.skills = { enabled: false };
    const snapshot = await readSkillsResourceSnapshot({ settings, homeDir: home });
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.skills.find((skill) => skill.name === 'still-listed')).toBeDefined();
  });
});
