import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_CATALOG_VERSION,
  BUILTIN_PROFILES,
  loadGlobalSettingsForWrite,
  loadSettings,
  migrateBuiltinCatalog,
  saveGlobalSettings,
} from '../src/settings.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const builtin = (id: string) => ({ ...BUILTIN_PROFILES.find((profile) => profile.id === id)! });

describe('native model catalog migration', () => {
  it('versions native protocol migration and provides native output budgets', () => {
    expect(BUILTIN_CATALOG_VERSION).toBeGreaterThan(3);
    expect(builtin('gpt-6-astra')).toMatchObject({
      provider: 'openai-responses',
      maxOutputTokens: 32768,
    });
    expect(builtin('claude-opus-5')).toMatchObject({
      provider: 'anthropic',
      maxOutputTokens: 16384,
    });
    expect(builtin('deepseek-flash').provider).toBe('openai-compatible');
  });

  it('preserves keys, references, explicit low budgets and custom Claude Chat gateways', () => {
    const native = {
      ...builtin('gpt-6-astra'),
      provider: 'openai-compatible' as const,
      apiKey: 'fixture-key',
      maxOutputTokens: 1024,
    };
    const custom = {
      ...builtin('claude-opus-5'),
      id: 'my-claude',
      provider: 'openai-compatible' as const,
      baseURL: 'https://gateway.example/v1',
      apiKey: 'gateway-key',
    };
    const input = {
      builtinCatalogVersion: 3,
      defaultModel: native.id,
      modelRouting: { execution: native.id, planning: custom.id },
      profiles: [native, custom],
    };
    const result = migrateBuiltinCatalog(input);
    expect(result.changed).toBe(true);
    expect(result.settings.profiles).toHaveLength(2);
    expect(result.settings.profiles[0]).toMatchObject({
      provider: 'openai-responses',
      apiKey: 'fixture-key',
      maxOutputTokens: 1024,
    });
    expect(result.settings.profiles[1]).toEqual(custom);
    expect(result.settings.defaultModel).toBe(input.defaultModel);
    expect(result.settings.modelRouting).toEqual(input.modelRouting);
    expect(input.profiles[0].provider).toBe('openai-compatible');
  });

  it('inherits a missing native budget when loading without adding unused profiles on disk', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-native-settings-'));
    directories.push(homeDir);
    const profile = builtin('claude-opus-5');
    profile.maxOutputTokens = undefined;
    saveGlobalSettings({ defaultModel: profile.id, profiles: [profile] }, { homeDir });
    const loaded = loadSettings({ homeDir, cwd: homeDir, includeProject: false }).settings;
    expect(loaded.profiles.find((candidate) => candidate.id === profile.id)?.maxOutputTokens).toBe(
      16384,
    );
    expect(loadGlobalSettingsForWrite({ homeDir }).profiles).toHaveLength(1);
  });

  it('keeps migrated profiles and references consistent when saving the same object twice', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-repeat-migration-'));
    directories.push(homeDir);
    const settings = {
      builtinCatalogVersion: 3,
      defaultModel: 'claude-opus-5',
      modelRouting: { planning: 'claude-opus-5', execution: 'gpt-6-astra' },
      profiles: ['claude-opus-5', 'gpt-6-astra'].map((id) => ({
        ...builtin(id),
        provider: 'openai-compatible' as const,
        apiKey: 'fixture-key',
        maxOutputTokens: 1024,
      })),
    };
    const expected = migrateBuiltinCatalog(settings).settings;
    const file = saveGlobalSettings(settings, { homeDir });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(expected);
    saveGlobalSettings(settings, { homeDir });
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(expected);
    expect(settings).toEqual(expected);
  });

  it('does not publish migrated settings in memory when replacing the file fails', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-failed-migration-'));
    directories.push(homeDir);
    const settings = {
      builtinCatalogVersion: 3,
      defaultModel: 'claude-opus-5',
      profiles: [{ ...builtin('claude-opus-5'), provider: 'openai-compatible' as const }],
    };
    const before = structuredClone(settings);
    const dir = path.join(homeDir, '.kapibala');
    fs.mkdirSync(dir);
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify(before));
    vi.spyOn(fs, 'renameSync').mockImplementation(() => {
      throw new Error('replace failed');
    });
    expect(() => saveGlobalSettings(settings, { homeDir })).toThrow('replace failed');
    expect(settings).toEqual(before);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(before);
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
  });

  it('rejects invalid output budgets in persistence before changing the existing file', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-native-invalid-'));
    directories.push(homeDir);
    const profile = builtin('gpt-6-astra');
    const settings = { defaultModel: profile.id, profiles: [profile] };
    const file = saveGlobalSettings(settings, { homeDir });
    const original = fs.readFileSync(file, 'utf8');
    settings.profiles[0]!.maxOutputTokens = -1;
    expect(() => saveGlobalSettings(settings, { homeDir })).toThrow(/maxOutputTokens/);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('does not invent scenario mappings for a new process', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-no-routes-'));
    directories.push(homeDir);
    expect(
      loadSettings({ homeDir, cwd: homeDir, includeProject: false }).settings.modelRouting,
    ).toBeUndefined();
  });

  it('preserves the previous settings file after a partial write failure', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-atomic-settings-'));
    directories.push(homeDir);
    const settings = { defaultModel: 'previous', profiles: [] };
    const file = saveGlobalSettings(settings, { homeDir });
    const original = fs.readFileSync(file, 'utf8');
    const write = fs.writeFileSync.bind(fs);
    vi.spyOn(fs, 'writeFileSync').mockImplementation((target, _value, options) => {
      write(target, 'partial', options);
      throw new Error('disk full');
    });
    expect(() => saveGlobalSettings({ ...settings, defaultModel: 'next' }, { homeDir })).toThrow(
      'disk full',
    );
    expect(fs.readFileSync(file, 'utf8')).toBe(original);
  });

  it('rejects malformed Chat capability overrides before persistence', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-invalid-capabilities-'));
    directories.push(homeDir);
    for (const chatCapabilities of [
      { requiresDone: 'false' },
      { maxTokensField: 'invented' },
      null,
    ]) {
      expect(() =>
        saveGlobalSettings(
          {
            defaultModel: 'custom',
            profiles: [{ ...builtin('deepseek-flash'), chatCapabilities } as never],
          },
          { homeDir },
        ),
      ).toThrow(/chatCapabilities/);
    }
  });

  it('describes all native protocols and overrides in the configuration schema', () => {
    const schema = JSON.parse(fs.readFileSync('schemas/settings.schema.json', 'utf8'));
    const fields = schema.definitions.modelProfile.properties;
    expect(fields.provider.enum).toEqual(['openai-compatible', 'anthropic', 'openai-responses']);
    expect(fields.maxOutputTokens).toMatchObject({ type: 'integer', minimum: 1 });
    expect(fields.chatCapabilities.properties.requiresDone).toEqual({ type: 'boolean' });
    expect(fields.anthropicWorkspaceId.type).toBe('string');
  });

  it('rejects invalid builtin output overrides instead of replacing them with the catalog budget', () => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-invalid-builtin-budget-'));
    directories.push(homeDir);
    fs.mkdirSync(path.join(homeDir, '.kapibala'));
    fs.writeFileSync(
      path.join(homeDir, '.kapibala', 'settings.json'),
      JSON.stringify({
        defaultModel: 'gpt-6-astra',
        profiles: [{ ...builtin('gpt-6-astra'), maxOutputTokens: 0 }],
      }),
    );
    expect(() => loadSettings({ homeDir, cwd: homeDir, includeProject: false })).toThrow(
      /maxOutputTokens/,
    );
  });
});
