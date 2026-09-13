import { describe, expect, it } from 'vitest';
import type { ModelEvent, ModelProfile, ModelProvider, ModelRequest } from '../src/index.js';
import { AgentSession } from '../src/session/index.js';

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
});
