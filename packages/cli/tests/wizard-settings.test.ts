import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingsCommand } from '../src/commands/settings.js';
import { createModelBinding } from '../src/model-bindings.js';
import {
  API_KEY_ENV_NONE,
  BUILTIN_PROFILES,
  type UserSettings,
  loadGlobalSettingsForWrite,
  saveGlobalSettings,
} from '../src/settings.js';
import { runSetupWizard } from '../src/wizard.js';

vi.mock('../src/settings.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/settings.js')>()),
  loadGlobalSettingsForWrite: vi.fn(),
  saveGlobalSettings: vi.fn(() => 'virtual-settings.json'),
}));

describe('wizard user overrides and credential groups', () => {
  const descriptors = [process.stdin, process.stdout].map((stream) =>
    Object.getOwnPropertyDescriptor(stream, 'isTTY'),
  );
  let original: UserSettings;
  beforeEach(() => {
    for (const stream of [process.stdin, process.stdout])
      Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
    original = {
      defaultModel: 'gpt-6-astra',
      modelRouting: { planning: 'gpt-5.6-sol' },
      profiles: [
        {
          ...BUILTIN_PROFILES.find((profile) => profile.id === 'gpt-6-astra')!,
          maxOutputTokens: 1024,
          chatCapabilities: { requiresDone: false },
          apiKey: 'old-fixture-key',
        },
        {
          ...BUILTIN_PROFILES.find((profile) => profile.id === 'gpt-5.6-sol')!,
          apiKey: 'sibling-fixture-key',
        },
      ],
    };
    vi.mocked(loadGlobalSettingsForWrite).mockReturnValue(original);
    vi.mocked(saveGlobalSettings).mockImplementation(() => 'virtual-settings.json');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    [process.stdin, process.stdout].forEach((stream, index) => {
      const descriptor = descriptors[index];
      if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
      else Reflect.deleteProperty(stream, 'isTTY');
    });
  });
  const question = () =>
    vi.fn().mockResolvedValueOnce('2').mockResolvedValueOnce('1').mockResolvedValueOnce('y');

  it('preserves the explicit lower output ceiling and user compatibility options', async () => {
    const result = await runSetupWizard({
      question: question(),
      secretReader: async () => 'new-fixture-key',
    });
    expect(result.profile.maxOutputTokens).toBe(1024);
    expect(result.profile.chatCapabilities).toEqual({ requiresDone: false });
    expect(vi.mocked(saveGlobalSettings).mock.calls[0]?.[0].profiles).toHaveLength(2);
  });

  it('normalizes the new key across the group and never prints credentials', async () => {
    await runSetupWizard({ question: question(), secretReader: async () => 'new-fixture-key' });
    const persisted = vi.mocked(saveGlobalSettings).mock.calls[0]?.[0];
    expect(persisted?.profiles.filter((profile) => profile.apiKey)).toHaveLength(1);
    expect(persisted?.profiles.find((profile) => profile.id === 'gpt-6-astra')?.apiKey).toBe(
      'new-fixture-key',
    );
    expect(vi.mocked(console.log).mock.calls.flat().join('\n')).not.toContain('new-fixture-key');
  });

  it('refreshes same-group role bindings after successful wizard persistence', async () => {
    const switched = vi.fn();
    const refreshed = vi.fn();
    await settingsCommand(['setup'], {
      question: question(),
      readSecret: async () => 'new-fixture-key',
      onModelSwitched: switched,
      onCredentialsUpdated: refreshed,
    } as never);
    expect(switched).toHaveBeenCalledWith('gpt-6-astra');
    expect(refreshed).toHaveBeenCalledWith('gpt-6-astra');
  });

  it('does not mutate the loaded snapshot or activate any binding when save fails', async () => {
    vi.mocked(saveGlobalSettings).mockImplementation(() => {
      throw new Error('disk full');
    });
    const before = structuredClone(original);
    const switched = vi.fn();
    const refreshed = vi.fn();
    await expect(
      settingsCommand(['setup'], {
        question: question(),
        readSecret: async () => 'new-fixture-key',
        onModelSwitched: switched,
        onCredentialsUpdated: refreshed,
      } as never),
    ).rejects.toThrow('disk full');
    expect(original).toEqual(before);
    expect(switched).not.toHaveBeenCalled();
    expect(refreshed).not.toHaveBeenCalled();
  });

  it('re-prompts and saves keyless mode explicitly when the entered key is empty', async () => {
    const answers = ['9', 'TestAPI', 'https://custom.example/v1', 'test-model'];
    const questionFn = vi
      .fn()
      .mockResolvedValueOnce(answers[0])
      .mockResolvedValueOnce(answers[1])
      .mockResolvedValueOnce(answers[2])
      .mockResolvedValueOnce(answers[3])
      .mockResolvedValueOnce('n')
      .mockResolvedValueOnce('y');
    const result = await runSetupWizard({
      question: questionFn,
      secretReader: vi.fn().mockResolvedValueOnce('').mockResolvedValueOnce('real-key'),
    });
    expect(result.apiKey).toBe('real-key');
    expect(questionFn).toHaveBeenCalledTimes(5);
    expect(result.profile.apiKeyEnv).toBe('CUSTOM_API_KEY');
  });

  it('saves an explicitly skipped key as keyless mode so startup succeeds without credentials', async () => {
    const questionFn = vi
      .fn()
      .mockResolvedValueOnce('9')
      .mockResolvedValueOnce('TestAPI')
      .mockResolvedValueOnce('https://custom.example/v1')
      .mockResolvedValueOnce('test-model')
      .mockResolvedValueOnce('y');
    const result = await runSetupWizard({
      question: questionFn,
      secretReader: async () => '',
    });
    expect(result.apiKey).toBe('');
    expect(result.profile.apiKeyEnv).toBe(API_KEY_ENV_NONE);
    const persisted = vi.mocked(saveGlobalSettings).mock.calls[0]?.[0];
    const saved = persisted?.profiles.find((profile) => profile.id === result.profile.id);
    expect(saved?.apiKeyEnv).toBe(API_KEY_ENV_NONE);
    expect(() => createModelBinding(result.profile, persisted!)).not.toThrow();
  });
});
