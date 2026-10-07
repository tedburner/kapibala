import { describe, expect, it } from 'vitest';
import { indexInteractions, normalizeHistory } from '../src/context/history.js';
import {
  createProtocolOrigin,
  projectProtocolHistory,
  summarySafeMessage,
  validateProtocolContent,
} from '../src/models/protocol-state.js';
import type { CanonicalMessage, ProviderStateBlock } from '../src/types/index.js';

const target = {
  protocol: 'openai-responses' as const,
  modelName: 'reasoner',
  baseURL: 'https://example.test/v1',
};
const context = { runId: 'run', modelId: 'profile' };

describe('protocol provenance and projection', () => {
  it('replays private state only within its origin and retains ordinary phase across runs', () => {
    const origin = createProtocolOrigin(target, context);
    const state: ProviderStateBlock = {
      type: 'provider_state',
      origin,
      item: { type: 'reasoning', id: 'r', encrypted_content: 'secret', summary: [] },
    };
    const message: CanonicalMessage = {
      role: 'assistant',
      content: [
        state,
        {
          type: 'text',
          text: 'answer',
          protocolMeta: { origin, itemIndex: 1, itemId: 'm', phase: 'final_answer' },
        },
      ],
    };
    const before = structuredClone(message);
    expect(projectProtocolHistory([message], target, context)[0]?.content).toEqual(message.content);
    const next = projectProtocolHistory([message], target, { ...context, runId: 'new' });
    expect(next[0]?.content).toHaveLength(1);
    expect(next[0]?.content[0]).toMatchObject({
      type: 'text',
      protocolMeta: { phase: 'final_answer' },
    });
    const foreign = projectProtocolHistory([message], { ...target, modelName: 'other' }, context);
    expect(foreign[0]?.content).toEqual([{ type: 'text', text: 'answer' }]);
    expect(message).toEqual(before);
    expect(
      projectProtocolHistory(
        [{ ...message, content: [{ ...state, item: { ...state.item, status: 'incomplete' } }] }],
        target,
        context,
      )[0]?.content,
    ).toEqual([]);
  });

  it('rejects an unknown provenance version and invalid reasoning shape', () => {
    const state = {
      type: 'provider_state',
      origin: { ...createProtocolOrigin(target, context), version: 9 },
      item: { type: 'reasoning', id: 'r', summary: [] },
    };
    expect(() => validateProtocolContent([state as never])).toThrow(/protocol|state/i);
    state.origin.version = 1;
    state.item.summary = [null] as never;
    expect(() => validateProtocolContent([state as never])).toThrow(/protocol|state/i);
    state.item.summary = [];
    const oversized = {
      ...state,
      item: { ...state.item, encrypted_content: 'x'.repeat(16 * 1024 * 1024) },
    };
    expect(() => validateProtocolContent([oversized as never])).toThrow(/protocol|state/i);
  });

  it('keeps visible text and tools while excluding signatures and ciphertext from summaries', () => {
    const origin = createProtocolOrigin(target, context);
    const safe = summarySafeMessage({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'visible', signature: 'private_signature', origin },
        { type: 'redacted_thinking', data: 'private_redacted', origin },
        {
          type: 'provider_state',
          origin,
          item: { type: 'reasoning', id: 'r', encrypted_content: 'private_cipher', summary: [] },
        },
        {
          type: 'tool_use',
          id: 'call',
          name: 'read',
          input: { path: 'file' },
          protocolMeta: { origin, itemIndex: 2, itemId: 'private_item' },
        },
      ],
    });
    const text = JSON.stringify(safe);
    expect(text).toContain('visible');
    expect(text).toContain('file');
    expect(text).not.toContain('private_');
  });

  it('does not merge assistant Item phases and recognizes a successful answer with state', () => {
    const origin = createProtocolOrigin(target, context);
    const history: CanonicalMessage[] = [
      { role: 'user', id: 'u', content: [{ type: 'text', text: 'task' }] },
      {
        role: 'assistant',
        id: 'a',
        content: [
          {
            type: 'text',
            text: 'working',
            protocolMeta: { origin, itemIndex: 0, phase: 'commentary' },
          },
        ],
      },
      {
        role: 'assistant',
        id: 'b',
        content: [
          {
            type: 'text',
            text: 'done',
            protocolMeta: { origin, itemIndex: 1, phase: 'final_answer' },
          },
        ],
      },
    ];
    expect(normalizeHistory(history).messages).toHaveLength(3);
    history[2]!.content.push({
      type: 'provider_state',
      origin,
      item: { type: 'reasoning', id: 'r', summary: [] },
    });
    expect(indexInteractions(history).interactions[0]?.status).toBe('completed');
    expect(indexInteractions(history.slice(0, 2)).interactions[0]?.status).toBe('interrupted');
  });
});
