import { type ModelProfile, type ModelRole, resolveContextWindow } from '@kiturone/kapibala';
import {
  ROUTABLE_MODEL_ROLES,
  createModelBinding,
  parsePrimaryModelRole,
} from '@kiturone/kapibala-host/internal';
import { PROVIDER_METAS, providerCategory } from '@kiturone/kapibala-host/internal';
import {
  API_KEY_ENV_NONE,
  type LoadSettingsOptions,
  type UserSettings,
  credentialGroup,
  describeCredentialGroup,
  ensureProfile,
  mutateGlobalSettings,
  resolveApiKeyDetailed,
  updateProfileApiKey,
} from '@kiturone/kapibala-host/internal';
import { resolveCommandOutput } from '../command-output.js';
import { persistDefaultModel, persistModelRole } from '../default-model.js';
import { isInteractiveTerminal } from '../input-coordinator.js';
import { formatTokenCount } from '../ui/metrics.js';
import type { SelectOption } from '../ui/select.js';
import type { CommandHandler } from './dispatcher.js';
import { settingsCommand } from './settings.js';

/**
 * {@link updateModelApiKey} 的注入点，供测试与宿主替换密钥读取和配置写入。
 * `globalSettings` 仅作为成功提交后的内存镜像；注入点替换整个短事务而非裸写盘。
 */
export interface UpdateModelApiKeyOptions {
  secretReader?: (prompt: string) => Promise<string>;
  mutateSettings?: typeof mutateGlobalSettings;
  globalSettings?: UserSettings;
  homeDir?: LoadSettingsOptions['homeDir'];
}

/**
 * 交互式更新模型密钥：读取输入后经 updateProfileApiKey 写入全局配置（同组冗余副本自动归一），
 * 再同步内存中的有效设置并通知宿主。非交互环境必须显式提供 secretReader，否则抛错。
 * 返回 false 表示用户输入了空密钥而取消，不算失败。
 */
export async function updateModelApiKey(
  profile: ModelProfile,
  ctx: Parameters<CommandHandler>[1],
  options: UpdateModelApiKeyOptions = {},
): Promise<boolean> {
  if (!options.secretReader && !isInteractiveTerminal())
    throw new Error('非交互环境不能等待密钥输入，请通过厂商环境变量或全局设置配置。');
  if (!options.secretReader && !ctx.readSecret)
    throw new Error('秘密输入不可用，请在交互终端配置密钥或使用厂商环境变量');
  const secretReader = (options.secretReader ?? ctx.readSecret)!;
  const apiKey = (await secretReader(`请输入 ${profile.name} 的新 API Key: `)).trim();
  if (!apiKey) {
    resolveCommandOutput(ctx).log('\x1b[33mAPI Key 为空，已取消更新。\x1b[0m');
    return false;
  }

  let committed: UserSettings | undefined;
  const change = (draft: UserSettings) => {
    ensureProfile(draft, profile);
    updateProfileApiKey(draft, profile.id, apiKey);
    committed = draft;
  };
  const savedPath = (options.mutateSettings ?? mutateGlobalSettings)(change, {
    homeDir: options.homeDir,
  });
  if (options.globalSettings && options.globalSettings !== ctx.settings)
    Object.assign(options.globalSettings, committed);
  updateProfileApiKey(ctx.settings, profile.id, apiKey);
  if (ctx.onCredentialsUpdated) {
    ctx.onCredentialsUpdated(profile.id);
  } else {
    const active = ctx.session.getActiveProfile();
    if (credentialGroup(active) === credentialGroup(profile)) ctx.onModelSwitched(active.id);
  }
  resolveCommandOutput(ctx).log(
    `\x1b[32m✔ 已更新 '${profile.name}' 的 API Key：${savedPath}\x1b[0m`,
  );
  resolveCommandOutput(ctx).log(
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
      resolveCommandOutput(ctx).log(
        `\x1b[90m🔑 复用 ${describeCredentialGroup(profile)} 的 API Key（来自 '${resolved.fromProfileId}'）\x1b[0m`,
      );
    }
    return true;
  }
  resolveCommandOutput(ctx).log(
    `\x1b[33m模型 '${profile.name}' 尚未配置 API Key，请先补录。\x1b[0m`,
  );
  return updateModelApiKey(profile, ctx);
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

/**
 * `/model` 入口：`key [id]` 更新密钥、`<角色> <id>` 绑定角色、`route <role>` 选择主任务角色，
 * 兼容 `setup` / `set-default` 子命令；无参数时非 TTY 输出只读列表，TTY 进入分级选择菜单。
 * 切换与绑定前都先确保密钥就绪，缺密钥时引导补录，补录取消则整体中止。
 */
export const modelCommand: CommandHandler = async (args, ctx) => {
  const target = args[0];

  if (target === 'route') {
    const role = parsePrimaryModelRole(args[1]);
    if (!ctx.onRoleSelected) throw new Error('当前宿主不支持模型角色选择');
    ctx.onRoleSelected(role);
    resolveCommandOutput(ctx).log(`✔ 当前主任务角色: ${role}`);
    return;
  }
  if (ROUTABLE_MODEL_ROLES.includes(target as never)) {
    const role = target as Exclude<ModelRole, 'default'>;
    const profile = ctx.settings.profiles.find((candidate) => candidate.id === args[1]);
    if (!profile) throw new Error(`未找到模型 Profile '${args[1]}'`);
    if (!ctx.onRoleBound) throw new Error('当前宿主不支持模型角色绑定');
    if (!(await ensureApiKey(profile, ctx))) return;
    createModelBinding(profile, ctx.settings);
    persistModelRole(profile, role, ctx.settings);
    ctx.onRoleBound(role, profile.id);
    resolveCommandOutput(ctx).log(`✔ 已绑定 ${role}: ${profile.name} (${profile.id})`);
    return;
  }

  // 0. `/model key [profile-id]` 主动更新当前或指定模型的密钥
  if (target === 'key') {
    const profileId = args[1] ?? ctx.session.getActiveProfile().id;
    const profile = ctx.settings.profiles.find((candidate) => candidate.id === profileId);
    if (!profile) {
      resolveCommandOutput(ctx).log(`\x1b[31m未找到模型 Profile '${profileId}'。\x1b[0m`);
      return;
    }
    if (profile.apiKeyEnv === API_KEY_ENV_NONE) {
      resolveCommandOutput(ctx).log(`\x1b[90m模型 '${profile.name}' 不需要 API Key。\x1b[0m`);
      return;
    }
    await updateModelApiKey(profile, ctx);
    return;
  }

  // 1. 若输入 `/model setup`，直接启动配置向导
  if (target === 'setup') {
    await settingsCommand(['setup'], ctx);
    return;
  }

  // 2. 若输入 `/model set-default <id>`
  if (target === 'set-default' && args[1]) {
    const defaultId = args[1];
    const found = ctx.settings.profiles.find((p) => p.id === defaultId);
    if (!found) {
      resolveCommandOutput(ctx).log(`\x1b[31m未找到模型 Profile '${defaultId}'。\x1b[0m`);
      return;
    }
    persistDefaultModel(found, ctx.settings);
    resolveCommandOutput(ctx).log(`\x1b[32m✔ 已将 '${found.name}' 设为全局默认模型。\x1b[0m`);
    return;
  }

  // 3. 若直接传入了 `<id>`，支持高级命令行直切
  if (target) {
    const profile = ctx.settings.profiles.find((p) => p.id === target);
    if (!profile) {
      resolveCommandOutput(ctx).log(
        `\x1b[31m未找到模型 Profile '${target}'。直接输入 /model 打开分级选择菜单。\x1b[0m`,
      );
      return;
    }

    if (!(await ensureApiKey(profile, ctx))) return;

    ctx.onModelSwitched(profile.id);
    resolveCommandOutput(ctx).log(
      `\x1b[32m✔ 已切换至模型: ${profile.name} (${profile.modelName})\x1b[0m`,
    );
    return;
  }

  // 4. 若无参数输入 `/model`：启动两步分级交互菜单 (第一步选 Provider，第二步选具体模型)
  const active = ctx.session.getActiveProfile();
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    resolveCommandOutput(ctx).log(
      `当前角色: ${ctx.session.getModelRole?.() ?? 'default'} | 模型: ${active.id} (${active.name})`,
    );
    for (const profile of ctx.settings.profiles)
      resolveCommandOutput(ctx).log(`  ${profile.id}: ${profile.name}`);
    resolveCommandOutput(ctx).log('使用 /model <id> 切换模型。');
    return;
  }
  if (!ctx.select) throw new Error('交互输入不可用，请使用 /model <id>');
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

    const chosenProvider = await ctx.select({
      message: '第一步：请选择模型提供商 (Provider)',
      options: providerOptions,
      defaultIndex: defaultProviderIdx >= 0 ? defaultProviderIdx : 0,
    });

    if (!chosenProvider) {
      // 用户按 Esc / Ctrl+C 取消
      return;
    }

    if (chosenProvider === '__action_setup__') {
      await settingsCommand(['setup'], ctx);
      return;
    }

    if (chosenProvider === '__action_set_default__') {
      persistDefaultModel(active, ctx.settings);
      resolveCommandOutput(ctx).log(`\x1b[32m✔ 已将 '${active.name}' 保存为全局默认模型。\x1b[0m`);
      return;
    }

    if (chosenProvider === '__action_update_key__') {
      if (active.apiKeyEnv === API_KEY_ENV_NONE) {
        resolveCommandOutput(ctx).log(`\x1b[90m模型 '${active.name}' 不需要 API Key。\x1b[0m`);
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

      const contextWindow = resolveContextWindow(p.contextWindow);
      const contextTag = ` | ${contextWindow.estimated ? '≈' : ''}${formatTokenCount(contextWindow.tokens)}`;

      return {
        label: p.name,
        value: p.id,
        badge,
        description: `${p.modelName}${contextTag} · ${describeKeyStatus([p], ctx.settings)}`,
      };
    });

    // 增加返回上一级选项
    modelOptions.push({
      label: '⬅️ 返回上一级 (重新选择提供商)',
      value: '__back__',
    });

    const activeModelIdx = modelsUnderProvider.findIndex((p) => p.id === active.id);

    const chosenModel = await ctx.select({
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

    if (chosenModel === active.id && (ctx.session.getModelRole?.() ?? 'default') === 'default') {
      resolveCommandOutput(ctx).log(`\x1b[90m当前已在使用模型 '${active.name}'。\x1b[0m`);
      return;
    }

    // 成功选择具体模型，进行切换
    const targetProfile = ctx.settings.profiles.find((p) => p.id === chosenModel);
    if (targetProfile) {
      if (!(await ensureApiKey(targetProfile, ctx))) return;
      ctx.onModelSwitched(targetProfile.id);
      resolveCommandOutput(ctx).log(
        `\x1b[32m✔ 已切换至模型: ${targetProfile.name} (${targetProfile.modelName})\x1b[0m`,
      );
    }
    return;
  }
};
