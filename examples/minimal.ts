import {
  AgentSession,
  type ModelProfile,
  OpenAICompatibleProvider,
  builtinTools,
} from '@kiturone/kapibala';

const profile: ModelProfile = {
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  provider: 'openai-compatible',
  baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
  apiKeyEnv: 'DEEPSEEK_API_KEY',
  modelName: 'deepseek-v4-flash',
};

const provider = new OpenAICompatibleProvider({
  baseURL: profile.baseURL,
  apiKey: process.env.DEEPSEEK_API_KEY || 'mock-key',
  modelName: profile.modelName,
});

const session = new AgentSession({
  defaultProfile: profile,
  defaultProvider: provider,
});

for (const tool of builtinTools) {
  session.tools.register(tool);
}

console.log('🐾 Kapibala Minimal Example Initialized.');
console.log(`Active Model: ${session.getActiveProfile().name}`);
console.log(
  `Loaded Tools: ${session.tools
    .list()
    .map((t) => t.name)
    .join(', ')}`,
);
