import type { CanonicalMessage } from '@kiturone/kapibala';
import { listDelegationSessions } from '@kiturone/kapibala-host/internal';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandContext } from '../src/commands/dispatcher.js';
import { evidenceCommand } from '../src/commands/evidence.js';

vi.mock('@kiturone/kapibala-host/internal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@kiturone/kapibala-host/internal')>();
  return { ...actual, listDelegationSessions: vi.fn() };
});

/** 捕获命令输出；只关心可见正文，不涉及样式与流选择。 */
function context(
  history: CanonicalMessage[],
  options: { manager?: object } = {},
): { ctx: CommandContext; lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  const ctx = {
    session: { conversationId: 'conv-1', getHistory: () => history },
    controller: options.manager ? { manager: options.manager } : undefined,
    output: {
      log: (message: string) => lines.push(message),
      error: (message: string) => errors.push(message),
      write: () => {},
    },
  } as unknown as CommandContext;
  return { ctx, lines, errors };
}

const history: CanonicalMessage[] = [
  {
    id: 'u1',
    role: 'user',
    content: [
      {
        type: 'text',
        text: '参考一下',
        referenceSource: {
          version: 1,
          sessionId: 'source-session',
          recordId: 'record-1',
          branchId: 'main',
          role: 'assistant',
          timestamp: 1_700_000_000_000,
          contentDigest: '0123456789abcdef',
          title: '来源标题',
        },
      },
    ],
  },
  {
    id: 'a1',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'w1', name: 'write_file', input: { path: 'src/a.ts' } }],
  },
  {
    id: 'r1',
    role: 'tool',
    content: [
      {
        type: 'tool_result',
        toolUseId: 'w1',
        content: 'ok',
        execution: {
          version: 1,
          dispatchOutcome: 'succeeded',
          facts: { version: 1, diff: { additions: 2, deletions: 1 } },
        },
      },
    ],
  },
  {
    id: 'a2',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'e1', name: 'edit_file', input: { path: 'src/b.ts' } }],
  },
  {
    id: 'r2',
    role: 'tool',
    content: [{ type: 'tool_result', toolUseId: 'e1', content: 'ok' }],
  },
  {
    id: 'a3',
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'm1', name: 'mcp__yapi__list', input: {} }],
  },
  {
    id: 'r3',
    role: 'tool',
    content: [{ type: 'tool_result', toolUseId: 'm1', content: 'failed', isError: true }],
  },
];

describe('/evidence', () => {
  beforeEach(() => {
    vi.mocked(listDelegationSessions).mockReset();
  });

  it('输出摘要与四分区，缺失事实显示未记录', async () => {
    const { ctx, lines } = context(history);
    await evidenceCommand([], ctx);
    const text = lines.join('\n');
    expect(text).toContain('变更 +2 −1 · 引用 1 条 · MCP 调用 1 次');
    expect(text).toContain('+2 −1  src/a.ts');
    expect(text).toContain('未记录  src/b.ts');
    expect(text).toContain('来源标题 · record-1 · assistant');
    expect(text).toContain('yapi · 1 次 · 1 次失败');
    expect(text).toContain('只统计成功的写入工具，不含命令行间接改动');
  });

  it('没有会话管理器时明确说明委派分区不可用', async () => {
    const { ctx, lines } = context(history);
    await evidenceCommand([], ctx);
    expect(lines.join('\n')).toContain('当前宿主无法访问会话管理器，委派分区不可用。');
  });

  it('有会话管理器时按父会话过滤并展示可续聊委派', async () => {
    vi.mocked(listDelegationSessions).mockResolvedValue([
      {
        sessionId: 'd1',
        title: '委派 · d1',
        taskName: '整理文档',
        parentSessionId: 'conv-1',
        lastActivityAt: 1_700_000_000_000,
        archived: false,
      },
      {
        sessionId: 'd2',
        title: '其它父会话',
        taskName: '无关',
        parentSessionId: 'other',
        lastActivityAt: 1_700_000_000_000,
        archived: false,
      },
    ]);
    const { ctx, lines } = context(history, { manager: {} });
    await evidenceCommand([], ctx);
    const text = lines.join('\n');
    expect(text).toContain('委派 · d1 · 整理文档 · 可续聊');
    expect(text).not.toContain('其它父会话');
  });

  it('空会话不伪造变更或引用', async () => {
    const { ctx, lines } = context([]);
    await evidenceCommand([], ctx);
    const text = lines.join('\n');
    expect(text).toContain('变更 +0 −0');
    expect(text).toContain('本会话没有成功的文件写入。');
    expect(text).toContain('本会话没有跨会话引用。');
    expect(text).toContain('本会话没有 MCP 调用。');
  });

  it('对引用来源标题与委派标题执行通用秘密脱敏', async () => {
    const fakeKey = ['sk', 'proj', '1234567890abcdefghijklmnop'].join('-');
    const fakeJwt = ['eyJhbGciOiJIUzI1NiJ9', 'secret', 'sig'].join('.');
    const secretHistory: CanonicalMessage[] = [
      {
        id: 'u-sec',
        role: 'user',
        content: [
          {
            type: 'text',
            text: '参考',
            referenceSource: {
              version: 1,
              sessionId: 'src-1',
              recordId: 'rec-1',
              branchId: 'main',
              role: 'user',
              timestamp: 1_700_000_000_000,
              contentDigest: '0123456789abcdef',
              title: `调试 ${fakeKey} 报错`,
            },
          },
        ],
      },
    ];
    vi.mocked(listDelegationSessions).mockResolvedValue([
      {
        sessionId: 'd-sec',
        title: `委派 Bearer ${fakeJwt}`,
        taskName: 'password=my_super_secret_value_123456',
        parentSessionId: 'conv-1',
        lastActivityAt: 1_700_000_000_000,
        archived: false,
      },
    ]);
    const { ctx, lines } = context(secretHistory, { manager: {} });
    await evidenceCommand([], ctx);
    const text = lines.join('\n');
    expect(text).not.toContain(fakeKey);
    expect(text).not.toContain(fakeJwt);
    expect(text).not.toContain('my_super_secret_value_123456');
  });
});
