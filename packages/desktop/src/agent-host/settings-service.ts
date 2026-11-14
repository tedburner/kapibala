import { type ModelProfile, resolveContextWindow } from '@kiturone/kapibala';
import {
  API_KEY_ENV_NONE,
  BUILTIN_PROFILES,
  PROVIDER_METAS,
  type UserSettings,
  describeCredentialGroup,
  ensureProfile,
  loadGlobalSettingsForWrite,
  loadSettings,
  mutateGlobalSettings,
  providerCategory,
  redactText,
  resolveApiKeyDetailed,
  resolveBaseURL,
  updateProfileApiKey,
} from '@kiturone/kapibala-host/host';
import { type Output, type ProfileDraft, ProfileDraftSchema } from '../shared/contracts.js';
import type { Workspaces } from './workspaces.js';

/** 全局配置服务只通过短事务提交字段；保存即写盘，不保留预览态或秘密副本。 */
export class SettingsService {
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
  /**
   * 一次落盘：校验通过后直接写本地 settings.json，并回读刚落盘的 Profile。
   *
   * 端点、协议或凭证环境变量变更，以及内置 Profile 的结构改动都必须另存新 id——
   * 避免把已可用的配置原地改成不可用。密钥留空时沿用同组已存凭证，
   * 既没有新密钥也没有可复用凭证才拒绝保存。
   */
  saveProfile(
    draft: ProfileDraft,
    apiKey?: string,
    editId?: string,
  ): Output<'settings.saveProfile'> {
    draft = ProfileDraftSchema.parse(draft);
    const settings = this.global();
    const original = settings.profiles.find((item) => item.id === draft.id);
    if (editId && editId !== draft.id && original) throw new Error('SETTINGS_CONFLICT');
    if (
      original &&
      original.id === draft.id &&
      (original.provider !== draft.provider ||
        original.baseURL !== draft.baseURL ||
        original.apiKeyEnv !== draft.apiKeyEnv)
    )
      throw new Error('SAVE_AS_NEW_PROFILE');
    const builtin = BUILTIN_PROFILES.find((item) => item.id === draft.id);
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
    if (apiKey === undefined) {
      const resolved = resolveApiKeyDetailed({ ...original, ...draft }, settings);
      if ((!resolved || resolved.source === 'none') && draft.apiKeyEnv !== API_KEY_ENV_NONE)
        throw new Error('CONFIG_REQUIRED');
    }
    mutateGlobalSettings(
      (raw) => {
        const current = raw.profiles.findIndex((item) => item.id === draft.id);
        if (current < 0) ensureProfile(raw, { ...draft });
        else raw.profiles[current] = { ...raw.profiles[current], ...draft };
        if (apiKey !== undefined) updateProfileApiKey(raw, draft.id, apiKey);
      },
      { homeDir: this.workspaces.home },
    );
    const saved = this.global();
    const profile = saved.profiles.find((item) => item.id === draft.id);
    if (!profile) throw new Error('PROFILE_UNAVAILABLE');
    return { profile: this.publicProfile(profile, saved) };
  }
  /**
   * 按 Base URL 只读探测模型目录，供自定义端点直接选模型。
   *
   * 只发一次 GET {baseURL}/models：8 秒超时、1MB 响应上限、500 条结果上限，失败以固定错误码
   * 交给页面翻译；本次输入的密钥只用于这一次请求，不落盘、不进预览令牌。留空时用 profileId
   * 指向的已存凭证（同组复用），避免用户重复输入。
   */
  async listModels(baseURL: string, apiKey?: string, profileId?: string): Promise<string[]> {
    const endpoint = new URL(baseURL);
    if (!['http:', 'https:'].includes(endpoint.protocol)) throw new Error('MODEL_LIST_INVALID');
    endpoint.search = '';
    endpoint.hash = '';
    const url = `${endpoint.href.replace(/\/$/, '')}/models`;
    const settings = this.global();
    const profile = profileId ? settings.profiles.find((item) => item.id === profileId) : undefined;
    const stored = profile ? resolveApiKeyDetailed(profile, settings) : undefined;
    const credential = apiKey ?? (stored && stored.source !== 'none' ? stored.key : undefined);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          accept: 'application/json',
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        signal: AbortSignal.timeout(8_000),
      });
    } catch (error) {
      throw new Error(
        (error as { name?: string }).name === 'TimeoutError'
          ? 'MODEL_LIST_TIMEOUT'
          : 'MODEL_LIST_UNAVAILABLE',
      );
    }
    if (!response.ok) throw new Error('MODEL_LIST_UNAVAILABLE');
    const body = await response.text();
    if (body.length > 1_000_000) throw new Error('MODEL_LIST_INVALID');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new Error('MODEL_LIST_INVALID');
    }
    const record = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null;
    // 兼容三类常见形状：OpenAI `{data:[{id}]}`、Ollama `{models:[{name|model}]}`、裸数组。
    const entries = Array.isArray(parsed)
      ? parsed
      : record(parsed) && Array.isArray(parsed.data)
        ? parsed.data
        : record(parsed) && Array.isArray(parsed.models)
          ? parsed.models
          : undefined;
    if (!entries) throw new Error('MODEL_LIST_INVALID');
    const models = [
      ...new Set(
        entries
          .map((entry) => {
            if (typeof entry === 'string') return entry;
            if (!record(entry)) return '';
            const id = entry.id ?? entry.name ?? entry.model;
            return typeof id === 'string' ? id : '';
          })
          .map((value) => value.trim())
          .filter((value) => value.length > 0 && value.length <= 256),
      ),
    ]
      .sort()
      .slice(0, 500);
    if (entries.length > 0 && models.length === 0) throw new Error('MODEL_LIST_INVALID');
    return models;
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
      // 厂商分组复用 CLI /model 菜单的同一套推断，页面分组与菜单分组永不漂移。
      providerKey: providerCategory(profile),
      credential: {
        configured: Boolean(resolved && resolved.source !== 'none'),
        source: resolved?.source ?? 'none',
        group: describeCredentialGroup(profile),
        env: profile.apiKeyEnv,
        fromProfileId: resolved?.fromProfileId,
      },
    };
  }
}
