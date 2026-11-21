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

  it('falls back to step count for mixed tools and empty input', () => {
    expect(summarizeToolGroup([tool('read_file'), tool('run_command')])?.text).toBe('执行 2 步');
    expect(summarizeToolGroup([])).toBeUndefined();
  });
});
