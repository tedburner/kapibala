import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type ModelProfile,
  type PermissionRule,
  type SessionMode,
  type ShellPreference,
  resolveContextWindow,
  validatePermissionRules,
} from '@kiturone/kapibala';

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
  /** 只有用户级设置可指定默认模式，FullAccess 仍须本次会话主动选择。 */
  permissionMode?: SessionMode;
  /** 只有用户级设置可提供可执行授权规则。 */
  permissionRules?: PermissionRule[];
  /** 项目设置不可启用或更换命令解释器。 */
  shell?: { enabled?: boolean; preference?: ShellPreference };
  /**
   * 该配置所依据的内置模型清单版本。
   * 缺失或落后于 BUILTIN_CATALOG_VERSION 时，启动阶段会执行一次目录升级（见 migrateBuiltinCatalog）。
   * 没有这个字段，老用户的配置永远是首次写入那天的快照 —— 厂商换代后菜单里还挂着已退役的模型。
   */
  builtinCatalogVersion?: number;
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

/**
 * 内置模型清单版本。**改动 BUILTIN_PROFILES 就必须 +1**，否则老用户不会触发目录升级
 * （migrateBuiltinCatalog 只在版本落后时执行），菜单里会一直挂着已退役的模型。
 */
export const BUILTIN_CATALOG_VERSION = 2;

/**
 * 内置模型清单。
 *
 * 这里的 id / modelName / 上下文窗口按各家官方文档核对（核实日期 2026-09-20），
 * 不要再凭印象补模型 —— 写错 modelName 的代价是用户配置完直接 404。
 * 详细出处见 README「内置模型清单」一节。
 */
export const BUILTIN_PROFILES: ModelProfile[] = [
  // ── DeepSeek ────────────────────────────────────────────────────────────
  // deepseek-chat / deepseek-reasoner 已于 2026-07-24 退役并不可访问；
  // deepseek-v4-flash 的模型本身也已退役，官方只保留同名别名路由到 V4.1-Flash，
  // 所以这里只列 current 的两个 id，避免菜单里出现两个指向同一后端的重复项。
  {
    id: 'deepseek-flash',
    name: 'DeepSeek Flash (V4.1-Flash)',
    provider: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    modelName: 'deepseek-flash',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  {
    id: 'deepseek-v4-pro',
    name: 'DeepSeek V4 Pro (深度推理)',
    provider: 'openai-compatible',
    baseURL: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    modelName: 'deepseek-v4-pro',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  // ── OpenAI ──────────────────────────────────────────────────────────────
  {
    id: 'gpt-6-astra',
    name: 'OpenAI GPT-6 Astra (旗舰)',
    provider: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelName: 'gpt-6-astra',
    contextWindow: 1050000,
    supportsThinking: true,
  },
  {
    id: 'gpt-5.6-sol',
    name: 'OpenAI GPT-5.6 Sol (复杂推理与编码)',
    provider: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelName: 'gpt-5.6-sol',
    contextWindow: 1050000,
    supportsThinking: true,
  },
  {
    id: 'gpt-5.6-terra',
    name: 'OpenAI GPT-5.6 Terra (日常均衡)',
    provider: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelName: 'gpt-5.6-terra',
    contextWindow: 1050000,
    supportsThinking: true,
  },
  {
    id: 'gpt-5.6-luna',
    name: 'OpenAI GPT-5.6 Luna (高吞吐低价)',
    provider: 'openai-compatible',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'OPENAI_API_KEY',
    modelName: 'gpt-5.6-luna',
    contextWindow: 1050000,
    supportsThinking: true,
  },
  // ── Anthropic ───────────────────────────────────────────────────────────
  {
    id: 'claude-fable-5-1',
    name: 'Claude Fable 5.1 (最强推理)',
    provider: 'openai-compatible',
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    modelName: 'claude-fable-5-1',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  {
    id: 'claude-opus-5',
    name: 'Claude Opus 5 (复杂 Agent 与编码)',
    provider: 'openai-compatible',
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    modelName: 'claude-opus-5',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5 (日常主力)',
    provider: 'openai-compatible',
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    modelName: 'claude-sonnet-5',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5 (最快最省)',
    provider: 'openai-compatible',
    baseURL: 'https://api.anthropic.com/v1',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    modelName: 'claude-haiku-4-5',
    contextWindow: 200000,
    supportsThinking: true,
  },
  // ── Google Gemini ───────────────────────────────────────────────────────
  {
    id: 'gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro (复杂任务旗舰)',
    provider: 'openai-compatible',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyEnv: 'GEMINI_API_KEY',
    modelName: 'gemini-3.1-pro-preview',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  {
    id: 'gemini-3-flash-preview',
    name: 'Gemini 3 Flash (生产流量主力)',
    provider: 'openai-compatible',
    baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai/',
    apiKeyEnv: 'GEMINI_API_KEY',
    modelName: 'gemini-3-flash-preview',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  // ── 通义千问 ────────────────────────────────────────────────────────────
  {
    id: 'qwen3.8-max',
    name: 'Qwen3.8-Max (旗舰)',
    provider: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    modelName: 'qwen3.8-max',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  {
    id: 'qwen3.8-flash',
    name: 'Qwen3.8-Flash (快速低价)',
    provider: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    modelName: 'qwen3.8-flash',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  {
    id: 'qwen3.7-plus',
    name: 'Qwen3.7-Plus (均衡)',
    provider: 'openai-compatible',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    modelName: 'qwen3.7-plus',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  // ── Kimi（月之暗面）─────────────────────────────────────────────────────
  {
    id: 'kimi-k3',
    name: 'Kimi K3 (长程编码与知识工作)',
    provider: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    modelName: 'kimi-k3',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  {
    id: 'kimi-k2.7-code',
    name: 'Kimi K2.7 Code (编码专用)',
    provider: 'openai-compatible',
    baseURL: 'https://api.moonshot.cn/v1',
    apiKeyEnv: 'MOONSHOT_API_KEY',
    modelName: 'kimi-k2.7-code',
    contextWindow: 256000,
    supportsThinking: true,
  },
  // ── 智谱 GLM ────────────────────────────────────────────────────────────
  {
    id: 'glm-5.3',
    name: 'GLM-5.3 (旗舰)',
    provider: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'ZHIPU_API_KEY',
    modelName: 'glm-5.3',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  {
    id: 'glm-5.3-flash',
    name: 'GLM-5.3-Flash (原生多模态)',
    provider: 'openai-compatible',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKeyEnv: 'ZHIPU_API_KEY',
    modelName: 'glm-5.3-flash',
    contextWindow: 1000000,
    supportsThinking: true,
  },
  // ── 本地 Ollama ─────────────────────────────────────────────────────────
  {
    id: 'ollama',
    name: 'Local Ollama (gpt-oss:20b)',
    provider: 'openai-compatible',
    baseURL: 'http://localhost:11434/v1',
    apiKeyEnv: 'NONE',
    apiKey: 'ollama',
    modelName: 'gpt-oss:20b',
    contextWindow: 131072,
  },
];

/** 默认模型 id。指向 BUILTIN_PROFILES 中「快 + 便宜 + 长上下文」的那一档。 */
export const DEFAULT_MODEL_ID = 'deepseek-flash';

/** 配置里的 $schema 指向，写入与读取共用一份，避免两处字符串漂移。 */
export const KAPIBALA_SCHEMA_URL =
  'https://raw.githubusercontent.com/tedburner/kapibala/main/schemas/settings.schema.json';

/**
 * 旧内置 id → 现役内置 id 的重定向表。
 *
 * 覆盖两类：厂商已退役的模型（deepseek-chat / deepseek-reasoner），以及本清单不再推荐的
 * 上代模型（gpt-4o 系列、qwen-plus）。两者都做重定向，老用户的默认模型与密钥才能平滑
 * 过渡到新档位，而不是在菜单里留一个指向旧 modelName 的死条目。
 *
 * **从内置清单删掉任何一个 id，都必须在这里补一条重定向**，否则它会在用户配置里变成孤儿。
 * 迁移时必须把密钥一起带过去：`deepseek-v4-flash` 往往是用户唯一存有 DeepSeek key 的
 * profile，直接删掉会把密钥一起抹掉，而密钥丢失是不可逆的。
 */
export const LEGACY_PROFILE_REDIRECT: Record<string, string> = {
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-v4-pro',
  'deepseek-v4-flash': 'deepseek-flash',
  'gpt-4o': 'gpt-5.6-terra',
  'gpt-4o-mini': 'gpt-5.6-luna',
  'o3-mini': 'gpt-5.6-sol',
  'qwen-plus': 'qwen3.8-flash',
};

/** 由内置清单持有、允许目录升级覆盖的字段（apiKey 不在其中，必须原样保留）。 */
const CATALOG_OWNED_FIELDS = [
  'name',
  'provider',
  'baseURL',
  'apiKeyEnv',
  'modelName',
  'contextWindow',
  'supportsThinking',
] as const satisfies readonly (keyof ModelProfile)[];

/** 无需密钥的本地端点(如 Ollama)的 apiKeyEnv 约定值 */
export const API_KEY_ENV_NONE = 'NONE';

export function getGlobalSettingsPath(homeDir = os.homedir()): string {
  return path.join(homeDir, '.kapibala', 'settings.json');
}

export function getProjectSettingsPath(cwd = process.cwd()): string {
  return path.join(cwd, '.kapibala', 'settings.json');
}

/**
 * 读取**磁盘上原始**的全局配置，不做内置清单合并，也不做值校验。
 *
 * 所有「读全局 → 改一处 → 写回」的路径都必须用它，不能用 loadSettings()：
 * loadSettings 的返回值已经和 BUILTIN_PROFILES 合并过，整份写回会把用户从未启用的内置
 * 模型全部物化进配置文件（实测 profile 数 9 → 10，凭空多出一个 deepseek-flash）。
 *
 * 注意：本函数可能返回含非法 `contextWindow` 的配置（原样透传）。
 * 写回路径不要直接用它的返回值落盘 —— 应改用 {@link loadGlobalSettingsForWrite}，
 * 由 saveGlobalSettings 的写前校验兜底，避免坏值进入运行时。
 */
export function readRawGlobalSettings(
  options: Pick<LoadSettingsOptions, 'homeDir'> = {},
): UserSettings | undefined {
  const globalPath = getGlobalSettingsPath(options.homeDir);
  if (!fs.existsSync(globalPath)) return undefined;
  try {
    const parsed = JSON.parse(fs.readFileSync(globalPath, 'utf-8')) as UserSettings;
    if (!Array.isArray(parsed?.profiles)) return undefined;
    return parsed;
  } catch (err: unknown) {
    console.error(
      `[kapibala] Failed to parse global settings (${globalPath}): ${(err as Error).message}`,
    );
    return undefined;
  }
}

/** 内置清单 + 默认值构成的基础配置（未与任何磁盘文件合并）。 */
function createBaseSettings(): UserSettings {
  return {
    $schema: KAPIBALA_SCHEMA_URL,
    defaultModel: DEFAULT_MODEL_ID,
    modelRouting: {
      planning: 'deepseek-v4-pro',
      execution: DEFAULT_MODEL_ID,
    },
    profiles: [...BUILTIN_PROFILES],
    builtinCatalogVersion: BUILTIN_CATALOG_VERSION,
  };
}

/**
 * 全新的用户级配置骨架：**不含任何内置 profile**。
 *
 * 写盘时用它做起点，配置文件里就只会有用户真正配置过的模型 —— 内置清单继续由代码提供，
 * 升级时不需要改用户文件。反之若拿合并结果回写，用户从未启用过的内置模型会被物化进配置。
 */
export function createUserSettingsSkeleton(): UserSettings {
  return {
    $schema: KAPIBALA_SCHEMA_URL,
    defaultModel: DEFAULT_MODEL_ID,
    profiles: [],
  };
}

/**
 * 为「读全局 → 写回」路径加载磁盘原始全局配置。
 *
 * 与 {@link readRawGlobalSettings} 的区别在于失败语义：
 * 文件不存在时返回空骨架（首次配置是合法场景）；但**文件存在却无法安全使用**
 * （JSON 损坏、profiles 缺失、任一 profile 的 contextWindow 非法）时直接抛错。
 * 这些路径的返回值会被整体写回 —— 若此时静默回退空骨架，用户的全部 profile
 * （含内联 apiKey）会在下一次写盘时被无声清空，宁可中止也要保住数据。
 */
export function loadGlobalSettingsForWrite(
  options: Pick<LoadSettingsOptions, 'homeDir'> = {},
): UserSettings {
  const globalPath = getGlobalSettingsPath(options.homeDir);
  if (!fs.existsSync(globalPath)) return createUserSettingsSkeleton();
  try {
    const parsed = JSON.parse(fs.readFileSync(globalPath, 'utf-8')) as UserSettings;
    if (!Array.isArray(parsed?.profiles)) {
      throw new Error('profiles 字段缺失或不是数组');
    }
    validateProfileContextWindows(parsed.profiles);
    return parsed;
  } catch (err: unknown) {
    throw new Error(
      `[kapibala] 全局配置存在但无法安全读取 (${globalPath})：${(err as Error).message}。为避免覆盖丢失已有 profiles，已中止本次写入；请先修复该文件后重试。`,
    );
  }
}

/**
 * 沿重定向表把指向旧内置 id 的引用改到现役模型上。
 *
 * 项目配置里也可能写着旧 id，而项目配置不参与目录升级（那是用户的仓库文件），
 * 所以每次加载后都做一次内存内的引用重映射，保证 defaultModel 不会指向不存在的 profile。
 */
function remapLegacyReferences(settings: UserSettings): UserSettings {
  const remap = (id: string | undefined): string | undefined => {
    let current = id;
    const guard = new Set<string>();
    while (current && LEGACY_PROFILE_REDIRECT[current] && !guard.has(current)) {
      guard.add(current);
      current = LEGACY_PROFILE_REDIRECT[current];
    }
    return current;
  };

  settings.defaultModel = remap(settings.defaultModel) ?? DEFAULT_MODEL_ID;
  if (settings.modelRouting) {
    const routing = settings.modelRouting;
    settings.modelRouting = {
      planning: remap(routing.planning),
      execution: remap(routing.execution),
      summary: remap(routing.summary),
      fast: remap(routing.fast),
    };
  }
  return settings;
}

export interface CatalogMigrationResult {
  settings: UserSettings;
  /** 人类可读的变更说明，供启动时提示用户 */
  changes: string[];
  changed: boolean;
}

/**
 * 把存量配置升级到当前内置清单。
 *
 * 三类动作：
 *   1. 旧 id 重定向 —— 目标 profile 已存在时合并（密钥优先补给无密钥的一方），否则原地改名；
 *   2. 目录字段同步 —— 已存 profile 若命中内置 id，刷新 name/modelName/上下文/思考标记，
 *      **apiKey 原样保留**；
 *   3. 引用重映射 —— defaultModel 与 modelRouting 里的旧 id 改到现役模型。
 *
 * 刻意**不新增**内置 profile：那些模型由 loadSettings 从代码侧合并进来，写进用户文件既无必要
 * 又会把一份用户从未启用过的清单物化到磁盘上。用户自建的 profile 一律原样保留。
 *
 * 纯函数：不改磁盘、不改入参，便于测试与 dry-run。
 */
export function migrateBuiltinCatalog(raw: UserSettings): CatalogMigrationResult {
  if (raw.builtinCatalogVersion === BUILTIN_CATALOG_VERSION) {
    return { settings: raw, changes: [], changed: false };
  }

  const changes: string[] = [];
  const profiles: ModelProfile[] = (raw.profiles ?? []).map((profile) => ({ ...profile }));

  // 1. 旧 id 重定向 + 同 id 合并。
  //
  // 不能只找「由别的旧 id 重定向过来的兄弟」：用户的配置里可能同时存在
  // `deepseek-v4-flash`（有密钥）与 `deepseek-flash`（无密钥）两条，前者重定向后的 id
  // 会和后者撞车。若不做合并就会产出两条同 id 的 profile，菜单里出现重复项，
  // 后续按 id 查找也会取到不可预期的那一条。故按**最终 id** 归类，Map 的插入序即输出序。
  const merged = new Map<string, ModelProfile>();
  for (const profile of profiles) {
    const targetId = LEGACY_PROFILE_REDIRECT[profile.id] ?? profile.id;
    const existing = merged.get(targetId);
    if (!existing) {
      merged.set(targetId, { ...profile, id: targetId });
      if (targetId !== profile.id) changes.push(`'${profile.id}' → 已改用 '${targetId}'`);
      continue;
    }
    // 密钥补给无密钥的一方：先到的那条若没密钥，就用后来这条的补上；
    // 两边都有则保留先到的，不做覆盖（避免静默替换用户正在用的凭证）。
    if (!existing.apiKey?.trim() && profile.apiKey?.trim()) {
      existing.apiKey = profile.apiKey;
      changes.push(`'${profile.id}' 的 API Key 已迁移到 '${targetId}'`);
    }
    changes.push(
      targetId === profile.id
        ? `已合并重复的 '${targetId}' 配置`
        : `已移除旧模型 '${profile.id}'（改用 '${targetId}'）`,
    );
  }
  const redirected = [...merged.values()];

  // 2. 目录字段同步（只针对已存在的 profile）
  const builtinById = new Map(BUILTIN_PROFILES.map((profile) => [profile.id, profile]));
  const synced = redirected.map((profile) => {
    const builtin = builtinById.get(profile.id);
    if (!builtin) return profile;
    const drifted = CATALOG_OWNED_FIELDS.filter(
      (field) => profile[field] !== builtin[field],
    ) as string[];
    if (drifted.length > 0) {
      changes.push(`'${profile.id}' 已更新 ${drifted.join('/')}`);
    }
    // 显式逐字段同步，而不是泛型遍历赋值：字段少、类型安全，
    // 也从结构上保证不会把 apiKey 这类用户数据卷进来。
    return {
      ...profile,
      name: builtin.name,
      provider: builtin.provider,
      baseURL: builtin.baseURL,
      apiKeyEnv: builtin.apiKeyEnv,
      modelName: builtin.modelName,
      contextWindow: builtin.contextWindow,
      supportsThinking: builtin.supportsThinking,
    };
  });

  const migrated: UserSettings = {
    ...raw,
    profiles: synced,
    builtinCatalogVersion: BUILTIN_CATALOG_VERSION,
  };
  const previousDefault = migrated.defaultModel;
  remapLegacyReferences(migrated);
  if (previousDefault !== migrated.defaultModel) {
    changes.push(`默认模型 '${previousDefault}' → '${migrated.defaultModel}'`);
  }

  return { settings: migrated, changes, changed: changes.length > 0 };
}

/**
 * 启动阶段的目录升级：读磁盘原始全局配置 → 迁移 → 仅在确有变更时写回。
 * 返回变更说明（空数组表示无需升级）。配置损坏时静默跳过，不能因此挡住启动。
 */
export function migrateGlobalSettingsCatalog(
  options: Pick<LoadSettingsOptions, 'homeDir'> = {},
): string[] {
  const raw = readRawGlobalSettings(options);
  if (!raw) return [];
  const { settings, changes, changed } = migrateBuiltinCatalog(raw);
  if (!changed) return [];
  saveGlobalSettings(settings, options);
  return changes;
}

/**
 * 加载全局配置，并仅在当前项目已被永久信任时合并项目配置。
 * 未信任项目只返回其路径，调用方必须先完成交互确认，不能读取其中内容。
 */
export function loadSettings(options: LoadSettingsOptions = {}): LoadedSettings {
  const cwd = options.cwd ?? process.cwd();
  const projectSettingsPath = getProjectSettingsPath(cwd);
  const globalPath = getGlobalSettingsPath(options.homeDir);

  let settings: UserSettings = createBaseSettings();

  let sourcePath: string | undefined;

  // 1. 全局配置兜底
  if (fs.existsSync(globalPath)) {
    try {
      const raw = fs.readFileSync(globalPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.permissionMode === 'FullAccess') {
        console.error(
          `[kapibala] User settings cannot default to FullAccess (${globalPath}); using Approval.`,
        );
        const { permissionMode: _rejectedMode, ...safeParsed } = parsed;
        settings = mergeSettings(settings, safeParsed, true);
        settings.permissionMode = 'Approval';
      } else {
        settings = mergeSettings(settings, parsed, true);
      }
      sourcePath = globalPath;
    } catch (err: unknown) {
      if (err instanceof InvalidPermissionSettings) throw err;
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
        settings: remapLegacyReferences(settings),
        sourcePath,
        pendingProject: { projectPath: realProjectPath, settingsPath: projectSettingsPath },
      };
    }

    try {
      const raw = fs.readFileSync(projectSettingsPath, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed?.permissionMode === 'FullAccess') {
        console.error(
          `[kapibala] Project settings cannot default to FullAccess (${projectSettingsPath}); using Approval.`,
        );
        const { permissionMode: _rejectedMode, ...safeProjectSettings } = parsed;
        settings = mergeSettings(settings, safeProjectSettings, false);
        settings.permissionMode = 'Approval';
      } else {
        settings = mergeSettings(settings, parsed, false);
      }
      sourcePath = projectSettingsPath;
    } catch (err: unknown) {
      if (err instanceof InvalidPermissionSettings) throw err;
      console.error(
        `[kapibala] Failed to parse project settings (${projectSettingsPath}): ${(err as Error).message}`,
      );
    }
  }

  return { settings: remapLegacyReferences(settings), sourcePath };
}

/** 写入全局配置。任何一次全局写入都会盖上当前清单版本，避免下次启动重复迁移。 */
export function saveGlobalSettings(
  settings: UserSettings,
  options: Pick<LoadSettingsOptions, 'homeDir'> = {},
): string {
  validateProfileContextWindows(settings.profiles);
  const globalPath = getGlobalSettingsPath(options.homeDir);
  const dir = path.dirname(globalPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  settings.builtinCatalogVersion = BUILTIN_CATALOG_VERSION;
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
 * 覆盖指定模型的内联 API Key，并把同密钥分组内的冗余副本清掉。
 *
 * 只更新既有 profile，避免拼写错误时静默创建无法使用的配置。
 * 之所以顺带清理同组副本：同一厂商族只应有一份密钥，否则"更新了 pro 的 key、
 * flash 却还在用自己那份旧 key"会变成静默不一致 —— 用户以为改了，实际没生效。
 * 该操作不丢信息，被清掉的密钥在组内仍保留一份。
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

  const group = credentialGroup(profile);
  for (const candidate of settings.profiles) {
    if (candidate.id === profile.id) continue;
    if (candidate.apiKey?.trim() && credentialGroup(candidate) === group) {
      candidate.apiKey = undefined;
    }
  }
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

export type ApiKeySource = 'inline' | 'shared' | 'none' | 'env' | 'family-env';

export interface ResolvedApiKey {
  key: string;
  source: ApiKeySource;
  /** source 为 'shared' 时，密钥实际来自哪个 profile（同厂商族复用） */
  fromProfileId?: string;
}

/**
 * 密钥复用分组键。
 *
 * 同一厂商族共用一个密钥是刚需：用户不该为 DeepSeek 的 4 个模型输入 4 次同一把 key。
 * 但 `unknown` 不是厂商、只是兜底类，把所有自建端点归为一组会让「OneAPI 网关」和
 * 「本机 vLLM」共用同一把 key —— 那正是跨厂商串号，排障成本极高。
 * 所以：可识别厂商按 family 分组，无法识别时退化到按端点 host 隔离。
 */
export function credentialGroup(profile: ModelProfile): string {
  const family = detectProviderFamily(profile);
  return family === 'unknown' ? `host:${endpointHost(profile)}` : `family:${family}`;
}

const FAMILY_LABELS: Record<ProviderFamily, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google Gemini',
  deepseek: 'DeepSeek',
  qwen: '通义千问',
  moonshot: 'Kimi',
  zhipu: '智谱 GLM',
  ollama: '本地 Ollama',
  unknown: '自定义端点',
};

/** 供 UI 展示的密钥分组名，如「DeepSeek」或自定义端点的 host */
export function describeCredentialGroup(profile: ModelProfile): string {
  const family = detectProviderFamily(profile);
  return family === 'unknown' ? endpointHost(profile) : FAMILY_LABELS[family];
}

/**
 * 解析密钥并说明来源。
 *
 * 顺序：自己的内联密钥 → 免鉴权端点 → 同厂商族已存的密钥 → 声明的环境变量 → 同族环境变量。
 * 「同厂商族已存密钥」这一级是 v0.0.1 缺失的一环：没有它，用户每换一个同厂模型
 * 都要重新输入同一把 key（实测同一把 DeepSeek key 被重复存了两份）。
 */
export function resolveApiKeyDetailed(
  profile: ModelProfile,
  settings?: Pick<UserSettings, 'profiles'>,
): ResolvedApiKey | undefined {
  if (profile.apiKey?.trim()) {
    return { key: profile.apiKey.trim(), source: 'inline' };
  }
  if (profile.apiKeyEnv === API_KEY_ENV_NONE) {
    return { key: 'none', source: 'none' };
  }

  // 同厂商族复用：交互式输入的密钥是最明确的用户意图，优先于外部环境变量。
  const sibling = findGroupSiblingWithKey(profile, settings);
  if (sibling?.apiKey?.trim()) {
    return { key: sibling.apiKey.trim(), source: 'shared', fromProfileId: sibling.id };
  }

  const envVal = process.env[profile.apiKeyEnv];
  if (envVal?.trim()) {
    return { key: envVal.trim(), source: 'env' };
  }

  // 仅在同族 provider 之间回退。
  // 无条件回退到 OPENAI_API_KEY 会让"拿 OpenAI 的 key 去打 DeepSeek 端点"变成静默行为，
  // 用户只会看到一条没头没尾的 401，排障成本极高。
  const fallbackEnv = FAMILY_KEY_ENV[detectProviderFamily(profile)];
  if (fallbackEnv && fallbackEnv !== profile.apiKeyEnv) {
    const fallbackVal = process.env[fallbackEnv];
    if (fallbackVal?.trim()) return { key: fallbackVal.trim(), source: 'family-env' };
  }
  return undefined;
}

export function resolveApiKey(
  profile: ModelProfile,
  settings?: Pick<UserSettings, 'profiles'>,
): string | undefined {
  return resolveApiKeyDetailed(profile, settings)?.key;
}

/** 在该 profile 所属密钥分组内，找出第一个已配置内联密钥的其它 profile。 */
function findGroupSiblingWithKey(
  profile: ModelProfile,
  settings?: Pick<UserSettings, 'profiles'>,
): ModelProfile | undefined {
  if (!settings || !Array.isArray(settings.profiles)) return undefined;
  const group = credentialGroup(profile);
  return settings.profiles.find(
    (candidate) =>
      candidate.id !== profile.id &&
      Boolean(candidate.apiKey?.trim()) &&
      credentialGroup(candidate) === group,
  );
}

function endpointHost(profile: ModelProfile): string {
  const base = (profile.baseURL || '').trim();
  if (!base) return 'unknown-endpoint';
  try {
    return new URL(base).host.toLowerCase();
  } catch {
    return base.replace(/\/+$/, '').toLowerCase();
  }
}

export interface NormalizeGroupKeysResult {
  /** 被清除冗余副本的 profile id */
  cleared: string[];
  /** 每组保留密钥的 profile id */
  kept: string[];
}

/**
 * 组内归一：同一密钥分组只保留一份密钥。
 *
 * 保留优先级：显式指定 → defaultModel 指向的 profile → 配置中靠前者。
 * 只清理冗余副本，不删除密钥本身（同一把 key 仍在组内留存一份）。
 */
export function normalizeGroupApiKeys(
  settings: UserSettings,
  preferredProfileId?: string,
): NormalizeGroupKeysResult {
  const groups = new Map<string, ModelProfile[]>();
  for (const profile of settings.profiles) {
    if (!profile.apiKey?.trim()) continue;
    const group = credentialGroup(profile);
    const members = groups.get(group);
    if (members) members.push(profile);
    else groups.set(group, [profile]);
  }

  const cleared: string[] = [];
  const kept: string[] = [];
  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const keeper =
      members.find((member) => member.id === preferredProfileId) ??
      members.find((member) => member.id === settings.defaultModel) ??
      members[0]!;
    for (const member of members) {
      if (member.id === keeper.id) continue;
      member.apiKey = undefined;
      cleared.push(member.id);
    }
    kept.push(keeper.id);
  }
  return { cleared, kept };
}

/** 环境变量覆盖端点(设计文档 §5.1.3)：OPENAI_BASE_URL / DEEPSEEK_BASE_URL */
export function resolveBaseURL(profile: ModelProfile): string {
  const envName = FAMILY_BASE_URL_ENV[detectProviderFamily(profile)];
  const override = envName ? process.env[envName]?.trim() : undefined;
  return (override || profile.baseURL || '').replace(/\/+$/, '');
}

export type ProviderFamily =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'qwen'
  | 'moonshot'
  | 'zhipu'
  | 'ollama'
  | 'unknown';

/**
 * 从 profile 的 id / baseURL 推断所属厂商族。
 *
 * 顺序敏感：先认端点 host，再认 id 前缀，最后才落到 openai 的宽泛匹配。
 * 各家 OpenAI 兼容端点里含 'openai' 字样（如 Gemini 的 `/v1beta/openai/`）但不含
 * 'openai.com'，所以 host 级判断不会被误吞。
 */
export function detectProviderFamily(profile: ModelProfile): ProviderFamily {
  const id = profile.id.toLowerCase();
  const base = (profile.baseURL || '').toLowerCase();

  if (base.includes('deepseek') || id.startsWith('deepseek')) return 'deepseek';
  if (base.includes('anthropic.com') || id.startsWith('claude')) return 'anthropic';
  if (base.includes('generativelanguage.googleapis.com') || id.startsWith('gemini')) {
    return 'google';
  }
  if (base.includes('moonshot') || id.startsWith('kimi')) return 'moonshot';
  if (base.includes('bigmodel.cn') || id.startsWith('glm')) return 'zhipu';
  if (base.includes('aliyuncs.com') || id.startsWith('qwen')) return 'qwen';
  if (id === 'ollama' || base.includes('11434')) return 'ollama';
  if (
    id.startsWith('gpt') ||
    id.startsWith('o1') ||
    id.startsWith('o3') ||
    id.startsWith('openai') ||
    base.includes('openai.com')
  ) {
    return 'openai';
  }
  return 'unknown';
}

const FAMILY_KEY_ENV: Partial<Record<ProviderFamily, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  moonshot: 'MOONSHOT_API_KEY',
  zhipu: 'ZHIPU_API_KEY',
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
  if (
    !allowTrustedProjects &&
    (incoming.permissionRules !== undefined ||
      incoming.permissionMode !== undefined ||
      incoming.shell !== undefined)
  ) {
    throw new InvalidPermissionSettings(
      'Project settings cannot define permission or shell execution fields',
    );
  }
  if (allowTrustedProjects) {
    if (incoming.permissionRules !== undefined) {
      if (!Array.isArray(incoming.permissionRules))
        throw new InvalidPermissionSettings('permissionRules must be an array');
      try {
        validatePermissionRules(incoming.permissionRules);
      } catch (error: unknown) {
        throw new InvalidPermissionSettings((error as Error).message);
      }
    }
    if (
      incoming.permissionMode !== undefined &&
      !['Approval', 'Plan', 'Auto', 'FullAccess'].includes(incoming.permissionMode)
    ) {
      throw new InvalidPermissionSettings('Invalid permissionMode');
    }
    if (
      incoming.shell?.preference !== undefined &&
      !isValidShellPreference(incoming.shell.preference)
    ) {
      throw new InvalidPermissionSettings('Invalid shell.preference');
    }
  }
  const profilesMap = new Map<string, ModelProfile>();
  for (const p of base.profiles) profilesMap.set(p.id, p);
  if (Array.isArray(incoming.profiles)) {
    for (const p of incoming.profiles) {
      // 校验失败只剔除该 profile，不拖垮整个配置文件：用户其余的好配置必须继续生效。
      try {
        resolveContextWindow(p.contextWindow);
      } catch (error: unknown) {
        console.warn(
          `[kapibala] Ignoring model profile '${p.id}' with invalid contextWindow: ${(error as Error).message}`,
        );
        continue;
      }
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
    // 不把 base 的版本号当作「已升级」：老配置里缺这个字段时必须继续显示为待升级，
    // 否则迁移判定的触发条件会被默认值抹平，目录永远升不上去。
    builtinCatalogVersion: incoming.builtinCatalogVersion,
    trustedProjects:
      allowTrustedProjects && Array.isArray(incoming.trustedProjects)
        ? incoming.trustedProjects.filter((value): value is string => typeof value === 'string')
        : base.trustedProjects,
    permissionMode: allowTrustedProjects
      ? (incoming.permissionMode ?? base.permissionMode)
      : base.permissionMode,
    permissionRules: allowTrustedProjects
      ? (incoming.permissionRules ?? base.permissionRules)
      : base.permissionRules,
    shell: allowTrustedProjects
      ? incoming.shell || base.shell
        ? { ...base.shell, ...incoming.shell }
        : undefined
      : base.shell,
  };
}

class InvalidPermissionSettings extends Error {}

/** 具名解释器或用户显式提供的解释器可执行文件全路径。 */
function isValidShellPreference(value: string): boolean {
  return (
    ['auto', 'bash', 'wsl', 'pwsh', 'powershell'].includes(value) ||
    /[\\/]/.test(value) ||
    value.toLowerCase().endsWith('.exe')
  );
}

/** 配置进入运行时前统一校验上下文窗口，避免直到展示指标或压缩时才暴露坏值。 */
function validateProfileContextWindows(profiles: ModelProfile[]): void {
  for (const profile of profiles) {
    try {
      resolveContextWindow(profile.contextWindow);
    } catch (error: unknown) {
      throw new Error(
        `Invalid contextWindow for model profile '${profile.id}': ${(error as Error).message}`,
      );
    }
  }
}
