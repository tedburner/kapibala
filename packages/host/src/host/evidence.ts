import {
  type AgentTaskRecord,
  type CanonicalMessage,
  type ToolResultBlock,
  type ToolUseBlock,
  isActiveTaskStatus,
} from '@kiturone/kapibala';
import type {
  ViewEvidence,
  ViewEvidenceChangeFile,
  ViewEvidenceDelegation,
  ViewEvidenceDelegationState,
  ViewEvidenceMcpServer,
  ViewEvidenceReference,
  ViewEvidenceSummary,
} from '../view-model/index.js';
import type { DelegationSessionSummary } from './delegations.js';
import type { PublicTextRedactor } from './public-projection.js';
import { sanitizeUntrustedOutput } from './ui/text-safety.js';

/** 聚合所需的全部输入；宿主负责提供当前会话的 canonical 历史与已过滤的委派/任务数据。 */
export interface SessionEvidenceInput {
  /** 当前会话；用于把委派分区限定在本会话派生出的子会话。 */
  readonly conversationId: string;
  /** 原始 canonical 历史；行数事实与引用溯源只存在于这里。 */
  readonly history: readonly CanonicalMessage[];
  /** 当前项目桶内的委派会话摘要；函数内部再按父会话过滤。 */
  readonly delegations?: readonly DelegationSessionSummary[];
  /** 运行时任务记录；用于把「可续聊」与「运行中/已结束」区分开。 */
  readonly tasks?: readonly AgentTaskRecord[];
  /**
   * 父会话是否仍在工具循环内。false 时，仍在活动的委派任务标为 `ended`
   * （父会话收尾），而不是报告一个用户已经无法观察的 running。
   */
  readonly parentActive?: boolean;
}

const CHANGE_TOOLS = new Set(['write_file', 'edit_file']);
const DELEGATION_ORDER: Readonly<Record<ViewEvidenceDelegationState, number>> = {
  running: 0,
  ended: 1,
  finished: 2,
  idle: 3,
  archived: 4,
};

/**
 * 从 canonical 历史聚合会话看板的四分区。
 *
 * 约束与边界：
 * - 纯函数，只读入参；不取锁、不写盘、不发起网络请求；
 * - 行数只读工具执行时持久化的 `execution.facts.diff`，缺失记 `missing`，截断记 `truncated`，
 *   绝不从入参或结果正文重算；
 * - 只统计成功（结果非错误）的 write/edit；失败调用不产生变更证据；
 * - 引用按（源会话, recordId）去重；MCP 只按 `mcp__<server>__<tool>` 前缀归组，不解析结果正文；
 * - 空历史返回四个空分区与零摘要，不省略字段。
 */
export function buildSessionEvidence(
  input: SessionEvidenceInput,
  redact: PublicTextRedactor = (text) => text,
): ViewEvidence {
  const calls: ToolUseBlock[] = [];
  const results = new Map<string, ToolResultBlock>();
  for (const message of input.history) {
    for (const block of message.content) {
      if (block.type === 'tool_use') calls.push(block);
      else if (block.type === 'tool_result') results.set(block.toolUseId, block);
    }
  }

  const changes: ViewEvidenceChangeFile[] = [];
  let additions = 0;
  let deletions = 0;
  const truncatedPaths = new Set<string>();
  const missingPaths = new Set<string>();
  for (const call of calls) {
    if (!CHANGE_TOOLS.has(call.name)) continue;
    const result = results.get(call.id);
    // 失败或尚未闭合的写入不产生变更；不把未完成的事实算进摘要。
    if (!result || result.isError) continue;
    const path = redact(sanitizeUntrustedOutput(readPath(call.input)));
    const diff = result.execution?.facts?.diff;
    if (!diff) {
      changes.push({
        path,
        callId: call.id,
        status: 'missing',
        additions: null,
        deletions: null,
      });
      missingPaths.add(path);
      continue;
    }
    if ('truncated' in diff) {
      changes.push({
        path,
        callId: call.id,
        status: 'truncated',
        additions: null,
        deletions: null,
      });
      truncatedPaths.add(path);
      continue;
    }
    changes.push({
      path,
      callId: call.id,
      status: 'recorded',
      additions: diff.additions,
      deletions: diff.deletions,
    });
    additions += diff.additions;
    deletions += diff.deletions;
  }

  const references = collectReferences(input.history, redact);

  const mcp = collectMcp(calls, results);

  const delegations = collectDelegations(input, redact);

  const mcpTotals = mcp.reduce(
    (totals, item) => ({
      calls: totals.calls + item.calls,
      failed: totals.failed + item.failed,
    }),
    { calls: 0, failed: 0 },
  );
  const summary: ViewEvidenceSummary = {
    additions,
    deletions,
    truncatedFiles: truncatedPaths.size,
    missingFiles: missingPaths.size,
    references: references.length,
    mcpCalls: mcpTotals.calls,
    mcpFailures: mcpTotals.failed,
    runningDelegations: delegations.filter((item) => item.state === 'running').length,
  };

  return { summary, changes, references, mcp, delegations };
}

/** 工具入参里的路径只作展示；缺失或非字符串时给出显式占位，不伪造文件名。 */
function readPath(input: Record<string, unknown>): string {
  return typeof input.path === 'string' && input.path ? input.path : '(未记录路径)';
}

/** 收集跨会话引用；同一源记录在同一会话内可能出现多次，只保留第一条。 */
function collectReferences(
  history: readonly CanonicalMessage[],
  redact: PublicTextRedactor,
): ViewEvidenceReference[] {
  const seen = new Set<string>();
  const references: ViewEvidenceReference[] = [];
  for (const message of history) {
    if (message.role !== 'user') continue;
    for (const block of message.content) {
      if (block.type !== 'text' || !block.referenceSource) continue;
      const source = block.referenceSource;
      const key = JSON.stringify([source.sessionId, source.recordId]);
      if (seen.has(key)) continue;
      seen.add(key);
      references.push({
        sessionId: source.sessionId,
        recordId: source.recordId,
        role: source.role,
        timestamp: source.timestamp,
        title: source.title ? redact(sanitizeUntrustedOutput(source.title)) : null,
      });
    }
  }
  return references;
}

/** 按服务器聚合 MCP 调用；失败只认工具结果的 isError，未闭合调用不计为失败。 */
function collectMcp(
  calls: readonly ToolUseBlock[],
  results: ReadonlyMap<string, ToolResultBlock>,
): ViewEvidenceMcpServer[] {
  const servers = new Map<string, { calls: number; failed: number }>();
  for (const call of calls) {
    if (!call.name.startsWith('mcp__')) continue;
    const rest = call.name.slice('mcp__'.length);
    const separator = rest.indexOf('__');
    const server = separator > 0 ? rest.slice(0, separator) : rest || 'unknown';
    const entry = servers.get(server) ?? { calls: 0, failed: 0 };
    entry.calls++;
    if (results.get(call.id)?.isError) entry.failed++;
    servers.set(server, entry);
  }
  return [...servers]
    .map(([server, entry]) => ({ server, calls: entry.calls, failed: entry.failed }))
    .sort((left, right) => right.calls - left.calls || left.server.localeCompare(right.server));
}

/**
 * 组装父会话视角的委派分区。
 *
 * 边界：只保留 parentSessionId 指向当前会话的条目；运行时任务按子会话 ID 对齐。
 * 任务缺失不等于失败——跨进程后运行时记录会消失，此时按 archived/idle 如实展示。
 */
function collectDelegations(
  input: SessionEvidenceInput,
  redact: PublicTextRedactor,
): ViewEvidenceDelegation[] {
  const parentDelegations = (input.delegations ?? []).filter(
    (item) => item.parentSessionId === input.conversationId,
  );
  const tasksBySession = new Map<string, AgentTaskRecord>();
  for (const task of input.tasks ?? []) {
    if (task.origin.parentSessionId !== input.conversationId) continue;
    if (!task.sessionId) continue;
    tasksBySession.set(task.sessionId, task);
  }

  const parentActive = input.parentActive === true;
  return parentDelegations
    .map((delegation): ViewEvidenceDelegation => {
      const task = tasksBySession.get(delegation.sessionId);
      let state: ViewEvidenceDelegationState;
      let summary: string | null = null;
      if (!task) {
        state = delegation.archived ? 'archived' : 'idle';
      } else if (isActiveTaskStatus(task.status)) {
        state = parentActive ? 'running' : 'ended';
      } else {
        state = 'finished';
        summary = task.summary ?? task.error ?? null;
      }
      return {
        sessionId: delegation.sessionId,
        title: redact(sanitizeUntrustedOutput(delegation.title)),
        taskName: redact(sanitizeUntrustedOutput(delegation.taskName)),
        state,
        summary: summary ? redact(sanitizeUntrustedOutput(summary)) : null,
        lastActivityAt: delegation.lastActivityAt,
      };
    })
    .sort(
      (left, right) =>
        DELEGATION_ORDER[left.state] - DELEGATION_ORDER[right.state] ||
        right.lastActivityAt - left.lastActivityAt,
    );
}
