import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AbortError } from '../src/errors/index.js';
import type { ModelProfile } from '../src/models/index.js';
import { AgentSession } from '../src/session/index.js';
import { JSONLMessageStore } from '../src/store/jsonl.js';
import { defineTool } from '../src/tools/index.js';
import type { ContentBlock, SessionEvent } from '../src/types/index.js';
import { ScriptedProvider, findDanglingToolUses, makeEchoToolRegistry } from './helpers/mock.js';

const TEST_PROFILE: ModelProfile = {
  id: 'test-profile',
  name: 'Test Profile',
  provider: 'openai-compatible',
  baseURL: 'http://127.0.0.1:9/v1',
  apiKeyEnv: 'NONE',
  modelName: 'test-model',
};

describe('AgentSession 消息级落盘', () => {
  let tempDir: string;
  let storePath: string;
  let store: JSONLMessageStore;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-session-test-'));
    storePath = path.join(tempDir, 'history.jsonl');
    store = new JSONLMessageStore(storePath);
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('把 user / assistant / tool / assistant 全链路写进 JSONL，重载后无需自愈', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_finish', id: 'call_1', name: 'echo', input: { value: 'hi' } },
        { type: 'message_stop' },
      ],
      [
        { type: 'text_delta', text: 'ok' },
        { type: 'message_stop', usage: { promptTokens: 3, completionTokens: 1, totalTokens: 4 } },
      ],
    ]);

    const session = new AgentSession({
      defaultProfile: TEST_PROFILE,
      defaultProvider: provider,
      store,
      rootDir: tempDir,
    });
    for (const tool of makeEchoToolRegistry().list()) {
      session.tools.register(tool);
    }
    await session.init();

    const events: SessionEvent[] = [];
    for await (const event of session.run('请调用 echo')) {
      events.push(event);
    }

    // 落盘内容（含 tool_result）必须与内存历史一致
    const persisted = fs
      .readFileSync(storePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(persisted.map((record) => record.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);
    expect(persisted[2].content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'call_1',
      content: 'echo:hi',
    });

    // 重载后仍是 4 条：修复前的实现里 tool 消息整条缺失，会被自愈逻辑补成 is_error
    const reloaded = await store.load();
    expect(reloaded.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ]);

    // token 统计继续累积
    expect(session.getStats().totalTokens.totalTokens).toBe(4);
  });

  it('destroy() 幂等，并回收已挂载插件的资源', async () => {
    const teardown = vi.fn();
    const session = new AgentSession({
      defaultProfile: TEST_PROFILE,
      defaultProvider: new ScriptedProvider([]),
      rootDir: tempDir,
    });
    const sessionEnd = vi.fn();
    session.hooks.on('session:end', sessionEnd);

    await session.use({ name: 'fixture-plugin', setup: vi.fn(), teardown });
    await session.destroy();
    await session.destroy();

    expect(teardown).toHaveBeenCalledTimes(1);
    expect(sessionEnd).toHaveBeenCalledTimes(1);
    await expect(session.use({ name: 'late', setup: vi.fn() })).rejects.toThrow(
      /already destroyed/,
    );
  });

  it('does not expose a tool-use message until its tool result has closed history', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_finish', id: 'call_buffered', name: 'echo', input: { value: 'hi' } },
        { type: 'message_stop' },
      ],
      [{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }],
    ]);
    const session = new AgentSession({
      defaultProfile: TEST_PROFILE,
      defaultProvider: provider,
      store,
      rootDir: tempDir,
    });
    for (const tool of makeEchoToolRegistry().list()) session.tools.register(tool);

    const iterator = session.run('use echo')[Symbol.asyncIterator]();
    let sawToolAssistant = false;
    while (!sawToolAssistant) {
      const next = await iterator.next();
      expect(next.done).toBe(false);
      if (next.value?.type === 'message_stop') {
        sawToolAssistant = next.value.message.content.some(
          (block: ContentBlock) => block.type === 'tool_use',
        );
      }
    }

    await iterator.return?.();
    expect(findDanglingToolUses(session.getHistory())).toEqual([]);
    expect((await store.load()).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
  });

  it('does not admit a tool-use message when model:after rejects', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_finish', id: 'call_hook', name: 'echo', input: { value: 'hi' } },
        { type: 'message_stop' },
      ],
    ]);
    const session = new AgentSession({
      defaultProfile: TEST_PROFILE,
      defaultProvider: provider,
      store,
      rootDir: tempDir,
    });
    session.hooks.on('model:after', async () => {
      throw new Error('hook failed');
    });

    await expect(async () => {
      for await (const _event of session.run('trigger hook')) {
        // drain
      }
    }).rejects.toThrow('hook failed');

    expect(findDanglingToolUses(session.getHistory())).toEqual([]);
    expect(session.getHistory().map((message) => message.role)).toEqual(['user']);
    expect((await store.load()).map((message) => message.role)).toEqual(['user']);
  });

  it('cancels and waits for tool cleanup before releasing a returned progress iterator', async () => {
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let toolSignal: AbortSignal | undefined;
    let cleanedUp = false;
    const session = new AgentSession({
      defaultProfile: TEST_PROFILE,
      defaultProvider: new ScriptedProvider([
        [
          { type: 'tool_call_finish', id: 'call_cleanup', name: 'cleanup', input: {} },
          { type: 'message_stop' },
        ],
      ]),
      rootDir: tempDir,
      store,
      eventLogger: { async record() {}, async recordAudit() {} },
    });
    session.tools.register(
      defineTool({
        name: 'cleanup',
        description: 'Wait for resource cleanup.',
        parameters: {},
        metadata: { permissions: ['fs:read'], managesTimeout: true },
        async execute(_input, ctx) {
          toolSignal = ctx.signal;
          ctx.onProgress?.({ elapsedMs: 1, outputBytes: 0 });
          await cleanupGate;
          cleanedUp = true;
          if (ctx.signal?.aborted) throw new AbortError();
          return 'done';
        },
      }),
    );
    const iterator = session.run('run cleanup')[Symbol.asyncIterator]();
    while ((await iterator.next()).value?.type !== 'tool_progress') {
      /* consume */
    }
    let returned = false;
    const returning = iterator.return!().then(() => {
      returned = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(toolSignal?.aborted).toBe(true);
      expect(returned).toBe(false);
      expect(cleanedUp).toBe(false);
      await expect(session.reset()).rejects.toThrow(/already running/i);
      await expect(session.run('second')[Symbol.asyncIterator]().next()).rejects.toThrow(
        /already running/i,
      );
      releaseCleanup();
      await returning;
      expect(cleanedUp).toBe(true);
      const persisted = fs
        .readFileSync(storePath, 'utf-8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(persisted.map((record) => record.role)).toEqual(['user', 'assistant', 'tool']);
      expect(persisted[2].content[0]).toMatchObject({
        type: 'tool_result',
        toolUseId: 'call_cleanup',
      });
      expect(findDanglingToolUses(session.getHistory())).toEqual([]);
      expect(session.getHistory().map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'tool',
      ]);
      await expect(session.reset()).resolves.toBeUndefined();
    } finally {
      releaseCleanup();
      await returning;
    }
  });

  it('does not start remaining tool calls after a progress iterator is returned', async () => {
    let releaseTool!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let remainingStarted = false;
    const session = new AgentSession({
      defaultProfile: TEST_PROFILE,
      defaultProvider: new ScriptedProvider([
        [
          { type: 'tool_call_finish', id: 'call_first', name: 'first', input: {} },
          { type: 'tool_call_finish', id: 'call_remaining', name: 'remaining', input: {} },
          { type: 'message_stop' },
        ],
      ]),
      rootDir: tempDir,
      store,
      eventLogger: { async record() {}, async recordAudit() {} },
    });
    session.tools.register(
      defineTool({
        name: 'first',
        description: 'First call.',
        parameters: {},
        metadata: { permissions: ['fs:read'], managesTimeout: true },
        async execute(_input, ctx) {
          ctx.onProgress?.({ elapsedMs: 1, outputBytes: 0 });
          await gate;
          if (ctx.signal?.aborted) throw new AbortError();
          return 'first result';
        },
      }),
    );
    session.tools.register(
      defineTool({
        name: 'remaining',
        description: 'Remaining call.',
        parameters: {},
        metadata: { permissions: ['fs:read'] },
        async execute() {
          remainingStarted = true;
          return 'remaining result';
        },
      }),
    );
    const iterator = session.run('run both')[Symbol.asyncIterator]();
    while ((await iterator.next()).value?.type !== 'tool_progress') {
      /* consume */
    }
    const returning = iterator.return!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseTool();
    await returning;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(remainingStarted).toBe(false);
    const persisted = fs
      .readFileSync(storePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(persisted.map((record) => record.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(
      persisted
        .slice(2)
        .flatMap((record) => record.content)
        .map((block) => block.toolUseId),
    ).toEqual(['call_first', 'call_remaining']);
    expect(findDanglingToolUses(session.getHistory())).toEqual([]);
  });

  it('persists completed tool results when returning with queued progress events', async () => {
    let finished = false;
    const session = new AgentSession({
      defaultProfile: TEST_PROFILE,
      defaultProvider: new ScriptedProvider([
        [
          { type: 'tool_call_finish', id: 'call_completed', name: 'completed', input: {} },
          { type: 'message_stop' },
        ],
      ]),
      rootDir: tempDir,
      store,
      eventLogger: {
        async record() {},
        async recordAudit(event) {
          if (event.event === 'tool.finished') finished = true;
        },
      },
    });
    session.tools.register(
      defineTool({
        name: 'completed',
        description: 'Finish immediately with progress queued.',
        parameters: {},
        metadata: { permissions: ['fs:read'] },
        async execute(_input, ctx) {
          ctx.onProgress?.({ elapsedMs: 1, outputBytes: 1 });
          ctx.onProgress?.({ elapsedMs: 2, outputBytes: 2 });
          return 'completed result';
        },
      }),
    );
    const iterator = session.run('complete')[Symbol.asyncIterator]();
    while ((await iterator.next()).value?.type !== 'tool_progress') {
      /* consume */
    }
    await vi.waitFor(() => expect(finished).toBe(true));
    await iterator.return!();
    const persisted = fs
      .readFileSync(storePath, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(persisted.map((record) => record.role)).toEqual(['user', 'assistant', 'tool']);
    expect(persisted[2].content[0]).toMatchObject({
      toolUseId: 'call_completed',
      content: 'completed result',
      isError: false,
    });
    expect(session.getHistory().map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ]);
    expect(findDanglingToolUses(session.getHistory())).toEqual([]);
  });

  it('rejects concurrent mutations of the same session and releases the lock on return', async () => {
    const session = new AgentSession({
      defaultProfile: TEST_PROFILE,
      defaultProvider: new ScriptedProvider([[{ type: 'message_stop' }]]),
      rootDir: tempDir,
    });

    const first = session.run('first')[Symbol.asyncIterator]();
    await first.next();

    await expect(session.run('second')[Symbol.asyncIterator]().next()).rejects.toThrow(
      /already running/i,
    );
    await expect(session.reset()).rejects.toThrow(/already running/i);
    expect(() => session.switchModel(TEST_PROFILE)).toThrow(/already running/i);

    await first.return?.();
    await expect(session.reset()).resolves.toBeUndefined();
  });
});
