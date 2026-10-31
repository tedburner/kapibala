import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { listBuiltinProviders } from '../src/providers.js';
import { loadGlobalSettingsForWrite, mutateGlobalSettings } from '../src/settings.js';
import { runSetupWizard } from '../src/wizard.js';

let home = '';
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});
it('向导在交互和探测后按字段提交，保留同时提交的其它配置', async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-wizard-transaction-'));
  vi.spyOn(os, 'homedir').mockReturnValue(home);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const answers = [
    String(listBuiltinProviders().length + 1),
    'Fixture',
    'http://127.0.0.1:1/v1',
    'fixture',
  ];
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      mutateGlobalSettings(
        (draft) => {
          draft.modelRouting = { fast: 'unrelated' };
        },
        { homeDir: home },
      );
      return { ok: true, status: 200 };
    }),
  );
  const result = await runSetupWizard({
    question: async () => answers.shift() ?? '',
    secretReader: async () => {
      mutateGlobalSettings(
        (draft) => {
          draft.trustedProjects = ['/other-writer'];
        },
        { homeDir: home },
      );
      return 'fixture-new-key';
    },
  });
  const stored = loadGlobalSettingsForWrite({ homeDir: home });
  expect(stored).toMatchObject({
    trustedProjects: ['/other-writer'],
    modelRouting: { fast: 'unrelated' },
    defaultModel: result.profile.id,
  });
  expect(stored.profiles).toHaveLength(1);
  expect(stored.profiles[0].apiKey).toBe('fixture-new-key');
  expect(fs.existsSync(path.join(home, '.kapibala/settings.json.lock'))).toBe(false);
});
