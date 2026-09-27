import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SessionStore } from '../src/context/session-store.js';
import { AgentSession } from '../src/context/session/index.js';
import { AbortError } from '../src/errors/index.js';
import type { ModelEvent, ModelRequest } from '../src/types/index.js';

describe('consumer cancellation waits for cleanup', () => {
  it.each(['run', 'compact'] as const)(
    'return aborts an in-flight %s and keeps busy until provider cleanup finishes',
    async (operation) => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-cancel-'));
      let session: AgentSession | undefined;
      let release!: () => void;
      try {
        const store = await SessionStore.create(path.join(directory, 'session.jsonl'), {
          conversationId: 'cancel',
          projectRoot: directory,
          initialCwd: directory,
        });
        if (operation === 'compact')
          for (const [role, text] of [
            ['user', 'old '.repeat(2000)],
            ['assistant', 'old done'],
            ['user', 'recent'],
            ['assistant', 'recent done'],
          ] as const)
            await store.append({ role, content: [{ type: 'text', text }] });
        let entered!: () => void;
        const started = new Promise<void>((resolve) => {
          entered = resolve;
        });
        const cleanup = new Promise<void>((resolve) => {
          release = resolve;
        });
        let aborted = false;
        const provider = {
          name: 'controlled',
          async *create(request: ModelRequest): AsyncIterable<ModelEvent> {
            yield* [];
            entered();
            try {
              await new Promise<void>((resolve) =>
                request.signal!.addEventListener(
                  'abort',
                  () => {
                    aborted = true;
                    resolve();
                  },
                  { once: true },
                ),
              );
              throw new AbortError();
            } finally {
              await cleanup;
            }
          },
          assembleToolResults: () => [],
        };
        const profile = {
          id: 'test',
          name: 'test',
          modelName: 'test',
          provider: 'openai-compatible' as const,
          baseURL: 'http://127.0.0.1:9',
          apiKeyEnv: 'NONE',
          contextWindow: '32K' as const,
        };
        session = new AgentSession({
          defaultProfile: profile,
          defaultProvider: provider,
          store,
          rootDir: directory,
          loggingDirectory: path.join(directory, 'logs'),
        });
        await session.init();
        const iterator = (operation === 'run' ? session.run('question') : session.compact())[
          Symbol.asyncIterator
        ]();
        const consuming = (async () => {
          try {
            while (!(await iterator.next()).done) {}
          } catch (error) {
            expect(error).toBeInstanceOf(AbortError);
          }
        })();
        await started;
        const stopping = iterator.return!();
        expect(aborted).toBe(true);
        expect(session.isBusy()).toBe(true);
        await expect(session.destroy()).rejects.toThrow(/busy|running/i);
        release();
        await Promise.all([stopping, consuming]);
        expect(session.isBusy()).toBe(false);
        const records = (await store.loadState()).records;
        expect(records.filter((r) => r.type === 'checkpoint')).toHaveLength(0);
        expect(records.filter((r) => r.type === 'compaction_state')).toHaveLength(0);
      } finally {
        release?.();
        if (session && !session.isBusy()) await session.destroy();
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );
});
