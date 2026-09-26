import { describe, expect, it, vi } from 'vitest';
import { modeCommand } from '../src/commands/mode.js';

describe('/mode', () => {
  it('requires an explicit confirmation before FullAccess and keeps the session unchanged on rejection', async () => {
    const switchMode = vi.fn();
    const confirm = vi.fn(async () => false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      await modeCommand(['full-access'], {
        session: { switchMode, getMode: () => 'Approval' },
        confirm,
      } as never);
      expect(confirm).toHaveBeenCalledOnce();
      expect(switchMode).not.toHaveBeenCalled();
      confirm.mockResolvedValue(true);
      await modeCommand(['full-access'], {
        session: { switchMode, getMode: () => 'Approval' },
        confirm,
      } as never);
      expect(switchMode).toHaveBeenCalledWith('FullAccess');
    } finally {
      log.mockRestore();
    }
  });
});
