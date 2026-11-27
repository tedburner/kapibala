import type { ViewMessage } from '@kiturone/kapibala-host/view-model';
import { describe, expect, it } from 'vitest';
import { buildSessionHandoffPayload } from '../src/renderer/handoff-context.js';
import { aggregateTurnUsage, formatTurnMetaBadge } from '../src/renderer/turn-usage.js';

describe('历史会话跨代理接力摘要与回合尾部模型/Effort 格式化', () => {
  it('提取最近多轮用户与助手正文并过滤技能/接力信封徽章，空会话返回 undefined', () => {
    expect(buildSessionHandoffPayload('空对话', [])).toBeUndefined();

    const messages: ViewMessage[] = [
      {
        id: 'u1',
        role: 'user',
        state: 'completed',
        persisted: true,
        blocks: [
          {
            id: 'b1',
            kind: 'text',
            text: '帮我写一个仓库巡检脚本',
            state: 'completed',
            revision: 0,
          },
          {
            id: 'b2',
            kind: 'text',
            text: '隐藏长文本',
            skillName: '承接 · 旧对话',
            state: 'completed',
            revision: 0,
          },
        ],
      },
      {
        id: 'a1',
        role: 'assistant',
        state: 'completed',
        persisted: true,
        blocks: [
          { id: 'b3', kind: 'thinking', text: '内部思考不进摘要', state: 'completed', revision: 0 },
          {
            id: 'b4',
            kind: 'text',
            text: '已生成 update-all.ps1 脚本。',
            state: 'completed',
            revision: 0,
          },
        ],
      },
    ];

    const payload = buildSessionHandoffPayload('PowerShell 仓库批量更新', messages);
    expect(payload).toBeDefined();
    expect(payload?.fromTitle).toBe('PowerShell 仓库批量更新');
    expect(payload?.context).toContain('帮我写一个仓库巡检脚本');
    expect(payload?.context).toContain('已生成 update-all.ps1 脚本。');
    expect(payload?.context).not.toContain('隐藏长文本');
    expect(payload?.context).not.toContain('内部思考不进摘要');
  });

  it('聚合多步工具调用回合内的真实 Token 用量并格式化当轮代理、模型与推理强度标签', () => {
    const turnMessages: ViewMessage[] = [
      {
        id: 'a-step-1',
        role: 'assistant',
        state: 'completed',
        persisted: true,
        blocks: [],
        usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
      },
      {
        id: 'a-step-2',
        role: 'assistant',
        state: 'completed',
        persisted: true,
        blocks: [],
        usage: { promptTokens: 150, completionTokens: 30, totalTokens: 180 },
        turnMeta: {
          agentName: 'OpenCode',
          modelLabel: 'DeepSeek V4.1 Flash Free',
          effortLabel: 'Max',
        },
      },
    ];

    expect(aggregateTurnUsage(turnMessages)).toEqual({
      promptTokens: 250,
      completionTokens: 50,
      totalTokens: 300,
    });
    expect(formatTurnMetaBadge(turnMessages)).toBe('OpenCode · DeepSeek V4.1 Flash Free · Max');
  });
});
