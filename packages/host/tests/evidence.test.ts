import type { AgentTaskRecord, CanonicalMessage, ToolDiffFacts } from '@kiturone/kapibala';
import { describe, expect, it } from 'vitest';
import type { DelegationSessionSummary } from '../src/host/delegations.js';
import { buildSessionEvidence } from '../src/host/evidence.js';

/** 构造历史工具调用与结果；只填聚合关心的字段，避免测试夹具掩盖真实边界。 */
function toolUse(id: string, name: string, input: Record<string, unknown>): CanonicalMessage {
  return {
    id: `m-${id}`,
    role: 'assistant',
    content: [{ type: 'tool_use', id, name, input }],
  };
}

function toolResult(
  toolUseId: string,
  options: { isError?: boolean; diff?: ToolDiffFacts } = {},
): CanonicalMessage {
  return {
    id: `r-${toolUseId}`,
    role: 'tool',
    content: [
      {
        type: 'tool_result',
        toolUseId,
        content: options.isError ? 'failed' : 'ok',
        isError: options.isError,
        execution: {
          version: 1,
          dispatchOutcome: options.isError ? 'failed' : 'succeeded',
          ...(options.diff ? { facts: { version: 1, diff: options.diff } } : {}),
        },
      },
    ],
  };
}

function userMessage(
  id: string,
  text: string,
  reference?: Record<string, unknown>,
): CanonicalMessage {
  return {
    id,
    role: 'user',
    content: [
      {
        type: 'text',
        text,
        ...(reference
          ? {
              referenceSource: {
                version: 1,
                sessionId: 'source-session',
                recordId: 'source-record',
                branchId: 'main',
                role: 'assistant',
                timestamp: 1_700_000_000_000,
                contentDigest: '0123456789abcdef',
                ...reference,
              },
            }
          : {}),
      },
    ],
  };
}

function delegation(
  sessionId: string,
  parentSessionId: string,
  options: { archived?: boolean } = {},
): DelegationSessionSummary {
  return {
    sessionId,
    title: `委派 · ${sessionId}`,
    taskName: `任务 ${sessionId}`,
    parentSessionId,
    lastActivityAt: 1_700_000_000_000,
    archived: options.archived ?? false,
  };
}

function task(
  sessionId: string,
  parentSessionId: string,
  status: AgentTaskRecord['status'],
  summary?: string,
): AgentTaskRecord {
  return {
    agentId: `agent-${sessionId}`,
    origin: {
      rootTaskId: 'root',
      parentSessionId,
      originBranchId: 'main',
      originRunId: 'run',
      spawnToolCallId: 'spawn',
      generation: 1,
      depth: 1,
    },
    role: 'implement',
    description: 'task',
    prompt: 'task',
    status,
    createdAt: 1_700_000_000_000,
    childAgentIds: new Set(),
    workspaceRoot: '/workspace',
    executionCwd: '/workspace',
    limits: { maxSteps: 15, timeoutMs: 1_000 },
    mode: 'detached',
    sessionId,
    ...(summary ? { summary } : {}),
  };
}

const PARENT = 'parent-session';

describe('会话证据聚合', () => {
  it('空会话返回四个空分区与零摘要', () => {
    const evidence = buildSessionEvidence({ conversationId: PARENT, history: [] });
    expect(evidence.changes).toEqual([]);
    expect(evidence.references).toEqual([]);
    expect(evidence.mcp).toEqual([]);
    expect(evidence.delegations).toEqual([]);
    expect(evidence.summary).toMatchObject({
      additions: 0,
      deletions: 0,
      references: 0,
      mcpCalls: 0,
      mcpFailures: 0,
      runningDelegations: 0,
    });
  });

  it('只统计成功写入，缺失与截断分别计数', () => {
    const history: CanonicalMessage[] = [
      toolUse('w1', 'write_file', { path: 'src/a.ts' }),
      toolResult('w1', { diff: { additions: 3, deletions: 1 } }),
      toolUse('w2', 'edit_file', { path: 'src/b.ts' }),
      toolResult('w2'),
      toolUse('w3', 'write_file', { path: 'big.ts' }),
      toolResult('w3', { diff: { truncated: true } }),
      toolUse('w4', 'write_file', { path: 'failed.ts' }),
      toolResult('w4', { isError: true }),
    ];
    const evidence = buildSessionEvidence({ conversationId: PARENT, history });
    expect(evidence.summary).toMatchObject({
      additions: 3,
      deletions: 1,
      missingFiles: 1,
      truncatedFiles: 1,
    });
    expect(evidence.changes.map((item) => [item.path, item.status])).toEqual([
      ['src/a.ts', 'recorded'],
      ['src/b.ts', 'missing'],
      ['big.ts', 'truncated'],
    ]);
    expect(evidence.changes[1].additions).toBeNull();
  });

  it('引用按源会话与 recordId 去重，并透传脱敏标题', () => {
    const history: CanonicalMessage[] = [
      userMessage('u1', '问题一', { title: '来源标题' }),
      userMessage('u2', '问题二'),
    ];
    const evidence = buildSessionEvidence({ conversationId: PARENT, history });
    expect(evidence.references).toHaveLength(1);
    expect(evidence.references[0]).toMatchObject({
      sessionId: 'source-session',
      recordId: 'source-record',
      role: 'assistant',
      title: '来源标题',
    });
  });

  it('MCP 按服务器分组计数，失败只认结果 isError', () => {
    const history: CanonicalMessage[] = [
      toolUse('m1', 'mcp__yapi__list', {}),
      toolResult('m1', { isError: true }),
      toolUse('m2', 'mcp__yapi__get', {}),
      toolResult('m2'),
      toolUse('m3', 'mcp__docs__search', {}),
      toolResult('m3'),
    ];
    const evidence = buildSessionEvidence({ conversationId: PARENT, history });
    expect(evidence.mcp).toEqual([
      { server: 'yapi', calls: 2, failed: 1 },
      { server: 'docs', calls: 1, failed: 0 },
    ]);
    expect(evidence.summary.mcpCalls).toBe(3);
    expect(evidence.summary.mcpFailures).toBe(1);
  });

  it('委派分区区分运行、父会话收尾、终态与可续聊', () => {
    const history: CanonicalMessage[] = [];
    const delegations = [
      delegation('d-running', PARENT),
      delegation('d-ended', PARENT),
      delegation('d-finished', PARENT),
      delegation('d-idle', PARENT),
      delegation('d-other', 'other-parent'),
    ];
    const tasks = [
      task('d-running', PARENT, 'running'),
      task('d-ended', PARENT, 'running'),
      task('d-finished', PARENT, 'completed', '已完成'),
    ];
    const evidence = buildSessionEvidence({
      conversationId: PARENT,
      history,
      delegations,
      tasks,
      parentActive: false,
    });
    // 父会话已收尾：两个活动任务都标 ended（不虚报 running/finished），其余按状态排序。
    expect(evidence.delegations.map((item) => [item.sessionId, item.state])).toEqual([
      ['d-running', 'ended'],
      ['d-ended', 'ended'],
      ['d-finished', 'finished'],
      ['d-idle', 'idle'],
    ]);
    expect(evidence.delegations.find((item) => item.sessionId === 'd-finished')?.summary).toBe(
      '已完成',
    );
    expect(evidence.summary.runningDelegations).toBe(0);
  });

  it('父会话仍在运行时活动子任务显示为 running', () => {
    const evidence = buildSessionEvidence({
      conversationId: PARENT,
      history: [],
      delegations: [delegation('d1', PARENT)],
      tasks: [task('d1', PARENT, 'running')],
      parentActive: true,
    });
    expect(evidence.delegations[0].state).toBe('running');
    expect(evidence.summary.runningDelegations).toBe(1);
  });

  it('同一输入重复调用结果深等于，保证历史重放与实时读取同口径', () => {
    const input = {
      conversationId: PARENT,
      history: [
        toolUse('w1', 'write_file', { path: 'a.ts' }),
        toolResult('w1', { diff: { additions: 2, deletions: 0 } }),
      ],
      delegations: [delegation('d1', PARENT)],
      tasks: [task('d1', PARENT, 'completed', 'done')],
    };
    expect(buildSessionEvidence(input)).toEqual(buildSessionEvidence(input));
  });
});
