import { stdin as input, stdout as output } from 'node:process';
import readline from 'node:readline/promises';
import type { ModelProfile } from '@kiturone/kapibala';
import {
  BUILTIN_PROFILES,
  type UserSettings,
  loadSettings,
  resolveBaseURL,
  saveGlobalSettings,
} from './settings.js';

export interface ProbeResult {
  status: 'ok' | 'auth' | 'unreachable';
  detail: string;
}

/**
 * 从名称 + 端点派生稳定的 profile id。
 * 固定用 'custom' 会让第二个自定义端点直接覆盖第一个 —— 用户以为加了新模型，实际丢了旧的。
 */
export function makeCustomProfileId(name: string, baseURL: string): string {
  const slug = `${name}-${baseURL}`
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug ? `custom-${slug}` : `custom-${Date.now()}`;
}

/**
 * 轻量连通性探测：GET {baseURL}/models。
 * 只做只读探测，不产生任何计费 token；判定结果不阻塞配置保存。
 */
export async function probeEndpoint(profile: ModelProfile, apiKey: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  const baseURL = resolveBaseURL(profile);
  const url = `${baseURL}/models`;

  try {
    const headers: Record<string, string> = {};
    if (apiKey && apiKey !== 'none') {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const response = await fetch(url, { method: 'GET', headers, signal: controller.signal });
    if (response.ok) {
      return { status: 'ok', detail: `HTTP ${response.status}` };
    }
    if (response.status === 401 || response.status === 403) {
      return { status: 'auth', detail: `HTTP ${response.status} ${response.statusText}` };
    }
    return {
      status: 'unreachable',
      detail: `HTTP ${response.status} ${response.statusText} (端点可能未实现 GET /models)`,
    };
  } catch (err: unknown) {
    return { status: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function runSetupWizard(): Promise<{ profile: ModelProfile; apiKey: string }> {
  const rl = readline.createInterface({ input, output });

  console.log('\n🐾 \x1b[36m欢迎使用 Kapibala (kpbl)!\x1b[0m');
  console.log('检测到当前尚未配置可用的模型服务。请选择您要使用的默认提供商：\n');
  console.log('  1) \x1b[32mDeepSeek V4 Flash\x1b[0m (推荐默认，极速响应、通用能力)');
  console.log('  2) \x1b[32mDeepSeek V4 Pro\x1b[0m (深度推理与旗舰思考链)');
  console.log('  3) \x1b[34mOpenAI GPT-4o\x1b[0m (官方最新旗舰)');
  console.log('  4) \x1b[33m通义千问 Qwen Plus\x1b[0m (阿里云官方兼容端点)');
  console.log('  5) \x1b[36m本地 Ollama\x1b[0m (完全本地运行，无需 API Key)');
  console.log('  6) \x1b[35m自定义 OpenAI 兼容接口\x1b[0m (OneAPI / vLLM / 代理)\n');

  let choice = await rl.question('请输入选项 [1-6] (默认 1): ');
  choice = choice.trim() || '1';

  let selectedProfile: ModelProfile;
  let enteredKey = '';

  if (choice === '1') {
    selectedProfile = { ...BUILTIN_PROFILES.find((p) => p.id === 'deepseek-v4-flash')! };
    enteredKey = await rl.question('请输入您的 DeepSeek API Key (sk-...): ');
    enteredKey = enteredKey.trim();
  } else if (choice === '2') {
    selectedProfile = { ...BUILTIN_PROFILES.find((p) => p.id === 'deepseek-v4-pro')! };
    enteredKey = await rl.question('请输入您的 DeepSeek API Key (sk-...): ');
    enteredKey = enteredKey.trim();
  } else if (choice === '3') {
    selectedProfile = { ...BUILTIN_PROFILES.find((p) => p.id === 'gpt-4o')! };
    enteredKey = await rl.question('请输入您的 OpenAI API Key (sk-...): ');
    enteredKey = enteredKey.trim();
  } else if (choice === '4') {
    selectedProfile = { ...BUILTIN_PROFILES.find((p) => p.id === 'qwen-plus')! };
    enteredKey = await rl.question('请输入您的 DashScope API Key (sk-...): ');
    enteredKey = enteredKey.trim();
  } else if (choice === '5') {
    selectedProfile = { ...BUILTIN_PROFILES.find((p) => p.id === 'ollama')! };
    enteredKey = 'ollama';
    const customUrl = await rl.question('请输入 Ollama 地址 (默认 http://localhost:11434/v1): ');
    if (customUrl.trim()) {
      selectedProfile.baseURL = customUrl.trim();
    }
  } else {
    const name = (await rl.question('请输入服务名称 (如 Custom API): ')).trim() || 'Custom';
    const baseURL = (await rl.question('请输入 BaseURL (如 https://api.example.com/v1): ')).trim();
    const modelName = (await rl.question('请输入 ModelName (如 gpt-4o): ')).trim();
    enteredKey = (await rl.question('请输入 API Key: ')).trim();

    selectedProfile = {
      id: makeCustomProfileId(name, baseURL),
      name,
      provider: 'openai-compatible',
      baseURL,
      apiKeyEnv: 'CUSTOM_API_KEY',
      modelName,
    };
  }

  rl.close();

  selectedProfile.apiKey = enteredKey;

  console.log('\n⏳ 正在验证连接与可用性...');
  const probe = await probeEndpoint(selectedProfile, enteredKey);
  if (probe.status === 'ok') {
    console.log(`\x1b[32m✔ 连接验证成功 (${probe.detail})\x1b[0m`);
  } else if (probe.status === 'auth') {
    console.log(
      `\x1b[33m⚠ 端点可达但密钥被拒绝 (${probe.detail})。配置仍会保存，请稍后核对密钥。\x1b[0m`,
    );
  } else {
    console.log(
      `\x1b[33m⚠ 未能验证连通性 (${probe.detail})。配置仍会保存，可稍后直接发起一次对话确认。\x1b[0m`,
    );
  }

  // 保存到全局 settings.json
  const { settings } = loadSettings();
  const existingIndex = settings.profiles.findIndex((p) => p.id === selectedProfile.id);
  if (existingIndex >= 0) {
    settings.profiles[existingIndex] = selectedProfile;
  } else {
    settings.profiles.push(selectedProfile);
  }
  settings.defaultModel = selectedProfile.id;

  const savedPath = saveGlobalSettings(settings);
  console.log(`\x1b[32m✔ 配置已成功持久化至全局：${savedPath}\x1b[0m`);
  console.log(
    `\x1b[36m已就绪！当前默认模型：${selectedProfile.name} (${selectedProfile.modelName})\x1b[0m\n`,
  );

  return { profile: selectedProfile, apiKey: enteredKey };
}
