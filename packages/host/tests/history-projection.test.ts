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

  it('按 interactionId 逐轮附加模型与推理元数据，且跨会话接力块折叠为紧凑徽章不暴露长上下文正文', () => {
    const multiTurn: CanonicalMessage[] = [
      {
        id: 'u1',
        interactionId: 'run-1',
        role: 'user',
        content: [
          { type: 'text', text: '继续优化刚才的脚本' },
          {
            type: 'text',
            text: '<conversation_handoff>长篇旧历史正文</conversation_handoff>',
            promptSource: { version: 1, server: 'kapibala-handoff', name: 'PowerShell 脚本调优' },
          },
        ],
        timestamp: 10,
      },
      {
        id: 'a1',
        interactionId: 'run-1',
        role: 'assistant',
        state: 'completed',
        content: [{ type: 'text', text: '第一轮回答' }],
        timestamp: 11,
      },
      {
        id: 'u2',
        interactionId: 'run-2',
        role: 'user',
        content: [{ type: 'text', text: '再检查一下边界' }],
        timestamp: 20,
      },
      {
        id: 'a2',
        interactionId: 'run-2',
        role: 'assistant',
        state: 'completed',
        content: [
          { type: 'thinking', thinking: '先推导边界条件' },
          { type: 'text', text: '第二轮回答' },
        ],
        timestamp: 21,
      },
    ];

    const projected = projectHistory(multiTurn, 'scope', undefined, {
      turnMetaByInteraction: new Map([
        ['run-1', { modelLabel: 'DeepSeek Flash (V4.1-Flash)' }],
        ['run-2', { modelLabel: 'DeepSeek V4 Pro', modeLabel: '规划' }],
      ]),
    });

    const user1 = projected[0]!;
    expect(user1.blocks).toHaveLength(2);
    expect(user1.blocks[0]?.text).toBe('继续优化刚才的脚本');
    expect(user1.blocks[1]?.skillName).toBe('承接 · PowerShell 脚本调优');
    expect(user1.blocks[1]?.text).toBe('');

    const assistant1 = projected[1]!;
    expect(assistant1.turnMeta).toEqual({ modelLabel: 'DeepSeek Flash (V4.1-Flash)' });

    const assistant2 = projected[3]!;
    expect(assistant2.turnMeta).toEqual({
      modelLabel: 'DeepSeek V4 Pro',
      effortLabel: '深度思考',
      modeLabel: '规划',
    });
  });
});
