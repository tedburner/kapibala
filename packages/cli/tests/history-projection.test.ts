import type { CanonicalMessage } from '@kiturone/kapibala';
import { describe, expect, it } from 'vitest';
import { projectHistory } from '../src/host/history-projection.js';

describe('canonical public history projection', () => {
  it('whitelists public content without copying protocol metadata or mutating source history', () => {
    const history: CanonicalMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        content: [
          {
            type: 'text',
            text: '公开正文',
            protocolMeta: {
              itemIndex: 0,
              origin: {
                version: 1,
                protocol: 'anthropic',
                modelName: 'x',
                runId: 'private-run',
                endpointScope: 'private-endpoint',
              },
            },
          },
          { type: 'thinking', thinking: '公开思考', signature: 'private-signature' },
          { type: 'redacted_thinking', data: 'private-redacted' },
          {
            type: 'provider_state',
            origin: {
              version: 1,
              protocol: 'openai-responses',
              modelName: 'x',
              runId: 'private-run',
              endpointScope: 'private-endpoint',
            },
            item: {
              type: 'reasoning',
              id: 'private-item',
              encrypted_content: 'private-encrypted',
              summary: [],
            },
          },
        ],
      },
    ];
    const before = JSON.stringify(history);
    const projected = projectHistory(history, 'scope');
    expect(projected[0].blocks.map((block) => block.text)).toEqual(['公开正文', '公开思考']);
    const serialized = JSON.stringify(projected);
    for (const privateValue of [
      'private-run',
      'private-endpoint',
      'private-signature',
      'private-redacted',
      'private-encrypted',
      'protocolMeta',
    ]) {
      expect(serialized).not.toContain(privateValue);
    }
    expect(JSON.stringify(history)).toBe(before);
  });

  it('pairs reverse-order results and redacts nested tool credentials before any view snapshot', () => {
    const history: CanonicalMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 'one',
            name: 'mcp__s__read',
            input: { nested: { apiKey: 'secret-one' }, path: 'a' },
          },
          { type: 'tool_use', id: 'two', name: 'read_file', input: { path: 'b' } },
        ],
      },
      {
        id: 'r2',
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'two', content: 'result two', durationMs: 20 }],
      },
      {
        id: 'r1',
        role: 'tool',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'one',
            content: '{"password":"secret-two","value":1}',
            isError: true,
          },
        ],
      },
    ];
    const projected = projectHistory(history, 'scope');
    expect(projected).toHaveLength(1);
    expect(projected[0].blocks[0].tool).toMatchObject({
      callId: 'one',
      status: 'failed',
      resultMessageId: 'r1',
    });
    expect(projected[0].blocks[1].tool).toMatchObject({
      callId: 'two',
      result: 'result two',
      durationMs: 20,
    });
    expect(JSON.stringify(projected)).not.toContain('secret-one');
    expect(JSON.stringify(projected)).not.toContain('secret-two');
    expect(JSON.stringify(projected)).toContain('[REDACTED]');
  });

  it('isolates reused stream call IDs in separate canonical messages', () => {
    const history: CanonicalMessage[] = [];
    for (const id of ['first', 'second']) {
      history.push({
        id,
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'reused', name: 'read_file', input: { path: id } }],
      });
      history.push({
        id: `${id}-result`,
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'reused', content: id }],
      });
    }
    const projected = projectHistory(history, 'scope');
    expect(projected.map((message) => message.blocks[0].tool?.result)).toEqual(['first', 'second']);
    expect(projected[0].blocks[0].id).not.toBe(projected[1].blocks[0].id);
  });

  it('keeps duplicate text, legacy identities and orphan results inspectable without spinning forever', () => {
    const history: CanonicalMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'same' }] },
      { role: 'user', content: [{ type: 'text', text: 'same' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'missing', name: 'tool', input: {} }],
      },
      {
        role: 'tool',
        content: [
          { type: 'tool_result', toolUseId: 'orphan', content: 'OUTCOME_UNKNOWN', isError: true },
        ],
      },
    ];
    const projected = projectHistory(history, 'scope');
    expect(new Set(projected.map((message) => message.id)).size).toBe(4);
    expect(projected[2].blocks[0].tool?.status).toBe('interrupted');
    expect(projected[3].blocks[0].tool?.result).toBe('OUTCOME_UNKNOWN');
    expect(projectHistory(history, 'scope')).toEqual(projected);
  });
});
