import type { ViewTool } from './types.js';

/** 执行组汇总（U1.8）：只描述已完成事实，不改变工具顺序或状态。 */
export interface ToolGroupSummary {
  /** 面向用户的一行摘要，例如「已读取 3 个文件」「运行 20 次，1 次失败」。 */
  readonly text: string;
  readonly total: number;
  readonly failed: number;
}

const FILE_VERBS: Readonly<Record<string, string>> = {
  read_file: '已读取',
  write_file: '已写入',
  edit_file: '已编辑',
};
const SEARCH_VERBS: Readonly<Record<string, string>> = {
  glob: '已搜索',
  grep: '已搜索',
};

/**
 * 把连续或多步工具调用汇总为自然语言短句。
 * 纯函数、零 I/O：单类工具直出精确计数；混合工具按动作类别拼合前 3 段（自动略过夹杂的 `todo_write` 记账噪音），
 * 类别超过 3 类时追加总步数，避免机械回退成无信息的「执行 N 步」。
 */
export function summarizeToolGroup(tools: readonly ViewTool[]): ToolGroupSummary | undefined {
  if (tools.length === 0) return undefined;
  const failed = tools.filter((tool) => tool.status === 'failed').length;
  const total = tools.length;
  const failSuffix = failed > 0 ? `，${failed} 次失败` : '';
  const names = new Set(tools.map((tool) => tool.name));
  if (names.size === 1) {
    const tool = tools[0];
    const fileVerb = FILE_VERBS[tool.name];
    if (fileVerb) return { text: `${fileVerb} ${total} 个文件${failSuffix}`, total, failed };
    const searchVerb = SEARCH_VERBS[tool.name];
    if (searchVerb) return { text: `${searchVerb} ${total} 次${failSuffix}`, total, failed };
    if (tool.name === 'run_command') {
      return { text: `运行 ${total} 次${failSuffix}`, total, failed };
    }
    return { text: `${tool.displayName} ${total} 次${failSuffix}`, total, failed };
  }

  // 混合工具：过滤与实质工作混排的 todo_write（除非全部都是 todo_write），按首次出现顺序归并类别短句。
  const substantive = tools.filter((tool) => tool.name !== 'todo_write');
  const source = substantive.length > 0 ? substantive : tools;
  const buckets = new Map<string, { count: number; render: (n: number) => string }>();
  const touch = (key: string, render: (n: number) => string) => {
    const existing = buckets.get(key);
    if (existing) existing.count += 1;
    else buckets.set(key, { count: 1, render });
  };
  for (const tool of source) {
    const fileVerb = FILE_VERBS[tool.name];
    if (fileVerb) {
      touch(`file:${tool.name}`, (n) => `${fileVerb} ${n} 个文件`);
      continue;
    }
    if (SEARCH_VERBS[tool.name]) {
      touch('search', (n) => `搜索 ${n} 次`);
      continue;
    }
    if (tool.name === 'run_command') {
      touch('command', (n) => `运行 ${n} 条命令`);
      continue;
    }
    touch(`other:${tool.name}`, (n) => `${tool.displayName} ${n} 次`);
  }
  const clauses = [...buckets.values()].map((item) => item.render(item.count));
  const joined =
    clauses.length <= 3 ? clauses.join('、') : `${clauses.slice(0, 2).join('、')} 等 ${total} 步`;
  return { text: `${joined}${failSuffix}`, total, failed };
}
