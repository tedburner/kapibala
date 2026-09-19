import type { AgentSession } from '@kiturone/kapibala';
import { describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../src/commands/dispatcher.js';
import { updateModelApiKey } from '../src/commands/model.js';
import { BUILTIN_PROFILES, type UserSettings } from '../src/settings.js';

describe('updateModelApiKey', () => {
  it('replaces an existing key, persists it, and refreshes the active provider', async () => {
    const profile = { ...BUILTIN_PROFILES.find((candidate) => candidate.id === 'gpt-4o')! };
    profile.apiKey = 'sk-old';
    const settings: UserSettings = { defaultModel: profile.id, profiles: [profile] };
    const onModelSwitched = vi.fn();
    const saveSettings = vi.fn(() => 'C:/fake/.kapibala/settings.json');
    const context: CommandContext = {
      session: { getActiveProfile: () => profile } as unknown as AgentSession,
      settings,
      onModelSwitched,
      onExit: () => undefined,
    };

    const updated = await updateModelApiKey(profile, context, {
      secretReader: async () => ' sk-new ',
      saveSettings,
      globalSettings: settings,
    });

    expect(updated).toBe(true);
    expect(profile.apiKey).toBe('sk-new');
    expect(saveSettings).toHaveBeenCalledWith(settings);
    expect(onModelSwitched).toHaveBeenCalledWith(profile.id);
  });

  it('does not erase an existing key when empty input is submitted', async () => {
    const profile = { ...BUILTIN_PROFILES.find((candidate) => candidate.id === 'gpt-4o')! };
    profile.apiKey = 'sk-existing';
    const settings: UserSettings = { defaultModel: profile.id, profiles: [profile] };
    const saveSettings = vi.fn(() => 'unused');
    const context: CommandContext = {
      session: { getActiveProfile: () => profile } as unknown as AgentSession,
      settings,
      onModelSwitched: vi.fn(),
      onExit: () => undefined,
    };

    const updated = await updateModelApiKey(profile, context, {
      secretReader: async () => '   ',
      saveSettings,
      globalSettings: settings,
    });

    expect(updated).toBe(false);
    expect(profile.apiKey).toBe('sk-existing');
    expect(saveSettings).not.toHaveBeenCalled();
  });

  it('updates only the global layer instead of persisting merged project overrides', async () => {
    const globalProfile = {
      ...BUILTIN_PROFILES.find((candidate) => candidate.id === 'gpt-4o')!,
      baseURL: 'https://global.example/v1',
    };
    const runtimeProfile = { ...globalProfile, baseURL: 'https://project.example/v1' };
    const globalSettings: UserSettings = {
      defaultModel: globalProfile.id,
      profiles: [globalProfile],
    };
    const runtimeSettings: UserSettings = {
      defaultModel: runtimeProfile.id,
      profiles: [runtimeProfile],
    };
    const saveSettings = vi.fn(() => 'saved');
    const context: CommandContext = {
      session: { getActiveProfile: () => runtimeProfile } as unknown as AgentSession,
      settings: runtimeSettings,
      onModelSwitched: vi.fn(),
      onExit: () => undefined,
    };

    await updateModelApiKey(runtimeProfile, context, {
      secretReader: async () => 'new-key',
      saveSettings,
      globalSettings,
    });

    expect(saveSettings).toHaveBeenCalledWith(globalSettings);
    expect(globalSettings.profiles[0]).toMatchObject({
      baseURL: 'https://global.example/v1',
      apiKey: 'new-key',
    });
    expect(runtimeProfile.apiKey).toBe('new-key');
  });
});
