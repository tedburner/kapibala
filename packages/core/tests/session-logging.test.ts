import { describe, expect, it } from 'vitest';
import { AgentSession } from '../src/context/session/index.js';
import { ModelError } from '../src/errors/index.js';
import {
  type LogEvent,
  type LogSink,
  StructuredLogger,
} from '../src/extensibility/logging/index.js';
import type { ModelProfile } from '../src/models/index.js';
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
  it('keeps completed tools and reports a later stream failure with a safe error code', async () => {
    const operation = new MemorySink();
    const audit = new MemorySink();
    const first = new ScriptedProvider([
      [
        { type: 'tool_call_finish', id: 'read', name: 'echo', input: { value: 'read result' } },
        { type: 'message_stop' },
      ],
    ]);
    let requests = 0;
    const session = new AgentSession({
      defaultProfile: profile,
      defaultProvider: {
        name: 'failed-stream',
        async *create(request) {
          if (requests++ === 0) yield* first.create(request);
          else {
            yield { type: 'thinking_delta' as const, thinking: 'Let me check package.json' };
            throw new ModelError('private transport details', {
              code: 'MODEL_STREAM_INTERRUPTED',
              retryable: false,
              transportCode: 'UND_ERR_SOCKET',
            });
          }
        },
        assembleToolResults: first.assembleToolResults.bind(first),
      },
      eventLogger: new StructuredLogger({ operationSink: operation, auditSink: audit }),
    });
    for (const tool of makeEchoToolRegistry().list()) session.tools.register(tool);
    const events = [];
    for await (const event of session.run('version plan')) events.push(event);
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'run_finish', metrics: { status: 'failed' } });
    expect(requests).toBe(2);
    expect(audit.events.filter((event) => event.event === 'tool.finished')).toHaveLength(1);
    expect(operation.events.find((event) => event.event === 'model.failed')?.fields.errorCode).toBe(
      'MODEL_STREAM_INTERRUPTED',
    );
    expect(JSON.stringify(operation.events)).not.toContain('private transport details');
    expect(
      operation.events.find((event) => event.event === 'model.failed')?.fields.transportCode,
    ).toBe('UND_ERR_SOCKET');
    await session.destroy();
  });
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
