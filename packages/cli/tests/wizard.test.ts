import { afterEach, describe, expect, it, vi } from 'vitest';

const readlineMocks = vi.hoisted(() => ({
  close: vi.fn(),
  question: vi.fn(async () => '1'),
}));

vi.mock('node:readline/promises', () => ({
  default: {
    createInterface: () => readlineMocks,
  },
}));

vi.mock('../src/settings.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/settings.js')>();
  return {
    ...actual,
    loadGlobalSettingsForWrite: vi.fn(() => {
      throw new Error('invalid global settings');
    }),
  };
});

import { probeEndpoint, runSetupWizard } from '../src/wizard.js';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('runSetupWizard resource cleanup', () => {
  it('uses native Anthropic authentication for its read-only connectivity probe', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    expect(
      await probeEndpoint(
        {
          id: 'native-claude',
          name: 'Claude',
          provider: 'anthropic',
          baseURL: 'https://api.anthropic.com/v1/',
          apiKeyEnv: 'ANTHROPIC_API_KEY',
          modelName: 'claude-opus-5',
        },
        'fixture-key',
      ),
    ).toMatchObject({ status: 'ok' });
    expect(fetch).toHaveBeenCalledWith(
      'https://api.anthropic.com/v1/models',
      expect.objectContaining({
        method: 'GET',
        headers: {
          'x-api-key': 'fixture-key',
          Authorization: 'Bearer fixture-key',
          'anthropic-version': '2023-06-01',
        },
      }),
    );
  });
  it('closes readline when loading the writable settings snapshot fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(runSetupWizard()).rejects.toThrow('invalid global settings');
      expect(readlineMocks.close).toHaveBeenCalledOnce();
      const output = log.mock.calls.flat().join('\n');
      expect(output).toContain('DeepSeek V4 Pro');
      expect(output).not.toMatch(/深度思考|深度推理|旗舰/);
    } finally {
      log.mockRestore();
    }
  });
});
