import { describe, expect, it } from 'vitest';
import { type LogEvent, type LogSink, StructuredLogger } from '../src/logging/index.js';
import type { ModelProfile } from '../src/models/index.js';
import { AgentSession } from '../src/session/index.js';
import { ScriptedProvider, makeEchoToolRegistry } from './helpers/mock.js';

const profile: ModelProfile = {
  id: 'logging-test',
  name: 'Logging Test',
  provider: 'openai-compatible',
  baseURL: 'http://127.0.0.1:9/v1',
  apiKeyEnv: 'NONE',
  modelName: 'test-model',
};

class MemorySink implements LogSink {
  readonly events: LogEvent[] = [];

  async write(event: LogEvent): Promise<void> {
    this.events.push(event);
  }
}

describe('normal-mode structured logging', () => {
  it('reports operation sink failures without interrupting the answer or tool audit', async () => {
    const audit = new MemorySink();
    const diagnostics: string[] = [];
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: new ScriptedProvider([
        [
          { type: 'tool_call_finish', id: 'call', name: 'echo', input: { value: 'hello' } },
          { type: 'message_stop' },
        ],
        [{ type: 'text_delta', text: 'answer' }, { type: 'message_stop' }],
      ]),
      eventLogger: new StructuredLogger({
        operationSink: {
          async write() {
            throw new Error('secret operation storage failure');
          },
        },
        auditSink: audit,
        onDiagnostic: (message) => diagnostics.push(message),
      }),
    });
    for (const tool of makeEchoToolRegistry().list()) session.tools.register(tool);
    const events = [];
    for await (const event of session.run('hello')) events.push(event);
    expect(events).toContainEqual({ type: 'text_delta', text: 'answer' });
    expect(session.getLastRunMetrics()?.status).toBe('completed');
    expect(audit.events.at(-1)?.event).toBe('tool.finished');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.join('\n')).not.toContain('secret');
  });

  it('records a complete session, model and tool audit chain without debug', async () => {
    const operation = new MemorySink();
    const audit = new MemorySink();
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: new ScriptedProvider([
        [
          {
            type: 'tool_call_finish',
            id: 'call_secret',
            name: 'echo',
            input: { value: 'private input' },
          },
          { type: 'message_stop' },
        ],
        [{ type: 'text_delta', text: 'private answer' }, { type: 'message_stop' }],
      ]),
      eventLogger: new StructuredLogger({ operationSink: operation, auditSink: audit }),
    });
    for (const tool of makeEchoToolRegistry().list()) session.tools.register(tool);

    for await (const _event of session.run('private prompt')) {
      // Consume the complete run.
    }

    expect(operation.events.map((event) => event.event)).toEqual(
      expect.arrayContaining([
        'session.started',
        'run.started',
        'model.requested',
        'model.finished',
        'run.finished',
      ]),
    );
    expect(audit.events.map((event) => event.event)).toEqual([
      'tool.requested',
      'tool.decided',
      'tool.started',
      'tool.finished',
    ]);
    const ids = new Set(audit.events.map((event) => event.operationId));
    expect(ids.size).toBe(1);
    expect(audit.events.every((event) => event.toolUseId === 'call_secret')).toBe(true);
    expect(audit.events.every((event) => event.runId === audit.events[0]?.runId)).toBe(true);
    expect(JSON.stringify([...operation.events, ...audit.events])).not.toMatch(
      /private prompt|private input|private answer/,
    );
  });
});
