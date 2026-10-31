import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { mutateGlobalSettings } from '../../cli/src/settings.js';
import { SettingsService } from '../src/agent-host/settings-service.js';
import { Workspaces } from '../src/agent-host/workspaces.js';

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-desktop-space-'));
  roots.push(root);
  return { root, workspaces: new Workspaces(root) };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
it('默认空间位于明确根且默认信任，信任记录写入全局配置与 CLI 共用', () => {
  const { root, workspaces } = fixture();
  execFileSync('git', ['init', '--quiet', root]);
  const workspace = workspaces.openDefault();
  expect(workspace.root).toBe(
    fs.realpathSync.native(path.join(root, '.kapibala/workspaces/default')),
  );
  // 默认空间由应用自有并默认信任：不需要确认即可打开会话，也不提升祖先 Git 根。
  expect(workspace.trusted).toBe(true);
  expect(workspaces.get(workspace.id).trusted).toBe(true);
  expect(workspaces.manager(workspace.id).project.projectRoot).toBe(workspace.root);
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.kapibala/settings.json'), 'utf8'));
  expect(stored.trustedProjects).toContain(workspace.root);
  // 祖先 Git 仓库不因此获得信任，项目信任确认语义保持独立。
  expect(stored.trustedProjects).not.toContain(fs.realpathSync.native(root));
});
it('默认目录文件占位或重定向不回退执行，也不先在外部创建 default', () => {
  const { root, workspaces } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-desktop-outside-'));
  roots.push(outside);
  fs.mkdirSync(path.join(root, '.kapibala'));
  fs.symlinkSync(
    outside,
    path.join(root, '.kapibala/workspaces'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(() => workspaces.openDefault()).toThrow('DEFAULT_WORKSPACE_UNAVAILABLE');
  expect(fs.existsSync(path.join(outside, 'default'))).toBe(false);
  fs.unlinkSync(path.join(root, '.kapibala/workspaces'));
  fs.writeFileSync(path.join(root, '.kapibala/workspaces'), 'occupied');
  expect(() => workspaces.openDefault()).toThrow();
  expect(fs.readFileSync(path.join(root, '.kapibala/workspaces'), 'utf8')).toBe('occupied');
});
it('配置目录被重定向时拒绝创建默认空间或写入信任', () => {
  const { root, workspaces } = fixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-desktop-outside-'));
  roots.push(outside);
  fs.symlinkSync(
    outside,
    path.join(root, '.kapibala'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  expect(() => workspaces.openDefault()).toThrow('DEFAULT_WORKSPACE_UNAVAILABLE');
  expect(fs.readdirSync(outside)).toEqual([]);
});
it('同组密钥值变化使预览冲突，未知字段更新不覆盖，公共设置不含已存凭证', () => {
  const { root, workspaces } = fixture();
  const service = new SettingsService(workspaces);
  const profile = {
    id: 'custom-fixture',
    name: 'Fixture',
    provider: 'openai-compatible' as const,
    baseURL: 'http://127.0.0.1:1/v1',
    apiKeyEnv: 'KPBL_FIXTURE',
    modelName: 'fixture',
    contextWindow: 32000,
  };
  const first = service.preview(profile);
  service.save(first.previewToken, 'first-private-key');
  const preview = service.preview(profile);
  mutateGlobalSettings(
    (raw) => {
      raw.profiles.find((item) => item.id === profile.id)!.apiKey = 'second-private-key';
    },
    { homeDir: root },
  );
  expect(() => service.save(preview.previewToken, 'third-private-key')).toThrow(
    'SETTINGS_CONFLICT',
  );
  const latest = service.preview(profile);
  mutateGlobalSettings(
    (raw) => {
      raw.trustedProjects = ['/another-writer'];
    },
    { homeDir: root },
  );
  service.save(latest.previewToken, 'third-private-key');
  const publicSettings = service.read();
  expect(JSON.stringify(publicSettings)).not.toMatch(
    /first-private-key|second-private-key|third-private-key/,
  );
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.kapibala/settings.json'), 'utf8'));
  expect(stored.trustedProjects).toEqual(['/another-writer']);
  expect(stored.profiles).toHaveLength(1);
});
it('项目专有凭证也必须从侧栏标题脱敏，环境端点变化使预览冲突', () => {
  const { root, workspaces } = fixture();
  const workspace = workspaces.openDefault();
  workspaces.confirm(workspace.id, workspace.trustToken, true);
  fs.mkdirSync(path.join(workspace.root, '.kapibala'));
  fs.writeFileSync(
    path.join(workspace.root, '.kapibala/settings.json'),
    JSON.stringify({
      profiles: [
        {
          id: 'project-key',
          name: 'Project',
          provider: 'openai-compatible',
          modelName: 'project',
          baseURL: 'http://127.0.0.1:1/v1',
          apiKeyEnv: 'PROJECT_ONLY',
          apiKey: 'project-only-private-value',
        },
      ],
    }),
  );
  const service = new SettingsService(workspaces);
  expect(service.redact('prefix project-only-private-value suffix', workspace.id)).not.toContain(
    'project-only-private-value',
  );
});
it('目标 ID 独立校验防止 editId 转移旧密钥，新端点预览不带旧内联凭证', () => {
  const { workspaces } = fixture();
  const service = new SettingsService(workspaces);
  const source = {
    id: 'source',
    name: 'Source',
    provider: 'openai-compatible' as const,
    modelName: 'fixture',
    baseURL: 'http://source.example/v1',
    apiKeyEnv: 'SOURCE',
    contextWindow: 32000,
  };
  const target = {
    ...source,
    id: 'target',
    name: 'Target',
    baseURL: 'http://target.example/v1',
    apiKeyEnv: 'TARGET',
  };
  service.save(service.preview(source).previewToken, 'source-private-key');
  service.save(service.preview(target).previewToken, 'target-private-key');
  expect(() => service.preview({ ...target, baseURL: 'http://new.example/v1' }, source.id)).toThrow(
    'SETTINGS_CONFLICT',
  );
  const copy = service.preview(
    { ...source, id: 'new-id', baseURL: 'http://new.example/v1' },
    source.id,
  );
  expect(copy.profile.credential.configured).toBe(false);
  expect(copy.profile.credential.source).toBe('none');
});
it('预览绑定实际环境端点与项目覆盖，变化后不提交旧确认', () => {
  const { root, workspaces } = fixture();
  const workspace = workspaces.openDefault();
  workspaces.confirm(workspace.id, workspace.trustToken, true);
  const service = new SettingsService(workspaces);
  const draft = {
    id: 'custom-openai',
    name: 'OpenAI fixture',
    provider: 'openai-compatible' as const,
    modelName: 'gpt-fixture',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    contextWindow: 32000,
  };
  try {
    vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:9999/override');
    const preview = service.preview(draft, undefined, workspace.id);
    expect(preview.profile.effectiveBaseURL).toBe('http://127.0.0.1:9999/override');
    vi.stubEnv('OPENAI_BASE_URL', 'http://127.0.0.1:9998/changed');
    expect(() => service.save(preview.previewToken, 'new-private-key')).toThrow(
      'SETTINGS_CONFLICT',
    );
    const next = service.preview(draft, undefined, workspace.id);
    fs.mkdirSync(path.join(workspace.root, '.kapibala'));
    fs.writeFileSync(path.join(workspace.root, '.kapibala/settings.json'), '{}');
    expect(() => service.save(next.previewToken, 'new-private-key')).toThrow('SETTINGS_CONFLICT');
    expect(fs.readFileSync(path.join(root, '.kapibala/settings.json'), 'utf8')).not.toContain(
      'new-private-key',
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
it('创建项目显式确认信任，显示名绑定物理根且不改目录；撤销信任后旧状态不能自动重新授信', () => {
  const { root, workspaces } = fixture();
  const project = path.join(root, 'existing-project');
  fs.mkdirSync(project);
  const selected = workspaces.registerProject(project);
  expect(() => workspaces.addProject(selected.id, 'API 项目', selected.trustToken, false)).toThrow(
    'TRUST_REQUIRED',
  );
  expect(() => workspaces.addProject(selected.id, '  ', selected.trustToken, true)).toThrow();
  expect(workspaces.get(selected.id).trusted).toBe(false);
  expect(() => workspaces.addProject(selected.id, 'API 项目', 'old-token', true)).toThrow(
    'SETTINGS_CONFLICT',
  );
  const added = workspaces.addProject(selected.id, 'API 项目', selected.trustToken, true);
  expect(added).toMatchObject({
    id: selected.id,
    root: fs.realpathSync.native(project),
    name: 'API 项目',
    trusted: true,
  });
  expect(workspaces.registerProject(project).id).toBe(selected.id);
  expect(fs.existsSync(path.join(root, 'API 项目'))).toBe(false);
  mutateGlobalSettings(
    (raw) => {
      raw.trustedProjects = [];
    },
    { homeDir: root },
  );
  expect(() =>
    workspaces.addProject(selected.id, '重命名显示', selected.trustToken, false),
  ).toThrow('TRUST_REQUIRED');
  expect(workspaces.get(selected.id).trusted).toBe(false);
});
