import type { ModelProfile } from '@kiturone/kapibala';
import { detectProviderFamily, resolveApiKey, saveGlobalSettings } from '../settings.js';
import { type SelectOption, select } from '../ui/select.js';
import { runSetupWizard } from '../wizard.js';
import type { CommandHandler } from './dispatcher.js';

interface ProviderMeta {
  key: string;
  name: string;
  desc: string;
}

const PROVIDER_METAS: ProviderMeta[] = [
  {
    key: 'deepseek',
    name: 'DeepSeek',
    desc: '国内直连、极速响应与旗舰推理能力',
  },
  {
    key: 'openai',
    name: 'OpenAI',
    desc: '官方最新 GPT-4o / o3-mini',
  },
  {
    key: 'qwen',
    name: '通义千问 (Qwen)',
    desc: '阿里云官方 DashScope 兼容模式',
  },
  {
    key: 'ollama',
    name: '本地 Ollama',
    desc: '完全本地运行开源模型，无须 API Key',
  },
  {
    key: 'custom',
    name: '自定义端点 / 其它',
    desc: 'OneAPI / vLLM / 其它第三方代理',
  },
];

/** 复用 settings 层的厂商族推断，避免两处启发式规则各自漂移 */
function getProviderCategory(profile: ModelProfile): string {
  const family = detectProviderFamily(profile);
  return family === 'unknown' ? 'custom' : family;
}

export const modelCommand: CommandHandler = async (args, ctx) => {
  const target = args[0];

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
    saveGlobalSettings(ctx.settings);
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

    const key = resolveApiKey(profile);
    if (!key && profile.apiKeyEnv !== 'NONE') {
      console.log(
        `\x1b[33m警告: 切换到 '${profile.name}' 但未检测到有效密钥 (${profile.apiKeyEnv})。可能无法正常请求。\x1b[0m`,
      );
    }

    ctx.onModelSwitched(profile.id);
    console.log(`\x1b[32m✔ 已切换至模型: ${profile.name} (${profile.modelName})\x1b[0m`);
    return;
  }

  // 4. 若无参数输入 `/model`：启动两步分级交互菜单 (第一步选 Provider，第二步选具体模型)
  const active = ctx.session.getActiveProfile();
  const currentProviderKey = getProviderCategory(active);

  while (true) {
    // -------------------------------------------------------------
    // 第一步：选择模型提供商 (Provider)
    // -------------------------------------------------------------
    const providerOptions: SelectOption<string>[] = [];

    for (const meta of PROVIDER_METAS) {
      const models = ctx.settings.profiles.filter((p) => getProviderCategory(p) === meta.key);
      if (models.length > 0) {
        const isCurrent = meta.key === currentProviderKey;
        providerOptions.push({
          label: meta.name,
          value: meta.key,
          badge: isCurrent ? '当前提供商' : undefined,
          description: `${meta.desc} (${models.length}个模型)`,
        });
      }
    }

    // 快捷操作选项
    providerOptions.push({
      label: '⚙️ 运行配置向导添加/配置新模型 (/model setup)',
      value: '__action_setup__',
    });

    providerOptions.push({
      label: `⭐️ 将当前模型 [${active.name}] 设为全局默认`,
      value: '__action_set_default__',
    });

    const defaultProviderIdx = Math.max(
      0,
      providerOptions.findIndex((o) => o.value === currentProviderKey),
    );

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
      ctx.settings.defaultModel = active.id;
      saveGlobalSettings(ctx.settings);
      console.log(`\x1b[32m✔ 已将 '${active.name}' 保存为全局默认模型。\x1b[0m`);
      return;
    }

    // -------------------------------------------------------------
    // 第二步：选择该提供商下的具体模型
    // -------------------------------------------------------------
    const providerMeta = PROVIDER_METAS.find((m) => m.key === chosenProvider);
    const providerName = providerMeta ? providerMeta.name : chosenProvider;
    const modelsUnderProvider = ctx.settings.profiles.filter(
      (p) => getProviderCategory(p) === chosenProvider,
    );

    const modelOptions: SelectOption<string>[] = modelsUnderProvider.map((p) => {
      let badge: string | undefined;
      if (p.id === active.id) {
        badge = '当前使用';
      } else if (p.id === ctx.settings.defaultModel) {
        badge = '默认';
      }

      const thinkingTag = p.supportsThinking ? ' | 深度思考' : '';
      const contextTag = p.contextWindow ? ` | ${Math.round(p.contextWindow / 1000)}k` : '';

      return {
        label: p.name,
        value: p.id,
        badge,
        description: `${p.modelName}${contextTag}${thinkingTag}`,
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
      const key = resolveApiKey(targetProfile);
      if (!key && targetProfile.apiKeyEnv !== 'NONE') {
        console.log(
          `\x1b[33m警告: 切换到 '${targetProfile.name}' 但未检测到有效密钥 (${targetProfile.apiKeyEnv})。可能无法正常请求。\x1b[0m`,
        );
      }
      ctx.onModelSwitched(targetProfile.id);
      console.log(
        `\x1b[32m✔ 已切换至模型: ${targetProfile.name} (${targetProfile.modelName})\x1b[0m`,
      );
    }
    return;
  }
};
