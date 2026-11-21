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
 * 把连续同类工具调用汇总为一行；混合工具或空列表退回「执行 N 步」。
 * 纯函数、零 I/O：只读取 `ViewTool` 的公开字段，运行中的数量不改变汇总口径。
 */
export function summarizeToolGroup(tools: readonly ViewTool[]): ToolGroupSummary | undefined {
  if (tools.length === 0) return undefined;
  const failed = tools.filter((tool) => tool.status === 'failed').length;
  const total = tools.length;
  const names = new Set(tools.map((tool) => tool.name));
  if (names.size !== 1) return { text: `执行 ${total} 步`, total, failed };
  const tool = tools[0];
  const fileVerb = FILE_VERBS[tool.name];
  if (fileVerb) {
    return {
      text: `${fileVerb} ${total} 个文件${failed > 0 ? `，${failed} 次失败` : ''}`,
      total,
      failed,
    };
  }
  const searchVerb = SEARCH_VERBS[tool.name];
  if (searchVerb) {
    return {
      text: `${searchVerb} ${total} 次${failed > 0 ? `，${failed} 次失败` : ''}`,
      total,
      failed,
    };
  }
  if (tool.name === 'run_command') {
    return {
      text: `运行 ${total} 次${failed > 0 ? `，${failed} 次失败` : ''}`,
      total,
      failed,
    };
  }
  return {
    text: `${tool.displayName} ${total} 次${failed > 0 ? `，${failed} 次失败` : ''}`,
    total,
    failed,
  };
}
