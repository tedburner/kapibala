import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ModelProfile } from '@kiturone/kapibala';

export interface ModelRoutingConfig {
  planning?: string;
  execution?: string;
  summary?: string;
  fast?: string;
}

export interface UserSettings {
  $schema?: string;
  defaultModel: string;
  modelRouting?: ModelRoutingConfig;
  profiles: ModelProfile[];
  /** 已由用户永久信任的项目真实绝对路径，仅允许从全局配置加载。 */
  trustedProjects?: string[];
}

export interface LoadSettingsOptions {
  cwd?: string;
  homeDir?: string;
  /** 设为 false 时只读取内置与全局层，供全局配置写入流程使用。 */
  includeProject?: boolean;
}

export interface PendingProjectSettings {
  projectPath: string;
  settingsPath: string;
}

export interface LoadedSettings {
  settings: UserSettings;
  sourcePath?: string;
  pendingProject?: PendingProjectSettings;
}

export const BUILTIN_PROFILES: ModelProfile[] = [
  {
    id: 'deepseek-flash',
    name: 'DeepSeek Flash',
    provider: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    modelName: 'deepseek-flash',
    contextWindow: 128000,
    supportsThinking: false,
  },
  {
    id: 'deepseek-v4-flash',
    name: 'DeepSeek V4 Flash',
    provider: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    modelName: 'deepseek-v4-flash',
    contextWindow: 128000,
    supportsThinking: false,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro (深度推理)',
    provider: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    modelName: 'deepseek-v4-pro',
    contextWindow: 128000,
    supportsThinking: true,
  },
  {
    id: 'gpt-4o',
    name: 'OpenAI GPT-4o (全能旗舰)',
    provider: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelName: 'gpt-4o',
    contextWindow: 128000,
  },
  {
    id: 'gpt-4o-mini',
    name: 'OpenAI GPT-4o Mini (极速轻量)',
    provider: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelName: 'gpt-4o-mini',
    contextWindow: 128000,
  },
  {
    id: 'o3-mini',
    name: 'OpenAI o3-mini (深度推理)',
    provider: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelName: 'o3-mini',
    contextWindow: 128000,
    supportsThinking: true,
  },
  {
    id: 'qwen-plus',
    name: 'Qwen Plus (通义千问)',
    provider: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    modelName: 'qwen-plus',
    contextWindow: 128000,
  },
  {
    id: 'ollama',
    name: 'Local Ollama (Llama 3.3)',
    provider: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    apiKeyEnv: 'NONE',
    apiKey: 'ollama',
    modelName: 'llama3.3',
    contextWindow: 128000,
  },
];

/** 无需密钥的本地端点(如 Ollama)的 apiKeyEnv 约定值 */
export const API_KEY_ENV_NONE = 'NONE';

export function getGlobalSettingsPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.kapibala', 'settings.json');
}

export function getProjectSettingsPath(cwd = process.cwd()): string {
  return path.join(cwd, '.kapibala', 'settings.json');
}

/**
 * 加载全局配置，并仅在当前项目已被永久信任时合并项目配置。
 * 未信任项目只返回其路径，调用方必须先完成交互确认，不能读取其中内容。
 */
export function loadSettings(options: LoadSettingsOptions = {}): LoadedSettings {
  const cwd = options.cwd ?? process.cwd();
  const projectSettingsPath = getProjectSettingsPath(cwd);
  const globalPath = getGlobalSettingsPath(options.homeDir);

  let settings: UserSettings = {
    $schema:
      'https://raw.githubusercontent.com/tedburner/kapibala/main/schemas/settings.schema.json',
    defaultModel: 'deepseek-v4-flash',
    modelRouting: {
      planning: 'deepseek-v4-pro',
      execution: 'deepseek-v4-flash',
    },
    profiles: [...BUILTIN_PROFILES],
  };

  let sourcePath: string | undefined;

  // 1. 全局配置兜底
  if (fs.existsSync(globalPath)) {
    try {
      const raw = fs.readFileSync(globalPath, 'utf-8');
      const parsed = JSON.parse(raw);
      settings = mergeSettings(settings, parsed, true);
      sourcePath = globalPath;
    } catch (err: unknown) {
      // 损坏配置不能静默吞掉：用户会以为配置生效了，实际一直在跑默认值
      console.error(
        `[kapibala] Failed to parse global settings (${globalPath}): ${(err as Error).message}`,
      );
    }
  }

  // 2. 项目配置是仓库输入：未获永久信任前只检测文件存在，不读取其内容。
  if (options.includeProject !== false && fs.existsSync(projectSettingsPath)) {
    const realProjectPath = normalizeProjectPath(cwd);
    if (!isProjectTrusted(settings, realProjectPath)) {
      return {
        settings,
        sourcePath,
        pendingProject: { projectPath: realProjectPath, settingsPath: projectSettingsPath },
      };
    }

    try {
      const raw = fs.readFileSync(projectSettingsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      settings = mergeSettings(settings, parsed, false);
      sourcePath = projectSettingsPath;
    } catch (err: unknown) {
      console.error(
        `[kapibala] Failed to parse project settings (${projectSettingsPath}): ${(err as Error).message}`,
      );
    }
  }

  return { settings, sourcePath };
}

export function saveGlobalSettings(
  settings: UserSettings,
  options: Pick<LoadSettingsOptions, 'homeDir'> = {},
): string {
  const globalPath = getGlobalSettingsPath(options.homeDir);
  const dir = path.dirname(globalPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const content = JSON.stringify(settings, null, 2);
  fs.writeFileSync(globalPath, content, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(globalPath, 0o600);
  } catch {
    // 某些平台不支持 POSIX mode；写入仍成功，CLI 会在保存密钥前明确提示存储位置。
  }
  return globalPath;
}

/** 将项目真实路径永久加入全局信任列表并立即持久化。 */
export function trustProject(
  settings: UserSettings,
  projectPath: string,
  options: Pick<LoadSettingsOptions, 'homeDir'> = {},
): string {
  const normalized = normalizeProjectPath(projectPath);
  const trustedProjects = settings.trustedProjects ?? [];
  if (!trustedProjects.some((trusted) => pathsEqual(trusted, normalized))) {
    settings.trustedProjects = [...trustedProjects, normalized];
  }
  return saveGlobalSettings(settings, options);
}

/**
 * 覆盖指定模型的内联 API Key。
 * 只更新既有 profile，避免拼写错误时静默创建无法使用的配置。
 */
export function updateProfileApiKey(
  settings: UserSettings,
  profileId: string,
  apiKey: string,
): ModelProfile {
  const profile = settings.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    throw new Error(`Model profile '${profileId}' not found`);
  }
  profile.apiKey = apiKey.trim();
  return profile;
}

/** 确保 profile 存在于目标配置；已有同 ID 配置保持不变，避免项目覆盖项反写全局。 */
export function ensureProfile(settings: UserSettings, profile: ModelProfile): ModelProfile {
  const existing = settings.profiles.find((candidate) => candidate.id === profile.id);
  if (existing) return existing;
  const added = { ...profile };
  settings.profiles.push(added);
  return added;
}

export function resolveApiKey(profile: ModelProfile): string | undefined {
  if (profile.apiKey?.trim()) {
    return profile.apiKey.trim();
  }
  if (profile.apiKeyEnv === API_KEY_ENV_NONE) {
    return 'none';
  }
  const envVal = process.env[profile.apiKeyEnv];
  if (envVal?.trim()) {
    return envVal.trim();
  }

  // 仅在同族 provider 之间回退。
  // 无条件回退到 OPENAI_API_KEY 会让"拿 OpenAI 的 key 去打 DeepSeek 端点"变成静默行为，
  // 用户只会看到一条没头没尾的 401，排障成本极高。
  const fallbackEnv = FAMILY_KEY_ENV[detectProviderFamily(profile)];
  if (fallbackEnv && fallbackEnv !== profile.apiKeyEnv) {
    const fallbackVal = process.env[fallbackEnv];
    if (fallbackVal?.trim()) return fallbackVal.trim();
  }
  return undefined;
}

/** 环境变量覆盖端点(设计文档 §5.1.3)：OPENAI_BASE_URL / DEEPSEEK_BASE_URL */
export function resolveBaseURL(profile: ModelProfile): string {
  const envName = FAMILY_BASE_URL_ENV[detectProviderFamily(profile)];
  const override = envName ? process.env[envName]?.trim() : undefined;
  return (override || profile.baseURL || '').replace(/\/+$/, '');
}

export type ProviderFamily = 'openai' | 'deepseek' | 'qwen' | 'ollama' | 'unknown';

/** 从 profile 的 id / baseURL 推断所属厂商族 */
export function detectProviderFamily(profile: ModelProfile): ProviderFamily {
  const id = profile.id.toLowerCase();
  const base = (profile.baseURL || '').toLowerCase();
  if (id.startsWith('deepseek') || base.includes('deepseek')) return 'deepseek';
  if (
    id.startsWith('gpt') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('openai') ||
    base.includes('openai.com')
  ) {
    return 'openai';
  }
  if (id.startsWith('qwen') || base.includes('aliyuncs.com')) return 'qwen';
  if (id === 'ollama' || base.includes('11434')) return 'ollama';
  return 'unknown';
}

const FAMILY_KEY_ENV: Partial<Record<ProviderFamily, string>> = {
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
};

const FAMILY_BASE_URL_ENV: Partial<Record<ProviderFamily, string>> = {
  openai: 'OPENAI_BASE_URL',
  deepseek: 'DEEPSEEK_BASE_URL',
};

function normalizeProjectPath(projectPath: string): string {
  const absolute = path.resolve(projectPath);
  return fs.realpathSync.native(absolute);
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === 'win32'
    ? path.normalize(left).toLowerCase() === path.normalize(right).toLowerCase()
    : path.normalize(left) === path.normalize(right);
}

function isProjectTrusted(settings: UserSettings, projectPath: string): boolean {
  return (settings.trustedProjects ?? []).some((trusted) => pathsEqual(trusted, projectPath));
}

function mergeSettings(
  base: UserSettings,
  incoming: Partial<UserSettings>,
  allowTrustedProjects: boolean,
): UserSettings {
  const profilesMap = new Map<string, ModelProfile>();
  for (const p of base.profiles) profilesMap.set(p.id, p);
  if (Array.isArray(incoming.profiles)) {
    for (const p of incoming.profiles) {
      const inherited = profilesMap.get(p.id);
      profilesMap.set(p.id, inherited ? { ...inherited, ...p } : p);
    }
  }

  return {
    $schema: incoming.$schema ?? base.$schema,
    defaultModel: incoming.defaultModel ?? base.defaultModel,
    // 浅合并各路由字段：只配 planning 时不应丢掉 base 里已有的 execution/summary/fast
    modelRouting: incoming.modelRouting
      ? { ...base.modelRouting, ...incoming.modelRouting }
      : base.modelRouting,
    profiles: Array.from(profilesMap.values()),
    trustedProjects:
      allowTrustedProjects && Array.isArray(incoming.trustedProjects)
        ? incoming.trustedProjects.filter((value): value is string => typeof value === 'string')
        : base.trustedProjects,
  };
}
