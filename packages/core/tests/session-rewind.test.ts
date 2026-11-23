import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStore } from '../src/context/session-store.js';
import { AgentSession } from '../src/context/session/index.js';
import { JSONLMessageStore } from '../src/context/store/jsonl.js';
import type { ModelProfile } from '../src/models/index.js';
import type { Usage } from '../src/types/index.js';
import { ScriptedProvider } from './helpers/mock.js';

const TEST_PROFILE: ModelProfile = {
  id: 'test-profile',
  name: 'Test Profile',
  provider: 'openai-compatible',
  baseURL: 'http://127.0.0.1:9/v1',
  apiKeyEnv: 'NONE',
  modelName: 'test-model',
};

const usage = (total: number): Usage => ({
  promptTokens: total - 4,
  completionTokens: 4,
  totalTokens: total,
});

/** 只回正文的单步 provider；每轮消耗由脚本显式给出。 */
function reply(text: string, total: number) {
  return [
    { type: 'text_delta' as const, text },
    { type: 'message_stop' as const, usage: usage(total) },
  ];
}

describe('AgentSession 逐消息消耗与上一轮回退', () => {
  let directory: string;
  let file: string;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kpbl-rewind-'));
    file = path.join(directory, 'session.jsonl');
  });

  afterEach(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });

  async function openSession(
    turns: ReturnType<typeof reply>[],
  ): Promise<{ session: AgentSession; provider: ScriptedProvider; store: SessionStore }> {
    const store = await SessionStore.create(file, {
      conversationId: 'test-rewind',
      projectRoot: directory,
      initialCwd: directory,
    });
    const provider = new ScriptedProvider(turns);
    const session = new AgentSession({
      conversationId: 'test-rewind',
      defaultProfile: TEST_PROFILE,
      defaultProvider: provider,
      store,
      rootDir: directory,
    });
    await session.init();
    return { session, provider, store };
  }

  it('把每条助手消息的 usage 持久化到 run_finished，并在重开后恢复', async () => {
    const { session } = await openSession([reply('第一轮', 11), reply('第二轮', 17)]);
    for await (const _ of session.run('问题一')) {
      /* 消费事件 */
    }
    for await (const _ of session.run('问题二')) {
      /* 消费事件 */
    }
    const history = session.getHistory();
    const assistantIds = history.filter((message) => message.role === 'assistant').map((m) => m.id);
    expect(assistantIds).toHaveLength(2);
    expect([...session.getMessageUsages().keys()]).toEqual(assistantIds);
    expect(session.getMessageUsages().get(assistantIds[1]!)).toMatchObject({ totalTokens: 17 });
    await session.destroy();

    // 重新打开同一会话：消息身份不变，token 映射从 run_finished 重建。
    const reopenedStore = await SessionStore.open(file);
    const reopened = new AgentSession({
      conversationId: 'test-rewind',
      defaultProfile: TEST_PROFILE,
      defaultProvider: new ScriptedProvider([]),
      store: reopenedStore,
      rootDir: directory,
    });
    await reopened.init();
    expect(reopened.getHistory().map((message) => message.id)).toEqual(
      history.map((message) => message.id),
    );
    expect(reopened.getMessageUsages().get(assistantIds[0]!)).toMatchObject({ totalTokens: 11 });
    expect(reopened.getMessageUsages().get(assistantIds[1]!)).toMatchObject({ totalTokens: 17 });
    await reopened.destroy();
  });

  it('rewindLastTurn 截断最后一轮、切换分支并剔除该轮消耗', async () => {
    const { session, store } = await openSession([
      reply('第一轮', 11),
      reply('第二轮', 17),
      reply('重试后的第二轮', 23),
    ]);
    for await (const _ of session.run('问题一')) {
      /* 消费事件 */
    }
    const afterFirst = session.getHistory();
    for await (const _ of session.run('问题二')) {
      /* 消费事件 */
    }
    expect(session.getHistory()).toHaveLength(4);

    const { branchId } = await session.rewindLastTurn();
    expect(store.getActiveBranchId()).toBe(branchId);
    expect(branchId).toMatch(/^retry-/);
    // 历史回到第一轮之后；被截断轮次的助手消息不再出现。
    expect(session.getHistory().map((message) => message.id)).toEqual(
      afterFirst.map((message) => message.id),
    );
    expect(session.getMessageUsages().size).toBe(1);
    expect(session.getStats().totalTokens).toMatchObject({ totalTokens: 11 });
    expect(session.getStats().totalTurns).toBe(1);

    // 重跑后只有一套新回答，usage 重新累计两条消息。
    for await (const _ of session.run('问题二')) {
      /* 消费事件 */
    }
    expect(session.getHistory()).toHaveLength(4);
    expect(session.getMessageUsages().size).toBe(2);
    expect(session.getStats().totalTokens).toMatchObject({ totalTokens: 34 });
    await session.destroy();
  });

  it('第一轮也能回退到空会话再重新生成', async () => {
    const { session } = await openSession([reply('首答', 9), reply('重答', 13)]);
    for await (const _ of session.run('问题一')) {
      /* 消费事件 */
    }
    expect(session.getHistory()).toHaveLength(2);
    await session.rewindLastTurn();
    expect(session.getHistory()).toHaveLength(0);
    expect(session.getMessageUsages().size).toBe(0);
    expect(session.getStats().totalTurns).toBe(0);

    for await (const _ of session.run('问题一')) {
      /* 消费事件 */
    }
    expect(session.getHistory()).toHaveLength(2);
    expect([...session.getMessageUsages().values()]).toEqual([usage(13)]);
    await session.destroy();
  });

  it('旧 SDK Store 与空会话明确拒绝回退', async () => {
    const legacy = new JSONLMessageStore(path.join(directory, 'legacy.jsonl'));
    const session = new AgentSession({
      defaultProfile: TEST_PROFILE,
      defaultProvider: new ScriptedProvider([reply('第一轮', 7)]),
      store: legacy,
      rootDir: directory,
    });
    await session.init();
    await expect(session.rewindLastTurn()).rejects.toMatchObject({
      code: 'REWIND_UNAVAILABLE',
    });
    for await (const _ of session.run('问题一')) {
      /* 消费事件 */
    }
    await expect(session.rewindLastTurn()).rejects.toMatchObject({
      code: 'REWIND_UNAVAILABLE',
    });
    await session.destroy();
  });
});
