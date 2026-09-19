import { describe, expect, it, vi } from 'vitest';
import { AbortError } from '../src/errors/index.js';
import { ToolExecutor } from '../src/executor/index.js';
import { HookRegistry } from '../src/hooks/registry.js';
import { AgentLoop } from '../src/loop/index.js';
import type { ModelProvider } from '../src/models/index.js';
import type { ToolRegistry } from '../src/tools/registry.js';
import type { CanonicalMessage, SessionEvent } from '../src/types/index.js';
import {
  ScriptedProvider,
  ThrowingProvider,
  findDanglingToolUses,
  makeEchoToolRegistry,
  makeUserMessage,
} from './helpers/mock.js';

interface RunOptions {
  provider: ModelProvider;
  history: CanonicalMessage[];
  tools?: ToolRegistry;
  signal?: AbortSignal;
  maxConsecutiveErrors?: number;
}

function buildLoop(options: RunOptions) {
  const tools = options.tools ?? makeEchoToolRegistry();
  const hooks = new HookRegistry();
  const executor = new ToolExecutor({
    tools,
    hooks,
    rootDir: process.cwd(),
    signal: options.signal,
  });
  const loop = new AgentLoop({
    provider: options.provider,
    executor,
    tools,
    hooks,
    systemPrompt: 'test system prompt',
    maxSteps: 6,
    maxConsecutiveErrors: options.maxConsecutiveErrors,
    signal: options.signal,
  });
  return { loop, hooks };
}

async function collect(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

function toolMessagesEvents(events: SessionEvent[]) {
  return events.filter(
    (event): event is Extract<SessionEvent, { type: 'tool_messages' }> =>
      event.type === 'tool_messages',
  );
}

describe('AgentLoop 工具结果回填与历史合法性', () => {
  it('把工具结果回填进历史，并对外派发 tool_messages 供落盘', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_finish', id: 'call_1', name: 'echo', input: { value: 'hi' } },
        { type: 'message_stop' },
      ],
      [{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }],
    ]);
    const history: CanonicalMessage[] = [makeUserMessage('run echo')];
    const { loop } = buildLoop({ provider, history });

    const events = await collect(loop.run(history));

    // 历史必须是闭合的四段式：user → assistant(tool_use) → tool(tool_result) → assistant(text)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(findDanglingToolUses(history)).toEqual([]);

    // 第二次请求必须已经能看到 tool_result，否则真实 API 会直接 400
    expect(provider.requests).toHaveLength(2);
    expect(provider.requests[1]!.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);

    const emitted = toolMessagesEvents(events);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.messages).toHaveLength(1);
    expect(emitted[0]!.messages[0]!.role).toBe('tool');
    expect(emitted[0]!.messages[0]!.content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'call_1',
      content: 'echo:hi',
      isError: false,
    });
  });

  it('direct consumers cannot stop after message_stop with dangling tool history', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_finish', id: 'call_direct', name: 'echo', input: { value: 'x' } },
        { type: 'message_stop' },
      ],
    ]);
    const history: CanonicalMessage[] = [makeUserMessage('run once')];
    const { loop } = buildLoop({ provider, history });
    const iterator = loop.run(history)[Symbol.asyncIterator]();

    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === 'message_stop') {
        await iterator.return?.();
        break;
      }
    }

    expect(findDanglingToolUses(history)).toEqual([]);
    expect(history.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('熔断发生时历史已闭合，且 error hook 会被触发', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_finish', id: 'call_x', name: 'echo', input: {} },
        { type: 'message_stop' },
      ],
    ]);
    const tools = makeEchoToolRegistry(() => {
      throw new Error('boom');
    });
    const history: CanonicalMessage[] = [makeUserMessage('break it')];
    const { loop, hooks } = buildLoop({ provider, history, tools, maxConsecutiveErrors: 1 });

    const observed: Error[] = [];
    hooks.on('error', (_ctx, err) => {
      observed.push(err);
    });

    const events = await collect(loop.run(history));

    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.message).toContain('Circuit breaker');

    // 熔断只终止循环，不得留下未闭合的 assistant(tool_use)
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
    expect(history[2]!.content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'call_x',
      isError: true,
    });
    expect(findDanglingToolUses(history)).toEqual([]);
  });

  it('工具执行中途中断时，未执行的调用也会补齐 tool_result', async () => {
    const controller = new AbortController();
    const tools = makeEchoToolRegistry(() => {
      // 第一个工具执行期间用户按下 Ctrl+C
      controller.abort();
      return 'partial';
    });
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_finish', id: 'call_a', name: 'echo', input: {} },
        { type: 'tool_call_finish', id: 'call_b', name: 'echo', input: {} },
        { type: 'message_stop' },
      ],
    ]);
    const history: CanonicalMessage[] = [makeUserMessage('two tools')];
    const { loop } = buildLoop({ provider, history, tools, signal: controller.signal });

    await expect(collect(loop.run(history))).rejects.toBeInstanceOf(AbortError);

    // OpenAI 兼容协议下每个 tool_call 对应一条独立 tool message，且必须连续跟在 assistant 之后
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'tool']);
    expect(history[2]!.content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'call_a',
    });
    expect(history[3]!.content[0]).toMatchObject({
      type: 'tool_result',
      toolUseId: 'call_b',
      isError: true,
    });
    expect(findDanglingToolUses(history)).toEqual([]);
  });

  it('模型流中断时不会把半成品 assistant 消息写进历史', async () => {
    const provider = new ThrowingProvider(new AbortError());
    const history: CanonicalMessage[] = [makeUserMessage('interrupt me')];
    const { loop } = buildLoop({ provider, history });

    await expect(collect(loop.run(history))).rejects.toBeInstanceOf(AbortError);

    expect(history.map((m) => m.role)).toEqual(['user']);
    expect(findDanglingToolUses(history)).toEqual([]);
  });

  it('未中断的模型错误会派发 error 事件与 error hook', async () => {
    const provider = new ThrowingProvider(new Error('stream exploded'));
    const history: CanonicalMessage[] = [makeUserMessage('boom')];
    const { loop, hooks } = buildLoop({ provider, history });

    const observed: Error[] = [];
    hooks.on('error', (_ctx, err) => {
      observed.push(err);
    });

    const events = await collect(loop.run(history));

    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
    expect(observed).toHaveLength(1);
    expect(observed[0]!.message).toBe('stream exploded');
    expect(findDanglingToolUses(history)).toEqual([]);
  });

  it('工具耗时不应重复计入模型耗时', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-19T00:00:00Z'));
    try {
      const provider = new ScriptedProvider([
        [
          { type: 'tool_call_finish', id: 'call_metric', name: 'echo', input: {} },
          { type: 'message_stop' },
        ],
        [{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }],
      ]);
      const tools = makeEchoToolRegistry(() => {
        vi.setSystemTime(Date.now() + 1_000);
        return 'done';
      });
      const history: CanonicalMessage[] = [makeUserMessage('measure it')];
      const { loop } = buildLoop({ provider, history, tools });

      const events = await collect(loop.run(history));
      const firstTurn = events.find(
        (event): event is Extract<SessionEvent, { type: 'turn_finish' }> =>
          event.type === 'turn_finish' && event.turn === 1,
      );

      expect(firstTurn).toBeDefined();
      expect(firstTurn!.metrics.toolDurationMs).toBe(1_000);
      expect(firstTurn!.metrics.modelDurationMs).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
