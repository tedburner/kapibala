import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const coreUrl = pathToFileURL(path.resolve(process.argv[2] ?? 'packages/core/dist/index.js')).href;
const { SessionManager, SessionLock, AgentSession, AbortError } = await import(coreUrl);
const workerMode = process.argv[3];
const profile = {
  id: 'test',
  name: 'test',
  modelName: 'test',
  provider: 'openai-compatible',
  baseURL: 'http://127.0.0.1:9',
  apiKeyEnv: 'NONE',
  contextWindow: '32K',
};
if (workerMode) {
  try {
    if (workerMode === 'lock') {
      const lock = await SessionLock.acquire(process.argv[4]);
      process.send({ status: 'owner' });
      process.on('message', async (command) => {
        if (command === 'release') await lock.release();
        process.exit(0);
      });
    } else if (workerMode.startsWith('checkpoint-')) {
      const manager = new SessionManager({ cwd: process.argv[4], homeDirectory: process.argv[4] });
      const handle = await manager.create();
      for (const [role, text] of [
        ['user', 'old observations '.repeat(1200)],
        ['assistant', 'old done'],
        ['user', 'recent task'],
        ['assistant', 'recent done'],
      ])
        await handle.store.append({ role, content: [{ type: 'text', text }] });
      const provider = {
        name: 'checkpoint-script',
        async *create() {
          yield {
            type: 'text_delta',
            text: JSON.stringify({
              schemaVersion: 1,
              goal: 'continue',
              constraints: ['retain public API'],
              decisions: [],
              completedWork: ['old observations'],
              pendingWork: [],
              references: [],
              unknownEffects: [],
            }),
          };
          yield {
            type: 'message_stop',
            usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 },
          };
        },
        assembleToolResults: () => [],
      };
      const append = handle.store.appendRecord.bind(handle.store);
      handle.store.appendRecord = async (type, payload) => {
        if (type !== 'checkpoint') return append(type, payload);
        if (workerMode === 'checkpoint-after') await append(type, payload);
        process.send({ status: 'checkpoint-boundary', id: handle.conversationId });
        await new Promise(() => {});
      };
      const session = new AgentSession({
        defaultProfile: profile,
        defaultProvider: provider,
        store: handle.store,
        rootDir: process.argv[4],
        loggingDirectory: path.join(process.argv[4], 'logs'),
      });
      await session.init();
      for await (const _ of session.compact()) {
      }
    } else {
      const manager = new SessionManager({ cwd: process.argv[4], homeDirectory: process.argv[4] });
      const handle = await manager.create();
      await handle.store.appendRecord('run_started', { interactionId: 'interrupted' });
      await handle.store.append({
        id: 'assistant',
        interactionId: 'interrupted',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'unknown-write',
            name: 'write_file',
            source: 'builtin',
            input: { path: 'never-replay.txt', content: 'unknown' },
          },
        ],
      });
      process.send({ status: 'stored', id: handle.conversationId });
      process.on('message', () => process.exit(0));
    }
  } catch {
    process.send({ status: 'locked' });
    process.exit(0);
  }
} else {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-platform-'));
  const children = [];
  const worker = (mode) => {
    const options = { silent: true, windowsHide: true };
    const child = fork(
      fileURLToPath(import.meta.url),
      [
        fileURLToPath(coreUrl),
        mode,
        mode === 'lock' ? path.join(directory, 'writer.lock') : directory,
      ],
      options,
    );
    children.push(child);
    const ready = new Promise((resolve, reject) => {
      child.once('message', resolve);
      child.once('error', reject);
      child.once('exit', (code) => {
        if (code) reject(new Error('Worker failed'));
      });
    });
    return { child, ready };
  };
  const stop = async (child) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exit = new Promise((resolve) => child.once('exit', resolve));
    child.send('crash');
    await exit;
  };
  let manager;
  let session;
  try {
    const a = worker('lock');
    const b = worker('lock');
    const results = await Promise.all([a.ready, b.ready]);
    assert.deepEqual(results.map((r) => r.status).sort(), ['locked', 'owner']);
    await assert.rejects(SessionLock.acquire(path.join(directory, 'writer.lock')), /locked/);
    await Promise.all([stop(a.child), stop(b.child)]);
    const recovered = await SessionLock.acquire(path.join(directory, 'writer.lock'));
    await recovered.release();
    const crashed = worker('store');
    const stored = await crashed.ready;
    await stop(crashed.child);
    manager = new SessionManager({ cwd: directory, homeDirectory: directory });
    const handle = await manager.open(stored.id);
    const history = await handle.store.load();
    assert.equal(history[1].content[0].errorCode, 'OUTCOME_UNKNOWN');
    assert.equal(fs.existsSync(path.join(directory, 'never-replay.txt')), false);
    assert.deepEqual(await handle.store.load(), history);
    let entered;
    let release;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const cleanup = new Promise((resolve) => {
      release = resolve;
    });
    let aborted = false;
    const provider = {
      name: 'script',
      async *create(request) {
        yield* [];
        entered();
        try {
          await new Promise((resolve) =>
            request.signal.addEventListener(
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
    session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: provider,
      store: handle.store,
      rootDir: directory,
      loggingDirectory: path.join(directory, 'logs'),
    });
    await session.init();
    const iterator = session.run('cancel this request')[Symbol.asyncIterator]();
    const consuming = (async () => {
      try {
        while (!(await iterator.next()).done) {}
      } catch (error) {
        assert.equal(error.name, 'AbortError');
      }
    })();
    await started;
    const ending = iterator.return();
    assert.equal(aborted, true);
    assert.equal(session.isBusy(), true);
    await assert.rejects(
      manager.open(stored.id).then(async (target) => {
        const rival = new SessionManager({ cwd: directory, homeDirectory: directory });
        await rival.open(target.conversationId);
      }),
      /locked/,
    );
    release();
    await Promise.all([ending, consuming]);
    assert.equal(session.isBusy(), false);
    await session.destroy();
    await manager.close();
    for (const stage of ['before', 'after']) {
      const interrupted = worker(`checkpoint-${stage}`);
      const boundary = await interrupted.ready;
      assert.equal(boundary.status, 'checkpoint-boundary');
      const exited = new Promise((resolve) => interrupted.child.once('exit', resolve));
      interrupted.child.kill('SIGKILL');
      await exited;
      const target = await manager.open(boundary.id);
      const dormant = {
        name: 'no-replay',
        async *create() {
          assert.fail('Restore must never call a provider');
          yield* [];
        },
        assembleToolResults: () => [],
      };
      const restored = new AgentSession({
        defaultProfile: profile,
        defaultProvider: dormant,
        store: target.store,
        rootDir: directory,
        loggingDirectory: path.join(directory, 'logs'),
      });
      await restored.init();
      const raw = restored.getHistory();
      const projection = restored.getContextHistory();
      assert.deepEqual(projection.slice(-2), raw.slice(-2));
      assert.equal(projection.length, stage === 'after' ? 3 : 4);
      assert.equal(restored.getStats().summaryUsage.totalTokens, 25);
      assert.equal(restored.getContextSnapshot().summaryCount, stage === 'after' ? 1 : 0);
      await restored.destroy();
      await target.release();
    }
    console.log(
      JSON.stringify({
        platform: process.platform,
        node: process.version,
        checks: [
          'two-process-lock',
          'dead-owner-recovery',
          'crash-history-repair',
          'no-tool-replay',
          'in-flight-return-cancellation',
          'cleanup-before-unlock',
          'checkpoint-crash-before-commit',
          'checkpoint-crash-after-fsync-before-activation',
        ],
        passed: true,
      }),
    );
  } finally {
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) child.kill();
    if (session && !session.isBusy()) await session.destroy();
    if (manager) await manager.close();
    const resolved = path.resolve(directory);
    if (
      !resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
      !path.basename(resolved).startsWith('kpbl-platform-')
    )
      assert.fail('Unsafe cleanup target');
    fs.rmSync(resolved, { recursive: true, force: true });
  }
}
