import type { CanonicalMessage } from '@kiturone/kapibala';
import { describe, expect, it } from 'vitest';
import type { CommandContext } from '../src/commands/dispatcher.js';
import { todosCommand } from '../src/commands/todos.js';

/** 捕获命令输出；只关心可见正文，不涉及样式与流选择。 */
function context(history: CanonicalMessage[]): { ctx: CommandContext; lines: string[] } {
  const lines: string[] = [];
  const ctx = {
    session: { conversationId: 'conv-1', getHistory: () => history },
    output: {
      log: (message: string) => lines.push(message),
      error: () => {},
      write: () => {},
    },
  } as unknown as CommandContext;
  return { ctx, lines };
}

const withTodos: CanonicalMessage[] = [
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
            { id: '1', title: '写设计', status: 'completed' },
            { id: '2', title: '写代码', status: 'in_progress' },
            { id: '3', title: '补测试', status: 'pending' },
            { id: '4', title: '已撤销', status: 'cancelled' },
          ],
        },
      },
    ],
  },
  { id: 'r1', role: 'tool', content: [{ type: 'tool_result', toolUseId: 't1', content: 'ok' }] },
];

describe('/todos', () => {
  it('输出进度与四态标记，顺序即模型提交顺序', async () => {
    const { ctx, lines } = context(withTodos);
    await todosCommand([], ctx);
    expect(lines).toEqual(['任务 1/4', '[x] 写设计', '[>] 写代码', '[ ] 补测试', '[-] 已撤销']);
  });

  it('没有成功声明时明确提示，不伪造空进度', async () => {
    const { ctx, lines } = context([]);
    await todosCommand([], ctx);
    expect(lines).toEqual(['当前会话没有任务清单。']);
  });
});
