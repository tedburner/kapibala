import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentSession, SessionManager } from '@kiturone/kapibala';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../core/tests/helpers/mock.js';
import { ActiveSessionController } from '../src/active-session.js';

const profile = {
  id: 'test',
  name: 'test',
  modelName: 'test',
  provider: 'openai-compatible' as const,
  baseURL: 'http://127.0.0.1:9',
  apiKeyEnv: 'NONE',
};
describe('active session controller', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-active-'));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  const make = async () => {
    const manager = new SessionManager({
      cwd: directory,
      homeDirectory: path.join(directory, 'home'),
    });
    const handle = await manager.create();
    const factory = async (target: typeof handle) =>
      new AgentSession({
        defaultProfile: profile,
        defaultProvider: new ScriptedProvider([
          [{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }],
        ]),
        store: target.store,
        rootDir: directory,
      });
    const session = await factory(handle);
    await session.init();
    return new ActiveSessionController({ manager, factory, current: { handle, session } });
  };

  it('switches every subsequent operation to the active target while preserving old history', async () => {
    const controller = await make();
    const first = controller.session.conversationId;
    for await (const _ of controller.run('first')) {
      /* drain */
    }
    await controller.newSession();
    const second = controller.session.conversationId;
    expect(second).not.toBe(first);
    for await (const _ of controller.run('second')) {
      /* drain */
    }
    await controller.resume(first);
    expect(controller.session.getHistory()[0].content[0]).toEqual({ type: 'text', text: 'first' });
    await controller.resume(first);
    expect(controller.session.conversationId).toBe(first);
    await controller.close();
  });

  it('keeps the original usable after failed target loading and rejects switching during cleanup', async () => {
    const controller = await make();
    const first = controller.session;
    await expect(controller.resume('missing')).rejects.toThrow(/not found/i);
    expect(controller.session).toBe(first);
    const run = controller.run('question')[Symbol.asyncIterator]();
    await run.next();
    await expect(controller.newSession()).rejects.toThrow(/busy|running/i);
    await run.return?.(undefined);
    await controller.newSession();
    await controller.close();
  });

  it('does not roll back a published target when old teardown fails and retains its lock', async () => {
    const controller = await make();
    const old = controller.session;
    const id = old.conversationId;
    let fail = true;
    await old.use({
      name: 'cleanup',
      setup: () => {},
      teardown: () => {
        if (fail) throw new Error('cleanup failure');
      },
    });
    await controller.newSession();
    expect(controller.session).not.toBe(old);
    await expect(controller.resume(id)).rejects.toThrow(/cleanup/i);
    fail = false;
    await controller.close();
  });
});
