import type { CanonicalMessage } from '@kiturone/kapibala';
import { describe, expect, it } from 'vitest';
import { projectHistory } from '../src/host/history-projection.js';
import type { ViewUsage } from '../src/view-model/types.js';

const history: CanonicalMessage[] = [
  {
    id: 'user-1',
    role: 'user',
    content: [{ type: 'text', text: '你好' }],
    timestamp: 1,
  },
  {
    id: 'assistant-1',
    role: 'assistant',
    state: 'completed',
    content: [{ type: 'text', text: '你好，有什么可以帮你？' }],
    timestamp: 2,
  },
];

function usage(totalTokens: number): ViewUsage {
  return { promptTokens: totalTokens - 3, completionTokens: 3, totalTokens };
}

describe('projectHistory 逐消息 usage 投影', () => {
  it('按 canonical 消息 ID 给助手消息附加真实消耗', () => {
    const projected = projectHistory(history, 'scope', undefined, {
      usageByMessageId: new Map([['assistant-1', usage(12)]]),
    });
    expect(projected.find((message) => message.role === 'user')?.usage).toBeUndefined();
    expect(projected.find((message) => message.role === 'assistant')?.usage).toEqual(usage(12));
  });

  it('缺少记录或 ID 未命中时不补零、不估算', () => {
    expect(projectHistory(history, 'scope').every((message) => !message.usage)).toBe(true);
    const projected = projectHistory(history, 'scope', undefined, {
      usageByMessageId: new Map([['other-id', usage(9)]]),
    });
    expect(projected.every((message) => !message.usage)).toBe(true);
  });
});
