import type { CanonicalMessage } from '@kiturone/kapibala';
import { buildTodoState, projectHistory } from '@kiturone/kapibala-host/internal';
import { describe, expect, it } from 'vitest';

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

describe('session task list projection', () => {
  it('returns undefined without a successful todo_write', () => {
    expect(buildTodoState([])).toBeUndefined();
    const failed: CanonicalMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't',
            name: 'todo_write',
            input: { items: [{ id: '1', title: 'x', status: 'pending' }] },
          },
        ],
      },
      {
        id: 'r',
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 't', content: 'boom', isError: true }],
      },
    ];
    expect(buildTodoState(failed)).toBeUndefined();
  });

  it('takes the latest successful call and counts successful updates as revision', () => {
    const history: CanonicalMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        timestamp: 100,
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'todo_write',
            input: { items: [{ id: '1', title: '旧', status: 'pending' }] },
          },
        ],
      },
      {
        id: 'r1',
        role: 'tool',
        timestamp: 110,
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }],
      },
      {
        id: 'a2',
        role: 'assistant',
        timestamp: 200,
        content: [
          {
            type: 'tool_use',
            id: 't2',
            name: 'todo_write',
            input: { items: [{ id: '1', title: '新', status: 'completed' }] },
          },
        ],
      },
      {
        id: 'r2',
        role: 'tool',
        timestamp: 210,
        content: [{ type: 'tool_result', toolUseId: 't2', content: 'ok' }],
      },
    ];
    expect(buildTodoState(history)).toEqual({
      items: [{ id: '1', title: '新', status: 'completed' }],
      revision: 2,
      updatedAt: 210,
    });
  });

  it('ignores failed latest calls and malformed input instead of blinking empty', () => {
    const history: CanonicalMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'todo_write',
            input: { items: [{ id: '1', title: '保留', status: 'in_progress' }] },
          },
        ],
      },
      {
        id: 'r1',
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }],
      },
      {
        id: 'a2',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't2',
            name: 'todo_write',
            input: { items: [{ id: '2', title: '丢弃', status: 'pending' }] },
          },
        ],
      },
      {
        id: 'r2',
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 't2', content: 'boom', isError: true }],
      },
      {
        id: 'a3',
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't3', name: 'todo_write', input: { items: 'bad' } }],
      },
      {
        id: 'r3',
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 't3', content: 'ok' }],
      },
    ];
    expect(buildTodoState(history)?.items).toEqual([
      { id: '1', title: '保留', status: 'in_progress' },
    ]);
    expect(buildTodoState(history)?.revision).toBe(1);
  });

  it('redacts todo titles through the injected public text redactor', () => {
    const history: CanonicalMessage[] = [
      {
        id: 'a1',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: 't1',
            name: 'todo_write',
            input: {
              items: [
                { id: '1', title: '轮换 sk-abcd1234 密钥', status: 'pending' },
                { id: '2', title: '普通标题', status: 'completed' },
              ],
            },
          },
        ],
      },
      {
        id: 'r1',
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }],
      },
    ];
    const state = buildTodoState(history, (text) => text.replaceAll('sk-abcd1234', '[REDACTED]'));
    expect(state?.items.map((item) => item.title)).toEqual(['轮换 [REDACTED] 密钥', '普通标题']);
    // 脱敏不改变结构事实：revision 与状态保持原样，id/status 不经过脱敏出口。
    expect(state?.revision).toBe(1);
    expect(state?.items.map((item) => item.id)).toEqual(['1', '2']);
  });
});

describe('artifact projection', () => {
  const policy = (
    name: string,
    _input: Record<string, unknown>,
    succeeded: boolean,
  ): readonly { kind: 'image'; path: string; ext: string; size: number }[] | undefined =>
    name === 'write_file' && succeeded
      ? [{ kind: 'image', path: '/workspace/chart.png', ext: 'png', size: 12 }]
      : undefined;

  it('attaches artifacts only to succeeded write_file calls', () => {
    const history: CanonicalMessage[] = [
      {
        id: 'a',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'ok', name: 'write_file', input: { path: 'chart.png' } },
          { type: 'tool_use', id: 'bad', name: 'write_file', input: { path: 'chart.png' } },
        ],
      },
      {
        id: 'r1',
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'ok', content: 'written' }],
      },
      {
        id: 'r2',
        role: 'tool',
        content: [{ type: 'tool_result', toolUseId: 'bad', content: 'denied', isError: true }],
      },
    ];
    const projected = projectHistory(history, 'scope', undefined, { artifacts: policy });
    expect(projected[0].blocks[0].tool?.artifacts).toEqual([
      { kind: 'image', path: '/workspace/chart.png', ext: 'png', size: 12 },
    ]);
    expect(projected[0].blocks[1].tool?.artifacts).toBeUndefined();
  });
});
