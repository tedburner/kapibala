import {
  AgentSession,
  AnthropicProvider,
  type ModelProfile,
  OpenAICompatibleProvider,
  OpenAIResponsesProvider,
} from '@kiturone/kapibala';
import { SummaryService } from '@kiturone/kapibala';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CliModelBindings,
  createModelBinding,
  parsePrimaryModelRole,
} from '../src/model-bindings.js';
import { type UserSettings, updateProfileApiKey } from '../src/settings.js';

const profile = (
  id: string,
  provider: ModelProfile['provider'] = 'openai-compatible',
): ModelProfile => ({
  id,
  name: id,
  provider,
  modelName: id,
  baseURL: 'https://gateway.example/v1',
  apiKeyEnv: 'NONE',
  contextWindow: '32K',
});
afterEach(() => vi.unstubAllEnvs());

describe('CLI explicit protocol and role bindings', () => {
  it('keeps a configured summary without credentials explicit instead of silently using default', async () => {
    const normal = profile('default');
    const summary = {
      ...profile('summary'),
      baseURL: 'https://missing-summary.example/v1',
      apiKeyEnv: 'UNSET_SUMMARY_TEST_KEY',
    };
    vi.stubEnv('UNSET_SUMMARY_TEST_KEY', '');
    const host = new CliModelBindings(
      {
        defaultModel: normal.id,
        profiles: [normal, summary],
        modelRouting: { summary: summary.id },
      },
      normal,
    );
    const binding = host.defaultBinding;
    const session = new AgentSession({
      defaultProfile: binding.profile,
      defaultProvider: binding.provider,
      eventLogger: { record: async () => {}, recordAudit: async () => {} } as never,
    });
    const switches = vi.spyOn(session, 'switchModel');
    host.attach(session);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    try {
      const service = new SummaryService({
        projectRoot: process.cwd(),
        router: {
          getProfile: () => session.getActiveProfile('summary'),
          resolve: () =>
            switches.mock.calls.find((call) => call[1] === 'summary')?.[2] ??
            host.defaultBinding.provider,
        },
      });
      await expect(
        service.generate([{ id: 'u', role: 'user', content: [{ type: 'text', text: 'task' }] }]),
      ).rejects.toThrow(/密钥/);
      expect(session.getActiveProfile('summary').id).toBe(summary.id);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      await session.destroy();
    }
  });
  it('degrades a broken summary route with a diagnostic instead of failing CLI startup', () => {
    const normal = profile('default');
    const diagnostics: string[] = [];
    const host = new CliModelBindings(
      {
        defaultModel: normal.id,
        profiles: [normal],
        modelRouting: { summary: 'no-longer-exists' },
      },
      normal,
      (message) => diagnostics.push(message),
    );
    expect(diagnostics.some((message) => message.includes('summary 路由不可用'))).toBe(true);
    expect(host.defaultBinding.profile.id).toBe('default');
  });
  it.each([
    ['openai-compatible', OpenAICompatibleProvider],
    ['anthropic', AnthropicProvider],
    ['openai-responses', OpenAIResponsesProvider],
  ] as const)('constructs %s without any classification request', (protocol, Provider) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const target = profile('claude-custom', protocol);
    const binding = createModelBinding(target, { profiles: [target] });
    expect(binding.provider).toBeInstanceOf(Provider);
    expect(binding.profile.provider).toBe(protocol);
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('resolves endpoint overrides in the Profile as well as Provider before binding', async () => {
    vi.stubEnv('OPENAI_BASE_URL', 'https://overridden.example/v1/');
    const target = {
      ...profile('gpt-custom', 'openai-responses'),
      baseURL: 'https://api.openai.com/v1',
    };
    const binding = createModelBinding(target, { profiles: [target] });
    expect(binding.profile.baseURL).toBe('https://overridden.example/v1');
    const session = new AgentSession({
      defaultProfile: binding.profile,
      defaultProvider: binding.provider,
      eventLogger: { record: async () => {}, recordAudit: async () => {} } as never,
    });
    await session.destroy();
    expect(target.baseURL).toBe('https://api.openai.com/v1');
  });

  it('strictly validates primary roles and refuses missing routes without fallback', async () => {
    expect(parsePrimaryModelRole(undefined)).toBe('default');
    for (const value of ['summary', 'automatic', '', 7])
      expect(() => parsePrimaryModelRole(value)).toThrow(/role/);
    const target = profile('default');
    const settings: UserSettings = { defaultModel: target.id, profiles: [target] };
    const host = new CliModelBindings(settings, target);
    const binding = host.defaultBinding;
    const session = new AgentSession({
      defaultProfile: binding.profile,
      defaultProvider: binding.provider,
      eventLogger: { record: async () => {}, recordAudit: async () => {} } as never,
    });
    host.attach(session);
    expect(() => host.selectRole(session, 'fast')).toThrow(/fast/);
    expect(session.getModelRole()).toBe('default');
    await session.destroy();
  });

  it('diagnoses missing route credentials and rejects explicitly selecting it', async () => {
    const normal = profile('default');
    const planning = {
      ...profile('planning'),
      baseURL: 'https://missing-key.example/v1',
      apiKeyEnv: 'UNCONFIGURED_TEST_KEY',
    };
    vi.stubEnv('UNCONFIGURED_TEST_KEY', '');
    const diagnostic = vi.fn();
    const host = new CliModelBindings(
      {
        defaultModel: normal.id,
        profiles: [normal, planning],
        modelRouting: { planning: planning.id },
      },
      normal,
      diagnostic,
    );
    const binding = host.defaultBinding;
    const session = new AgentSession({
      defaultProfile: binding.profile,
      defaultProvider: binding.provider,
      eventLogger: { record: async () => {}, recordAudit: async () => {} } as never,
    });
    host.attach(session);
    expect(diagnostic).toHaveBeenCalledWith(expect.stringMatching(/planning.*密钥/));
    expect(() => host.selectRole(session, 'planning')).toThrow(/planning.*密钥/);
    await session.destroy();
  });

  it('allows a keyed explicit role when the unused default has no credentials', async () => {
    const normal = {
      ...profile('default'),
      baseURL: 'https://missing-default.example/v1',
      apiKeyEnv: 'MISSING_DEFAULT_TEST_KEY',
    };
    vi.stubEnv('MISSING_DEFAULT_TEST_KEY', '');
    const planning = { ...profile('planner', 'anthropic'), apiKey: 'planner-key' };
    const settings = {
      defaultModel: normal.id,
      profiles: [normal, planning],
      modelRouting: { planning: planning.id },
    };
    const host = new CliModelBindings(settings, normal, undefined, true);
    expect(host.defaultBinding.provider.credentialsReady).toBe(false);
    const session = new AgentSession({
      defaultProfile: host.defaultBinding.profile,
      defaultProvider: host.defaultBinding.provider,
      eventLogger: { record: async () => {}, recordAudit: async () => {} } as never,
    });
    host.attach(session, 'planning');
    expect(session.getActiveProfile().id).toBe(planning.id);
    expect(() => host.selectRole(session, 'default')).toThrow(/密钥|credential/);
    expect(session.getModelRole()).toBe('planning');
    await session.destroy();
  });

  it('retains selected role across in-process session replacement and resets on new host', async () => {
    const normal = profile('default');
    const planning = profile('planner', 'anthropic');
    const settings = {
      defaultModel: normal.id,
      profiles: [normal, planning],
      modelRouting: { planning: planning.id },
    };
    const host = new CliModelBindings(settings, normal);
    const makeSession = () =>
      new AgentSession({
        defaultProfile: host.defaultBinding.profile,
        defaultProvider: host.defaultBinding.provider,
        eventLogger: { record: async () => {}, recordAudit: async () => {} } as never,
      });
    const first = makeSession();
    host.attach(first);
    host.selectRole(first, 'planning');
    const resumed = makeSession();
    host.attach(resumed);
    expect(resumed.getModelRole()).toBe('planning');
    expect(resumed.getActiveProfile().id).toBe(planning.id);
    expect(new CliModelBindings(settings, normal).selectedRole).toBe('default');
    await first.destroy();
    await resumed.destroy();
  });

  it('refreshes all same-group role Providers without changing the selected role', async () => {
    const normal = { ...profile('default'), apiKeyEnv: 'UNCONFIGURED_TEST_KEY', apiKey: 'old-key' };
    const planning = { ...profile('planner', 'anthropic'), apiKeyEnv: normal.apiKeyEnv };
    const settings: UserSettings = {
      defaultModel: normal.id,
      profiles: [normal, planning],
      modelRouting: { planning: planning.id },
    };
    const host = new CliModelBindings(settings, normal);
    const oldDefault = host.defaultBinding.provider;
    const session = new AgentSession({
      defaultProfile: host.defaultBinding.profile,
      defaultProvider: oldDefault,
      eventLogger: { record: async () => {}, recordAudit: async () => {} } as never,
    });
    host.attach(session);
    host.selectRole(session, 'planning');
    updateProfileApiKey(settings, planning.id, 'new-key');
    host.refreshCredentials(session, planning.id);
    expect(host.defaultBinding.provider).not.toBe(oldDefault);
    expect((host.defaultBinding.provider as OpenAICompatibleProvider).apiKey).toBe('new-key');
    expect(session.getModelRole()).toBe('planning');
    expect(settings.profiles.filter((item) => item.apiKey)).toHaveLength(1);
    await session.destroy();
  });

  it('refreshes the source credential group when its current endpoint was temporarily overridden', async () => {
    const normal = {
      ...profile('custom-gateway'),
      baseURL: 'https://gw-a.example/v1',
      apiKeyEnv: 'GATEWAY_TEST_KEY',
      apiKey: 'old-fixture-key',
    };
    const planning = { ...normal, id: 'custom-planner', apiKey: undefined };
    const settings: UserSettings = {
      defaultModel: normal.id,
      profiles: [normal, planning],
      modelRouting: { planning: planning.id },
    };
    const host = new CliModelBindings(settings, { ...normal, baseURL: 'https://gw-b.example/v1' });
    const session = new AgentSession({
      defaultProfile: host.defaultBinding.profile,
      defaultProvider: host.defaultBinding.provider,
      eventLogger: { record: async () => {}, recordAudit: async () => {} } as never,
    });
    host.attach(session);
    const switched = vi.spyOn(session, 'switchModel');
    updateProfileApiKey(settings, normal.id, 'new-fixture-key');
    host.refreshCredentials(session, normal.id);
    expect((host.defaultBinding.provider as OpenAICompatibleProvider).apiKey).toBe(
      'new-fixture-key',
    );
    expect(host.defaultBinding.profile.baseURL).toBe('https://gw-b.example/v1');
    expect(switched.mock.calls.map((call) => call[1])).toEqual(['default', 'planning']);
    expect((switched.mock.calls[1]?.[2] as OpenAICompatibleProvider).apiKey).toBe(
      'new-fixture-key',
    );
    await session.destroy();
  });
});
