import { describe, expect, it } from 'vitest';
import type { ModelEvent, ModelProfile, ModelProvider, ModelRequest } from '../src/index.js';
import { AgentSession } from '../src/session/index.js';
import { ScriptedProvider, makeEchoToolRegistry } from './helpers/mock.js';

class MockMetricProvider implements ModelProvider {
  readonly name = 'mock-provider';

  async *create(_req: ModelRequest): AsyncIterable<ModelEvent> {
    yield { type: 'text_delta', text: 'Hello, ' };
    yield { type: 'text_delta', text: 'metrics!' };
    yield {
      type: 'message_stop',
      usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
      ttftMs: 42,
      durationMs: 120,
    };
  }

  assembleToolResults() {
    return [];
  }
}

describe('Step Logs and TurnMetrics', () => {
  const profile: ModelProfile = {
    id: 'test-model',
    name: 'Test Model',
    provider: 'openai-compatible',
    baseURL: 'http://localhost',
    apiKeyEnv: 'NONE',
    modelName: 'test',
  };

  it('should emit step_log and turn_finish with TurnMetrics', async () => {
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: new MockMetricProvider(),
    });

    const stepLogs: any[] = [];
    let turnMetrics: any;

    for await (const event of session.run('test question')) {
      if (event.type === 'step_log') {
        stepLogs.push(event.log);
      } else if (event.type === 'turn_finish') {
        turnMetrics = event.metrics;
      }
    }

    // 验证 step_log 是否完整涵盖各阶段
    expect(stepLogs.length).toBeGreaterThanOrEqual(3);
    const stages = stepLogs.map((l) => l.stage);
    expect(stages).toContain('model_request_start');
    expect(stages).toContain('first_token');
    expect(stages).toContain('model_stream_finish');
    expect(stages).toContain('turn_finish');

    // 验证 key metrics 字段
    expect(turnMetrics).toBeDefined();
    expect(turnMetrics.turn).toBe(1);
    expect(typeof turnMetrics.totalDurationMs).toBe('number');
    expect(typeof turnMetrics.ttftMs).toBe('number');
    expect(turnMetrics.promptTokens).toBe(50);
    expect(turnMetrics.completionTokens).toBe(10);
    expect(turnMetrics.totalTokens).toBe(60);

    // 验证 session.getStats()
    const stats = session.getStats();
    expect(stats.totalTurns).toBe(1);
    expect(stats.totalTokens.totalTokens).toBe(60);
    expect(stats.lastMetrics).toEqual(turnMetrics);
  });

  it('emits one run_finish that aggregates every internal tool step', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_finish', id: 'call_metrics', name: 'echo', input: { value: 'x' } },
        {
          type: 'message_stop',
          usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
          ttftMs: 15,
        },
      ],
      [
        { type: 'text_delta', text: 'done' },
        {
          type: 'message_stop',
          usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23 },
          ttftMs: 5,
        },
      ],
    ]);
    const session = new AgentSession({ defaultProfile: profile, defaultProvider: provider });
    for (const tool of makeEchoToolRegistry().list()) session.tools.register(tool);

    const runFinishes: any[] = [];
    let turnFinishes = 0;
    for await (const event of session.run('aggregate this request')) {
      if (event.type === 'turn_finish') turnFinishes++;
      if (event.type === 'run_finish') runFinishes.push(event.metrics);
    }

    expect(turnFinishes).toBe(2);
    expect(runFinishes).toHaveLength(1);
    expect(runFinishes[0]).toMatchObject({
      promptTokens: 30,
      completionTokens: 5,
      totalTokens: 35,
      turns: 2,
      toolCalls: 1,
      ttftMs: 15,
      status: 'completed',
      contextUsage: {
        usedTokens: 20,
        limitTokens: 1_000_000,
        percent: 0.002,
        estimatedLimit: true,
      },
    });
    expect(session.getStats().lastRunMetrics).toEqual(runFinishes[0]);
  });

  it('uses the last internal request instead of aggregate prompt tokens for context usage', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_finish', id: 'call_context', name: 'echo', input: { value: 'x' } },
        {
          type: 'message_stop',
          usage: { promptTokens: 700_000, completionTokens: 2, totalTokens: 700_002 },
        },
      ],
      [
        { type: 'text_delta', text: 'done' },
        {
          type: 'message_stop',
          usage: { promptTokens: 800_000, completionTokens: 3, totalTokens: 800_003 },
        },
      ],
    ]);
    const session = new AgentSession({
      defaultProfile: { ...profile, contextWindow: '1M' },
      defaultProvider: provider,
    });
    for (const tool of makeEchoToolRegistry().list()) session.tools.register(tool);

    for await (const _event of session.run('measure current context')) {
      // consume the full run
    }

    expect(session.getStats().lastRunMetrics?.promptTokens).toBe(1_500_000);
    expect(session.getStats().contextUsage).toEqual({
      usedTokens: 800_000,
      limitTokens: 1_000_000,
      percent: 80,
      estimatedLimit: false,
    });
  });

  it('keeps context usage unknown when the provider omits usage data', async () => {
    const provider = new ScriptedProvider([
      [{ type: 'text_delta', text: 'done' }, { type: 'message_stop' }],
    ]);
    const session = new AgentSession({ defaultProfile: profile, defaultProvider: provider });

    for await (const _event of session.run('provider without usage')) {
      // consume the full run
    }

    expect(session.getStats().contextUsage).toEqual({
      usedTokens: undefined,
      limitTokens: 1_000_000,
      percent: undefined,
      estimatedLimit: true,
    });
  });

  it('rejects invalid context windows at session profile boundaries', () => {
    expect(
      () =>
        new AgentSession({
          defaultProfile: { ...profile, contextWindow: -1 },
          defaultProvider: new MockMetricProvider(),
        }),
    ).toThrow(/contextWindow/i);

    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: new MockMetricProvider(),
    });
    expect(() =>
      session.switchModel(
        { ...profile, id: 'invalid-switch', contextWindow: 0 },
        'default',
        new MockMetricProvider(),
      ),
    ).toThrow(/contextWindow/i);
    expect(session.getActiveProfile().id).toBe(profile.id);
  });

  it('does not leave the session busy when the active profile becomes invalid during a run', async () => {
    const mutableProfile: ModelProfile = { ...profile, contextWindow: '1M' };
    const provider = new ScriptedProvider([
      [
        { type: 'text_delta', text: 'first' },
        {
          type: 'message_stop',
          usage: { promptTokens: 10, completionTokens: 1, totalTokens: 11 },
        },
      ],
      [{ type: 'text_delta', text: 'recovered' }, { type: 'message_stop' }],
    ]);
    const session = new AgentSession({ defaultProfile: mutableProfile, defaultProvider: provider });
    let invalidateProfile = true;
    session.hooks.on('model:after', async () => {
      if (invalidateProfile) mutableProfile.contextWindow = -1;
    });

    const consumeRun = async (input: string): Promise<void> => {
      for await (const _event of session.run(input)) {
        // consume the full run
      }
    };

    await expect(consumeRun('invalid profile')).rejects.toThrow(/contextWindow/i);

    invalidateProfile = false;
    mutableProfile.contextWindow = '1M';
    await expect(consumeRun('recovered profile')).resolves.toBeUndefined();
  });

  it('marks run_finish as failed when the loop emits an error event', async () => {
    const provider = new ScriptedProvider([
      [
        { type: 'tool_call_finish', id: 'call_fail', name: 'echo', input: { value: 'x' } },
        { type: 'message_stop' },
      ],
    ]);
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: provider,
      maxSteps: 1,
    });
    for (const tool of makeEchoToolRegistry().list()) session.tools.register(tool);

    let status: string | undefined;
    for await (const event of session.run('never reaches a final answer')) {
      if (event.type === 'run_finish') status = event.metrics.status;
    }

    expect(status).toBe('failed');
  });
});
