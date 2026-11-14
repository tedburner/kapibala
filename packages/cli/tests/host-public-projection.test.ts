import type { CanonicalMessage } from '@kiturone/kapibala';
import { projectHistory } from '@kiturone/kapibala-host/internal';
import { PresentationStore } from '@kiturone/kapibala-host/internal';
import { redactText } from '@kiturone/kapibala-host/internal';
import { SessionPresentation } from '@kiturone/kapibala-host/internal';
import { projectStatusFacts } from '@kiturone/kapibala-host/internal';
import { describe, expect, it } from 'vitest';

it('恢复历史与实时工具卡片共享脱敏和调用身份，私有块不进入展示', () => {
  const secret = 'opaque-fixture-credential';
  const redact = (text: string) => redactText(text, [secret]);
  const history: CanonicalMessage[] = [
    {
      id: 'a',
      role: 'assistant',
      content: [
        { type: 'text', text: secret },
        { type: 'tool_use', id: 'call', name: 'read_file', input: { path: secret } },
      ],
    },
    {
      id: 't',
      role: 'tool',
      content: [{ type: 'tool_result', toolUseId: 'call', content: secret }],
    },
  ];
  const projected = projectHistory(history, 'scope', redact);
  expect(JSON.stringify(projected)).not.toContain(secret);
  expect(projected[0].blocks[1].tool).toMatchObject({
    callId: 'call',
    status: 'succeeded',
    result: '[REDACTED]',
  });
  const store = new PresentationStore({ conversationId: 'c', branchId: 'main', viewEpoch: 1 });
  const events: unknown[] = [];
  store.subscribeEvents((event) => events.push(event));
  const presentation = new SessionPresentation(store, 'op', () => [], redact);
  presentation.consume({
    type: 'tool_start',
    id: 'call',
    name: 'read_file',
    input: { path: secret },
  });
  presentation.consume({
    type: 'tool_finish',
    id: 'call',
    name: 'read_file',
    result: secret,
    durationMs: 1,
    isError: false,
  });
  presentation.settle();
  expect(JSON.stringify(events)).not.toContain(secret);
  expect(JSON.stringify(store.snapshot())).not.toContain(secret);
  const block = store.snapshot().pendingMessages[0].blocks[0];
  expect(block.tool).toMatchObject({ callId: 'call', result: '[REDACTED]' });
  store.close();
});

describe('公共状态事实', () => {
  it('诊断与任务摘要不泄漏当前已知凭证，也不附带私有字段', () => {
    const secret = 'opaque-fixture-credential';
    const input = {
      phase: 'idle' as const,
      model: secret,
      privateHeaders: secret,
      tasks: [
        {
          agentId: 'id',
          description: secret,
          role: 'advisor',
          status: 'failed' as const,
          originBranchId: 'main',
          isOtherBranch: false,
          delivery: 'unknown' as const,
          error: secret,
        },
      ],
    };
    const projected = projectStatusFacts(input, (text) => redactText(text, [secret]));
    expect(JSON.stringify(projected)).not.toContain(secret);
    expect(projected).not.toHaveProperty('privateHeaders');
    expect(projected.tasks?.[0].agentId).toBe('id');
  });
});
