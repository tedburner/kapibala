import { describe, expect, it } from 'vitest';
import { summarizeToolGroup } from '../src/view-model/tool-summary.js';
import type { ViewTool } from '../src/view-model/types.js';

function tool(name: string, status: ViewTool['status'] = 'succeeded'): ViewTool {
  return {
    callId: `${name}-${status}`,
    name,
    displayName: name,
    invocation: name,
    input: '{}',
    status,
  };
}

describe('summarizeToolGroup', () => {
  it('collapses consecutive file reads into a file count', () => {
    expect(
      summarizeToolGroup([tool('read_file'), tool('read_file'), tool('read_file')])?.text,
    ).toBe('已读取 3 个文件');
  });

  it('keeps failure count for repeated commands', () => {
    const summary = summarizeToolGroup([
      tool('run_command'),
      tool('run_command'),
      tool('run_command', 'failed'),
    ]);
    expect(summary).toMatchObject({ text: '运行 3 次，1 次失败', total: 3, failed: 1 });
  });

  it('summarizes mixed tools into natural clauses and omits interleaved todo_write noise', () => {
    const res = summarizeToolGroup([
      tool('read_file'),
      tool('read_file'),
      tool('todo_write', 'failed'),
      tool('edit_file'),
      tool('run_command'),
    ]);
    expect(res).toEqual({
      text: '已读取 2 个文件、已编辑 1 个文件、运行 1 条命令',
      total: 4,
      failed: 0,
    });

    const overThree = summarizeToolGroup([
      tool('read_file'),
      tool('edit_file'),
      tool('grep'),
      tool('run_command'),
      tool('write_file'),
    ]);
    expect(overThree?.text).toBe('已读取 1 个文件、已编辑 1 个文件、搜索 1 次 等 5 步');
    expect(summarizeToolGroup([])).toBeUndefined();
  });
});
