import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_PROFILES, loadSettings } from '@kiturone/kapibala-host/internal';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { persistDefaultModel, persistModelRole } from '../src/default-model.js';

describe('default model persistence', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-default-'));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  it('内置模型只写引用，不把内置条目物化进用户文件', () => {
    const settings = loadSettings({ homeDir: directory, includeProject: false }).settings;
    const selected = BUILTIN_PROFILES.find((p) => p.id !== settings.defaultModel)!;
    persistDefaultModel(selected, settings, { homeDir: directory });
    const stored = JSON.parse(
      fs.readFileSync(path.join(directory, '.kapibala', 'settings.json'), 'utf8'),
    );
    // 内置清单由代码提供，引用在加载时经 loadSettings 合并解析；物化条目只会得到过期快照。
    expect(stored.profiles).toEqual([]);
    expect(stored.defaultModel).toBe(selected.id);
    expect(settings.defaultModel).toBe(selected.id);
  });
  it('自定义 Profile 补入全局文件，跨项目与重启后的引用才有落点', () => {
    const settings = loadSettings({ homeDir: directory, includeProject: false }).settings;
    const custom = {
      id: 'custom-gateway',
      name: 'Custom Gateway',
      provider: 'openai-compatible' as const,
      baseURL: 'https://gw.example.com/v1',
      apiKeyEnv: 'CUSTOM_API_KEY',
      modelName: 'gateway-model',
    };
    persistDefaultModel(custom, settings, { homeDir: directory });
    const stored = JSON.parse(
      fs.readFileSync(path.join(directory, '.kapibala', 'settings.json'), 'utf8'),
    );
    expect(stored.profiles.map((p: { id: string }) => p.id)).toEqual(['custom-gateway']);
    expect(stored.defaultModel).toBe('custom-gateway');
  });
  it('角色绑定同样只写引用：内置模型不物化条目', () => {
    const settings = loadSettings({ homeDir: directory, includeProject: false }).settings;
    const selected = BUILTIN_PROFILES.find(
      (p) => p.id !== settings.defaultModel && p.id !== settings.modelRouting?.planning,
    )!;
    persistModelRole(selected, 'planning', settings, { homeDir: directory });
    const stored = JSON.parse(
      fs.readFileSync(path.join(directory, '.kapibala', 'settings.json'), 'utf8'),
    );
    expect(stored.profiles).toEqual([]);
    expect(stored.modelRouting).toEqual({ planning: selected.id });
    expect(settings.modelRouting?.planning).toBe(selected.id);
  });
  it('does not update memory when storage fails', () => {
    const settings = loadSettings({ homeDir: directory, includeProject: false }).settings;
    const before = settings.defaultModel;
    const selected = BUILTIN_PROFILES.find((p) => p.id !== before)!;
    expect(() =>
      persistDefaultModel(selected, settings, {
        homeDir: directory,
        mutateSettings: () => {
          throw new Error('write failed');
        },
      }),
    ).toThrow('write failed');
    expect(settings.defaultModel).toBe(before);
  });
});
