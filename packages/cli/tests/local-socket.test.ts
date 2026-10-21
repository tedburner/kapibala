import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LocalClient } from '../src/client/index.js';
import { LocalHostServer } from '../src/local-host/server.js';
import { connectLocal, listenLocalHost } from '../src/transport/socket.js';

describe('authenticated local socket', () => {
  it('exchanges RPC over a real local endpoint and removes only its own socket', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-socket-'));
    const endpoint =
      process.platform === 'win32'
        ? { type: 'pipe' as const, path: `\\\\.\\pipe\\kpbl-test-${process.pid}` }
        : { type: 'unix' as const, path: path.join(root, 'host.sock') };
    const host = new LocalHostServer({
      token: 'fixture-token',
      create: async () => {
        throw new Error('not needed');
      },
    });
    const listener = await listenLocalHost(endpoint, (transport) => host.accept(transport));
    const client = await LocalClient.connect(await connectLocal(endpoint), {
      major: 1,
      minMinor: 0,
      maxMinor: 0,
      clientName: 'socket-test',
      capabilities: [],
      token: 'fixture-token',
    });
    expect(await client.call('ping', {})).toMatchObject({ alive: true });
    await client.close();
    await host.shutdown();
    await listener.close();
    if (endpoint.type === 'unix') expect(fs.existsSync(endpoint.path)).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
  });
  it('refuses network endpoint shapes', async () => {
    await expect(connectLocal({ type: 'tcp', path: '127.0.0.1:3000' } as never)).rejects.toThrow(
      /endpoint/i,
    );
  });
});
