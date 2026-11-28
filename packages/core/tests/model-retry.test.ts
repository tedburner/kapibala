import { describe, expect, it, vi } from 'vitest';
import { defineTool } from '../src/capabilities/tools/index.js';
import { ToolRegistry } from '../src/capabilities/tools/registry.js';
import { AgentSession } from '../src/context/session/index.js';
import {
  AbortError,
  ContextOverflowError,
  ModelError,
  describeModelError,
} from '../src/errors/index.js';
import { HookRegistry } from '../src/extensibility/hooks/registry.js';
import type { ModelProfile, ModelProvider } from '../src/models/index.js';
import { assembleCanonicalToolResults } from '../src/models/index.js';
import { ToolExecutor } from '../src/runtime/executor/index.js';
import { AgentLoop } from '../src/runtime/loop/index.js';
import type {
  CanonicalMessage,
  ModelEvent,
  ModelRequest,
  SessionEvent,
} from '../src/types/index.js';

const TEST_PROFILE: ModelProfile = {
  id: 'retry-test',
  name: 'Retry Test',
  provider: 'openai-compatible',
  baseURL: 'https://example.test/v1',
  apiKeyEnv: 'NONE',
  modelName: 'retry-model',
  contextWindow: 128_000,
};

async function collectEvents(iterable: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const events: SessionEvent[] = [];
  for await (const event of iterable) {
    events.push(event);
  }
  return events;
}

describe('AgentLoop & AgentSession automatic step retry and stream reset', () => {
  it('retries transient 429/503 failures with exponential backoff + jitter and stops at maxRetries', async () => {
    const delays: number[] = [];
    let calls = 0;
    const provider: ModelProvider = {
      name: 'transient-provider',
      assembleToolResults: assembleCanonicalToolResults,
      async *create(): AsyncIterable<ModelEvent> {
        calls++;
        if (calls === 1) {
          throw new ModelError('Too Many Requests', { status: 429 });
        }
        if (calls === 2) {
          throw new ModelError('Service overloaded', {
            status: 529,
            providerType: 'overloaded_error',
          });
        }
        yield { type: 'text_delta', text: 'Recovered answer' };
        yield { type: 'message_stop' };
      },
    };

    const tools = new ToolRegistry();
    const hooks = new HookRegistry();
    const loop = new AgentLoop({
      provider,
      tools,
      hooks,
      executor: new ToolExecutor({ tools, hooks, rootDir: process.cwd() }),
      retry: {
        maxRetries: 2,
        baseDelayMs: 1000,
        maxDelayMs: 30_000,
        random: () => 0.4,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    });

    const history: CanonicalMessage[] = [
      { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }] },
    ];
    const events = await collectEvents(loop.run(history));

    expect(calls).toBe(3);
    // attempt 1: 1000 * (1 + 0.25 * 0.4) = 1100; attempt 2: 2000 * 1.1 = 2200
    expect(delays).toEqual([1100, 2200]);
    expect(events.filter((e) => e.type === 'stream_reset')).toHaveLength(0);
    const scheduled = events.filter(
      (e): e is Extract<SessionEvent, { type: 'retry_scheduled' }> => e.type === 'retry_scheduled',
    );
    expect(scheduled).toHaveLength(2);
    expect(scheduled[0]).toMatchObject({
      type: 'retry_scheduled',
      step: 1,
      attempt: 1,
      maxRetries: 2,
      delayMs: 1100,
      category: 'rate_limit',
    });
    expect(scheduled[1]).toMatchObject({
      type: 'retry_scheduled',
      step: 1,
      attempt: 2,
      maxRetries: 2,
      delayMs: 2200,
      category: 'service',
    });
    expect(history.at(-1)?.content).toEqual([{ type: 'text', text: 'Recovered answer' }]);
  });

  it('honors Retry-After within maxRetryAfterMs and fails immediately when Retry-After exceeds cap', async () => {
    const delays: number[] = [];
    let calls = 0;
    const withinCapProvider: ModelProvider = {
      name: 'retry-after-ok',
      assembleToolResults: assembleCanonicalToolResults,
      async *create(): AsyncIterable<ModelEvent> {
        if (++calls === 1) {
          throw new ModelError('Rate limit', { status: 429, retryAfterMs: 5_000 });
        }
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'message_stop' };
      },
    };
    const tools = new ToolRegistry();
    const hooks = new HookRegistry();
    const loop = new AgentLoop({
      provider: withinCapProvider,
      tools,
      hooks,
      executor: new ToolExecutor({ tools, hooks, rootDir: process.cwd() }),
      retry: {
        random: () => 0.5,
        sleep: async (ms) => {
          delays.push(ms);
        },
      },
    });
    await collectEvents(
      loop.run([{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
    );
    // 5000 + 0.5 * min(5000 * 0.2, 2000) = 5000 + 500 = 5500
    expect(delays).toEqual([5500]);

    // Exceeding maxRetryAfterMs (default 60_000) must fail immediately without sleeping
    let overCapCalls = 0;
    const sleepSpy = vi.fn(async () => {});
    const overCapLoop = new AgentLoop({
      provider: {
        name: 'retry-after-exceeded',
        assembleToolResults: assembleCanonicalToolResults,
        async *create(): AsyncIterable<ModelEvent> {
          yield* [];
          overCapCalls++;
          throw new ModelError('Retry much later', { status: 429, retryAfterMs: 65_000 });
        },
      },
      tools,
      hooks,
      executor: new ToolExecutor({ tools, hooks, rootDir: process.cwd() }),
      retry: { sleep: sleepSpy },
    });
    const overCapEvents = await collectEvents(
      overCapLoop.run([{ id: 'u2', role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
    );
    expect(overCapCalls).toBe(1);
    expect(sleepSpy).not.toHaveBeenCalled();
    expect(overCapEvents.some((e) => e.type === 'retry_scheduled')).toBe(false);
    const overCapErrorEvent = overCapEvents.find(
      (e): e is Extract<SessionEvent, { type: 'error' }> => e.type === 'error',
    );
    expect(overCapErrorEvent).toBeDefined();
    expect(overCapErrorEvent?.modelError?.suggestion).toContain('65');
    expect(
      describeModelError(
        new ModelError('Service maintenance', { status: 503, retryAfterMs: 75_200 }),
      ).suggestion,
    ).toContain('76');
  });

  it('never retries quota/auth errors and keeps ContextOverflowError compaction separate from backoff budget', async () => {
    const sleepSpy = vi.fn(async () => {});
    const tools = new ToolRegistry();
    const hooks = new HookRegistry();

    for (const fatal of [
      new ModelError('Bad key', { status: 401 }),
      new ModelError('Quota exhausted', { status: 429, providerCode: 'insufficient_quota' }),
    ]) {
      let fatalCalls = 0;
      const loop = new AgentLoop({
        provider: {
          name: 'fatal',
          assembleToolResults: assembleCanonicalToolResults,
          async *create(): AsyncIterable<ModelEvent> {
            yield* [];
            fatalCalls++;
            throw fatal;
          },
        },
        tools,
        hooks,
        executor: new ToolExecutor({ tools, hooks, rootDir: process.cwd() }),
        retry: { maxRetries: 2, sleep: sleepSpy },
      });
      await collectEvents(
        loop.run([{ id: 'u', role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
      );
      expect(fatalCalls).toBe(1);
    }
    expect(sleepSpy).not.toHaveBeenCalled();

    // ContextOverflowError -> 1-shot compaction (no sleep), followed by 2 transient 503 retries -> success!
    let mixedCalls = 0;
    const mixedDelays: number[] = [];
    const mixedLoop = new AgentLoop({
      provider: {
        name: 'mixed',
        assembleToolResults: assembleCanonicalToolResults,
        async *create(): AsyncIterable<ModelEvent> {
          mixedCalls++;
          if (mixedCalls === 1) throw new ContextOverflowError(400);
          if (mixedCalls === 2 || mixedCalls === 3) {
            throw new ModelError('Temporary 503', { status: 503 });
          }
          yield { type: 'text_delta', text: 'after overflow + 2 retries' };
          yield { type: 'message_stop' };
        },
      },
      tools,
      hooks,
      executor: new ToolExecutor({ tools, hooks, rootDir: process.cwd() }),
      async *prepareRequest(candidate, _history, reason) {
        yield* [];
        return reason === 'overflow'
          ? {
              ...candidate,
              messages: [{ id: 'u-short', role: 'user', content: [{ type: 'text', text: 's' }] }],
            }
          : candidate;
      },
      retry: {
        maxRetries: 2,
        baseDelayMs: 100,
        random: () => 0,
        sleep: async (ms) => {
          mixedDelays.push(ms);
        },
      },
    });
    const mixedHistory: CanonicalMessage[] = [
      { id: 'u-long', role: 'user', content: [{ type: 'text', text: 'long' }] },
    ];
    await collectEvents(mixedLoop.run(mixedHistory));
    expect(mixedCalls).toBe(4);
    expect(mixedDelays).toEqual([100, 200]);
    expect(mixedHistory.at(-1)?.content).toEqual([
      { type: 'text', text: 'after overflow + 2 retries' },
    ]);
  });

  it('resets mid-stream partial output via stream_reset when allowMidStreamRetry is enabled and never replays prior step tools', async () => {
    let toolRuns = 0;
    let step2Attempts = 0;
    let totalModelCalls = 0;

    const provider: ModelProvider = {
      name: 'mid-stream-drop',
      assembleToolResults: assembleCanonicalToolResults,
      async *create(): AsyncIterable<ModelEvent> {
        totalModelCalls++;
        if (totalModelCalls === 1) {
          yield {
            type: 'tool_call_finish',
            id: 'call_once',
            name: 'mutate_once',
            input: { value: 'v1' },
          };
          yield { type: 'message_stop', finishReason: 'tool_calls' };
          return;
        }
        step2Attempts++;
        if (step2Attempts === 1) {
          yield { type: 'thinking_delta', thinking: 'stale thinking' };
          yield { type: 'text_delta', text: 'half-baked partial text' };
          throw new ModelError('Socket dropped mid-stream', {
            code: 'MODEL_STREAM_INTERRUPTED',
            stage: 'stream',
            transportCode: 'ECONNRESET',
          });
        }
        yield { type: 'text_delta', text: 'clean final answer' };
        yield { type: 'message_stop', finishReason: 'stop' };
      },
    };

    const session = new AgentSession({
      workspaceRoot: process.cwd(),
      defaultProfile: TEST_PROFILE,
      defaultProvider: provider,
      mode: 'FullAccess',
      retry: {
        maxRetries: 2,
        allowMidStreamRetry: true,
        baseDelayMs: 50,
        random: () => 0,
        sleep: async () => {},
      },
    });
    session.tools.register(
      defineTool({
        name: 'mutate_once',
        description: 'Side-effecting tool',
        parameters: { type: 'object' },
        metadata: { permissions: ['fs:write'] },
        async execute() {
          toolRuns++;
          return 'mutated-ok';
        },
      }),
    );

    const events = await collectEvents(session.run('execute and summarize'));
    await session.destroy();

    expect(toolRuns).toBe(1);
    expect(totalModelCalls).toBe(3);
    expect(events).toContainEqual({ type: 'stream_reset', step: 2, attempt: 1 });
    expect(
      events.some(
        (e) => e.type === 'retry_scheduled' && e.step === 2 && e.attempt === 1 && e.delayMs === 50,
      ),
    ).toBe(true);

    const finalHistory = session.getHistory();
    expect(finalHistory.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(finalHistory.at(-1)?.content).toEqual([{ type: 'text', text: 'clean final answer' }]);
    expect(JSON.stringify(finalHistory)).not.toContain('half-baked');
    expect(JSON.stringify(finalHistory)).not.toContain('stale thinking');
  });

  it('does not retry after outputSeen when allowMidStreamRetry is false (CLI default)', async () => {
    let calls = 0;
    const tools = new ToolRegistry();
    const hooks = new HookRegistry();
    const loop = new AgentLoop({
      provider: {
        name: 'no-mid-stream',
        assembleToolResults: assembleCanonicalToolResults,
        async *create(): AsyncIterable<ModelEvent> {
          calls++;
          yield { type: 'text_delta', text: 'already printed to terminal' };
          throw new ModelError('Stream broke', {
            code: 'MODEL_STREAM_INTERRUPTED',
            stage: 'stream',
          });
        },
      },
      tools,
      hooks,
      executor: new ToolExecutor({ tools, hooks, rootDir: process.cwd() }),
      retry: {
        maxRetries: 2,
        allowMidStreamRetry: false,
        sleep: async () => {},
      },
    });

    const events = await collectEvents(
      loop.run([{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
    );
    expect(calls).toBe(1);
    expect(events.some((e) => e.type === 'stream_reset')).toBe(false);
    expect(events.some((e) => e.type === 'retry_scheduled')).toBe(false);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('cancels backoff sleep immediately when AbortSignal fires and removes abort listeners', async () => {
    const controller = new AbortController();
    let calls = 0;
    const tools = new ToolRegistry();
    const hooks = new HookRegistry();
    const loop = new AgentLoop({
      provider: {
        name: 'sleep-abort',
        assembleToolResults: assembleCanonicalToolResults,
        async *create(): AsyncIterable<ModelEvent> {
          yield* [];
          calls++;
          throw new ModelError('Rate limited', { status: 429 });
        },
      },
      tools,
      hooks,
      executor: new ToolExecutor({
        tools,
        hooks,
        rootDir: process.cwd(),
        signal: controller.signal,
      }),
      signal: controller.signal,
      retry: {
        maxRetries: 2,
        baseDelayMs: 10_000,
        random: () => 0,
      },
    });

    const consuming = (async () => {
      for await (const event of loop.run([
        { id: 'u1', role: 'user', content: [{ type: 'text', text: 'cancel sleep' }] },
      ])) {
        if (event.type === 'retry_scheduled') {
          controller.abort();
        }
      }
    })();

    await expect(consuming).rejects.toBeInstanceOf(AbortError);
    expect(calls).toBe(1);
  });

  it('retries invisible tool_call_start/delta stream drops without emitting stream_reset even when allowMidStreamRetry is false, and measures TTFT per attempt', async () => {
    let calls = 0;
    const tools = new ToolRegistry();
    const hooks = new HookRegistry();
    const loop = new AgentLoop({
      provider: {
        name: 'invisible-tool-drop',
        assembleToolResults: assembleCanonicalToolResults,
        async *create(): AsyncIterable<ModelEvent> {
          calls++;
          if (calls === 1) {
            await new Promise((r) => setTimeout(r, 40));
            yield { type: 'tool_call_start', id: 'tc_partial', name: 'read_file' };
            yield { type: 'tool_call_delta', id: 'tc_partial', argumentChunk: '{"path":' };
            throw new ModelError('Stream dropped during invisible tool args', {
              code: 'MODEL_STREAM_INTERRUPTED',
              stage: 'stream',
            });
          }
          yield { type: 'text_delta', text: 'Recovered fast' };
          yield { type: 'message_stop', finishReason: 'stop' };
        },
      },
      tools,
      hooks,
      executor: new ToolExecutor({ tools, hooks, rootDir: process.cwd() }),
      retry: {
        maxRetries: 2,
        allowMidStreamRetry: false,
        baseDelayMs: 60,
        random: () => 0,
        sleep: async (ms) => {
          await new Promise((r) => setTimeout(r, ms));
        },
      },
    });

    const events = await collectEvents(
      loop.run([{ id: 'u1', role: 'user', content: [{ type: 'text', text: 'hi' }] }]),
    );
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === 'stream_reset')).toBe(false);
    expect(events.some((e) => e.type === 'retry_scheduled')).toBe(true);
    const turnFinish = events.find(
      (e): e is Extract<SessionEvent, { type: 'turn_finish' }> => e.type === 'turn_finish',
    );
    // Attempt 1 took ~40ms + 60ms backoff sleep = >=100ms before attempt 2 started;
    // attempt 2 yielded first token immediately, so per-attempt TTFT must be well below 80ms!
    expect(turnFinish?.metrics.ttftMs).toBeDefined();
    expect(turnFinish!.metrics.ttftMs!).toBeLessThan(80);
  });

  it('supports toggling retry options dynamically via AgentSession.setRetryOptions while idle', async () => {
    let calls = 0;
    const session = new AgentSession({
      workspaceRoot: process.cwd(),
      defaultProfile: TEST_PROFILE,
      defaultProvider: {
        name: 'dynamic-retry-provider',
        assembleToolResults: assembleCanonicalToolResults,
        async *create(): AsyncIterable<ModelEvent> {
          calls++;
          if (calls === 1) {
            yield { type: 'text_delta', text: 'partial before toggle' };
            throw new ModelError('Mid-stream reset', {
              code: 'MODEL_STREAM_INTERRUPTED',
              stage: 'stream',
            });
          }
          yield { type: 'text_delta', text: 'final after toggle' };
          yield { type: 'message_stop', finishReason: 'stop' };
        },
      },
      retry: {
        maxRetries: 1,
        allowMidStreamRetry: false,
        sleep: async () => {},
      },
    });

    session.setRetryOptions({
      maxRetries: 1,
      allowMidStreamRetry: true,
      baseDelayMs: 10,
      random: () => 0,
      sleep: async () => {},
    });
    expect(session.getRetryOptions()?.allowMidStreamRetry).toBe(true);

    const events = await collectEvents(session.run('test dynamic retry toggle'));
    await session.destroy();
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === 'stream_reset')).toBe(true);
  });
});
