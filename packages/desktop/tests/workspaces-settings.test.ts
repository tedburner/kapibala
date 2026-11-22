import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  API_KEY_ENV_NONE,
  BUILTIN_PROFILES,
  ensureProfile,
  mutateGlobalSettings,
} from '@kiturone/kapibala-host/host';
import { afterEach, expect, it, vi } from 'vitest';
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
it('端点模型目录去重排序，鉴权失败与非法响应返回固定错误码', async () => {
  const { workspaces } = fixture();
  const service = new SettingsService(workspaces);
  const server = createServer((request, response) => {
    if (request.url === '/v1/models' && request.headers.authorization === 'Bearer probe-key') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({ data: [{ id: 'b-model' }, { id: 'a-model' }, { id: 'a-model' }] }),
      );
      return;
    }
    if (request.url === '/broken/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"unexpected":true}');
      return;
    }
    response.writeHead(401, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    // 与 /model 菜单同一套端点拼接：用户填 .../v1，探测请求落在 .../v1/models。
    expect(await service.listModels(`http://127.0.0.1:${port}/v1`, 'probe-key')).toEqual([
      'a-model',
      'b-model',
    ]);
    await expect(service.listModels(`http://127.0.0.1:${port}/v1`, 'wrong')).rejects.toThrow(
      'MODEL_LIST_UNAVAILABLE',
    );
    await expect(
      service.listModels(`http://127.0.0.1:${port}/broken`, 'probe-key'),
    ).rejects.toThrow('MODEL_LIST_INVALID');
  } finally {
    server.close();
  }
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
it('保存直接落盘，公共设置不含已存凭证，无关字段更新不被覆盖', async () => {
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
  await service.saveProfile(profile, 'first-private-key');
  // 保存即写盘：不需要预览令牌或第二次提交。
  const first = JSON.parse(fs.readFileSync(path.join(root, '.kapibala/settings.json'), 'utf8'));
  expect(first.profiles).toHaveLength(1);
  expect(first.profiles[0].apiKey).toBe('first-private-key');
  // 不带新密钥再次保存：沿用同组已存凭证，只更新其它字段。
  const renamed = await service.saveProfile({ ...profile, name: 'Fixture 2' });
  expect(renamed.profile.name).toBe('Fixture 2');
  expect(renamed.profile.credential.configured).toBe(true);
  mutateGlobalSettings(
    (raw) => {
      raw.trustedProjects = ['/another-writer'];
    },
    { homeDir: root },
  );
  await service.saveProfile({ ...profile, modelName: 'fixture-2' }, 'third-private-key');
  const publicSettings = service.read();
  expect(JSON.stringify(publicSettings)).not.toMatch(/first-private-key|third-private-key/);
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.kapibala/settings.json'), 'utf8'));
  expect(stored.trustedProjects).toEqual(['/another-writer']);
  expect(stored.profiles).toHaveLength(1);
  expect(stored.profiles[0].apiKey).toBe('third-private-key');
});
it('项目专有凭证也必须从侧栏标题脱敏', () => {
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
it('目标 ID 独立校验防止 editId 转移旧密钥，新端点不会继承旧内联凭证', async () => {
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
  await service.saveProfile(source, 'source-private-key');
  await service.saveProfile(target, 'target-private-key');
  // editId 指向别的 Profile 时拒绝，避免把 source 的密钥写进 target。
  await expect(
    service.saveProfile({ ...target, baseURL: 'http://new.example/v1' }, undefined, source.id),
  ).rejects.toThrow('SETTINGS_CONFLICT');
  // 换端点且不带密钥：不静默复用旧端点的内联凭证。
  await expect(
    service.saveProfile({ ...source, id: 'new-id', baseURL: 'http://new.example/v1' }),
  ).rejects.toThrow('CONFIG_REQUIRED');
  const copy = await service.saveProfile(
    { ...source, id: 'new-id', baseURL: 'http://new.example/v1' },
    'fresh-key',
  );
  expect(copy.profile.credential.source).toBe('inline');
});
it('免密钥自建端点可直接保存，并按厂商名独立分组', async () => {
  const { root, workspaces } = fixture();
  const service = new SettingsService(workspaces);
  const saved = await service.saveProfile({
    id: 'custom-magpie',
    name: 'deepseek-flash',
    provider: 'openai-compatible',
    modelName: 'deepseek-flash',
    baseURL: 'http://127.0.0.1:3425',
    apiKeyEnv: API_KEY_ENV_NONE,
    vendorName: 'magpie',
    contextWindow: 32000,
  });
  expect(saved.profile.credential.source).toBe('none');
  expect(saved.profile.providerKey).toBe('custom:magpie');
  expect(service.read().providers).toContainEqual(
    expect.objectContaining({ key: 'custom:magpie', name: 'magpie', custom: true }),
  );
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.kapibala/settings.json'), 'utf8'));
  expect(stored.profiles[0]).toMatchObject({ apiKeyEnv: API_KEY_ENV_NONE, vendorName: 'magpie' });
  expect(stored.profiles[0].apiKey).toBeUndefined();
});
it('保存回读反映环境变量实际端点，覆盖值不写进配置', async () => {
  const { root, workspaces } = fixture();
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
    const saved = await service.saveProfile(draft, 'new-private-key');
    expect(saved.profile.effectiveBaseURL).toBe('http://127.0.0.1:9999/override');
  } finally {
    vi.unstubAllEnvs();
  }
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.kapibala/settings.json'), 'utf8'));
  expect(stored.profiles[0].baseURL).toBe('https://api.openai.com/v1');
  expect(stored.profiles[0].apiKey).toBe('new-private-key');
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
it('停用模型保留密钥，并把默认与路由引用迁到首个启用模型', async () => {
  const { root, workspaces } = fixture();
  const service = new SettingsService(workspaces);
  await service.saveProfile(
    {
      id: 'custom-toggle',
      name: 'Toggle',
      provider: 'openai-compatible',
      modelName: 'toggle',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKeyEnv: 'CUSTOM_API_KEY',
      contextWindow: 32000,
    },
    'toggle-private-key',
  );
  service.setDefault('custom-toggle');
  service.setRouting('planning', 'custom-toggle');

  service.setEnabled('custom-toggle', false);

  const after = service.read();
  expect(after.profiles.find((item) => item.id === 'custom-toggle')?.disabled).toBe(true);
  expect(after.defaultModel).not.toBe('custom-toggle');
  expect(after.routing.planning).not.toBe('custom-toggle');
  // 停用只切换开关，已存密钥必须原样留在配置文件里。
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.kapibala/settings.json'), 'utf8'));
  expect(stored.profiles[0]).toMatchObject({ id: 'custom-toggle', apiKey: 'toggle-private-key' });

  service.setEnabled('custom-toggle', true);
  expect(service.read().profiles.find((item) => item.id === 'custom-toggle')?.disabled).toBe(false);
});
it('删除自定义模型移除条目并清理默认引用，内置模型只写停用态', async () => {
  const { root, workspaces } = fixture();
  const service = new SettingsService(workspaces);
  await service.saveProfile(
    {
      id: 'custom-remove',
      name: 'Remove',
      provider: 'openai-compatible',
      modelName: 'remove',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKeyEnv: 'CUSTOM_API_KEY',
      contextWindow: 32000,
    },
    'remove-private-key',
  );
  service.setDefault('custom-remove');
  service.deleteProfile('custom-remove');
  const afterDelete = service.read();
  expect(afterDelete.profiles.some((item) => item.id === 'custom-remove')).toBe(false);
  expect(afterDelete.defaultModel).not.toBe('custom-remove');

  // 内置模型无法物理删除：写入停用墓碑，已存密钥保留，重新启用即可恢复。
  const builtin = BUILTIN_PROFILES.find((item) => item.id === 'deepseek-flash')!;
  await service.saveProfile(
    {
      id: builtin.id,
      name: builtin.name,
      provider: builtin.provider,
      modelName: builtin.modelName,
      baseURL: builtin.baseURL,
      apiKeyEnv: builtin.apiKeyEnv,
    },
    'builtin-private-key',
  );
  service.deleteProfile(builtin.id);
  expect(service.read().profiles.find((item) => item.id === builtin.id)?.disabled).toBe(true);
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.kapibala/settings.json'), 'utf8'));
  expect(stored.profiles.find((item: { id: string }) => item.id === builtin.id)).toMatchObject({
    disabled: true,
    apiKey: 'builtin-private-key',
  });
});
it('测试连接复用已存凭证，失败返回可展示的中文结论', async () => {
  const { workspaces } = fixture();
  const service = new SettingsService(workspaces);
  const server = createServer((request, response) => {
    if (request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ id: 'probe-model' }] }));
      return;
    }
    response.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await service.saveProfile(
      {
        id: 'custom-probe',
        name: 'Probe',
        provider: 'openai-compatible',
        modelName: 'probe-model',
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKeyEnv: 'CUSTOM_API_KEY',
        contextWindow: 32000,
      },
      'probe-private-key',
    );
    await expect(service.testProfile('custom-probe')).resolves.toEqual({
      ok: true,
      message: expect.stringContaining('1 个'),
    });
  } finally {
    server.close();
  }

  await service.saveProfile(
    {
      id: 'custom-down',
      name: 'Down',
      provider: 'openai-compatible',
      modelName: 'down',
      baseURL: 'http://127.0.0.1:1/v1',
      apiKeyEnv: 'CUSTOM_API_KEY',
      contextWindow: 32000,
    },
    'down-private-key',
  );
  const failed = await service.testProfile('custom-down');
  expect(failed.ok).toBe(false);
  expect(failed.message).toContain('连接失败');
});
it('保存留空窗口的自定义模型时探测端点声明并回填，失败静默落默认估算', async () => {
  const { root, workspaces } = fixture();
  const service = new SettingsService(workspaces);
  const server = createServer((request, response) => {
    if (request.url === '/v1/models' && request.headers.authorization === 'Bearer probe-key') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: [
            { id: 'noise-model', context_length: 8192 },
            { id: 'probed-model', context_length: 1048576 },
          ],
        }),
      );
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' }).end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    // 留空窗口 + 端点声明了该模型的窗口：保存即回填端点声明值。
    const saved = await service.saveProfile(
      {
        id: 'custom-backfill',
        name: 'Backfill',
        provider: 'openai-compatible',
        modelName: 'probed-model',
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKeyEnv: 'CUSTOM_API_KEY',
      },
      'probe-key',
    );
    expect(saved.profile.contextWindow).toBe(1048576);
    const stored = JSON.parse(fs.readFileSync(path.join(root, '.kapibala/settings.json'), 'utf8'));
    expect(stored.profiles[0].contextWindow).toBe(1048576);

    // 端点未实现 /models（404）：静默跳过，落盘 JSON 不写窗口，由运行时按统一默认值估算；
    // 公共投影保留落盘声明语义（undefined 原样透出），不把估算值物化回草稿 ——
    // 否则一次编辑保存就会把估算值冻结成显式声明，保存前探测也从此失效。
    const failed = await service.saveProfile(
      {
        id: 'custom-silent',
        name: 'Silent',
        provider: 'openai-compatible',
        modelName: 'probed-model',
        baseURL: `http://127.0.0.1:${port}/absent`,
        apiKeyEnv: 'CUSTOM_API_KEY',
      },
      'probe-key',
    );
    expect(failed.profile.contextWindow).toBeUndefined();
    const silentStored = JSON.parse(
      fs.readFileSync(path.join(root, '.kapibala/settings.json'), 'utf8'),
    );
    const silentProfile = silentStored.profiles.find(
      (item: { id: string }) => item.id === 'custom-silent',
    );
    expect(silentProfile.contextWindow).toBeUndefined();

    // 草稿显式填写窗口：探测不触发，用户显式值优先。
    const explicit = await service.saveProfile(
      {
        id: 'custom-explicit',
        name: 'Explicit',
        provider: 'openai-compatible',
        modelName: 'probed-model',
        baseURL: `http://127.0.0.1:${port}/v1`,
        apiKeyEnv: 'CUSTOM_API_KEY',
        contextWindow: 32000,
      },
      'probe-key',
    );
    expect(explicit.profile.contextWindow).toBe(32000);
  } finally {
    server.close();
  }
});

it('anthropic 端点探测携带 x-api-key 与 anthropic-version，官方 API 不认纯 Bearer', async () => {
  const { workspaces } = fixture();
  const service = new SettingsService(workspaces);
  const seen: Record<string, string | undefined> = {};
  const server = createServer((request, response) => {
    seen['x-api-key'] = request.headers['x-api-key'] as string | undefined;
    seen.authorization = request.headers.authorization;
    seen['anthropic-version'] = request.headers['anthropic-version'] as string | undefined;
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ data: [{ id: 'claude-fable-5-1' }] }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    // testProfile 用已存 Profile 的 provider 分支鉴权头：内置条目的端点被目录迁移锁定为
    // 官方值，这里落一条指向本地服务器的自定义 anthropic Profile 来驱动同一分支。
    mutateGlobalSettings(
      (raw) => {
        ensureProfile(raw, {
          id: 'custom-anthropic',
          name: 'Custom Anthropic',
          provider: 'anthropic',
          baseURL: `http://127.0.0.1:${port}/v1`,
          apiKeyEnv: 'ANTHROPIC_API_KEY',
          modelName: 'claude-fable-5-1',
          apiKey: 'sk-ant-test',
        });
      },
      { homeDir: workspaces.home },
    );
    const result = await service.testProfile('custom-anthropic');
    expect(result.ok).toBe(true);
    expect(seen['x-api-key']).toBe('sk-ant-test');
    expect(seen['anthropic-version']).toBe('2023-06-01');
    expect(seen.authorization).toBe('Bearer sk-ant-test');

    // 表单「获取模型列表」没有已存 Profile：协议由页面随草稿显式传入。
    seen['x-api-key'] = undefined;
    seen['anthropic-version'] = undefined;
    const models = await service.listModels(
      `http://127.0.0.1:${port}/v1`,
      'sk-ant-draft',
      undefined,
      'anthropic',
    );
    expect(models).toEqual(['claude-fable-5-1']);
    expect(seen['x-api-key']).toBe('sk-ant-draft');
    expect(seen['anthropic-version']).toBe('2023-06-01');
  } finally {
    server.close();
  }
});

it('设为默认与角色绑定只写引用：内置模型不物化条目进用户文件', () => {
  const { root, workspaces } = fixture();
  const service = new SettingsService(workspaces);
  service.setDefault('deepseek-flash');
  service.setRouting('planning', 'claude-opus-5');
  const stored = JSON.parse(fs.readFileSync(path.join(root, '.kapibala/settings.json'), 'utf8'));
  expect(stored.defaultModel).toBe('deepseek-flash');
  expect(stored.modelRouting).toEqual({ planning: 'claude-opus-5' });
  expect(stored.profiles).toEqual([]);
});

it('项目级模型在目录投影中标记 scope=project，供页面禁用管理操作', () => {
  const { workspaces } = fixture();
  const service = new SettingsService(workspaces);
  const projectDir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-scope-project-')),
  );
  roots.push(projectDir);
  const workspace = workspaces.registerProject(projectDir);
  const trusted = workspaces.confirm(workspace.id, workspace.trustToken, true);
  fs.mkdirSync(path.join(trusted.root, '.kapibala'), { recursive: true });
  fs.writeFileSync(
    path.join(trusted.root, '.kapibala/settings.json'),
    JSON.stringify({
      defaultModel: 'project-only-model',
      profiles: [
        {
          id: 'project-only-model',
          name: 'Project Only',
          provider: 'openai-compatible',
          baseURL: 'https://project.example.com/v1',
          apiKeyEnv: 'PROJECT_API_KEY',
          modelName: 'project-model',
        },
      ],
    }),
  );
  const catalog = service.read(trusted.id);
  const scopes = Object.fromEntries(catalog.profiles.map((item) => [item.id, item.scope]));
  expect(scopes['project-only-model']).toBe('project');
  expect(scopes['deepseek-flash']).toBe('global');
});
