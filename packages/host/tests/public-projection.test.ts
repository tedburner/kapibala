import { describe, expect, it } from 'vitest';
import {
  redactPresentationChange,
  redactPresentationState,
} from '../src/host/public-projection.js';
import type { PresentationChange, PresentationState } from '../src/view-model/index.js';

/** 测试用凭证脱敏：固定替换，不依赖真实凭证集。 */
const redact = (text: string) => text.replaceAll('sk-secret1', '[REDACTED]');

describe('public presentation redaction covers todos', () => {
  it('redacts todo titles in todos_changed events', () => {
    const change: PresentationChange = {
      type: 'todos_changed',
      todos: {
        items: [{ id: '1', title: '轮换 sk-secret1 密钥', status: 'pending' }],
        revision: 1,
      },
    };
    expect(redactPresentationChange(change, redact)).toEqual({
      type: 'todos_changed',
      todos: {
        items: [{ id: '1', title: '轮换 [REDACTED] 密钥', status: 'pending' }],
        revision: 1,
      },
    });
  });

  it('passes todos_changed without a state through unchanged', () => {
    const change: PresentationChange = { type: 'todos_changed' };
    expect(redactPresentationChange(change, redact)).toEqual({ type: 'todos_changed' });
  });

  it('re-redacts cached todo snapshots when the credential set evolves', () => {
    const state = {
      identity: { conversationId: 'c1', branchId: 'main', viewEpoch: 1 },
      sequence: 7,
      messages: [],
      pendingMessages: [],
      order: [],
      expanded: {},
      notices: [],
      todos: {
        items: [{ id: '1', title: '清理 sk-secret1 残留', status: 'in_progress' }],
        revision: 1,
      },
    } as PresentationState;
    expect(redactPresentationState(state, redact).todos?.items[0]?.title).toBe(
      '清理 [REDACTED] 残留',
    );
  });

  it('leaves sessions without todos untouched', () => {
    const state = {
      identity: { conversationId: 'c1', branchId: 'main', viewEpoch: 1 },
      sequence: 7,
      messages: [],
      pendingMessages: [],
      order: [],
      expanded: {},
      notices: [],
    } as PresentationState;
    expect(redactPresentationState(state, redact).todos).toBeUndefined();
  });
});
