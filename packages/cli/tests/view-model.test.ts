import { describe, expect, it } from 'vitest';
import {
  createPresentation,
  isBlockExpanded,
  reducePresentation,
  selectMessages,
} from '../src/view-model/index.js';
import type { PresentationEvent, ViewIdentity } from '../src/view-model/index.js';

const identity: ViewIdentity = { conversationId: 'conversation', branchId: 'main', viewEpoch: 1 };
const event = (
  sequence: number,
  change: PresentationEvent['change'],
  operationId = 'op-1',
): PresentationEvent => ({ ...identity, sequence, operationId, change });

describe('pure client presentation', () => {
  it('keeps the execution gate busy after the result until the host confirms settlement', () => {
    let state = createPresentation(identity);
    state = reducePresentation(state, event(1, { type: 'operation_started' }));
    state = reducePresentation(state, event(2, { type: 'operation_result', result: 'completed' }));
    expect(state.operation?.phase).toBe('settling');
    state = reducePresentation(
      state,
      event(3, { type: 'diagnostic', id: 'save', text: '保存失败', level: 'error' }),
    );
    state = reducePresentation(state, event(4, { type: 'operation_settled', result: 'failed' }));
    expect(state.operation).toMatchObject({ phase: 'idle', result: 'failed' });
    expect(state.notices[0].text).toBe('保存失败');
  });

  it('rejects stale view, operation and sequence updates without modifying the current state', () => {
    let state = createPresentation(identity);
    state = reducePresentation(state, event(2, { type: 'operation_started' }));
    const append = {
      type: 'append' as const,
      messageId: 'pending',
      blockId: 'text',
      kind: 'text' as const,
      text: 'late',
    };
    expect(reducePresentation(state, { ...event(3, append), viewEpoch: 0 })).toBe(state);
    expect(reducePresentation(state, event(1, append))).toBe(state);
    expect(reducePresentation(state, event(3, append, 'previous-op'))).toBe(state);
    expect(reducePresentation(state, { ...event(3, append), branchId: 'another' })).toBe(state);
    expect(state.messages).toEqual([]);
  });

  it('reconciles canonical content once and preserves user overrides through block aliases', () => {
    let state = createPresentation(identity);
    state = reducePresentation(state, event(1, { type: 'operation_started' }));
    state = reducePresentation(
      state,
      event(2, {
        type: 'append',
        messageId: 'pending',
        blockId: 'local-think',
        kind: 'thinking',
        text: '公开思考',
      }),
    );
    expect(isBlockExpanded(state, 'local-think')).toBe(true);
    state = reducePresentation(state, event(3, { type: 'block_stopped', blockId: 'local-think' }));
    expect(isBlockExpanded(state, 'local-think')).toBe(false);
    state = reducePresentation(
      state,
      event(4, { type: 'set_expanded', blockId: 'local-think', expanded: true }),
    );
    const commit = {
      type: 'message_committed' as const,
      provisionalId: 'pending',
      aliases: { 'canonical-think': 'local-think' },
      message: {
        id: 'message-1',
        role: 'assistant' as const,
        state: 'completed' as const,
        persisted: true,
        blocks: [
          {
            id: 'canonical-think',
            kind: 'thinking' as const,
            text: '公开思考',
            state: 'completed' as const,
            revision: 0,
          },
        ],
      },
    };
    state = reducePresentation(state, event(5, commit));
    state = reducePresentation(state, event(6, commit));
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0].blocks[0].id).toBe('local-think');
    expect(isBlockExpanded(state, 'local-think')).toBe(true);
  });

  it('keeps identical messages independent and never mutates previous snapshots', () => {
    const first = createPresentation(identity);
    const started = reducePresentation(first, event(1, { type: 'operation_started' }));
    const change = (id: string): PresentationEvent['change'] => ({
      type: 'message_committed',
      message: {
        id,
        role: 'user',
        state: 'completed',
        persisted: true,
        blocks: [
          { id: `${id}:text`, kind: 'text', text: '相同正文', state: 'completed', revision: 0 },
        ],
      },
    });
    const second = reducePresentation(started, event(2, change('one')));
    const third = reducePresentation(second, event(3, change('two')));
    expect(second.messages).toHaveLength(1);
    expect(third.messages.map((message) => message.id)).toEqual(['one', 'two']);
    expect(first.operation).toBeUndefined();
    expect(started.messages).toEqual([]);
  });

  it('marks missing-stop transient blocks interrupted without inventing persisted history', () => {
    let state = createPresentation(identity);
    state = reducePresentation(state, event(1, { type: 'operation_started' }));
    state = reducePresentation(
      state,
      event(2, {
        type: 'append',
        messageId: 'pending',
        blockId: 'think',
        kind: 'thinking',
        text: 'partial',
      }),
    );
    state = reducePresentation(state, event(3, { type: 'operation_result', result: 'aborted' }));
    expect(selectMessages(state)[0]).toMatchObject({ persisted: false, state: 'interrupted' });
    expect(selectMessages(state)[0].blocks[0].state).toBe('interrupted');
    expect(isBlockExpanded(state, 'think')).toBe(false);
  });

  it('keeps an uncommitted interrupted message before the next user turn', () => {
    let state = createPresentation(identity);
    state = reducePresentation(state, event(1, { type: 'operation_started' }));
    state = reducePresentation(
      state,
      event(2, {
        type: 'append',
        messageId: 'partial',
        blockId: 't',
        kind: 'text',
        text: 'partial',
      }),
    );
    const history = state.messages;
    state = reducePresentation(
      state,
      event(3, { type: 'append', messageId: 'partial', blockId: 't', kind: 'text', text: ' rest' }),
    );
    expect(state.messages).toBe(history);
    state = reducePresentation(state, event(4, { type: 'operation_settled', result: 'aborted' }));
    state = reducePresentation(state, event(5, { type: 'operation_started' }, 'op-2'));
    state = reducePresentation(
      state,
      event(
        6,
        {
          type: 'message_committed',
          message: {
            id: 'next-user',
            role: 'user',
            state: 'completed',
            persisted: true,
            blocks: [],
          },
        },
        'op-2',
      ),
    );
    expect(selectMessages(state).map((message) => message.id)).toEqual(['partial', 'next-user']);
    expect(
      reducePresentation(
        state,
        event(7, { type: 'diagnostic', id: 'late', text: 'old', level: 'error' }),
      ),
    ).toBe(state);
  });

  it('does not reopen a settled operation on a late result', () => {
    let state = createPresentation(identity);
    state = reducePresentation(state, event(1, { type: 'operation_started' }));
    state = reducePresentation(state, event(2, { type: 'operation_settled', result: 'completed' }));
    expect(
      reducePresentation(state, event(3, { type: 'operation_result', result: 'completed' })),
    ).toBe(state);
  });

  it('preserves document order when completion order differs and invalidates reconciled layout revisions', () => {
    let state = createPresentation(identity);
    state = reducePresentation(state, event(1, { type: 'operation_started' }));
    for (const [sequence, id] of [
      [2, 'first'],
      [3, 'second'],
    ] as const)
      state = reducePresentation(
        state,
        event(sequence, {
          type: 'append',
          messageId: id,
          blockId: `${id}:text`,
          kind: 'text',
          text: id,
        }),
      );
    for (const [sequence, id] of [
      [4, 'second'],
      [5, 'first'],
    ] as const)
      state = reducePresentation(
        state,
        event(sequence, {
          type: 'message_committed',
          provisionalId: id,
          message: {
            id: `${id}-saved`,
            role: 'assistant',
            state: 'completed',
            persisted: true,
            blocks: [
              { id: `${id}:text`, kind: 'text', text: `${id}!`, state: 'completed', revision: 0 },
            ],
          },
        }),
      );
    expect(selectMessages(state).map((message) => message.id)).toEqual([
      'first-saved',
      'second-saved',
    ]);
    expect(selectMessages(state)[0].blocks[0].revision).toBeGreaterThan(1);
  });
});
