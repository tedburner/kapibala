import type { ViewMessage } from '@kiturone/kapibala-host/view-model';
import { describe, expect, it } from 'vitest';
import {
  MAX_PROMPT_HISTORY,
  extractUserPrompts,
  isPromptHistoryBrowsing,
  rememberPromptEntry,
  resetPromptBrowsing,
  seedPromptHistory,
  stepPromptHistory,
} from '../src/renderer/prompt-history.js';

function userMsg(id: string, text: string, skillName?: string): ViewMessage {
  return {
    id,
    role: 'user',
    state: 'completed',
    persisted: true,
    blocks: [
      ...(text
        ? [{ id: `${id}:t`, kind: 'text' as const, text, state: 'completed' as const, revision: 0 }]
        : []),
      ...(skillName
        ? [
            {
              id: `${id}:s`,
              kind: 'text' as const,
              text: 'skill body',
              skillName,
              state: 'completed' as const,
              revision: 0,
            },
          ]
        : []),
    ],
  };
}

function assistantMsg(id: string, text: string): ViewMessage {
  return {
    id,
    role: 'assistant',
    state: 'completed',
    persisted: true,
    blocks: [{ id: `${id}:t`, kind: 'text', text, state: 'completed', revision: 0 }],
  };
}

describe('prompt-history', () => {
  it('extracts user prompts while skipping assistant, background notifications, and consecutive duplicates', () => {
    const messages: ViewMessage[] = [
      userMsg('u1', '第一问'),
      assistantMsg('a1', '第一答'),
      userMsg('u2', '<watch-event id="w1">changed</watch-event>'),
      userMsg('u3', '<subagent-notification id="s1">done</subagent-notification>'),
      userMsg('u4', '第一问'),
      userMsg('u5', '第二问\r\n第二行'),
      userMsg('u6', '', 'demo-skill'),
      userMsg('u7', '检查改动', 'review-skill'),
    ];
    expect(extractUserPrompts(messages)).toEqual([
      '第一问',
      '第二问\n第二行',
      '/skill demo-skill',
      '/skill review-skill 检查改动',
    ]);
  });

  it('seeds an unopened scope from resumed conversation history and supports arrow recall', () => {
    const messages: ViewMessage[] = [
      userMsg('u1', '升级 guava 版本'),
      assistantMsg('a1', '已完成'),
      userMsg('u2', '如何验证版本升级兼容性问题?'),
      assistantMsg('a2', '需要编译期和运行期验证'),
    ];

    const state = seedPromptHistory(undefined, messages);
    expect(state).toEqual({
      entries: ['升级 guava 版本', '如何验证版本升级兼容性问题?'],
      index: 2,
      draft: undefined,
      seeded: true,
    });
    expect(isPromptHistoryBrowsing(state)).toBe(false);

    expect(stepPromptHistory(state, -1, '未发送草稿')).toEqual({
      consumed: true,
      value: '如何验证版本升级兼容性问题?',
    });
    expect(isPromptHistoryBrowsing(state)).toBe(true);
    expect(stepPromptHistory(state, -1, '如何验证版本升级兼容性问题?')).toEqual({
      consumed: true,
      value: '升级 guava 版本',
    });
    expect(stepPromptHistory(state, -1, '升级 guava 版本')).toEqual({ consumed: false });
    expect(stepPromptHistory(state, 1, '升级 guava 版本')).toEqual({
      consumed: true,
      value: '如何验证版本升级兼容性问题?',
    });
    expect(stepPromptHistory(state, 1, '如何验证版本升级兼容性问题?')).toEqual({
      consumed: true,
      value: '未发送草稿',
    });
    expect(isPromptHistoryBrowsing(state)).toBe(false);
  });

  it('preserves in-session slash commands when already seeded and deduplicates boundary prompt on first seed', () => {
    // 首页首问已先记入 scope，再收到首条消息快照时不重复追加。
    const preRecorded = rememberPromptEntry(undefined, '首页首问');
    const merged = seedPromptHistory(preRecorded, [userMsg('u1', '首页首问')]);
    expect(merged.entries).toEqual(['首页首问']);
    expect(merged.seeded).toBe(true);

    // 已经补种后执行本地斜杠命令，后续快照刷新不得抹掉斜杠命令。
    const withSlash = rememberPromptEntry(merged, '/watches');
    const afterRefresh = seedPromptHistory(withSlash, [
      userMsg('u1', '首页首问'),
      assistantMsg('a1', '回答'),
    ]);
    expect(afterRefresh).toBe(withSlash);
    expect(afterRefresh.entries).toEqual(['首页首问', '/watches']);
  });

  it('caps history length at MAX_PROMPT_HISTORY and exits browsing cleanly on reset', () => {
    const many = Array.from({ length: MAX_PROMPT_HISTORY + 15 }, (_, index) =>
      userMsg(`u${index}`, `问题 ${index}`),
    );
    const seeded = seedPromptHistory(undefined, many);
    expect(seeded.entries).toHaveLength(MAX_PROMPT_HISTORY);
    expect(seeded.entries[0]).toBe('问题 15');
    expect(seeded.entries.at(-1)).toBe(`问题 ${MAX_PROMPT_HISTORY + 14}`);

    stepPromptHistory(seeded, -1, '草稿');
    expect(isPromptHistoryBrowsing(seeded)).toBe(true);
    resetPromptBrowsing(seeded);
    expect(isPromptHistoryBrowsing(seeded)).toBe(false);
    expect(seeded.draft).toBeUndefined();
    expect(stepPromptHistory(seeded, 1, '已改草稿')).toEqual({ consumed: false });
  });
});
