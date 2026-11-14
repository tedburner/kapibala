import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGlobalMcpConfigPath } from '@kiturone/kapibala-host/internal';
import { afterEach, expect, it } from 'vitest';
import { ResourceService } from '../src/agent-host/resource-service.js';
import { Workspaces } from '../src/agent-host/workspaces.js';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-desktop-resource-'));
  roots.push(root);
  const workspaces = new Workspaces(root);
  const workspace = workspaces.openDefault();
  return { root, workspaceId: workspace.id, service: new ResourceService(workspaces) };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

it('MCP 新增 → 校验拒绝 → 删除全链回读', () => {
  const { workspaceId, service } = fixture();
  // 空态
  expect(service.readMcp(workspaceId).servers).toEqual([]);
  // 新增 stdio
  const saved = service.saveMcpServer({
    workspaceId,
    draft: { name: 'local', type: 'stdio', command: 'node srv.js', args: ['--x'] },
  });
  const added = saved.servers.find((server) => server.name === 'local');
  expect(added?.enabled).toBe(true);
  expect(added?.type).toBe('stdio');
  // 非法配置被宿主层事务拒绝（http 缺 url 不满足传输必填），错误码保留
  expect(() =>
    service.saveMcpServer({ workspaceId, draft: { name: 'broken', type: 'http' } }),
  ).toThrow(/MCP_CONFIG_INVALID/);
  // 改名编辑保留启停字段
  service.toggleMcpServer({ workspaceId, name: 'local', enabled: false });
  const renamed = service.saveMcpServer({
    workspaceId,
    editName: 'local',
    draft: { name: 'renamed', type: 'stdio', command: 'node srv2.js' },
  });
  expect(renamed.servers.find((server) => server.name === 'renamed')?.enabled).toBe(false);
  expect(renamed.servers.find((server) => server.name === 'local')).toBeUndefined();
  // 删除回读空
  const after = service.deleteMcpServer({ workspaceId, name: 'renamed' });
  expect(after.servers).toEqual([]);
  // 项目级只读：未在全局配置的服务删除被拒
  expect(() => service.deleteMcpServer({ workspaceId, name: 'ghost' })).toThrow(
    /MCP_SERVER_NOT_FOUND/,
  );
});

it('toggle 写回 enabled 字段并保留其余声明原文', () => {
  const { workspaceId, service, root } = fixture();
  service.saveMcpServer({
    workspaceId,
    draft: { name: 'local', type: 'stdio', command: 'node srv.js', args: ['--flag'] },
  });
  service.toggleMcpServer({ workspaceId, name: 'local', enabled: false });
  // 直接读宿主层事务产物：args 等面板外字段必须原样保留
  const file = JSON.parse(fs.readFileSync(getGlobalMcpConfigPath(root), 'utf8')) as {
    mcpServers: Record<string, { enabled?: boolean; args?: string[] }>;
  };
  expect(file.mcpServers.local?.enabled).toBe(false);
  expect(file.mcpServers.local?.args).toEqual(['--flag']);
  const snapshot = service.readMcp(workspaceId);
  expect(snapshot.servers.find((server) => server.name === 'local')?.enabled).toBe(false);
});

it('keepTransport 编辑保留原传输声明原文，仅改名与启停', () => {
  const { workspaceId, service, root } = fixture();
  service.saveMcpServer({
    workspaceId,
    draft: { name: 'local', type: 'stdio', command: 'node srv.js', args: ['--flag'] },
  });
  // 干净声明提供未脱敏编辑面，正常编辑路径据此无损回填
  const snapshot = service.readMcp(workspaceId);
  expect(snapshot.servers.find((server) => server.name === 'local')?.edit).toEqual({
    command: 'node srv.js',
    args: ['--flag'],
  });
  // keepTransport：draft.type 与缺失的传输字段不得覆盖原声明（防脱敏摘要回写损坏配置）
  const renamed = service.saveMcpServer({
    workspaceId,
    editName: 'local',
    keepTransport: true,
    draft: { name: 'renamed', type: 'http' },
  });
  expect(renamed.servers.find((server) => server.name === 'renamed')?.enabled).toBe(true);
  const file = JSON.parse(fs.readFileSync(getGlobalMcpConfigPath(root), 'utf8')) as {
    mcpServers: Record<string, { type?: string; command?: string; args?: string[]; url?: string }>;
  };
  expect(file.mcpServers.renamed?.type).toBe('stdio');
  expect(file.mcpServers.renamed?.command).toBe('node srv.js');
  expect(file.mcpServers.renamed?.args).toEqual(['--flag']);
  expect(file.mcpServers.renamed?.url).toBeUndefined();
});

it('Skills 开关与逐技能禁用走配置事务并回读', async () => {
  const { workspaceId, service, root } = fixture();
  // 默认空间根下放一个全局技能目录（home 即 fixture root）
  const home = root;
  const skillDir = path.join(home, '.kapibala/skills/demo-skill');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    '---\nname: demo-skill\ndescription: 演示技能\n---\nBody.',
  );
  const enabled = await service.setSkillsEnabled({ workspaceId, enabled: false });
  expect(enabled.enabled).toBe(false);
  const listed = await service.readSkills(workspaceId);
  expect(listed.skills.some((skill) => skill.name === 'demo-skill')).toBe(true);
  const disabled = await service.setSkillDisabled({
    workspaceId,
    name: 'demo-skill',
    disabled: true,
  });
  expect(disabled.skills.find((skill) => skill.name === 'demo-skill')?.disabled).toBe(true);
  const restored = await service.setSkillDisabled({
    workspaceId,
    name: 'demo-skill',
    disabled: false,
  });
  expect(restored.skills.find((skill) => skill.name === 'demo-skill')?.disabled).toBe(false);
  const reEnabled = await service.setSkillsEnabled({ workspaceId, enabled: true });
  expect(reEnabled.enabled).toBe(true);
});
