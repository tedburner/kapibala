import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { DesktopHost } from '../src/agent-host/desktop-host.js';

it('utility Host 清理首次失败后，显式退出可重试未完成清理', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-host-entry-'));
  const original = Object.getOwnPropertyDescriptor(process, 'parentPort');
  const parent = Object.assign(new EventEmitter(), { postMessage: vi.fn() });
  const port = Object.assign(new EventEmitter(), {
    postMessage: () => {},
    start: () => {},
    close: () => {},
  });
  const disconnect = vi
    .spyOn(DesktopHost.prototype, 'disconnect')
    .mockRejectedValueOnce(new Error('cleanup-failed'))
    .mockResolvedValue(undefined);
  Object.defineProperty(process, 'parentPort', { value: parent, configurable: true });
  try {
    await import('../src/agent-host/index.js');
    parent.emit('message', {
      data: { kind: 'attach', hostInstanceId: 'host', controlEpoch: 1, homeDirectory: home },
      ports: [port],
    });
    parent.emit('message', { data: { kind: 'detach', controlEpoch: 1 }, ports: [] });
    await vi.waitFor(() =>
      expect(parent.postMessage).toHaveBeenCalledWith({
        kind: 'host.detached',
        controlEpoch: 1,
        ok: false,
      }),
    );
    parent.emit('message', { data: { kind: 'shutdown' }, ports: [] });
    await vi.waitFor(() =>
      expect(parent.postMessage).toHaveBeenCalledWith({ kind: 'host.cleaned' }),
    );
    expect(disconnect).toHaveBeenCalledTimes(2);
  } finally {
    disconnect.mockRestore();
    parent.removeAllListeners();
    if (original) Object.defineProperty(process, 'parentPort', original);
    else Reflect.deleteProperty(process, 'parentPort');
    fs.rmSync(home, { recursive: true, force: true });
  }
});
