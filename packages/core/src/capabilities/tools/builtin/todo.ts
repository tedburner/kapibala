import { ToolError } from '../../../errors/index.js';
import { defineTool } from '../index.js';

/**
 * 任务状态；只表达计划状态，不承载执行结果与工具关联。
 * `cancelled` 表示模型主动撤销，不等于「未开始」，读路径必须保留该条目。
 */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

/** 一条任务项；id 由模型生成并在清单内唯一，宿主不落盘、不改写。 */
export interface TodoItem {
  id: string;
  title: string;
  status: TodoStatus;
}

/** 允许的状态词；与本文件导出的 `TodoStatus` 严格一致，校验时按它拒绝其它值。 */
const TODO_STATUSES: readonly TodoStatus[] = ['pending', 'in_progress', 'completed', 'cancelled'];

/** 清单容量上限；超限直接拒绝，避免一次写入撑爆投影与展示预算。 */
const MAX_ITEMS = 50;
/** 单条标题字符上限；按原始长度计算，不静默截断模型提交的内容。 */
const MAX_TITLE_LENGTH = 200;

/**
 * 归一化并校验模型提交的清单；成功返回条目，失败返回人类可读原因。
 * 只做结构与取值校验，不合并、不排序、不改写 id/title —— 宿主重算依赖原样入参。
 */
function validateTodoInput(input: unknown): { items: TodoItem[] } | { error: string } {
  if (!input || typeof input !== 'object') return { error: '参数必须是对象' };
  const items = (input as { items?: unknown }).items;
  if (!Array.isArray(items)) return { error: 'items 必须是数组' };
  if (items.length === 0) return { error: '任务清单至少需要 1 条' };
  if (items.length > MAX_ITEMS) return { error: `任务清单最多 ${MAX_ITEMS} 条` };

  const seen = new Set<string>();
  const normalized: TodoItem[] = [];
  for (let index = 0; index < items.length; index++) {
    const raw = items[index];
    if (!raw || typeof raw !== 'object') return { error: `第 ${index + 1} 条任务格式非法` };
    const { id, title, status } = raw as Record<string, unknown>;
    if (typeof id !== 'string' || !id.trim()) return { error: `第 ${index + 1} 条任务缺少 id` };
    if (seen.has(id)) return { error: `任务 id 重复：${id}` };
    seen.add(id);
    if (typeof title !== 'string' || !title.trim()) return { error: `任务「${id}」标题不能为空` };
    if (title.length > MAX_TITLE_LENGTH)
      return { error: `任务「${id}」标题超过 ${MAX_TITLE_LENGTH} 字符` };
    if (typeof status !== 'string' || !TODO_STATUSES.includes(status as TodoStatus))
      return { error: `任务「${id}」状态非法：${String(status)}` };
    normalized.push({ id, title, status: status as TodoStatus });
  }
  return { items: normalized };
}

/**
 * 生成供模型自检的归一化确认文本；UI 不消费该文本。
 * 进度分子只计 `completed`，分母为全部条目；多个进行中时追加「另有 N 项」。
 */
function summarize(items: readonly TodoItem[]): string {
  const total = items.length;
  const completed = items.filter((item) => item.status === 'completed').length;
  const active = items.filter((item) => item.status === 'in_progress');
  let text = `任务清单已更新：${completed}/${total} 已完成`;
  if (active.length) text += `，进行中「${active[0].title}」`;
  if (active.length > 1) text += `（另有 ${active.length - 1} 项进行中）`;
  return text;
}

/**
 * 会话任务清单写入工具：每次提交完整清单，语义为**全量替换**而非增量合并。
 *
 * 约束与边界：
 * - 无文件 / shell / 网络副作用，也不维护进程内可变状态；清单状态由宿主从历史中
 *   「最近一次成功调用」的入参重算，因此并发提交天然按历史顺序后者生效，不需要写租约
 *   （声明 `fs:write` 只会让它与同批文件写入无谓串行，却没有共享对象可保护）。
 * - 状态四态含 `cancelled`；`in_progress` 允许 0..N，不硬拒多个并行任务。
 * - 失败或被中断的调用不改变展示视图：读路径只认成功结果，结果仅作过程证据。
 * - 声明 `fs:read` 仅为让权限策略在 Plan/Auto/FullAccess 都自动放行（零能力工具会在
 *   Plan 被拒、在其它模式每次询问）；它不触发工作区写租约，也不代表真实文件读取。
 */
export const todoWriteTool = defineTool<{ items: TodoItem[] }, string>({
  name: 'todo_write',
  description:
    'Replace the session task list with the complete set of tasks. Use it to declare a plan and to update progress as work advances. Each call submits the full list (full replacement, not incremental merge); statuses are pending / in_progress / completed / cancelled.',
  metadata: {
    source: 'builtin',
    permissions: ['fs:read'],
  },
  parameters: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: MAX_ITEMS,
        description: '完整的任务清单；每次调用全量替换，不做增量合并。',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '清单内唯一的任务 id。' },
            title: {
              type: 'string',
              description: `任务标题，不能为空，最多 ${MAX_TITLE_LENGTH} 字符。`,
            },
            status: {
              type: 'string',
              enum: [...TODO_STATUSES],
              description: '任务状态：待办 / 进行中 / 已完成 / 已取消。',
            },
          },
          required: ['id', 'title', 'status'],
        },
      },
    },
    required: ['items'],
  },
  validateInput(input) {
    const result = validateTodoInput(input);
    return 'error' in result ? { valid: false, message: result.error } : { valid: true };
  },
  async execute(input) {
    const result = validateTodoInput(input);
    if ('error' in result) throw new ToolError(result.error);
    return summarize(result.items);
  },
});
