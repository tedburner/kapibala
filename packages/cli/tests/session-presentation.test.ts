import type { CanonicalMessage, RunMetrics } from '@kiturone/kapibala';
import { describe, expect, it } from 'vitest';
import { PresentationStore } from '../src/host/presentation-store.js';
import { SessionPresentation } from '../src/host/session-presentation.js';
import { isBlockExpanded, selectMessages } from '../src/view-model/index.js';

const metrics: RunMetrics = {
  startTime: 1,
  endTime: 2,
  totalDurationMs: 1,
  modelDurationMs: 1,
  toolDurationMs: 0,
  promptTokens: 1,
  completionTokens: 1,
  totalTokens: 2,
  turns: 1,
  toolCalls: 0,
  status: 'completed',
};

function fixture() {
  const identity = { conversationId: 'c', branchId: 'main', viewEpoch: 1 };
  const store = new PresentationStore(identity);
  const history: CanonicalMessage[] = [];
  const adapter = new SessionPresentation(store, 'op-1', () => history);
  return { store, history, adapter, identity };
}

describe('session event host adapter', () => {
  it('stops an unclosed tool display on failure without rewriting an already completed result', () => {
    const { store, adapter } = fixture();
    adapter.consume({ type: 'tool_start', id: 'running', name: 'tool', input: {} });
    adapter.consume({ type: 'tool_start', id: 'done', name: 'tool', input: {} });
    adapter.consume({
      type: 'tool_finish',
      id: 'done',
      name: 'tool',
      result: 'actual result',
      isError: false,
    });
    adapter.consume({ type: 'error', error: new Error('network') });
    const tools = selectMessages(store.snapshot())[0].blocks;
    expect(tools[0].tool?.status).toBe('interrupted');
    expect(tools[1].tool).toMatchObject({ status: 'succeeded', result: 'actual result' });
    adapter.settle('failed');
    store.close();
  });
  it('shows newly accepted user history and reconciles streamed body exactly once', () => {
    const { store, history, adapter } = fixture();
    history.push({ id: 'u', role: 'user', content: [{ type: 'text', text: 'question' }] });
    adapter.consume({ type: 'turn_start', turn: 1 });
    adapter.consume({ type: 'text_delta', text: 'answer' });
    const assistant: CanonicalMessage = {
      id: 'a',
      role: 'assistant',
      content: [{ type: 'text', text: 'answer' }],
    };
    history.push(assistant);
    adapter.consume({ type: 'message_stop', message: assistant });
    adapter.consume({ type: 'run_finish', metrics });
    expect(store.snapshot().operation?.phase).toBe('settling');
    expect(
      selectMessages(store.snapshot()).map((message) =>
        message.blocks.map((block) => block.text).join(''),
      ),
    ).toEqual(['question', 'answer']);
    adapter.settle();
    expect(store.snapshot().operation?.phase).toBe('idle');
    store.close();
  });

  it('keeps thinking overrides through canonical projection and stops interrupted streams', () => {
    const { store, history, adapter } = fixture();
    adapter.consume({ type: 'turn_start', turn: 1 });
    adapter.consume({ type: 'thinking_block_start', blockId: 'source-think' });
    adapter.consume({ type: 'thinking_delta', blockId: 'source-think', thinking: 'public' });
    const id = selectMessages(store.snapshot())[0].blocks[0].id;
    adapter.setExpanded(id, true);
    const message: CanonicalMessage = {
      id: 'a',
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'public', signature: 'private' }],
    };
    history.push(message);
    adapter.consume({ type: 'message_stop', message });
    expect(isBlockExpanded(store.snapshot(), id)).toBe(true);
    expect(JSON.stringify(store.snapshot())).not.toContain('private');
    adapter.consume({ type: 'turn_start', turn: 2 });
    adapter.consume({ type: 'thinking_delta', thinking: 'unfinished' });
    adapter.consume({ type: 'error', error: new Error('network') });
    const interrupted = store.snapshot().pendingMessages.at(-1)!;
    expect(interrupted.blocks[0].state).toBe('interrupted');
    expect(store.snapshot().operation?.phase).toBe('settling');
    adapter.settle('failed');
    store.close();
  });

  it.each(['before', 'after'] as const)(
    'reconciles tools once when inverse finish events arrive %s canonical completion',
    (finishOrder) => {
      const { store, history, adapter } = fixture();
      adapter.consume({ type: 'turn_start', turn: 1 });
      adapter.consume({ type: 'tool_start', id: 'one', name: 'tool', input: { apiKey: 'hidden' } });
      adapter.consume({ type: 'tool_start', id: 'two', name: 'tool', input: {} });
      expect(selectMessages(store.snapshot())[0].blocks).toHaveLength(2);
      const finishTools = () => {
        adapter.consume({
          type: 'tool_finish',
          id: 'two',
          name: 'tool',
          result: 'second',
          isError: true,
          durationMs: 20,
        });
        adapter.consume({
          type: 'tool_finish',
          id: 'one',
          name: 'tool',
          result: 'first',
          isError: false,
          durationMs: 10,
        });
      };
      if (finishOrder === 'before') finishTools();
      const assistant: CanonicalMessage = {
        id: 'a',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'one', name: 'tool', input: { apiKey: 'hidden' } },
          { type: 'tool_use', id: 'two', name: 'tool', input: {} },
        ],
      };
      const results: CanonicalMessage[] = [
        {
          id: 'r2',
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolUseId: 'two',
              content: 'second',
              isError: true,
              durationMs: 20,
            },
          ],
        },
        {
          id: 'r1',
          role: 'tool',
          content: [{ type: 'tool_result', toolUseId: 'one', content: 'first', durationMs: 10 }],
        },
      ];
      history.push(assistant, ...results);
      adapter.consume({ type: 'message_stop', message: assistant });
      if (finishOrder === 'after') finishTools();
      adapter.consume({ type: 'tool_messages', messages: results });
      adapter.settle('completed');
      expect(selectMessages(store.snapshot())).toHaveLength(1);
      expect(selectMessages(store.snapshot())[0].blocks.map((block) => block.tool?.result)).toEqual(
        ['first', 'second'],
      );
      expect(selectMessages(store.snapshot())[0]).toMatchObject({
        persisted: true,
        state: 'completed',
        blocks: [
          { tool: { status: 'succeeded', durationMs: 10 } },
          { tool: { status: 'failed', durationMs: 20 } },
        ],
      });
      expect(store.snapshot().pendingMessages).toEqual([]);
      expect(JSON.stringify(store.snapshot())).not.toContain('hidden');
      store.close();
    },
  );

  it('rejects an old adapter after switching and reports post-result cleanup errors', () => {
    const { store, adapter, identity } = fixture();
    adapter.consume({ type: 'run_finish', metrics });
    adapter.settle('failed', new Error('save failed'));
    expect(store.snapshot().operation).toMatchObject({ phase: 'idle', result: 'failed' });
    expect(store.snapshot().notices.at(-1)?.text).toContain('save failed');
    store.reload({ ...identity, branchId: 'another', viewEpoch: 2 }, []);
    adapter.consume({ type: 'text_delta', text: 'late' });
    adapter.settle();
    expect(selectMessages(store.snapshot())).toEqual([]);
    expect(store.snapshot().operation).toBeUndefined();
    store.close();
  });
});
