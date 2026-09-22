import { stdin as input, stdout as output } from 'node:process';
import readline, { type Interface as ReadlineInterface } from 'node:readline/promises';
import { type ModelProfile, resolveContextWindow } from '@kiturone/kapibala';
import { type ProviderMeta, listBuiltinProviders } from './providers.js';
import {
  type UserSettings,
  describeCredentialGroup,
  loadGlobalSettingsForWrite,
  resolveApiKeyDetailed,
  resolveBaseURL,
  saveGlobalSettings,
} from './settings.js';
import { formatTokenCount } from './ui/metrics.js';
import { readSecret } from './ui/secret.js';

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

export interface SetupWizardOptions {
  secretReader?: (prompt: string) => Promise<string>;
}

export async function runSetupWizard(
  options: SetupWizardOptions = {},
): Promise<{ profile: ModelProfile; apiKey: string }> {
  const rl = readline.createInterface({ input, output });
  let readlineClosed = false;
  const closeReadline = (): void => {
    if (readlineClosed) return;
    readlineClosed = true;
    rl.close();
  };

  try {
    return await executeSetupWizard(rl, closeReadline, options);
  } finally {
    closeReadline();
  }
}

async function executeSetupWizard(
  rl: ReadlineInterface,
  closeReadline: () => void,
  options: SetupWizardOptions,
): Promise<{ profile: ModelProfile; apiKey: string }> {
  console.log('\n🐾 \x1b[36m欢迎使用 Kapibala (kpbl)!\x1b[0m');
  console.log('检测到当前尚未配置可用的模型服务。请选择您要使用的提供商：\n');

  // 厂商与模型清单全部来自内置目录，不再在这里硬编码 id ——
  // 硬编码会在模型换代后变成一句 `BUILTIN_PROFILES.find(...)!` 的运行时崩溃。
  const providerEntries = listBuiltinProviders();
  providerEntries.forEach((entry, index) => {
    const recommended = entry.meta.key === 'deepseek' ? ' \x1b[32m(推荐默认)\x1b[0m' : '';
    console.log(
      `  ${index + 1}) \x1b[36m${entry.meta.name}\x1b[0m${recommended} —— ${entry.meta.desc} (${entry.models.length}个模型)`,
    );
  });
  const customChoice = providerEntries.length + 1;
  console.log(`  ${customChoice}) \x1b[35m自定义 OpenAI 兼容接口\x1b[0m —— OneAPI / vLLM / 代理\n`);

  const choice = (await rl.question(`请输入选项 [1-${customChoice}] (默认 1): `)).trim() || '1';

  let selectedProfile: ModelProfile;
  let enteredKey = '';
  let keyPrompt: string | undefined;

  const parsedChoice = Number.parseInt(choice, 10);
  const isCustom = parsedChoice === customChoice;
  const entry: { meta: ProviderMeta; models: ModelProfile[] } | undefined = isCustom
    ? undefined
    : (providerEntries[parsedChoice - 1] ?? providerEntries[0]);

  if (entry) {
    let chosen = entry.models[0]!;
    if (entry.models.length > 1) {
      console.log('');
      entry.models.forEach((candidate, index) => {
        const contextWindow = resolveContextWindow(candidate.contextWindow);
        const context = ` | ${contextWindow.estimated ? '≈' : ''}${formatTokenCount(contextWindow.tokens)}`;
        const thinking = candidate.supportsThinking ? ' | 深度思考' : '';
        console.log(
          `  ${index + 1}) ${candidate.name} —— ${candidate.modelName}${context}${thinking}`,
        );
      });
      const modelChoice =
        (await rl.question(`请选择具体模型 [1-${entry.models.length}] (默认 1): `)).trim() || '1';
      chosen = entry.models[Number.parseInt(modelChoice, 10) - 1] ?? chosen;
    }
    console.log('');

    selectedProfile = { ...chosen };
    if (entry.meta.key === 'ollama') {
      enteredKey = 'ollama';
      const customUrl = await rl.question('请输入 Ollama 地址 (默认 http://localhost:11434/v1): ');
      if (customUrl.trim()) {
        selectedProfile.baseURL = customUrl.trim();
      }
    } else {
      keyPrompt = entry.meta.keyPrompt;
    }
  } else {
    const name = (await rl.question('请输入服务名称 (如 Custom API): ')).trim() || 'Custom';
    const baseURL = (await rl.question('请输入 BaseURL (如 https://api.example.com/v1): ')).trim();
    const modelName = (await rl.question('请输入 ModelName (如 gpt-5.6-terra): ')).trim();
    keyPrompt = '请输入 API Key: ';

    selectedProfile = {
      id: makeCustomProfileId(name, baseURL),
      name,
      provider: 'openai-compatible',
      baseURL,
      apiKeyEnv: 'CUSTOM_API_KEY',
      modelName,
    };
  }

  // 只读磁盘原始配置：合并版配置里含全部内置 profile，回写会把用户从未启用的模型物化进文件。
  // 文件存在但损坏/含非法值时 loadGlobalSettingsForWrite 直接抛错 —— 静默回退空骨架会把
  // 用户已有 profile（含内联 apiKey）在下一次写盘时全部清空。
  const settings: UserSettings = loadGlobalSettingsForWrite();
  const existingProfile = settings.profiles.find((profile) => profile.id === selectedProfile.id);
  if (keyPrompt && existingProfile?.apiKey?.trim()) {
    const replace = (await rl.question('该模型已有保存的 API Key，是否更新？[y/N]: '))
      .trim()
      .toLowerCase();
    if (replace !== 'y' && replace !== 'yes') {
      enteredKey = existingProfile.apiKey.trim();
      keyPrompt = undefined;
    }
  } else if (keyPrompt) {
    // 该模型自己没有密钥，但同厂商族已有可用密钥 —— 默认复用，别让用户为同一把 key 反复输入
    const available = resolveApiKeyDetailed(selectedProfile, settings);
    if (available) {
      const origin =
        available.source === 'shared'
          ? `来自同厂商模型 '${available.fromProfileId}'`
          : '来自环境变量';
      const reuse = (
        await rl.question(
          `检测到 ${describeCredentialGroup(selectedProfile)} 的可用 API Key（${origin}）。直接复用？[Y/n]: `,
        )
      )
        .trim()
        .toLowerCase();
      if (reuse !== 'n' && reuse !== 'no') {
        enteredKey = available.key;
        keyPrompt = undefined;
      }
    }
  }

  closeReadline();

  if (keyPrompt) {
    const secretReader = options.secretReader ?? readSecret;
    enteredKey = (await secretReader(keyPrompt)).trim();
  }

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
  const existingIndex = settings.profiles.findIndex((p) => p.id === selectedProfile.id);
  if (existingIndex >= 0) {
    settings.profiles[existingIndex] = selectedProfile;
  } else {
    settings.profiles.push(selectedProfile);
  }
  settings.defaultModel = selectedProfile.id;

  if (enteredKey && enteredKey !== 'ollama') {
    console.log(
      '\x1b[33m⚠ API Key 将保存在全局配置 ~/.kapibala/settings.json，请确保仅当前用户可访问。\x1b[0m',
    );
  }
  const savedPath = saveGlobalSettings(settings);
  console.log(`\x1b[32m✔ 配置已成功持久化至全局：${savedPath}\x1b[0m`);

  if (enteredKey && enteredKey !== 'ollama') {
    console.log(
      `\x1b[33m⚠ API Key 已保存在 ${savedPath}；Kapibala 已尝试将文件权限限制为当前用户。\x1b[0m`,
    );
  }

  console.log(
    `\x1b[36m已就绪！当前默认模型：${selectedProfile.name} (${selectedProfile.modelName})\x1b[0m\n`,
  );

  return { profile: selectedProfile, apiKey: enteredKey };
}
