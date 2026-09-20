import type { ModelProfile } from '@kiturone/kapibala';
import { BUILTIN_PROFILES, detectProviderFamily } from './settings.js';

/**
 * 厂商展示元数据。
 *
 * 单独成模块是因为它同时被 `/model` 分级菜单和冷启动向导消费 —— 之前两个调用点各自
 * 硬编码了一份厂商/模型清单，加一家厂商要改两处，改漏一处就只剩一边能看到。
 * `key` 必须与 `detectProviderFamily` 的返回值一致（自定义桶统一用 'custom'）。
 */
export interface ProviderMeta {
  key: string;
  name: string;
  desc: string;
  /** 冷启动向导索要密钥时的提示语；免密钥厂商为空串 */
  keyPrompt: string;
}

export const CUSTOM_PROVIDER_KEY = 'custom';

export const PROVIDER_METAS: ProviderMeta[] = [
  {
    key: 'deepseek',
    name: 'DeepSeek',
    desc: '国内直连、极速响应与旗舰推理能力',
    keyPrompt: '请输入您的 DeepSeek API Key (sk-...): ',
  },
  {
    key: 'openai',
    name: 'OpenAI',
    desc: 'GPT-6 Astra / GPT-5.6 Sol·Terra·Luna',
    keyPrompt: '请输入您的 OpenAI API Key (sk-...): ',
  },
  {
    key: 'anthropic',
    name: 'Anthropic Claude',
    desc: 'Fable 5.1 / Opus 5 / Sonnet 5 / Haiku 4.5',
    keyPrompt: '请输入您的 Anthropic API Key (sk-ant-...): ',
  },
  {
    key: 'google',
    name: 'Google Gemini',
    desc: 'Gemini 3.1 Pro / Gemini 3 Flash',
    keyPrompt: '请输入您的 Gemini API Key (AIza...): ',
  },
  {
    key: 'qwen',
    name: '通义千问 (Qwen)',
    desc: '阿里云官方 DashScope 兼容模式',
    keyPrompt: '请输入您的 DashScope API Key (sk-...): ',
  },
  {
    key: 'moonshot',
    name: 'Kimi (月之暗面)',
    desc: 'Kimi K3 / K2.7 Code',
    keyPrompt: '请输入您的 Moonshot API Key (sk-...): ',
  },
  {
    key: 'zhipu',
    name: '智谱 GLM',
    desc: 'GLM-5.3 / GLM-5.3-Flash',
    keyPrompt: '请输入您的智谱 API Key: ',
  },
  {
    key: 'ollama',
    name: '本地 Ollama',
    desc: '完全本地运行开源模型，无须 API Key',
    keyPrompt: '',
  },
  {
    key: CUSTOM_PROVIDER_KEY,
    name: '自定义端点 / 其它',
    desc: 'OneAPI / vLLM / 其它第三方代理',
    keyPrompt: '请输入 API Key: ',
  },
];

/** 菜单分组键：可识别厂商用 family，其余（自建网关等）统一归到 custom。 */
export function providerCategory(profile: ModelProfile): string {
  const family = detectProviderFamily(profile);
  return family === 'unknown' ? CUSTOM_PROVIDER_KEY : family;
}

/** 内置清单里实际存在模型的厂商（不含自定义桶），供向导渲染可选列表。 */
export function listBuiltinProviders(): Array<{ meta: ProviderMeta; models: ModelProfile[] }> {
  return PROVIDER_METAS.filter((meta) => meta.key !== CUSTOM_PROVIDER_KEY)
    .map((meta) => ({
      meta,
      models: BUILTIN_PROFILES.filter((profile) => providerCategory(profile) === meta.key),
    }))
    .filter((entry) => entry.models.length > 0);
}
