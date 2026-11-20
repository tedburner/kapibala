import type { ModelProfile } from '@kiturone/kapibala';
import { BUILTIN_PROFILES, detectProviderFamily } from './settings.js';

/**
 * 厂商展示元数据。
 *
 * 单独成模块是因为它同时被 `/model` 分级菜单和冷启动向导消费 —— 之前两个调用点各自
 * 硬编码了一份厂商/模型清单，加一家厂商要改两处，改漏一处就只剩一边能看到。
 * `key` 必须与 `detectProviderFamily` 的返回值一致；用户自定义厂商用 `custom:<slug>`
 * 动态键（见 {@link providerCategory}），通用兜底桶固定为 'custom'。
 */
export interface ProviderMeta {
  key: string;
  name: string;
  desc: string;
  /** 冷启动向导索要密钥时的提示语；免密钥厂商为空串 */
  keyPrompt: string;
  /**
   * 是否为用户自建端点分组（自定义厂商或通用兜底桶）。
   * 桌面设置页据此渲染「自定义」标签并放开端点/厂商名编辑；内置厂商恒为 false/缺省。
   */
  custom?: boolean;
}

/** 无法识别厂商（自建网关等）在菜单与向导中的统一分组键。 */
export const CUSTOM_PROVIDER_KEY = 'custom';

/** 自定义厂商分组键前缀；与内置厂商 key 及通用 custom 桶都不会冲突。 */
export const CUSTOM_VENDOR_KEY_PREFIX = `${CUSTOM_PROVIDER_KEY}:`;

/**
 * 厂商展示元数据，顺序即 /model 菜单与冷启动向导的呈现顺序。
 * `key` 必须能被 detectProviderFamily 识别（或就是 custom），否则该分组在菜单里永远为空；
 * 新增厂商只改这里与内置清单，不要在命令层另备一份模型 id 清单。
 */
export const PROVIDER_METAS: ProviderMeta[] = [
  {
    key: 'deepseek',
    name: 'DeepSeek',
    desc: 'DeepSeek Flash / V4 Pro',
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
    custom: true,
  },
];

/**
 * 把用户填写的厂商名压成分组键后缀。
 *
 * 大小写、空白与标点差异必须归一，否则「magpie」「Magpie」「magpie 」会被拆成三个分组；
 * 只保留字母/数字并折叠分隔符，保证键能安全出现在选择器值里。空名返回 undefined，
 * 由调用方退回通用 custom 桶。
 */
function vendorKeySuffix(vendorName: string | undefined): string | undefined {
  const slug = (vendorName ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || undefined;
}

/**
 * 菜单分组键：可识别厂商用 family；自建端点若填了厂商名则独立成组（custom:<slug>），
 * 否则归到通用 custom 桶。
 */
export function providerCategory(profile: ModelProfile): string {
  const family = detectProviderFamily(profile);
  if (family !== 'unknown') return family;
  const suffix = vendorKeySuffix(profile.vendorName);
  return suffix ? `${CUSTOM_VENDOR_KEY_PREFIX}${suffix}` : CUSTOM_PROVIDER_KEY;
}

/**
 * 目录所需的厂商分组清单：内置厂商保持固定顺序，用户自定义的厂商按名称排序后
 * 插在通用「自定义端点 / 其它」之前。
 *
 * 动态分组的键必须与 {@link providerCategory} 从同一 vendorName 派生的结果一致，
 * 否则桌面左栏会出现「有模型却点不进」的空分组。内置厂商无论有无模型都会返回，
 * 通用兜底桶固定在末尾，供用户新建自定义模型。
 */
export function listProviderMetas(profiles: readonly ModelProfile[]): ProviderMeta[] {
  const builtins = PROVIDER_METAS.filter((meta) => meta.key !== CUSTOM_PROVIDER_KEY);
  const fallback = PROVIDER_METAS.find((meta) => meta.key === CUSTOM_PROVIDER_KEY)!;
  const dynamic = new Map<string, ProviderMeta>();
  for (const profile of profiles) {
    const key = providerCategory(profile);
    const name = profile.vendorName?.trim();
    if (!name || !key.startsWith(CUSTOM_VENDOR_KEY_PREFIX) || dynamic.has(key)) continue;
    dynamic.set(key, {
      key,
      name,
      desc: '自定义端点',
      keyPrompt: fallback.keyPrompt,
      custom: true,
    });
  }
  const sorted = [...dynamic.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return [...builtins, ...sorted, fallback];
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
