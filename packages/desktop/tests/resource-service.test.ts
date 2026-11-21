import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getGlobalMcpConfigPath, getProjectMcpConfigPath } from '@kiturone/kapibala-host/internal';
import { afterEach, expect, it } from 'vitest';
import { ResourceService } from '../src/agent-host/resource-service.js';
import { Workspaces } from '../src/agent-host/workspaces.js';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-desktop-resource-'));
  roots.push(root);
  const workspaces = new Workspaces(root);
  const workspace = workspaces.openDefault();
  return { root, workspaceId: workspace.id, service: new ResourceService(workspaces), workspaces };
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

it('inspectSkills 预览候选，importSkills 归一后落盘并可回读', async () => {
  const { workspaceId, service, root } = fixture();
  const source = path.join(root, '.claude/skills/imported-skill');
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(
    path.join(source, 'SKILL.md'),
    '---\nname: imported-skill\ndescription: 导入演示\nmodel: claude-3\n---\nBody.',
  );
  const scan = await service.inspectSkills(workspaceId);
  const candidate = scan.candidates.find((item) => item.name === 'imported-skill');
  expect(candidate?.harness).toBe('claude-code');
  expect(candidate?.strippedFields).toContain('model');
  const result = await service.importSkills({
    workspaceId,
    scope: 'global',
    items: [
      {
        harness: 'claude-code',
        name: 'imported-skill',
        expectedSourceRef: candidate!.sourceRef,
      },
    ],
  });
  expect(result.imported).toBe(1);
  const target = path.join(root, '.kapibala/skills/imported-skill/SKILL.md');
  expect(fs.readFileSync(target, 'utf8')).not.toContain('model:');
  const listed = await service.readSkills(workspaceId);
  expect(listed.skills.some((skill) => skill.name === 'imported-skill')).toBe(true);

  // 同名再次导入默认跳过冲突；来源身份不一致时拒绝，不写盘。
  const again = await service.importSkills({
    workspaceId,
    scope: 'global',
    items: [
      {
        harness: 'claude-code',
        name: 'imported-skill',
        expectedSourceRef: candidate!.sourceRef,
      },
    ],
  });
  expect(again.unchanged).toBe(1);
  const stale = await service.importSkills({
    workspaceId,
    scope: 'global',
    items: [
      {
        harness: 'claude-code',
        name: 'imported-skill',
        expectedSourceRef: path.join(root, '.claude/skills/other'),
      },
    ],
  });
  expect(stale.failed).toBe(1);
});

it('项目级 MCP 写入在受信项目上可写，未信任项目直接拒绝', () => {
  const { root, workspaceId, service, workspaces } = fixture();
  // 默认空间由应用创建并已写入信任，因此项目级写入可用
  const saved = service.saveMcpServer({
    workspaceId,
    scope: 'project',
    draft: { name: 'project-server', type: 'stdio', command: 'node proj.js', args: ['--p'] },
  });
  const created = saved.servers.find((server) => server.name === 'project-server');
  expect(created?.source).toBe('project');
  expect(created?.edit).toEqual({ command: 'node proj.js', args: ['--p'] });
  const projectRoot = workspaces.get(workspaceId).root;
  const projectFile = JSON.parse(fs.readFileSync(getProjectMcpConfigPath(projectRoot), 'utf8')) as {
    mcpServers: Record<string, { command?: string; enabled?: boolean }>;
  };
  expect(projectFile.mcpServers['project-server']?.command).toBe('node proj.js');

  // 启停与删除同样作用于项目级文件
  service.toggleMcpServer({
    workspaceId,
    scope: 'project',
    name: 'project-server',
    enabled: false,
  });
  expect(service.readMcp(workspaceId).servers[0]?.enabled).toBe(false);
  service.deleteMcpServer({ workspaceId, scope: 'project', name: 'project-server' });
  expect(service.readMcp(workspaceId).servers).toEqual([]);

  // 未信任项目：写入口由宿主事务拒绝，且不创建项目 mcp.json
  const untrustedRoot = path.join(root, 'untrusted-project');
  fs.mkdirSync(untrustedRoot, { recursive: true });
  const untrusted = workspaces.registerProject(untrustedRoot);
  expect(untrusted.trusted).toBe(false);
  expect(() =>
    service.saveMcpServer({
      workspaceId: untrusted.id,
      scope: 'project',
      draft: { name: 'blocked', type: 'stdio', command: 'node blocked.js' },
    }),
  ).toThrow(/MCP_PROJECT_UNTRUSTED/);
  expect(fs.existsSync(getProjectMcpConfigPath(untrusted.root))).toBe(false);
  expect(() => service.inspectMcpImport({ workspaceId: untrusted.id, scope: 'project' })).toThrow(
    /MCP_PROJECT_UNTRUSTED/,
  );
});

it('逐服务器批准随配置摘要失效，撤销后回到待批准', () => {
  const { workspaceId, service } = fixture();
  service.saveMcpServer({
    workspaceId,
    draft: { name: 'local', type: 'stdio', command: 'node srv.js' },
  });
  const pending = service.readMcp(workspaceId).servers.find((server) => server.name === 'local');
  expect(pending?.approval).toEqual({ approved: false });

  const approved = service
    .approveMcpServer({ workspaceId, name: 'local' })
    .servers.find((server) => server.name === 'local');
  expect(approved?.approval?.approved).toBe(true);
  expect(approved?.approval?.approvedAt).toBeTruthy();

  // 配置字段变化 → 旧批准失效，但保留批准时间用于提示「需重新批准」
  const changed = service
    .saveMcpServer({
      workspaceId,
      editName: 'local',
      draft: { name: 'local', type: 'stdio', command: 'node srv2.js' },
    })
    .servers.find((server) => server.name === 'local');
  expect(changed?.approval?.approved).toBe(false);
  expect(changed?.approval?.approvedAt).toBeTruthy();

  const revoked = service
    .revokeMcpServer({ workspaceId, name: 'local' })
    .servers.find((server) => server.name === 'local');
  expect(revoked?.approval).toEqual({ approved: false });
  expect(() => service.approveMcpServer({ workspaceId, name: 'ghost' })).toThrow(
    /MCP_SERVER_NOT_FOUND/,
  );
});

it('inspectMcpImport 只返回脱敏投影，importMcp 落盘后可见且二次导入不变', () => {
  const { root, workspaceId, service } = fixture();
  fs.writeFileSync(
    path.join(root, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        imported: {
          command: 'node',
          args: ['srv.js'],
          env: { API_TOKEN: 'secret-value' },
          disabled: true,
        },
      },
    }),
  );
  const scan = service.inspectMcpImport({ workspaceId });
  const candidate = scan.candidates.find((item) => item.name === 'imported');
  expect(candidate?.harness).toBe('claude-code');
  expect(candidate?.target).toBe('node srv.js');
  expect(candidate?.hasSecretSurface).toBe(true);
  expect(candidate?.strippedFields).toContain('disabled');
  // 完整配置（含 env 值）绝不能进入渲染层
  expect(Object.keys(candidate ?? {})).not.toContain('config');
  expect(Object.keys(candidate ?? {})).not.toContain('configDigest');
  expect(JSON.stringify(scan)).not.toContain('secret-value');

  const result = service.importMcp({
    workspaceId,
    scope: 'global',
    items: [
      {
        harness: 'claude-code',
        name: 'imported',
        expectedSourceRef: candidate!.sourceRef,
      },
    ],
  });
  expect(result.imported).toBe(1);
  const target = JSON.parse(fs.readFileSync(getGlobalMcpConfigPath(root), 'utf8')) as {
    mcpServers: Record<string, { env?: Record<string, string> }>;
  };
  expect(target.mcpServers.imported?.env?.API_TOKEN).toBe('secret-value');
  expect(service.readMcp(workspaceId).servers.some((server) => server.name === 'imported')).toBe(
    true,
  );

  // 第二次导入内容一致 → unchanged；来源身份不一致 → failed
  const again = service.importMcp({
    workspaceId,
    scope: 'global',
    items: [
      {
        harness: 'claude-code',
        name: 'imported',
        expectedSourceRef: candidate!.sourceRef,
      },
    ],
  });
  expect(again.unchanged).toBe(1);
  const stale = service.importMcp({
    workspaceId,
    scope: 'global',
    items: [
      {
        harness: 'claude-code',
        name: 'imported',
        expectedSourceRef: path.join(root, '.claude-other.json'),
      },
    ],
  });
  expect(stale.failed).toBe(1);
});
