import { describe, expect, it } from 'vitest';
import { AgentSession } from '../src/context/session/index.js';
import { OpenAICompatibleProvider } from '../src/models/openai-compatible/index.js';
import type { ModelProfile } from '../src/models/router.js';

const profile: ModelProfile = {
  id: 'a',
  name: 'A',
  modelName: 'model-a',
  provider: 'openai-compatible',
  baseURL: 'http://localhost/v1',
  apiKeyEnv: 'NONE',
};
const makeProvider = () =>
  new OpenAICompatibleProvider({
    baseURL: profile.baseURL,
    apiKey: 'unused',
    modelName: profile.modelName,
  });

describe('model bindings', () => {
  it.each([
    { modelName: 'other' },
    { baseURL: 'http://other/v1' },
    { provider: 'anthropic' as const },
  ])('rejects mismatched replacement and retains the old binding: %j', (override) => {
    const session = new AgentSession({ defaultProfile: profile, defaultProvider: makeProvider() });
    expect(() => session.switchModel({ ...profile, ...override })).toThrow(/binding|provider/i);
    expect(session.getActiveProfile()).toMatchObject(profile);
  });

  it('rejects an explicitly supplied mismatched provider', () => {
    const session = new AgentSession({ defaultProfile: profile, defaultProvider: makeProvider() });
    expect(() =>
      session.switchModel({ ...profile, modelName: 'other' }, 'planning', makeProvider()),
    ).toThrow(/binding|provider/i);
  });

  it('allows label changes with an unchanged request target', () => {
    const session = new AgentSession({ defaultProfile: profile, defaultProvider: makeProvider() });
    session.switchModel({ ...profile, name: 'Renamed' });
    expect(session.getActiveProfile().name).toBe('Renamed');
  });
});
