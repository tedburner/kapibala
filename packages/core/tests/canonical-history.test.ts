import { describe, expect, it, vi } from 'vitest';
import {
  createMessageId,
  identifyHistory,
  indexInteractions,
  normalizeHistory,
} from '../src/context/history.js';
import type { CanonicalMessage } from '../src/types/index.js';

const text = (role: CanonicalMessage['role'], value: string): CanonicalMessage => ({
  role,
  content: [{ type: 'text', text: value }],
});

describe('canonical history', () => {
  it('assigns deterministic legacy identities and monotonic UUIDv7 identities', () => {
    const raw = [text('user', 'a'), text('user', 'a')];
    const first = identifyHistory(raw, 'source');
    expect(first).toEqual(identifyHistory(raw, 'source'));
    expect(first[0].id).not.toBe(first[1].id);
    expect(raw[0]).not.toHaveProperty('id');
    const ids = Array.from({ length: 100 }, () => createMessageId());
    expect(ids).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(100);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const time = Date.now() + 1000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(time);
    try {
      const a = createMessageId();
      clock.mockReturnValue(time - 10000);
      const b = createMessageId();
      expect(a < b).toBe(true);
      expect(a.slice(0, 13)).toBe(b.slice(0, 13));
    } finally {
      clock.mockRestore();
    }
  });

  it('merges compatible messages with sources without mutating raw history', () => {
    const raw = identifyHistory(
      [
        text('user', 'a'),
        text('assistant', ''),
        text('user', 'b'),
        text('assistant', 'c'),
        text('assistant', 'd'),
      ],
      'source',
    );
    const before = structuredClone(raw);
    const result = normalizeHistory(raw);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result.sources[0]).toEqual([raw[0].id, raw[2].id]);
    expect(normalizeHistory(result.messages).messages).toEqual(result.messages);
    result.messages[0].content[0] = { type: 'text', text: 'hook changed' };
    expect(raw).toEqual(before);
    expect(normalizeHistory(raw)).toEqual(normalizeHistory(raw));
  });

  it('preserves real results, repairs only missing calls and diagnoses late results', () => {
    const raw = identifyHistory(
      [
        text('user', 'read'),
        {
          role: 'assistant',
          content: ['a', 'b'].map((id) => ({
            type: 'tool_use' as const,
            id,
            name: 'read_file',
            input: {},
          })),
        },
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'a', content: 'real value' }] },
        text('user', 'next'),
        { role: 'tool', content: [{ type: 'tool_result', toolUseId: 'b', content: 'late' }] },
      ],
      'source',
    );
    const result = normalizeHistory(raw);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(result.messages[2].content).toEqual([
      { type: 'tool_result', toolUseId: 'a', content: 'real value' },
      expect.objectContaining({
        toolUseId: 'b',
        errorCode: 'OUTCOME_UNKNOWN',
        retryPolicy: 'after_user_action',
      }),
    ]);
    expect(result.repairs).toHaveLength(1);
    expect(result.repairs[0].assistantId).toBe(raw[1].id);
    expect(result.diagnostics).toHaveLength(1);
    expect(normalizeHistory(result.messages).messages).toEqual(result.messages);
  });

  it('rejects duplicate call IDs instead of inventing results', () => {
    const call: CanonicalMessage = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a', name: 'read_file', input: {} },
        { type: 'tool_use', id: 'a', name: 'read_file', input: {} },
      ],
    };
    expect(() => normalizeHistory([call])).toThrow(/Duplicate tool call/);
  });

  it('does not replay partial responses and protects failed interactions after the last success', () => {
    const raw = identifyHistory(
      [
        text('user', 'one'),
        text('assistant', 'done'),
        text('user', 'two'),
        { ...text('assistant', 'partial'), state: 'failed' as const },
        text('user', 'three'),
      ],
      'source',
    );
    const index = indexInteractions(raw);
    expect(index.interactions.map((i) => i.status)).toEqual([
      'completed',
      'interrupted',
      'interrupted',
    ]);
    expect(index.protectedMessageIds).toEqual(raw.map((m) => m.id));
    expect(
      normalizeHistory(raw)
        .messages.flatMap((m) => m.content)
        .some((b) => b.type === 'text' && b.text === 'partial'),
    ).toBe(false);
  });

  it('protects everything when no successful interaction is proven', () => {
    const raw = identifyHistory([text('user', 'one'), text('user', 'two')], 'source');
    expect(indexInteractions(raw).protectedMessageIds).toEqual(raw.map((m) => m.id));
  });
});
