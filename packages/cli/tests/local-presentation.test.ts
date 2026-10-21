import { describe, expect, it } from 'vitest';
import { ConnectedPresentation } from '../src/local-host/presentation.js';
import { selectMessages } from '../src/view-model/index.js';

describe('connected presentation projection', () => {
  it('reuses the existing reducer and replaces provisional output with canonical snapshot', () => {
    const presentation = new ConnectedPresentation('s', 'i', 'e');
    const base = { sessionId: 's', serverInstanceId: 'i', streamEpoch: 'e', runId: 'r' };
    presentation.consume({
      ...base,
      seq: 1,
      type: 'run_started',
      payload: { clientOperationId: 'o' },
    });
    presentation.consume({ ...base, seq: 2, type: 'text_delta', payload: { text: 'hello' } });
    expect(selectMessages(presentation.state)[0].blocks[0].text).toBe('hello');
    presentation.consume({
      ...base,
      seq: 3,
      type: 'run_settled',
      payload: { outcome: 'completed' },
    });
    expect(presentation.state.operation?.phase).toBe('idle');
    presentation.restore([
      {
        id: 'message',
        role: 'assistant',
        state: 'completed',
        blocks: [{ kind: 'text', text: 'hello' }],
      },
    ]);
    expect(selectMessages(presentation.state)).toHaveLength(1);
    expect(selectMessages(presentation.state)[0].persisted).toBe(true);
    presentation.consume({
      ...base,
      serverInstanceId: 'old',
      seq: 4,
      type: 'text_delta',
      payload: { text: 'stale' },
    });
    expect(selectMessages(presentation.state)[0].blocks[0].text).toBe('hello');
  });

  it('projects tool start, progress and finish into one block', () => {
    const presentation = new ConnectedPresentation('s', 'i', 'e');
    const base = { sessionId: 's', serverInstanceId: 'i', streamEpoch: 'e', runId: 'r' };
    presentation.consume({
      ...base,
      seq: 1,
      type: 'run_started',
      payload: { clientOperationId: 'o' },
    });
    presentation.consume({
      ...base,
      seq: 2,
      type: 'tool_start',
      payload: { toolId: 't', toolName: 'write_file', target: '/project/a.txt' },
    });
    presentation.consume({
      ...base,
      seq: 3,
      type: 'tool_progress',
      payload: { toolId: 't', toolName: 'write_file', elapsedMs: 12, outputBytes: 34 },
    });
    const running = selectMessages(presentation.state)[0].blocks.find(
      (block) => block.kind === 'tool',
    )!;
    expect(running.tool).toMatchObject({
      callId: 't',
      name: 'write_file',
      invocation: '/project/a.txt',
      status: 'running',
      elapsedMs: 12,
      outputBytes: 34,
    });
    presentation.consume({
      ...base,
      seq: 4,
      type: 'tool_finish',
      payload: { toolId: 't', result: 'written', isError: false, truncated: false },
    });
    const finished = selectMessages(presentation.state)[0].blocks.find(
      (block) => block.kind === 'tool',
    )!;
    expect(finished.state).toBe('completed');
    expect(finished.tool).toMatchObject({ status: 'succeeded', result: 'written' });
    expect(
      selectMessages(presentation.state)[0].blocks.filter((block) => block.kind === 'tool'),
    ).toHaveLength(1);
  });
});
