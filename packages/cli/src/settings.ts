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

export function getGlobalSettingsPath(): string {
  return path.join(os.homedir(), '.kapibala', 'settings.json');
}

export function getProjectSettingsPath(): string {
  return path.join(process.cwd(), '.kapibala', 'settings.json');
}

export function loadSettings(): { settings: UserSettings; sourcePath?: string } {
  const projectPath = getProjectSettingsPath();
  const globalPath = getGlobalSettingsPath();

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
      settings = mergeSettings(settings, parsed);
      sourcePath = globalPath;
    } catch {
      // 忽略损坏配置
    }
  }

  // 2. 项目配置覆盖
  if (fs.existsSync(projectPath)) {
    try {
      const raw = fs.readFileSync(projectPath, 'utf-8');
      const parsed = JSON.parse(raw);
      settings = mergeSettings(settings, parsed);
      sourcePath = projectPath;
    } catch {
      // 忽略损坏配置
    }
  }

  return { settings, sourcePath };
}

export function saveGlobalSettings(settings: UserSettings): string {
  const globalPath = getGlobalSettingsPath();
  const dir = path.dirname(globalPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const content = JSON.stringify(settings, null, 2);
  fs.writeFileSync(globalPath, content, { encoding: 'utf-8', mode: 0o600 });
  return globalPath;
}

export function resolveApiKey(profile: ModelProfile): string | undefined {
  if (profile.apiKey?.trim()) {
    return profile.apiKey.trim();
  }
  if (profile.apiKeyEnv === 'NONE') {
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

function mergeSettings(base: UserSettings, incoming: Partial<UserSettings>): UserSettings {
  const profilesMap = new Map<string, ModelProfile>();
  for (const p of base.profiles) profilesMap.set(p.id, p);
  if (incoming.profiles) {
    for (const p of incoming.profiles) profilesMap.set(p.id, p);
  }

  return {
    $schema: incoming.$schema ?? base.$schema,
    defaultModel: incoming.defaultModel ?? base.defaultModel,
    modelRouting: incoming.modelRouting ?? base.modelRouting,
    profiles: Array.from(profilesMap.values()),
  };
}
