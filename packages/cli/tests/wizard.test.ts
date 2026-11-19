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

vi.mock('@kiturone/kapibala-host/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kiturone/kapibala-host/internal')>();
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
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        // 新探测实现会读取响应体解析窗口；旧目录形状（无窗口字段）不影响连通性判定。
        text: () => Promise.resolve(JSON.stringify({ data: [{ id: 'claude-opus-5' }] })),
      }),
    );
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
        headers: expect.objectContaining({
          'x-api-key': 'fixture-key',
          Authorization: 'Bearer fixture-key',
          'anthropic-version': '2023-06-01',
        }),
      }),
    );
  });
  it('surfaces the endpoint-declared context window from the probe', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: () =>
          Promise.resolve(JSON.stringify({ data: [{ id: 'gpt-x', context_length: 262144 }] })),
      }),
    );
    expect(
      await probeEndpoint(
        {
          id: 'custom-x',
          name: 'X',
          provider: 'openai-compatible',
          baseURL: 'http://127.0.0.1:9/v1',
          apiKeyEnv: 'CUSTOM_API_KEY',
          modelName: 'gpt-x',
        },
        'fixture-key',
      ),
    ).toEqual({ status: 'ok', detail: 'HTTP 200', contextWindow: 262144 });
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
