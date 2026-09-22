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

import { runSetupWizard } from '../src/wizard.js';

afterEach(() => {
  vi.clearAllMocks();
});

describe('runSetupWizard resource cleanup', () => {
  it('closes readline when loading the writable settings snapshot fails', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await expect(runSetupWizard()).rejects.toThrow('invalid global settings');
      expect(readlineMocks.close).toHaveBeenCalledOnce();
    } finally {
      log.mockRestore();
    }
  });
});
