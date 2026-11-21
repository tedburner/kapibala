/**
 * @fileoverview `/evidence`：当前会话的证据四分区（变更 / 引用 / MCP / 委派）。
 *
 * 约束、边界与为什么：
 * 1. 只读：不写控制记录、不改历史，事件投影与桌面看板共用 host 的同一聚合函数；
 * 2. 行数只认工具执行时落盘的 `facts.diff`，缺失显示「未记录」，不从入参重算；
 * 3. 斜杠命令在两轮之间执行，父会话不在工具循环内，活动子任务按「已结束（父会话收尾）」
 *    展示，不虚报 running；
 * 4. 当前宿主没有会话管理器时不伪造空委派列表，而是明确说明该分区不可用。
 */

import { buildSessionEvidence, listDelegationSessions } from '@kiturone/kapibala-host/internal';
import type { ViewEvidenceDelegationState } from '@kiturone/kapibala-host/view-model';
import { resolveCommandOutput } from '../command-output.js';
import type { CommandHandler } from './dispatcher.js';

/** 抽取到模块级，保证 CLI 与桌面展示同一套状态文案。 */
const DELEGATION_STATES: Record<ViewEvidenceDelegationState, string> = {
  running: '运行中',
  ended: '已结束（父会话收尾）',
  finished: '已完成',
  idle: '可续聊',
  archived: '已归档',
};

/** `/evidence`：输出头部摘要与四分区纯文本；不接收子命令参数。 */
export const evidenceCommand: CommandHandler = async (_args, ctx) => {
  const out = resolveCommandOutput(ctx);
  const manager = ctx.controller?.manager;
  const delegations = manager ? await listDelegationSessions(manager) : [];
  const evidence = buildSessionEvidence({
    conversationId: ctx.session.conversationId,
    history: ctx.session.getHistory(),
    delegations,
    tasks: ctx.runtime?.listTasks() ?? [],
    parentActive: false,
  });

  const { summary } = evidence;
  out.log(
    `会话证据 · 变更 +${summary.additions} −${summary.deletions} · 引用 ${summary.references} 条 · MCP 调用 ${summary.mcpCalls} 次 · 委派 ${summary.runningDelegations} 个运行中`,
  );

  out.log('── 变更 ──');
  if (!evidence.changes.length) out.log('本会话没有成功的文件写入。');
  else
    for (const item of evidence.changes)
      out.log(
        item.status === 'recorded'
          ? `+${item.additions} −${item.deletions}  ${item.path}`
          : item.status === 'truncated'
            ? `未记录（文件过大）  ${item.path}`
            : `未记录  ${item.path}`,
      );
  out.log('只统计成功的写入工具，不含命令行间接改动。');

  out.log('── 引用来源 ──');
  if (!evidence.references.length) out.log('本会话没有跨会话引用。');
  else
    for (const item of evidence.references)
      out.log(`${item.title ?? item.sessionId} · ${item.recordId} · ${item.role}`);

  out.log('── MCP 调用 ──');
  if (!evidence.mcp.length) out.log('本会话没有 MCP 调用。');
  else
    for (const item of evidence.mcp)
      out.log(`${item.server} · ${item.calls} 次${item.failed ? ` · ${item.failed} 次失败` : ''}`);

  out.log('── 委派任务 ──');
  if (!manager) out.log('当前宿主无法访问会话管理器，委派分区不可用。');
  else if (!evidence.delegations.length) out.log('本会话没有派生委派任务。');
  else
    for (const item of evidence.delegations)
      out.log(
        `${item.title} · ${item.taskName} · ${DELEGATION_STATES[item.state]}${
          item.summary ? ` · ${item.summary}` : ''
        }`,
      );
};
