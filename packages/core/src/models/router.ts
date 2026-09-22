import type { ModelProvider } from './index.js';

export type ModelRole = 'default' | 'planning' | 'execution' | 'summary' | 'fast';

export type ContextWindowValue = number | `${number}${'K' | 'k' | 'M' | 'm'}`;

export interface ResolvedContextWindow {
  tokens: number;
  /** true 表示模型未声明窗口，当前值来自 Kapibala 的默认估算。 */
  estimated: boolean;
}

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

export interface ModelProfile {
  id: string;
  name: string;
  provider: 'openai-compatible';
  baseURL: string;
  apiKeyEnv: string;
  apiKey?: string;
  modelName: string;
  contextWindow?: ContextWindowValue;
  supportsThinking?: boolean;
}

export interface ModelRouter {
  resolve(role?: ModelRole): ModelProvider;
  getProfile(role?: ModelRole): ModelProfile;
}

export class SimpleModelRouter implements ModelRouter {
  private readonly providers = new Map<ModelRole, ModelProvider>();
  private readonly profiles = new Map<ModelRole, ModelProfile>();
  private defaultRole: ModelRole = 'default';

  constructor(defaultProfile: ModelProfile, defaultProvider: ModelProvider) {
    this.setRole('default', defaultProfile, defaultProvider);
  }

  setRole(role: ModelRole, profile: ModelProfile, provider: ModelProvider): void {
    this.profiles.set(role, profile);
    this.providers.set(role, provider);
  }

  resolve(role: ModelRole = 'default'): ModelProvider {
    return this.providers.get(role) ?? this.providers.get('default')!;
  }

  getProfile(role: ModelRole = 'default'): ModelProfile {
    return this.profiles.get(role) ?? this.profiles.get('default')!;
  }
}
