import type { ViewMessage } from '@kiturone/kapibala-host/view-model';
import { describe, expect, it } from 'vitest';
import {
  artifactFileName,
  collectViewArtifacts,
  isArtifactTooLarge,
} from '../src/renderer/artifact-model.js';
import { IMAGE_PREVIEW_LIMIT } from '../src/shared/preview.js';

function message(callId: string, status: 'succeeded' | 'failed', paths: string[]): ViewMessage {
  return {
    id: `m-${callId}`,
    role: 'assistant',
    state: 'completed',
    persisted: true,
    blocks: [
      {
        id: `b-${callId}`,
        kind: 'tool',
        text: '写入',
        state: 'completed',
        revision: 0,
        tool: {
          callId,
          name: 'write_file',
          displayName: '写文件',
          invocation: '写入 chart.png',
          input: '',
          status,
          artifacts: paths.map((path) => ({ kind: 'image', path, ext: 'png', size: 8 })),
        },
      },
    ],
  };
}

describe('产物预览模型', () => {
  it('只收集成功终态工具的产物，并按会话、调用与路径去重', () => {
    const messages = [
      message('t1', 'succeeded', ['/w/a.png', '/w/a.png']),
      message('t2', 'failed', ['/w/b.png']),
    ];
    expect(collectViewArtifacts(messages, 'ws:c').map((item) => item.key)).toEqual([
      'ws:c|t1|/w/a.png',
    ]);
  });

  it('文件名按 Windows 与 POSIX 分隔符取最后一段', () => {
    expect(artifactFileName('/tmp/chart.png')).toBe('chart.png');
    expect(artifactFileName('C:\\out\\plot.jpg')).toBe('plot.jpg');
  });

  it('超过预览通道上限时按过大处理，缺省大小不误判', () => {
    expect(isArtifactTooLarge(IMAGE_PREVIEW_LIMIT + 1)).toBe(true);
    expect(isArtifactTooLarge(IMAGE_PREVIEW_LIMIT)).toBe(false);
    expect(isArtifactTooLarge(undefined)).toBe(false);
  });
});
