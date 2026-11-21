import { describe, expect, it } from 'vitest';
import { type TodoItem, todoWriteTool } from '../src/capabilities/tools/builtin/todo.js';
import { ToolError } from '../src/errors/index.js';

/** todo_write 的校验矩阵与结果文本；工具无副作用，执行上下文不参与逻辑。 */
const ctx = { rootDir: process.cwd() };

function items(count: number): TodoItem[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t${index}`,
    title: `任务 ${index}`,
    status: 'pending' as const,
  }));
}

describe('todo_write 校验矩阵', () => {
  it('接受四态清单并返回归一化确认文本', async () => {
    const result = await todoWriteTool.execute(
      {
        items: [
          { id: 'a', title: '待办', status: 'pending' },
          { id: 'b', title: '进行中', status: 'in_progress' },
          { id: 'c', title: '完成', status: 'completed' },
          { id: 'd', title: '取消', status: 'cancelled' },
        ],
      },
      ctx,
    );
    expect(result).toBe('任务清单已更新：1/4 已完成，进行中「进行中」');
  });

  it('无进行中时不追加进行中描述', async () => {
    const result = await todoWriteTool.execute(
      {
        items: [
          { id: 'a', title: '待办', status: 'pending' },
          { id: 'b', title: '完成', status: 'completed' },
        ],
      },
      ctx,
    );
    expect(result).toBe('任务清单已更新：1/2 已完成');
  });

  it('允许多个 in_progress，结果文本追加另有 N 项', async () => {
    const result = await todoWriteTool.execute(
      {
        items: [
          { id: 'a', title: '主任务', status: 'in_progress' },
          { id: 'b', title: '并行一', status: 'in_progress' },
          { id: 'c', title: '并行二', status: 'in_progress' },
        ],
      },
      ctx,
    );
    expect(result).toBe('任务清单已更新：0/3 已完成，进行中「主任务」（另有 2 项进行中）');
  });

  it('空清单被拒绝', async () => {
    await expect(todoWriteTool.execute({ items: [] }, ctx)).rejects.toBeInstanceOf(ToolError);
  });

  it('超过 50 条被拒绝', async () => {
    await expect(todoWriteTool.execute({ items: items(51) }, ctx)).rejects.toThrow(/最多 50 条/);
    await expect(todoWriteTool.execute({ items: items(50) }, ctx)).resolves.toContain('0/50');
  });

  it('空标题与重复 id 被拒绝', async () => {
    await expect(
      todoWriteTool.execute({ items: [{ id: 'a', title: '   ', status: 'pending' }] }, ctx),
    ).rejects.toThrow(/标题不能为空/);
    await expect(
      todoWriteTool.execute(
        {
          items: [
            { id: 'a', title: '一', status: 'pending' },
            { id: 'a', title: '二', status: 'completed' },
          ],
        },
        ctx,
      ),
    ).rejects.toThrow(/id 重复/);
  });

  it('非法状态被拒绝', async () => {
    await expect(
      // 故意用非法状态字符串绕过类型，验证运行时校验。
      todoWriteTool.execute(
        { items: [{ id: 'a', title: '一', status: 'done' as unknown as TodoItem['status'] }] },
        ctx,
      ),
    ).rejects.toThrow(/状态非法/);
  });

  it('超长标题被拒绝', async () => {
    await expect(
      todoWriteTool.execute(
        { items: [{ id: 'a', title: 'x'.repeat(201), status: 'pending' }] },
        ctx,
      ),
    ).rejects.toThrow(/超过 200 字符/);
  });

  it('validateInput 与 execute 同口径', () => {
    expect(todoWriteTool.validateInput?.({ items: items(1) })).toEqual({ valid: true });
    expect(todoWriteTool.validateInput?.({ items: [] })).toMatchObject({ valid: false });
  });
});
