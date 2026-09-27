import { type ChildProcess, fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SessionLock } from '../src/context/session-lock.js';

const children: ChildProcess[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    const exit = new Promise<void>((resolve) => child.once('exit', () => resolve()));
    child.kill();
    await exit;
  }
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
function worker(lock: string) {
  const directory = path.dirname(lock);
  const file = path.join(directory, `worker-${children.length}.mjs`);
  const core = pathToFileURL(path.resolve('packages/core/dist/index.js')).href;
  fs.writeFileSync(
    file,
    `import { SessionLock } from ${JSON.stringify(core)};
    try {
      const lock = await SessionLock.acquire(${JSON.stringify(lock)});
      process.send({ status: 'owner' });
      process.on('message', async command => {
        if (command === 'release') await lock.release();
        process.exit(0);
      });
    } catch { process.send({ status: 'locked' }); process.exit(0); }`,
  );
  const options = { silent: true, windowsHide: true };
  const child = fork(file, [], options);
  children.push(child);
  const ready = new Promise<string>((resolve, reject) => {
    child.once('message', (message: { status: string }) => resolve(message.status));
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code && code !== 0) reject(new Error('worker exited'));
    });
  });
  return { child, ready };
}
describe('real process writer ownership', () => {
  it('allows exactly one simultaneous owner and recovers only after confirmed process exit', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-process-'));
    directories.push(directory);
    const lock = path.join(directory, 'conversation.lock');
    const a = worker(lock);
    const b = worker(lock);
    const states = await Promise.all([a.ready, b.ready]);
    expect(states.sort()).toEqual(['locked', 'owner']);
    await expect(SessionLock.acquire(lock)).rejects.toThrow(/locked/i);
    const owner = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    const holder = [a.child, b.child].find((child) => child.pid === owner.pid)!;
    const exit = new Promise<void>((resolve) => holder.once('exit', () => resolve()));
    holder.send('crash');
    await exit;
    const recovered = await SessionLock.acquire(lock);
    expect(JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8')).nonce).not.toBe(
      owner.nonce,
    );
    await recovered.release();
    expect(fs.existsSync(lock)).toBe(false);
  }, 15_000);
});
