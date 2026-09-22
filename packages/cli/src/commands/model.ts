import { type ModelProfile, resolveContextWindow } from '@kiturone/kapibala';
import { PROVIDER_METAS, providerCategory } from '../providers.js';
import {
  API_KEY_ENV_NONE,
  type LoadSettingsOptions,
  type UserSettings,
  describeCredentialGroup,
  ensureProfile,
  loadGlobalSettingsForWrite,
  resolveApiKeyDetailed,
  saveGlobalSettings,
  updateProfileApiKey,
} from '../settings.js';
import { formatTokenCount } from '../ui/metrics.js';
import { readSecret } from '../ui/secret.js';
import { type SelectOption, select } from '../ui/select.js';
import { runSetupWizard } from '../wizard.js';
import type { CommandHandler } from './dispatcher.js';

export interface UpdateModelApiKeyOptions {
  secretReader?: (prompt: string) => Promise<string>;
  saveSettings?: typeof saveGlobalSettings;
  globalSettings?: UserSettings;
  homeDir?: LoadSettingsOptions['homeDir'];
}

/**
 * 取一份**磁盘原始**的全局配置用于写回。
 *
 * 不能用 loadSettings().settings：它已经和 BUILTIN_PROFILES 合并过，整份写回会把用户
 * 从未启用的内置模型全部物化进配置文件。文件不存在时由 loadGlobalSettingsForWrite
 * 退回空骨架；文件存在但损坏/含非法值时直接抛错，绝不能静默回退骨架 ——
 * 否则下一次写盘会把用户的全部 profile（含内联 apiKey）无声清空。
 */
function globalSettingsForWrite(options: UpdateModelApiKeyOptions): UserSettings {
  if (options.globalSettings) return options.globalSettings;
  return loadGlobalSettingsForWrite({ homeDir: options.homeDir });
}

export async function updateModelApiKey(
  profile: ModelProfile,
  ctx: Parameters<CommandHandler>[1],
  options: UpdateModelApiKeyOptions = {},
): Promise<boolean> {
  const secretReader = options.secretReader ?? ctx.readSecret ?? readSecret;
  const apiKey = (await secretReader(`请输入 ${profile.name} 的新 API Key: `)).trim();
  if (!apiKey) {
    console.log('\x1b[33mAPI Key 为空，已取消更新。\x1b[0m');
    return false;
  }

  updateProfileApiKey(ctx.settings, profile.id, apiKey);

  const globalSettings = globalSettingsForWrite(options);
  const globalProfile = globalSettings.profiles.find((candidate) => candidate.id === profile.id);
  if (globalProfile) {
    // 走 updateProfileApiKey 而非直接赋值：让磁盘配置同样执行组内归一，
    // 否则会残留同厂商族的旧密钥副本，下次加载时与该密钥双源并存。
    updateProfileApiKey(globalSettings, profile.id, apiKey);
  } else {
    globalSettings.profiles.push({ ...profile, apiKey });
  }
  const savedPath = (options.saveSettings ?? saveGlobalSettings)(globalSettings, {
    homeDir: options.homeDir,
  });
  if (ctx.session.getActiveProfile().id === profile.id) {
    ctx.onModelSwitched(profile.id);
  }
  console.log(`\x1b[32m✔ 已更新 '${profile.name}' 的 API Key：${savedPath}\x1b[0m`);
  console.log(
    `\x1b[90m  ${describeCredentialGroup(profile)} 下的其它模型将自动复用该密钥，无需重复输入。\x1b[0m`,
  );
  return true;
}

async function ensureApiKey(
  profile: ModelProfile,
  ctx: Parameters<CommandHandler>[1],
): Promise<boolean> {
  const resolved = resolveApiKeyDetailed(profile, ctx.settings);
  if (resolved) {
    if (resolved.source === 'shared') {
      // 让隐式复用显式可见：否则用户会误以为该模型有自己的密钥，更新时找错入口
      console.log(
        `\x1b[90m🔑 复用 ${describeCredentialGroup(profile)} 的 API Key（来自 '${resolved.fromProfileId}'）\x1b[0m`,
      );
    }
    return true;
  }
  console.log(`\x1b[33m模型 '${profile.name}' 尚未配置 API Key，请先补录。\x1b[0m`);
  return updateModelApiKey(profile, ctx);
}

/** 把「当前模型 / 指定模型」写为全局默认，只落盘用户自有的 profile，不物化整份内置清单。 */
function persistDefaultModel(profile: ModelProfile, ctx: Parameters<CommandHandler>[1]): void {
  ctx.settings.defaultModel = profile.id;
  const globalSettings = globalSettingsForWrite({});
  ensureProfile(globalSettings, profile);
  globalSettings.defaultModel = profile.id;
  saveGlobalSettings(globalSettings);
}

/**
 * 菜单里直接暴露密钥就绪状态。
 * 等到切换时才弹输入框，用户无法预知哪些厂商已配好、哪些还要输。
 */
function describeKeyStatus(models: ModelProfile[], settings: UserSettings): string {
  if (models.length === 0) return '无模型';
  if (models.every((model) => model.apiKeyEnv === API_KEY_ENV_NONE)) return '免密钥';
  const resolved = models.map((model) => resolveApiKeyDetailed(model, settings));
  if (resolved.some((item) => item?.source === 'inline' || item?.source === 'shared')) {
    return '🔑 已配置密钥';
  }
  if (resolved.some((item) => item?.source === 'env' || item?.source === 'family-env')) {
    return '🔑 密钥来自环境变量';
  }
  return '⚠️ 未配置密钥';
}

export const modelCommand: CommandHandler = async (args, ctx) => {
  const target = args[0];

  // 0. `/model key [profile-id]` 主动更新当前或指定模型的密钥
  if (target === 'key') {
    const profileId = args[1] ?? ctx.session.getActiveProfile().id;
    const profile = ctx.settings.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) {
      console.log(`\x1b[31m未找到模型 Profile '${profileId}'。\x1b[0m`);
      return;
    }
    if (profile.apiKeyEnv === API_KEY_ENV_NONE) {
      console.log(`\x1b[90m模型 '${profile.name}' 不需要 API Key。\x1b[0m`);
      return;
    }
    await updateModelApiKey(profile, ctx);
    return;
  }

  // 1. 若输入 `/model setup`，直接启动配置向导
  if (target === 'setup') {
    const { profile } = await runSetupWizard();
    ctx.onModelSwitched(profile.id);
    return;
  }

  // 2. 若输入 `/model set-default <id>`
  if (target === 'set-default' && args[1]) {
    const defaultId = args[1];
    const found = ctx.settings.profiles.find((p) => p.id === defaultId);
    if (!found) {
      console.log(`\x1b[31m未找到模型 Profile '${defaultId}'。\x1b[0m`);
      return;
    }
    ctx.settings.defaultModel = defaultId;
    persistDefaultModel(found, ctx);
    console.log(`\x1b[32m✔ 已将 '${found.name}' 设为全局默认模型。\x1b[0m`);
    return;
  }

  // 3. 若直接传入了 `<id>`，支持高级命令行直切
  if (target) {
    const profile = ctx.settings.profiles.find((p) => p.id === target);
    if (!profile) {
      console.log(
        `\x1b[31m未找到模型 Profile '${target}'。直接输入 /model 打开分级选择菜单。\x1b[0m`,
      );
      return;
    }

    if (!(await ensureApiKey(profile, ctx))) return;

    ctx.onModelSwitched(profile.id);
    console.log(`\x1b[32m✔ 已切换至模型: ${profile.name} (${profile.modelName})\x1b[0m`);
    return;
  }

  // 4. 若无参数输入 `/model`：启动两步分级交互菜单 (第一步选 Provider，第二步选具体模型)
  const active = ctx.session.getActiveProfile();
  const currentProviderKey = providerCategory(active);

  while (true) {
    // -------------------------------------------------------------
    // 第一步：选择模型提供商 (Provider)
    // -------------------------------------------------------------
    const providerOptions: SelectOption<string>[] = [];

    for (const meta of PROVIDER_METAS) {
      const models = ctx.settings.profiles.filter((p) => providerCategory(p) === meta.key);
      if (models.length > 0) {
        const isCurrent = meta.key === currentProviderKey;
        providerOptions.push({
          label: meta.name,
          value: meta.key,
          badge: isCurrent ? '当前提供商' : undefined,
          description: `${meta.desc} · ${models.length}个模型 · ${describeKeyStatus(models, ctx.settings)}`,
        });
      }
    }

    // 快捷操作选项
    providerOptions.push({
      label: '⚙️ 运行配置向导添加/配置新模型 (/model setup)',
      value: '__action_setup__',
    });

    providerOptions.push({
      label: `🔑 更新当前模型 [${active.name}] 的 API Key`,
      value: '__action_update_key__',
    });

    providerOptions.push({
      label: `⭐️ 将当前模型 [${active.name}] 设为全局默认`,
      value: '__action_set_default__',
    });

    const defaultProviderIdx = providerOptions.findIndex((o) => o.value === currentProviderKey);

    const chosenProvider = await select({
      message: '第一步：请选择模型提供商 (Provider)',
      options: providerOptions,
      defaultIndex: defaultProviderIdx >= 0 ? defaultProviderIdx : 0,
    });

    if (!chosenProvider) {
      // 用户按 Esc / Ctrl+C 取消
      return;
    }

    if (chosenProvider === '__action_setup__') {
      const { profile } = await runSetupWizard();
      ctx.onModelSwitched(profile.id);
      return;
    }

    if (chosenProvider === '__action_set_default__') {
      persistDefaultModel(active, ctx);
      console.log(`\x1b[32m✔ 已将 '${active.name}' 保存为全局默认模型。\x1b[0m`);
      return;
    }

    if (chosenProvider === '__action_update_key__') {
      if (active.apiKeyEnv === API_KEY_ENV_NONE) {
        console.log(`\x1b[90m模型 '${active.name}' 不需要 API Key。\x1b[0m`);
      } else {
        await updateModelApiKey(active, ctx);
      }
      return;
    }

    // -------------------------------------------------------------
    // 第二步：选择该提供商下的具体模型
    // -------------------------------------------------------------
    const providerMeta = PROVIDER_METAS.find((m) => m.key === chosenProvider);
    const providerName = providerMeta ? providerMeta.name : chosenProvider;
    const modelsUnderProvider = ctx.settings.profiles.filter(
      (p) => providerCategory(p) === chosenProvider,
    );

    const modelOptions: SelectOption<string>[] = modelsUnderProvider.map((p) => {
      let badge: string | undefined;
      if (p.id === active.id) {
        badge = '当前使用';
      } else if (p.id === ctx.settings.defaultModel) {
        badge = '默认';
      }

      const thinkingTag = p.supportsThinking ? ' | 深度思考' : '';
      const contextWindow = resolveContextWindow(p.contextWindow);
      const contextTag = ` | ${contextWindow.estimated ? '≈' : ''}${formatTokenCount(contextWindow.tokens)}`;

      return {
        label: p.name,
        value: p.id,
        badge,
        description: `${p.modelName}${contextTag}${thinkingTag} · ${describeKeyStatus([p], ctx.settings)}`,
      };
    });

    // 增加返回上一级选项
    modelOptions.push({
      label: '⬅️ 返回上一级 (重新选择提供商)',
      value: '__back__',
    });

    const activeModelIdx = modelsUnderProvider.findIndex((p) => p.id === active.id);

    const chosenModel = await select({
      message: `第二步：请选择【${providerName}】的具体模型`,
      options: modelOptions,
      defaultIndex: activeModelIdx >= 0 ? activeModelIdx : 0,
    });

    if (!chosenModel) {
      // 用户取消
      return;
    }

    if (chosenModel === '__back__') {
      // 返回第一步重新选择提供商
      continue;
    }

    if (chosenModel === active.id) {
      console.log(`\x1b[90m当前已在使用模型 '${active.name}'。\x1b[0m`);
      return;
    }

    // 成功选择具体模型，进行切换
    const targetProfile = ctx.settings.profiles.find((p) => p.id === chosenModel);
    if (targetProfile) {
      if (!(await ensureApiKey(targetProfile, ctx))) return;
      ctx.onModelSwitched(targetProfile.id);
      console.log(
        `\x1b[32m✔ 已切换至模型: ${targetProfile.name} (${targetProfile.modelName})\x1b[0m`,
      );
    }
    return;
  }
};
