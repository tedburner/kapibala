import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type ModelProfile, resolveContextWindow } from '@kiturone/kapibala';
import {
  API_KEY_ENV_NONE,
  BUILTIN_PROFILES,
  PROVIDER_METAS,
  type UserSettings,
  credentialGroup,
  describeCredentialGroup,
  ensureProfile,
  loadGlobalSettingsForWrite,
  loadSettings,
  mutateGlobalSettings,
  redactText,
  resolveApiKeyDetailed,
  resolveBaseURL,
  updateProfileApiKey,
} from '@kiturone/kapibala-cli/host';
import { type Output, type ProfileDraft, ProfileDraftSchema } from '../shared/contracts.js';
import type { Workspaces } from './workspaces.js';

/** 全局配置服务只通过短事务提交字段；预览令牌持有相关原始值，不让页面比较秘密。 */
export class SettingsService {
  private readonly previews = new Map<
    string,
    {
      draft: ProfileDraft;
      fingerprint: string;
      expiresAt: number;
      workspaceId?: string;
      projectFingerprint: string;
    }
  >();
  constructor(private readonly workspaces: Workspaces) {}
  /** 白名单目录与凭证来源；项目未信任时只读全局，不回显已有密钥。 */
  read(workspaceId?: string): Output<'settings.read'> {
    loadGlobalSettingsForWrite({ homeDir: this.workspaces.home });
    const workspace = workspaceId ? this.workspaces.get(workspaceId) : undefined;
    const loaded = loadSettings({
      homeDir: this.workspaces.home,
      cwd: workspace?.root,
      includeProject: workspace?.trusted ?? false,
    });
    return {
      noAuthEnv: API_KEY_ENV_NONE,
      profiles: loaded.settings.profiles.map((item) => this.publicProfile(item, loaded.settings)),
      defaultModel: loaded.settings.defaultModel,
      routing: { ...loaded.settings.modelRouting },
      providers: PROVIDER_METAS.map((item) => ({
        key: item.key,
        name: item.name,
        description: item.desc,
      })),
      projectOverride: Boolean(
        workspace?.trusted &&
          loaded.sourcePath !== undefined &&
          loaded.sourcePath.includes(workspace.root),
      ),
    };
  }
  /** 协议、端点或凭证环境变量变化必须另存；最多保留 64 个、30 秒失效的控制连接内令牌。 */
  preview(
    draft: ProfileDraft,
    editId?: string,
    workspaceId?: string,
  ): Output<'settings.previewProfile'> {
    draft = ProfileDraftSchema.parse(draft);
    const settings = this.global();
    const target = settings.profiles.find((item) => item.id === draft.id);
    if (editId && editId !== draft.id && target) throw new Error('SETTINGS_CONFLICT');
    const original = target;
    const builtin = BUILTIN_PROFILES.find((item) => item.id === draft.id);
    if (
      original &&
      (original.provider !== draft.provider ||
        original.baseURL !== draft.baseURL ||
        original.apiKeyEnv !== draft.apiKeyEnv) &&
      original.id === draft.id
    )
      throw new Error('SAVE_AS_NEW_PROFILE');
    if (
      builtin &&
      ['provider', 'baseURL', 'modelName', 'apiKeyEnv', 'contextWindow'].some((field) =>
        field === 'contextWindow'
          ? resolveContextWindow(builtin.contextWindow).tokens !==
            (draft.contextWindow ?? resolveContextWindow(builtin.contextWindow).tokens)
          : Reflect.get(builtin, field) !== Reflect.get(draft, field),
      )
    )
      throw new Error('SAVE_AS_NEW_PROFILE');
    this.prune();
    if (this.previews.size >= 64) throw new Error('RESOURCE_LIMIT');
    const previewToken = randomUUID();
    this.previews.set(previewToken, {
      draft,
      fingerprint: this.fingerprint(settings, draft),
      expiresAt: Date.now() + 30_000,
      workspaceId,
      projectFingerprint: this.projectFingerprint(workspaceId),
    });
    return {
      previewToken,
      profile: this.publicProfile(
        { ...(original?.id === draft.id ? original : undefined), ...draft },
        settings,
      ),
    };
  }
  /** 持锁重读相关字段，任何同组凭证值变化都会使旧预览冲突；无关字段自然保留。 */
  save(token: string, key?: string, credentialMode?: 'reuse' | 'none'): void {
    this.prune();
    const preview = this.previews.get(token);
    if (!preview) throw new Error('SETTINGS_CONFLICT');
    mutateGlobalSettings(
      (raw) => {
        const settings = this.merge(raw);
        if (this.projectFingerprint(preview.workspaceId) !== preview.projectFingerprint)
          throw new Error('SETTINGS_CONFLICT');
        const resolved = resolveApiKeyDetailed(
          { ...settings.profiles.find((item) => item.id === preview.draft.id), ...preview.draft },
          settings,
        );
        if (key === undefined && credentialMode === 'none' && resolved?.source !== 'none')
          throw new Error('INVALID_REQUEST');
        if (
          key === undefined &&
          credentialMode === 'reuse' &&
          (!resolved || resolved.source === 'none')
        )
          throw new Error('CONFIG_REQUIRED');
        if (this.fingerprint(settings, preview.draft) !== preview.fingerprint)
          throw new Error('SETTINGS_CONFLICT');
        const current = raw.profiles.findIndex((item) => item.id === preview.draft.id);
        if (current < 0) ensureProfile(raw, { ...preview.draft });
        else raw.profiles[current] = { ...raw.profiles[current], ...preview.draft };
        if (key !== undefined) updateProfileApiKey(raw, preview.draft.id, key);
      },
      { homeDir: this.workspaces.home },
    );
    this.previews.delete(token);
  }
  /** 默认模型仅影响未来装配，不替换已打开会话的临时选择。 */
  setDefault(id: string): void {
    mutateGlobalSettings(
      (raw) => {
        const profile = this.merge(raw).profiles.find((item) => item.id === id);
        if (!profile) throw new Error('PROFILE_UNAVAILABLE');
        ensureProfile(raw, profile);
        raw.defaultModel = id;
      },
      { homeDir: this.workspaces.home },
    );
  }
  /** 单角色字段提交；清除路由不删除 Profile 或复制其它模型目录。 */
  setRouting(role: 'planning' | 'execution' | 'fast' | 'summary', id?: string): void {
    mutateGlobalSettings(
      (raw) => {
        if (id) {
          const profile = this.merge(raw).profiles.find((item) => item.id === id);
          if (!profile) throw new Error('PROFILE_UNAVAILABLE');
          ensureProfile(raw, profile);
        }
        raw.modelRouting = { ...raw.modelRouting };
        if (id) raw.modelRouting[role] = id;
        else delete raw.modelRouting[role];
      },
      { homeDir: this.workspaces.home },
    );
  }
  /** 公共文字出口保留当前所有已知凭证；不把集合或配置对象交给 Main/Renderer。 */
  redact(value: string, workspaceId?: string): string {
    if (workspaceId) return this.captureRedactor(workspaceId)(value);
    const settings = this.global();
    const secrets = settings.profiles.flatMap((profile) => {
      const resolved = resolveApiKeyDetailed(profile, settings);
      return resolved?.source !== 'none' && resolved?.key ? [resolved.key] : [];
    });
    return redactText(value, secrets);
  }
  /** 运行受理时捕获脱敏集合，直到该 run 收口前保留旧凭证，覆盖在途审批说明。 */
  captureRedactor(workspaceId: string): (text: string) => string {
    const workspace = this.workspaces.get(workspaceId, true);
    const settings = loadSettings({ homeDir: this.workspaces.home, cwd: workspace.root }).settings;
    const secrets = settings.profiles.flatMap((profile) => {
      const resolved = resolveApiKeyDetailed(profile, settings);
      return resolved?.source !== 'none' && resolved?.key ? [resolved.key] : [];
    });
    const globalSettings = this.global();
    for (const profile of globalSettings.profiles) {
      const resolved = resolveApiKeyDetailed(profile, globalSettings);
      if (resolved?.source !== 'none' && resolved?.key) secrets.push(resolved.key);
    }
    return (text) => redactText(text, secrets);
  }
  private global(): UserSettings {
    return this.merge(loadGlobalSettingsForWrite({ homeDir: this.workspaces.home }));
  }
  private merge(raw: UserSettings): UserSettings {
    const profiles = new Map(BUILTIN_PROFILES.map((item) => [item.id, { ...item }]));
    for (const item of raw.profiles) profiles.set(item.id, { ...profiles.get(item.id), ...item });
    return { ...raw, profiles: [...profiles.values()] };
  }
  private fingerprint(settings: UserSettings, draft: ProfileDraft): string {
    const current = settings.profiles.find((item) => item.id === draft.id);
    const target = { ...current, ...draft };
    return JSON.stringify({
      current,
      group: credentialGroup(target),
      resolved: resolveApiKeyDetailed(target, settings),
      endpoint: resolveBaseURL({ ...target, ...draft }),
    });
  }
  private projectFingerprint(workspaceId?: string): string {
    if (!workspaceId) return '';
    const workspace = this.workspaces.get(workspaceId, true);
    const file = path.join(workspace.root, '.kapibala/settings.json');
    try {
      if (fs.statSync(file).size > 1024 * 1024) throw new Error('CONFIG_INVALID');
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }
  private publicProfile(
    profile: ModelProfile,
    settings: UserSettings,
  ): Output<'settings.read'>['profiles'][number] {
    const resolved = resolveApiKeyDetailed(profile, settings);
    const secrets = settings.profiles.flatMap((item) => {
      const key = resolveApiKeyDetailed(item, settings);
      return key?.source !== 'none' && key?.key ? [key.key] : [];
    });
    const clean = (value: string) => redactText(value, secrets);
    const endpoint = new URL(profile.baseURL);
    endpoint.username = '';
    endpoint.password = '';
    endpoint.search = '';
    endpoint.hash = '';
    const publicEndpoint = endpoint.href.replace(/\/$/, profile.baseURL.endsWith('/') ? '/' : '');
    return {
      id: profile.id,
      name: clean(profile.name),
      provider: profile.provider,
      modelName: clean(profile.modelName),
      baseURL: clean(publicEndpoint),
      apiKeyEnv: profile.apiKeyEnv,
      contextWindow: resolveContextWindow(profile.contextWindow).tokens,
      maxOutputTokens: profile.maxOutputTokens,
      supportsThinking: profile.supportsThinking,
      effectiveBaseURL: (() => {
        const actual = new URL(resolveBaseURL(profile));
        actual.username = '';
        actual.password = '';
        actual.search = '';
        actual.hash = '';
        return clean(actual.href);
      })(),
      builtin: BUILTIN_PROFILES.some((item) => item.id === profile.id),
      credential: {
        configured: Boolean(resolved && resolved.source !== 'none'),
        source: resolved?.source ?? 'none',
        group: describeCredentialGroup(profile),
        env: profile.apiKeyEnv,
        fromProfileId: resolved?.fromProfileId,
      },
    };
  }
  private prune(): void {
    for (const [token, item] of this.previews)
      if (item.expiresAt <= Date.now()) this.previews.delete(token);
  }
}
