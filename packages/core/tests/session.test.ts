import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelProfile } from '../src/models/index.js';
import { AgentSession } from '../src/session/index.js';
import { JSONLMessageStore } from '../src/store/jsonl.js';
import type { SessionEvent } from '../src/types/index.js';
import { ScriptedProvider, makeEchoToolRegistry } from './helpers/mock.js';

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
});
