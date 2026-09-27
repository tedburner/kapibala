import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PromptAssembler } from '../src/capabilities/prompt/index.js';
import { writeFileTool } from '../src/capabilities/tools/builtin/fs.js';
import { SessionStore } from '../src/context/session-store.js';
import { AgentSession } from '../src/context/session/index.js';
import type { ModelProfile } from '../src/models/index.js';
import { ScriptedProvider } from './helpers/mock.js';

const profile: ModelProfile = {
  id: 'test',
  name: 'test',
  modelName: 'test',
  provider: 'openai-compatible',
  baseURL: 'http://127.0.0.1:9',
  apiKeyEnv: 'NONE',
  contextWindow: '32K',
};

describe('managed session lifecycle and request isolation', () => {
  let directory: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-context-'));
  });
  afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
  it('retains file execution paths across subdirectory resumes and checkpoint recovery', async () => {
    const firstRoot = path.join(directory, 'first');
    const secondRoot = path.join(directory, 'second');
    fs.mkdirSync(firstRoot);
    fs.mkdirSync(secondRoot);
    let store = await SessionStore.create(path.join(directory, 'paths.jsonl'), {
      conversationId: 'paths',
      projectRoot: directory,
      initialCwd: firstRoot,
    });
    for (const [index, rootDir] of [firstRoot, secondRoot].entries()) {
      const session = new AgentSession({
        defaultProfile: profile,
        defaultProvider: new ScriptedProvider([
          [
            {
              type: 'tool_call_finish',
              id: `write-${index}`,
              name: 'write_file',
              input: { path: 'file.txt', content: `from-${index}` },
            },
            { type: 'message_stop' },
          ],
          [{ type: 'text_delta', text: 'written' }, { type: 'message_stop' }],
        ]),
        store,
        rootDir,
        projectRoot: directory,
        loggingDirectory: path.join(directory, 'logs'),
        mode: 'Auto',
      });
      session.tools.register(writeFileTool);
      try {
        for await (const _ of session.run(`write-${index} ${'old observations '.repeat(500)}`)) {
          /* drain */
        }
        expect(fs.readFileSync(path.join(rootDir, 'file.txt'), 'utf8')).toBe(`from-${index}`);
      } finally {
        await session.destroy();
      }
      store = await SessionStore.open(store.filePath);
    }
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: new ScriptedProvider([
        [{ type: 'text_delta', text: 'recent done' }, { type: 'message_stop' }],
        [
          {
            type: 'text_delta',
            text: JSON.stringify({
              schemaVersion: 1,
              goal: 'continue',
              constraints: [],
              decisions: [],
              completedWork: ['wrote two files'],
              pendingWork: [],
              references: [],
              unknownEffects: [],
            }),
          },
          { type: 'message_stop' },
        ],
      ]),
      store,
      rootDir: directory,
      loggingDirectory: path.join(directory, 'logs'),
    });
    try {
      for await (const _ of session.run('recent task')) {
        /* drain */
      }
      for await (const _ of session.compact()) {
        /* drain */
      }
      const checkpoint = (await store.loadState()).records.find((r) => r.type === 'checkpoint');
      expect(checkpoint).toBeDefined();
      const details = checkpoint!.payload.details as { modifiedFiles: { path: string }[] };
      expect(details.modifiedFiles.map((file) => file.path)).toEqual(
        [firstRoot, secondRoot].map((root) => path.join(root, 'file.txt').replaceAll('\\', '/')),
      );
      await session.destroy();
      const restored = new AgentSession({
        defaultProfile: profile,
        defaultProvider: new ScriptedProvider([]),
        store: await SessionStore.open(store.filePath),
        rootDir: firstRoot,
        projectRoot: directory,
        loggingDirectory: path.join(directory, 'logs'),
      });
      try {
        await restored.init();
        expect(restored.getContextSnapshot()?.checkpointId).toBe(checkpoint!.payload.id);
      } finally {
        await restored.destroy();
      }
    } finally {
      await session.destroy();
    }
  });

  it('persists user interaction boundaries and restores actual usage without duplication', async () => {
    const store = await SessionStore.create(path.join(directory, 'session.jsonl'), {
      conversationId: 'conversation',
      projectRoot: directory,
      initialCwd: directory,
    });
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: 'done' },
        {
          type: 'message_stop',
          usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
        },
      ],
    ]);
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: provider,
      store,
      rootDir: directory,
      conversationId: 'conversation',
    });
    for await (const _ of session.run('question')) {
      /* drain */
    }
    const state = await store.loadState();
    expect(state.records.filter((r) => r.type === 'run_started')).toHaveLength(1);
    expect(state.records.filter((r) => r.type === 'run_finished')[0].payload.status).toBe(
      'completed',
    );
    expect(new Set(session.getHistory().map((m) => m.interactionId)).size).toBe(1);
    const metrics = session.getStats();
    metrics.lastRunMetrics!.status = 'failed';
    metrics.contextUsage.limitTokens = 1;
    expect(session.getStats().lastRunMetrics?.status).toBe('completed');
    expect(session.getStats().contextUsage.limitTokens).not.toBe(1);
    const restored = new AgentSession({
      defaultProfile: profile,
      defaultProvider: new ScriptedProvider([]),
      store: await SessionStore.open(store.filePath),
      rootDir: directory,
    });
    await restored.init();
    expect(restored.getStats().totalTokens.totalTokens).toBe(110);
    expect(restored.getStats().totalTurns).toBe(1);
    expect(restored.conversationId).toBe('conversation');
    const copy = restored.getHistory();
    copy[0].content.length = 0;
    expect(restored.getHistory()[0].content).toHaveLength(1);
  });

  it('keeps hook modifications separate from raw history and enforces final budgets', async () => {
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }],
    ]);
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: provider,
      rootDir: directory,
    });
    session.hooks.on('model:before', (_, request) => {
      request.messages[0].content = [{ type: 'text', text: 'hook context' }];
      return request;
    });
    for await (const _ of session.run('original')) {
      /* drain */
    }
    expect(session.getHistory()[0].content[0]).toEqual({ type: 'text', text: 'original' });
    expect(provider.requests[0][0].content[0]).toEqual({ type: 'text', text: 'hook context' });
    const blockedProvider = new ScriptedProvider([]);
    const blocked = new AgentSession({
      defaultProfile: { ...profile, contextWindow: 2048 },
      defaultProvider: blockedProvider,
      rootDir: directory,
    });
    blocked.hooks.on('model:before', (_, request) => ({
      ...request,
      systemPrompt: '中'.repeat(5000),
    }));
    await expect(async () => {
      for await (const _ of blocked.run('question')) {
        /* drain */
      }
    }).rejects.toMatchObject({ code: 'CONTEXT_BUDGET_EXCEEDED' });
    expect(blockedProvider.requests).toHaveLength(0);
    expect(blocked.getHistory()).toHaveLength(1);
  });

  it('keeps unchanged system prefixes byte stable across runs', () => {
    expect(new PromptAssembler({ rootDir: directory }).assemble()).toBe(
      new PromptAssembler({ rootDir: directory }).assemble(),
    );
    expect(new PromptAssembler({ rootDir: directory }).assemble()).not.toContain(
      'Current Date/Time:',
    );
  });

  it('records interrupted terminal after iterator return and waits before releasing busy state', async () => {
    const store = await SessionStore.create(path.join(directory, 'interrupted.jsonl'), {
      conversationId: 'interrupted',
      projectRoot: directory,
      initialCwd: directory,
    });
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: new ScriptedProvider([]),
      store,
      rootDir: directory,
    });
    const run = session.run('question')[Symbol.asyncIterator]();
    await run.next();
    await run.return?.();
    expect(
      (await store.loadState()).records.filter((r) => r.type === 'run_finished')[0].payload.status,
    ).toBe('interrupted');
    expect(session.isBusy()).toBe(false);
  });

  it.each([undefined, 'length'])(
    'does not mark empty or truncated answers as successful interactions (%s)',
    async (finishReason) => {
      const store = await SessionStore.create(
        path.join(directory, `failed-${finishReason}.jsonl`),
        { conversationId: 'failed', projectRoot: directory, initialCwd: directory },
      );
      const provider = new ScriptedProvider([
        finishReason
          ? [
              { type: 'text_delta', text: 'partial' },
              { type: 'message_stop', finishReason },
            ]
          : [{ type: 'message_stop' }],
      ]);
      const session = new AgentSession({
        defaultProfile: profile,
        defaultProvider: provider,
        store,
        rootDir: directory,
        loggingDirectory: path.join(directory, 'logs'),
      });
      for await (const _ of session.run('question')) {
      }
      expect(
        (await store.loadState()).records.find((r) => r.type === 'run_finished')!.payload.status,
      ).toBe('failed');
      expect(session.getContextSnapshot()!.protectedMessageIds).toContain(
        session.getHistory()[0].id,
      );
      await session.destroy();
    },
  );
});
