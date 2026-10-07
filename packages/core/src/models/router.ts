import { ModelError } from '../errors/index.js';
import type { ModelProvider } from './index.js';

/** 逻辑模型角色：default 为回退绑定，planning / execution / fast 是主任务可选场景，summary 仅用于独立的上下文压缩。 */
export type ModelRole = 'default' | 'planning' | 'execution' | 'summary' | 'fast';
/** 主任务可显式选择的场景；summary 只用于独立的上下文压缩。 */
export type PrimaryModelRole = Exclude<ModelRole, 'summary'>;
/** wire 协议族；决定适配器实现、私有状态格式与错误解析方式。 */
export type ModelProtocol = 'openai-compatible' | 'anthropic' | 'openai-responses';

/** 兼容 Chat 端点的显式参数/完成能力；缺省保持既有参数并要求完整 DONE。 */
export interface ChatCapabilities {
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  supportsStreamingUsage?: boolean;
  supportsTemperature?: boolean;
  requiresDone?: boolean;
  replayReasoningContent?: boolean;
}

/** 配置侧窗口值：正整数 Token 数，或十进制 K / M 简写（如 '200K'）；解析规则见 resolveContextWindow。 */
export type ContextWindowValue = number | `${number}${'K' | 'k' | 'M' | 'm'}`;

/** 解析后的窗口；estimated 为 true 时数值来自默认估算，不能当作模型的精确保证。 */
export interface ResolvedContextWindow {
  tokens: number;
  /** true 表示模型未声明窗口，当前值来自 Kapibala 的默认估算。 */
  estimated: boolean;
}

/** 模型未声明 contextWindow 时的默认窗口估算值。 */
export const DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000;

/**
 * 将模型上下文窗口统一解析为整数 Token 数。
 *
 * 配置允许直接填写整数，或使用十进制 K/M 简写；未填写时返回默认 1M，并标记为估算值。
 */
export function resolveContextWindow(value?: ContextWindowValue): ResolvedContextWindow {
  if (value === undefined) {
    return { tokens: DEFAULT_CONTEXT_WINDOW_TOKENS, estimated: true };
  }

  let tokens: number;
  if (typeof value === 'number') {
    tokens = value;
  } else {
    const match = /^([0-9]+(?:\.[0-9]+)?)([km])$/i.exec(value.trim());
    const unit = match?.[2]?.toLowerCase();
    const fractionDigits = match?.[1]?.split('.')[1]?.length ?? 0;
    const maxFractionDigits = unit === 'm' ? 6 : 3;
    if (!match || fractionDigits > maxFractionDigits) {
      throw new RangeError(
        `Invalid contextWindow '${value}': expected a positive integer or K/M value`,
      );
    }
    const multiplier = unit === 'm' ? 1_000_000 : 1_000;
    tokens = Number(match[1]) * multiplier;
  }

  if (!Number.isSafeInteger(tokens) || tokens <= 0) {
    throw new RangeError(
      `Invalid contextWindow '${value}': token count must be a positive integer`,
    );
  }

  return { tokens, estimated: false };
}

/** 模型配置档案；provider 是 wire 协议族而非厂商名，绑定必须与适配器声明一致（见 validateModelBinding）。 */
export interface ModelProfile {
  id: string;
  name: string;
  provider: ModelProtocol;
  baseURL: string;
  /** 承载密钥的环境变量名；core 不直接读取，由宿主解析后注入 Provider。 */
  apiKeyEnv: string;
  apiKey?: string;
  modelName: string;
  /** 未声明时按 DEFAULT_CONTEXT_WINDOW_TOKENS 估算；解析规则见 resolveContextWindow。 */
  contextWindow?: ContextWindowValue;
  supportsThinking?: boolean;
  /** 单次输出上限；参与上下文预算推导，缺省按 4096 预留。 */
  maxOutputTokens?: number;
  chatCapabilities?: ChatCapabilities;
  /** Anthropic 请求携带的 workspace；参与绑定一致性校验。 */
  anthropicWorkspaceId?: string;
}

/** 角色到 Profile / Provider 配对的解析接口；实现必须保证配对一致且 profile 以副本返回。 */
export interface ModelRouter {
  resolve(role?: ModelRole): ModelProvider;
  getProfile(role?: ModelRole): ModelProfile;
}

/** 校验内置适配器的实际请求目标；旧自定义 Provider 由宿主显式提供绑定。 */
export function validateModelBinding(profile: ModelProfile, provider: ModelProvider): void {
  const binding = provider.binding;
  if (
    binding &&
    (binding.protocol !== profile.provider ||
      binding.modelName !== profile.modelName ||
      binding.baseURL.replace(/\/+$/, '') !== profile.baseURL.replace(/\/+$/, '') ||
      binding.workspaceId !== profile.anthropicWorkspaceId)
  ) {
    throw new ModelError('Model profile and provider binding do not match', {
      stage: 'request',
      retryable: false,
    });
  }
}

/** 保存原子 Profile/Provider 配对；普通与摘要查询可回退 default，显式任务严格解析。 */
export class SimpleModelRouter implements ModelRouter {
  private readonly providers = new Map<ModelRole, ModelProvider>();
  private readonly profiles = new Map<ModelRole, ModelProfile>();
  private defaultRole: ModelRole = 'default';

  constructor(defaultProfile: ModelProfile, defaultProvider: ModelProvider) {
    this.setRole('default', defaultProfile, defaultProvider);
  }

  /** 校验配对后同时替换两者并保存配置副本，校验失败不污染既有绑定。 */
  setRole(role: ModelRole, profile: ModelProfile, provider: ModelProvider): void {
    validateModelBinding(profile, provider);
    this.profiles.set(role, structuredClone(profile));
    this.providers.set(role, provider);
  }

  /** 显式场景要求存在绑定；只有普通查询和摘要允许既有默认回退。 */
  getBinding(
    role: ModelRole = 'default',
    strict = false,
  ): { profile: ModelProfile; provider: ModelProvider } {
    if (strict && (!this.profiles.has(role) || !this.providers.has(role)))
      throw new ModelError(`Model role '${role}' is not configured`, {
        stage: 'request',
        retryable: false,
      });
    return { profile: structuredClone(this.getProfile(role)), provider: this.resolve(role) };
  }

  resolve(role: ModelRole = 'default'): ModelProvider {
    return this.providers.get(role) ?? this.providers.get('default')!;
  }

  /** 返回指定角色或默认模型的独立副本，调用方不能改写在途绑定。 */
  getProfile(role: ModelRole = 'default'): ModelProfile {
    return structuredClone(this.profiles.get(role) ?? this.profiles.get('default')!);
  }
}
