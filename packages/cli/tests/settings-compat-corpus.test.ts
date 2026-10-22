import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_CATALOG_VERSION,
  BUILTIN_PROFILES,
  DEFAULT_MODEL_ID,
  credentialGroup,
  loadGlobalSettingsForWrite,
  migrateGlobalSettingsCatalog,
  readRawGlobalSettings,
  resolveApiKeyDetailed,
  saveGlobalSettings,
  updateProfileApiKey,
} from '../src/settings.js';

const fixtureDirectory = fileURLToPath(new URL('./fixtures/compat', import.meta.url));
const fixturePath = path.join(fixtureDirectory, 'settings-v0.0.9.json');
const manifest = JSON.parse(
  fs.readFileSync(path.join(fixtureDirectory, 'manifest.json'), 'utf8'),
) as {
  schemaVersion: number;
  fixtures: { file: string; sourceVersion: string; sha256: string }[];
};

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
const originalEnvKey = process.env.CUSTOM_ENV_KEY;
const temporaryDirectories: string[] = [];

function createHome(): { homeDir: string; settingsPath: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kapibala-config-compat-'));
  temporaryDirectories.push(root);
  const homeDir = path.join(root, 'home');
  const settingsPath = path.join(homeDir, '.kapibala', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  return { homeDir, settingsPath };
}

function installFixture(settingsPath: string): void {
  fs.copyFileSync(fixturePath, settingsPath);
}

afterEach(() => {
  vi.restoreAllMocks();
  if (originalEnvKey === undefined) Reflect.deleteProperty(process.env, 'CUSTOM_ENV_KEY');
  else process.env.CUSTOM_ENV_KEY = originalEnvKey;
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('settings compatibility corpus', () => {
  it('pins the v0.0.9 corpus and migrates legacy ids without losing keys', () => {
    const entry = manifest.fixtures.find((candidate) => candidate.file === 'settings-v0.0.9.json')!;
    expect(manifest.schemaVersion).toBe(1);
    expect(sha256(fs.readFileSync(fixturePath))).toBe(entry.sha256);
    expect(entry.sourceVersion).toBe('0.0.9');

    const { homeDir, settingsPath } = createHome();
    installFixture(settingsPath);
    const sourceHash = sha256(fs.readFileSync(fixturePath));

    const changes = migrateGlobalSettingsCatalog({ homeDir });
    expect(changes.length).toBeGreaterThan(0);
    expect(sha256(fs.readFileSync(fixturePath))).toBe(sourceHash);

    const persisted = readRawGlobalSettings({ homeDir })!;
    expect(persisted.defaultModel).toBe('deepseek-flash');
    expect(persisted.modelRouting).toEqual({
      planning: 'deepseek-v4-pro',
      execution: 'deepseek-flash',
      summary: 'gpt-5.6-terra',
      fast: 'gpt-5.6-sol',
    });
    expect(persisted.builtinCatalogVersion).toBe(BUILTIN_CATALOG_VERSION);
    expect(persisted.profiles.map((profile) => profile.id).sort()).toEqual([
      'custom-env-only',
      'custom-oneapi-a',
      'custom-oneapi-b',
      'deepseek-flash',
      'deepseek-v4-pro',
      'gpt-5.6-terra',
    ]);
    expect(persisted.profiles.find((profile) => profile.id === 'deepseek-flash')?.apiKey).toBe(
      'sk-deepseek-family',
    );
    expect(persisted.profiles.find((profile) => profile.id === 'gpt-5.6-terra')?.apiKey).toBe(
      'sk-openai-family',
    );
    expect(
      persisted.profiles.some((profile) => ['gpt-4o', 'deepseek-v4-flash'].includes(profile.id)),
    ).toBe(false);
    expect(migrateGlobalSettingsCatalog({ homeDir })).toEqual([]);
  });

  it('updates one family key, isolates unknown hosts, and never materializes builtins', () => {
    const { homeDir, settingsPath } = createHome();
    installFixture(settingsPath);
    migrateGlobalSettingsCatalog({ homeDir });
    const settings = loadGlobalSettingsForWrite({ homeDir });
    const gatewayA = settings.profiles.find((profile) => profile.id === 'custom-oneapi-a')!;
    const gatewayB = settings.profiles.find((profile) => profile.id === 'custom-oneapi-b')!;
    const envOnly = settings.profiles.find((profile) => profile.id === 'custom-env-only')!;

    expect(credentialGroup(gatewayA)).toMatch(/^host:/);
    expect(credentialGroup(gatewayA)).not.toBe(credentialGroup(gatewayB));
    expect(credentialGroup(envOnly)).toBe('host:env-only.example.com');

    const sameHost = { ...gatewayA, id: 'custom-oneapi-a2', apiKey: 'sk-stale' };
    settings.profiles.push(sameHost);
    expect(resolveApiKeyDetailed({ ...sameHost, apiKey: undefined }, settings)).toEqual({
      key: 'sk-gateway-a',
      source: 'shared',
      fromProfileId: 'custom-oneapi-a',
    });

    updateProfileApiKey(settings, 'custom-oneapi-a', ' sk-gateway-a-new ');
    updateProfileApiKey(settings, 'deepseek-flash', 'sk-deepseek-new');
    expect(gatewayA.apiKey).toBe('sk-gateway-a-new');
    expect(sameHost.apiKey).toBeUndefined();
    expect(gatewayB.apiKey).toBe('sk-gateway-b');
    expect(
      settings.profiles.find((profile) => profile.id === 'deepseek-v4-pro')?.apiKey,
    ).toBeUndefined();

    process.env.CUSTOM_ENV_KEY = 'sk-from-environment';
    expect(resolveApiKeyDetailed(envOnly, settings)).toEqual({
      key: 'sk-from-environment',
      source: 'env',
    });
    saveGlobalSettings(settings, { homeDir });

    const persisted = readRawGlobalSettings({ homeDir })!;
    expect(persisted.profiles).toHaveLength(settings.profiles.length);
    expect(persisted.profiles.some((profile) => profile.id === 'claude-opus-5')).toBe(false);
    expect(persisted.profiles.length).toBeLessThan(BUILTIN_PROFILES.length);
    expect(
      persisted.profiles.find((profile) => profile.id === 'custom-env-only')?.apiKey,
    ).toBeUndefined();
    expect(persisted.profiles.find((profile) => profile.id === 'custom-oneapi-b')?.apiKey).toBe(
      'sk-gateway-b',
    );
  });

  it('uses an empty skeleton for a missing file and refuses to overwrite a corrupt one', () => {
    const { homeDir, settingsPath } = createHome();
    const skeleton = loadGlobalSettingsForWrite({ homeDir });
    expect(skeleton.defaultModel).toBe(DEFAULT_MODEL_ID);
    expect(skeleton.profiles).toEqual([]);
    expect(fs.existsSync(settingsPath)).toBe(false);

    fs.writeFileSync(settingsPath, '{"defaultModel":"deepseek-flash","profiles":');
    const corruptBytes = fs.readFileSync(settingsPath);
    expect(() => loadGlobalSettingsForWrite({ homeDir })).toThrow(/无法安全读取/);
    expect(fs.readFileSync(settingsPath)).toEqual(corruptBytes);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => migrateGlobalSettingsCatalog({ homeDir })).not.toThrow();

    fs.writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'deepseek-flash' }));
    const missingProfilesBytes = fs.readFileSync(settingsPath);
    expect(() => loadGlobalSettingsForWrite({ homeDir })).toThrow(/无法安全读取/);
    expect(fs.readFileSync(settingsPath)).toEqual(missingProfilesBytes);
  });
});
