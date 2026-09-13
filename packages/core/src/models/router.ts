import type { ModelProvider } from './index.js';

export type ModelRole = 'default' | 'planning' | 'execution' | 'summary' | 'fast';

export interface ModelProfile {
  id: string;
  name: string;
  provider: 'openai-compatible';
  baseURL: string;
  apiKeyEnv: string;
  apiKey?: string;
  modelName: string;
  contextWindow?: number;
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
