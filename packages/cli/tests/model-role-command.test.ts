import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession, ModelProfile } from '@kiturone/kapibala';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_CATALOG } from '../src/commands/catalog.js';
import { type CommandContext, CommandDispatcher } from '../src/commands/dispatcher.js';
import { modelCommand, updateModelApiKey } from '../src/commands/model.js';
import { persistModelRole } from '../src/default-model.js';
import { CliModelBindings } from '../src/model-bindings.js';
import {
  type UserSettings,
  loadGlobalSettingsForWrite,
  saveGlobalSettings,
} from '../src/settings.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const profile: ModelProfile = {
  id: 'target',
  name: 'Target',
  provider: 'openai-compatible',
  modelName: 'target',
  baseURL: 'https://gateway.example/v1',
  apiKeyEnv: 'NONE',
};

describe('CLI role command contract', () => {
  it('returns to default when an ordinary model choice follows a planning selection', async () => {
    const { AgentSession } = await import('@kiturone/kapibala');
    const planning = { ...profile, id: 'planner' };
    const settings: UserSettings = {
      defaultModel: profile.id,
      profiles: [profile, planning],
      modelRouting: { planning: planning.id },
    };
    const host = new CliModelBindings(settings, profile);
    const session = new AgentSession({
      defaultProfile: host.defaultBinding.profile,
      defaultProvider: host.defaultBinding.provider,
      eventLogger: { record: async () => {}, recordAudit: async () => {} } as never,
    });
    host.attach(session, 'planning');
    await modelCommand([profile.id], {
      session,
      settings,
      onModelSwitched: (id) => host.switchDefault(session, id),
      onExit: () => {},
    });
    expect(session.getModelRole()).toBe('default');
    expect(session.getActiveProfile().id).toBe(profile.id);
    await session.destroy();
  });

  it('persists the role before notifying the host to activate the saved binding', async () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-role-command-'));
    directories.push(homeDir);
    vi.spyOn(os, 'homedir').mockReturnValue(homeDir);
    const settings: UserSettings = { defaultModel: profile.id, profiles: [profile] };
    const activate = vi.fn(() => {
      expect(loadGlobalSettingsForWrite({ homeDir }).modelRouting?.planning).toBe(profile.id);
      expect(settings.modelRouting?.planning).toBe(profile.id);
    });
    await modelCommand(['planning', profile.id], {
      settings,
      onRoleBound: activate,
    } as unknown as CommandContext);
    expect(activate).toHaveBeenCalledWith('planning', profile.id);
    expect(loadGlobalSettingsForWrite({ homeDir }).profiles).toHaveLength(1);
  });
  it('accepts role bindings and primary routes while rejecting summary route and malformed input', () => {
    const model = COMMAND_CATALOG.find((command) => command.name === 'model')!;
    for (const args of [
      ['planning', 'target'],
      ['execution', 'target'],
      ['fast', 'target'],
      ['summary', 'target'],
      ['route', 'planning'],
      ['route', 'default'],
    ])
      expect(model.validate(args)).toBeUndefined();
    for (const args of [
      ['route', 'summary'],
      ['route', 'wrong'],
      ['planning'],
      ['execution', 'target', 'extra'],
    ])
      expect(model.validate(args)).toBeDefined();
    expect(model.usage).toContain('route');
  });

  it('selects a role without invoking the ordinary default-model switch', async () => {
    const selected = vi.fn();
    const switched = vi.fn();
    const context = {
      session: { isBusy: () => false },
      settings: { profiles: [profile] },
      onRoleSelected: selected,
      onModelSwitched: switched,
    } as unknown as CommandContext;
    await modelCommand(['route', 'planning'], context);
    expect(selected).toHaveBeenCalledWith('planning');
    expect(switched).not.toHaveBeenCalled();
  });

  it('persists only the chosen role and Profile before activation, preserving default semantics', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-route-write-'));
    directories.push(homeDir);
    saveGlobalSettings({ defaultModel: 'old-default', profiles: [] }, { homeDir });
    const runtime: UserSettings = { defaultModel: 'old-default', profiles: [profile] };
    persistModelRole(profile, 'planning', runtime, { homeDir });
    const global = loadGlobalSettingsForWrite({ homeDir });
    expect(global.profiles).toHaveLength(1);
    expect(global.defaultModel).toBe('old-default');
    expect(global.modelRouting).toEqual({ planning: profile.id });
    expect(runtime.modelRouting).toEqual({ planning: profile.id });
  });

  it('does not update runtime routing or activate when persistence fails', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-route-fail-'));
    directories.push(homeDir);
    const runtime: UserSettings = {
      defaultModel: profile.id,
      profiles: [profile],
      modelRouting: { fast: 'old-fast' },
    };
    expect(() =>
      persistModelRole(profile, 'planning', runtime, {
        homeDir,
        saveSettings: () => {
          throw new Error('disk failure');
        },
      }),
    ).toThrow('disk failure');
    expect(runtime.modelRouting).toEqual({ fast: 'old-fast' });
  });

  it('updates current-role credentials through group refresh without selecting default', async () => {
    const target = { ...profile, apiKeyEnv: 'GATEWAY_KEY', apiKey: 'old-key' };
    const settings: UserSettings = { defaultModel: 'another', profiles: [target] };
    const refresh = vi.fn();
    const switched = vi.fn();
    const context = {
      session: { getActiveProfile: () => target },
      settings,
      onModelSwitched: switched,
      onCredentialsUpdated: refresh,
    } as unknown as CommandContext;
    await updateModelApiKey(target, context, {
      globalSettings: settings,
      secretReader: async () => 'new-key',
      saveSettings: () => 'saved',
    });
    expect(refresh).toHaveBeenCalledWith(target.id);
    expect(switched).not.toHaveBeenCalled();
  });

  it('keeps both disk snapshot and runtime key unchanged when saving the new key fails', async () => {
    const target = { ...profile, apiKeyEnv: 'GATEWAY_KEY', apiKey: 'old-key' };
    const settings: UserSettings = { defaultModel: target.id, profiles: [target] };
    const context = {
      session: { getActiveProfile: () => target },
      settings,
      onModelSwitched: vi.fn(),
    } as unknown as CommandContext;
    await expect(
      updateModelApiKey(target, context, {
        globalSettings: settings,
        secretReader: async () => 'new-key',
        saveSettings: () => {
          throw new Error('disk failure');
        },
      }),
    ).rejects.toThrow('disk failure');
    expect(target.apiKey).toBe('old-key');
    expect(context.onModelSwitched).not.toHaveBeenCalled();
  });

  it('rejects busy role changes through the shared dispatcher before touching configuration', async () => {
    const dispatcher = new CommandDispatcher();
    const handler = vi.fn();
    dispatcher.registerDefinition(
      COMMAND_CATALOG.find((command) => command.name === 'model')!,
      handler,
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});
    await dispatcher.dispatch('/model route planning', {
      session: { isBusy: () => true } as AgentSession,
    } as CommandContext);
    expect(handler).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('会话忙'));
  });
});
