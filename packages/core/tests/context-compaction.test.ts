import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { identifyHistory } from '../src/context/history.js';
import { ContextManager } from '../src/context/manager.js';
import { SessionStore } from '../src/context/session-store.js';
import type { MessageStore } from '../src/context/store/index.js';
import { ModelError } from '../src/errors/index.js';
import { SimpleModelRouter } from '../src/models/router.js';
import type { CanonicalMessage, ModelRequest, SessionEvent } from '../src/types/index.js';
import { ScriptedProvider } from './helpers/mock.js';

const profile = {
  id: 'test',
  name: 'test',
  modelName: 'test',
  provider: 'openai-compatible' as const,
  baseURL: 'http://127.0.0.1:9',
  apiKeyEnv: 'NONE',
  contextWindow: 4096,
};
const structured = {
  schemaVersion: 1,
  goal: 'continue',
  constraints: [],
  decisions: [],
  completedWork: ['read data'],
  pendingWork: [],
  references: [],
  unknownEffects: [],
};
const text = (role: CanonicalMessage['role'], value: string): CanonicalMessage => ({
  role,
  content: [{ type: 'text', text: value }],
});
const rawHistory = (name = 'read_file', failed = false) =>
  identifyHistory(
    [
      text('user', 'old request'),
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'read', name, source: 'builtin', input: { path: 'file.txt' } },
        ],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolUseId: 'read', content: '中'.repeat(3000), isError: failed },
        ],
      },
      text('assistant', 'old done'),
      text('user', 'recent request'),
      text('assistant', 'recent done'),
      text('user', 'current request'),
    ],
    'source',
  );
async function drain(
  generator: AsyncGenerator<SessionEvent, ModelRequest>,
): Promise<{ events: SessionEvent[]; request: ModelRequest }> {
  const events: SessionEvent[] = [];
  while (true) {
    const next = await generator.next();
    if (next.done) return { events, request: next.value };
    events.push(next.value);
  }
}

describe('two level context compaction', () => {
  it('exposes sanitized summary model reasons and retains the valid history projection', async () => {
    const provider = new ScriptedProvider([]);
    provider.create = async function* () {
      yield { type: 'thinking_delta', thinking: 'Checking the summary request.' };
      throw new ModelError('Insufficient Balance api_key=private-value', {
        status: 402,
        providerCode: 'insufficient_quota',
        stage: 'response',
      });
    };
    const manager = new ContextManager({
      conversationId: 'summary-error',
      router: new SimpleModelRouter({ ...profile, contextWindow: '32K' }, provider),
      projectRoot: process.cwd(),
      builtInToolNames: () => new Set(['read_file']),
    });
    const history = rawHistory('run_command');
    const before = JSON.stringify(history);
    const result = await drain(
      manager.prepare(history, { messages: manager.project(history) }, profile, 'run', 'manual'),
    );
    const failure = result.events.find((event) => event.type === 'compaction_failed');
    expect(failure).toMatchObject({
      modelError: {
        category: 'quota',
        status: 402,
        providerCode: 'insufficient_quota',
        operation: 'summary',
        modelId: 'test',
        message: 'Insufficient Balance api_key=[redacted]',
      },
    });
    expect(JSON.stringify(result.events)).not.toContain('private-value');
    expect(JSON.stringify(history)).toBe(before);
    expect(result.request.messages).toHaveLength(history.length);
  });
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-compaction-'));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  const make = (store?: MessageStore, provider = new ScriptedProvider([])) =>
    new ContextManager({
      conversationId: 'test',
      store,
      router: new SimpleModelRouter({ ...profile, contextWindow: '32K' }, provider),
      projectRoot: directory,
      builtInToolNames: () => new Set(['read_file', 'glob', 'grep']),
    });

  it.each(['failed', 'interrupted'] as const)(
    'summarizes an old closed %s interaction and restores its unknown file outcome',
    async (status) => {
      const store = await SessionStore.create(path.join(directory, 'failed-prefix.jsonl'), {
        conversationId: 'test',
        projectRoot: directory,
        initialCwd: directory,
      });
      const history = rawHistory('write_file', true);
      history.splice(3, 1);
      for (const message of history.slice(0, 3)) message.interactionId = 'old-failure';
      const result = history[2].content[0];
      if (result.type !== 'tool_result') throw new Error('Expected result');
      result.errorCode = 'OUTCOME_UNKNOWN';
      result.retryPolicy = 'after_user_action';
      await store.appendRecord('run_started', { interactionId: 'old-failure' });
      for (const message of history) await store.append(message);
      await store.appendRecord('run_finished', { interactionId: 'old-failure', status });
      const provider = new ScriptedProvider([
        [
          {
            type: 'text_delta',
            text: JSON.stringify({
              ...structured,
              completedWork: [],
              unknownEffects: ['file.txt write acknowledgement unknown; do not replay'],
            }),
          },
          { type: 'message_stop' },
        ],
      ]);
      const manager = make(store, provider);
      await manager.restore(history);
      const before = structuredClone(history);
      const prepared = await drain(
        manager.prepare(
          history,
          { messages: manager.project(history) },
          profile,
          undefined,
          'manual',
        ),
      );
      expect(
        prepared.events.some(
          (event) => event.type === 'compaction_finish' && event.kind === 'summary',
        ),
      ).toBe(true);
      expect(prepared.request.messages.slice(-3)).toEqual(history.slice(-3));
      expect(history).toEqual(before);
      const checkpoint = (await store.loadState()).records.find(
        (record) => record.type === 'checkpoint',
      )!;
      expect(
        (
          checkpoint.payload.details as {
            unknownFileOperations: unknown[];
            modifiedFiles: unknown[];
          }
        ).unknownFileOperations,
      ).toHaveLength(1);
      expect(
        (checkpoint.payload.details as { modifiedFiles: unknown[] }).modifiedFiles,
      ).toHaveLength(0);
      const restored = make(await SessionStore.open(store.filePath));
      await restored.restore(history);
      expect(restored.project(history)).toEqual(manager.project(history));
    },
  );

  it.each([false, true])(
    'keeps an old unresolved interaction when explicit terminal is %s',
    async (hasTerminal) => {
      const history = rawHistory('write_file', true);
      history.splice(3, 1);
      for (const message of history.slice(0, 3)) message.interactionId = 'unresolved';
      if (hasTerminal) history.splice(2, 1);
      const provider = new ScriptedProvider([]);
      const manager = make(undefined, provider);
      if (hasTerminal) manager.finishInteraction({ interactionId: 'unresolved', status: 'failed' });
      const before = manager.project(history);
      const prepared = await drain(
        manager.prepare(history, { messages: before }, profile, undefined, 'manual'),
      );
      expect(prepared.events).toEqual([]);
      expect(prepared.request.messages).toEqual(before);
      expect(provider.requests).toHaveLength(0);
    },
  );

  it('summarizes a closed failed round without pruning its successful reads', async () => {
    const history = rawHistory();
    history.splice(3, 1);
    for (const message of history.slice(0, 3)) message.interactionId = 'failed-after-read';
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: JSON.stringify(structured) }, { type: 'message_stop' }],
    ]);
    const manager = make(undefined, provider);
    manager.finishInteraction({ interactionId: 'failed-after-read', status: 'failed' });
    const prepared = await drain(
      manager.prepare(history, { messages: manager.project(history) }, profile),
    );
    expect(
      prepared.events.some((event) => event.type === 'compaction_finish' && event.kind === 'prune'),
    ).toBe(false);
    expect(
      prepared.events.some(
        (event) => event.type === 'compaction_finish' && event.kind === 'summary',
      ),
    ).toBe(true);
  });

  it('rejects fabricated checkpoint file observations and falls back to raw history', async () => {
    const store = await SessionStore.create(path.join(directory, 'facts.jsonl'), {
      conversationId: 'test',
      projectRoot: directory,
      initialCwd: directory,
    });
    const history = rawHistory();
    for (const message of history) await store.append(message);
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: JSON.stringify(structured) }, { type: 'message_stop' }],
    ]);
    const manager = make(store, provider);
    await drain(
      manager.prepare(
        history,
        { messages: manager.project(history) },
        profile,
        undefined,
        'manual',
      ),
    );
    const lines = fs
      .readFileSync(store.filePath, 'utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));
    const checkpoint = lines.find((record) => record.type === 'checkpoint');
    checkpoint.payload.details.readFiles[0].path = '/invented-success.txt';
    fs.writeFileSync(store.filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const restored = make(await SessionStore.open(store.filePath));
    await restored.restore(history);
    expect(restored.project(history)).toEqual(history);
  });

  it('does not activate a generated summary or count success when its commit fails', async () => {
    const { vi } = await import('vitest');
    const store = await SessionStore.create(path.join(directory, 'commit-fail.jsonl'), {
      conversationId: 'test',
      projectRoot: directory,
      initialCwd: directory,
    });
    const history = rawHistory('run_command');
    for (const message of history) await store.append(message);
    const original = store.appendRecord.bind(store);
    const spy = vi
      .spyOn(store, 'appendRecord')
      .mockImplementation((type, payload) =>
        type === 'checkpoint' ? Promise.reject(new Error('disk full')) : original(type, payload),
      );
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: JSON.stringify(structured) },
        { type: 'message_stop', usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } },
      ],
    ]);
    try {
      const manager = make(store, provider);
      await expect(
        drain(
          manager.prepare(
            history,
            { messages: manager.project(history) },
            profile,
            undefined,
            'manual',
          ),
        ),
      ).rejects.toMatchObject({ code: 'CONTEXT_STORAGE_ERROR' });
      expect(manager.project(history)).toEqual(history);
      const records = (await store.loadState()).records;
      expect(records.filter((r) => r.type === 'checkpoint')).toHaveLength(0);
      expect(
        records.filter((r) => r.type === 'usage' && r.payload.role === 'summary'),
      ).toHaveLength(1);
      expect(records.filter((r) => r.type === 'compaction_state')).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the live view unchanged on checkpoint fsync failure and recovers a complete durable record', async () => {
    const { vi } = await import('vitest');
    const store = await SessionStore.create(path.join(directory, 'fsync-fail.jsonl'), {
      conversationId: 'test',
      projectRoot: directory,
      initialCwd: directory,
    });
    const history = rawHistory('run_command');
    for (const message of history) await store.append(message);
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: JSON.stringify(structured) },
        { type: 'message_stop', usage: { promptTokens: 20, completionTokens: 5, totalTokens: 25 } },
      ],
    ]);
    const manager = make(store, provider);
    const sync = fs.fsyncSync;
    let syncCalls = 0;
    const spy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (++syncCalls === 2) throw new Error('checkpoint flush failed');
      sync(fd);
    });
    try {
      await expect(
        drain(
          manager.prepare(
            history,
            { messages: manager.project(history) },
            profile,
            undefined,
            'manual',
          ),
        ),
      ).rejects.toMatchObject({ code: 'CONTEXT_STORAGE_ERROR' });
      expect(manager.project(history)).toEqual(history);
      await expect(store.append({ role: 'user', content: [] })).rejects.toThrow();
    } finally {
      spy.mockRestore();
    }
    // 写入已到完整记录边界但确认失败：本进程不能假称成功，重启按完整日志重新校验。
    const reopened = await SessionStore.open(store.filePath);
    const restored = make(reopened);
    await restored.restore(history);
    expect(restored.project(history)).not.toEqual(history);
    expect(restored.project(history).slice(-3)).toEqual(history.slice(-3));
    const records = (await reopened.loadState()).records;
    expect(records.filter((r) => r.type === 'checkpoint')).toHaveLength(1);
    expect(records.filter((r) => r.type === 'usage' && r.payload.role === 'summary')).toHaveLength(
      1,
    );
  });

  it('prunes old successful builtin results without a summary call or changing raw/protected messages', async () => {
    const history = rawHistory();
    const before = structuredClone(history);
    const provider = new ScriptedProvider([]);
    const manager = make(undefined, provider);
    const result = await drain(
      manager.prepare(history, { messages: manager.project(history) }, profile),
    );
    expect(result.events.some((e) => e.type === 'compaction_finish' && e.kind === 'prune')).toBe(
      true,
    );
    expect(provider.requests).toHaveLength(0);
    expect(history).toEqual(before);
    expect(result.request.messages.slice(-3)).toEqual(before.slice(-3));
    expect(result.request.messages[2].content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'read',
      isError: false,
    });
    expect(manager.getSnapshot()?.prunedResults).toBe(1);
  });

  it('restores exactly the committed pruning and reset discards it', async () => {
    const store = await SessionStore.create(path.join(directory, 'session.jsonl'), {
      conversationId: 'test',
      projectRoot: directory,
      initialCwd: directory,
    });
    const history = rawHistory();
    for (const message of history) await store.append(message);
    const manager = make(store);
    const result = await drain(
      manager.prepare(history, { messages: manager.project(history) }, profile),
    );
    const restored = make(await SessionStore.open(store.filePath));
    await restored.restore(history);
    expect(restored.project(history)).toEqual(result.request.messages);
    await store.clear();
    await restored.restore(await store.load());
    expect(restored.project(await store.load())).toEqual([]);
  });

  it('does not prune failed, unknown or command results and summarizes their raw prefix', async () => {
    const history = rawHistory('run_command');
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: JSON.stringify(structured) }, { type: 'message_stop' }],
    ]);
    const manager = make(undefined, provider);
    const result = await drain(
      manager.prepare(history, { messages: manager.project(history) }, profile),
    );
    expect(result.events.some((e) => e.type === 'compaction_finish' && e.kind === 'summary')).toBe(
      true,
    );
    expect(result.events.some((e) => e.type === 'compaction_finish' && e.kind === 'prune')).toBe(
      false,
    );
    expect(result.request.messages[0].role).toBe('user');
    expect(result.request.messages.slice(-3)).toEqual(history.slice(-3));
    expect(provider.requests).toHaveLength(1);
    expect(JSON.stringify(provider.requests[0])).toContain('omitted');
  });

  it('stops when protected content alone exceeds budget without calling a summary model', async () => {
    const history = identifyHistory([text('user', '中'.repeat(5000))], 'source');
    const provider = new ScriptedProvider([]);
    const manager = make(undefined, provider);
    await expect(
      drain(manager.prepare(history, { messages: manager.project(history) }, profile)),
    ).rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });
    expect(provider.requests).toHaveLength(0);
  });

  it('does not activate a pruning candidate when durable commit fails', async () => {
    const history = rawHistory();
    const store = await SessionStore.create(path.join(directory, 'session.jsonl'), {
      conversationId: 'test',
      projectRoot: directory,
      initialCwd: directory,
    });
    for (const message of history) await store.append(message);
    const manager = make(store);
    fs.renameSync(store.filePath, `${store.filePath}.moved`);
    fs.mkdirSync(store.filePath);
    await expect(
      drain(manager.prepare(history, { messages: manager.project(history) }, profile)),
    ).rejects.toThrow();
    expect(manager.project(history)).toEqual(history);
  });

  it('allows manual summary below threshold without adding a user message', async () => {
    const history = identifyHistory(
      [
        text('user', 'one'),
        text('assistant', 'a'.repeat(2000)),
        text('user', 'two'),
        text('assistant', 'done'),
      ],
      'source',
    );
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: JSON.stringify(structured) }, { type: 'message_stop' }],
    ]);
    const manager = make(undefined, provider);
    const result = await drain(
      manager.prepare(
        history,
        { messages: manager.project(history) },
        { ...profile, contextWindow: '32K' },
        undefined,
        'manual',
      ),
    );
    expect(provider.requests).toHaveLength(1);
    expect(history).toHaveLength(4);
    expect(result.events.some((e) => e.type === 'compaction_finish' && e.kind === 'summary')).toBe(
      true,
    );
  });
  it('restores summary checkpoints and rolling summaries preserve the new protected tail', async () => {
    const store = await SessionStore.create(path.join(directory, 'summary.jsonl'), {
      conversationId: 'test',
      projectRoot: directory,
      initialCwd: directory,
    });
    const history = rawHistory('run_command');
    for (const message of history) await store.append(message);
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: JSON.stringify(structured) }, { type: 'message_stop' }],
      [{ type: 'text_delta', text: JSON.stringify(structured) }, { type: 'message_stop' }],
    ]);
    const manager = make(store, provider);
    const result = await drain(
      manager.prepare(history, { messages: manager.project(history) }, profile),
    );
    const reopenedStore = await SessionStore.open(store.filePath);
    const restored = make(reopenedStore, provider);
    await restored.restore(history);
    expect(restored.project(history)).toEqual(result.request.messages);
    const next = identifyHistory([text('assistant', 'done'), text('user', 'new current')], 'next');
    for (const message of next) {
      history.push(message);
      await reopenedStore.append(message);
    }
    const rolled = await drain(
      restored.prepare(
        history,
        { messages: restored.project(history) },
        profile,
        undefined,
        'manual',
      ),
    );
    expect(rolled.events.some((e) => e.type === 'compaction_finish')).toBe(true);
    expect(rolled.request.messages.slice(-3)).toEqual(history.slice(-3));
    expect(JSON.stringify(provider.requests[1])).toContain('previousSummary');
    const final = make(await SessionStore.open(store.filePath));
    await final.restore(history);
    expect(final.project(history)).toEqual(rolled.request.messages);
  });

  it('persists failure suppression and breaker state while retaining committed pruning', async () => {
    const history = rawHistory();
    history.splice(
      3,
      0,
      {
        id: 'command-call',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'command', name: 'run_command', source: 'builtin', input: {} },
        ],
      },
      {
        id: 'command-result',
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'command', content: '中'.repeat(2800) }],
      },
    );
    let store = await SessionStore.create(path.join(directory, 'breaker.jsonl'), {
      conversationId: 'test',
      projectRoot: directory,
      initialCwd: directory,
    });
    for (const message of history) await store.append(message);
    const provider = new ScriptedProvider(
      Array.from({ length: 5 }, () => [
        { type: 'text_delta', text: 'invalid summary' },
        { type: 'message_stop', usage: { promptTokens: 5, completionTokens: 1, totalTokens: 6 } },
      ]),
    );
    let manager = make(store, provider);
    const first = await drain(
      manager.prepare(history, { messages: manager.project(history) }, profile),
    );
    expect(
      first.events.filter((e) => e.type === 'compaction_finish' && e.kind === 'prune'),
    ).toHaveLength(1);
    expect(first.events.filter((e) => e.type === 'compaction_failed')).toHaveLength(1);
    expect(manager.getSnapshot()?.consecutiveFailures).toBe(1);
    await drain(manager.prepare(history, { messages: manager.project(history) }, profile));
    expect(provider.requests).toHaveLength(1);
    store = await SessionStore.open(store.filePath);
    manager = make(store, provider);
    await manager.restore(history);
    await drain(manager.prepare(history, { messages: manager.project(history) }, profile));
    expect(provider.requests).toHaveLength(1);
    for (let i = 0; i < 3; i++) {
      const message = { ...text('user', `new ${i}`), id: `new-${i}` };
      history.push(message);
      await store.append(message);
      await drain(manager.prepare(history, { messages: manager.project(history) }, profile));
    }
    expect(provider.requests).toHaveLength(3);
    expect(manager.getSnapshot()?.automaticSummaryPaused).toBe(true);
    expect(
      (await store.loadState()).records.filter(
        (r) => r.type === 'usage' && r.payload.role === 'summary',
      ),
    ).toHaveLength(3);
    await drain(
      manager.prepare(
        history,
        { messages: manager.project(history) },
        profile,
        undefined,
        'manual',
      ),
    );
    expect(manager.getSnapshot()?.consecutiveFailures).toBe(3);
    const successful = make(
      store,
      new ScriptedProvider([
        [{ type: 'text_delta', text: JSON.stringify(structured) }, { type: 'message_stop' }],
      ]),
    );
    await successful.restore(history);
    await drain(
      successful.prepare(
        history,
        { messages: successful.project(history) },
        profile,
        undefined,
        'manual',
      ),
    );
    expect(successful.getSnapshot()?.consecutiveFailures).toBe(0);
    expect(successful.getSnapshot()?.automaticSummaryPaused).toBe(false);
  });

  it('starts a new failure epoch when a summary endpoint or model changes under the same profile ID', async () => {
    const history = rawHistory('run_command');
    const provider = new ScriptedProvider(
      Array.from({ length: 4 }, () => [
        { type: 'text_delta' as const, text: 'invalid' },
        { type: 'message_stop' as const },
      ]),
    );
    const router = new SimpleModelRouter({ ...profile, contextWindow: '32K' }, provider);
    const manager = new ContextManager({ conversationId: 'test', router, projectRoot: directory });
    for (let i = 0; i < 3; i++) {
      history.push({ ...text('user', `new input ${i}`), id: `new-input-${i}` });
      await drain(manager.prepare(history, { messages: manager.project(history) }, profile));
    }
    expect(manager.getSnapshot()?.automaticSummaryPaused).toBe(true);
    router.setRole(
      'summary',
      {
        ...profile,
        contextWindow: '32K',
        modelName: 'new-summary-model',
        baseURL: 'http://127.0.0.1:8',
      },
      provider,
    );
    await drain(manager.prepare(history, { messages: manager.project(history) }, profile));
    expect(provider.requests).toHaveLength(4);
    expect(manager.getSnapshot()?.consecutiveFailures).toBe(1);
  });

  it('degrades legacy stores without rewriting messages or claiming restorable compaction', async () => {
    const history = rawHistory('run_command');
    const before = structuredClone(history);
    const legacy: MessageStore = {
      async load() {
        return structuredClone(history);
      },
      async append() {
        throw new Error('Must not rewrite raw messages');
      },
      async clear() {
        throw new Error('Must not clear raw messages');
      },
    };
    const provider = new ScriptedProvider([]);
    const manager = make(legacy, provider);
    await manager.restore(history);
    const result = await drain(
      manager.prepare(
        history,
        { messages: manager.project(history) },
        profile,
        undefined,
        'manual',
      ),
    );
    expect(provider.requests).toHaveLength(0);
    expect(result.request.messages).toEqual(before);
    expect(history).toEqual(before);
    expect(manager.getSnapshot()?.persistence).toBe('unsupported');
  });
});
