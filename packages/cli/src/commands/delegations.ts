/**
 * @fileoverview `/delegations`：面向用户的委派会话面板（区别于 `/agents` 的运行时任务树）。
 *
 * 约束、边界与为什么：
 * 1. 数据源分离：列表来自会话元数据（跨进程可见），运行状态来自 AgentRuntime 快照，
 *    两者按 sessionId 对齐；进程重启后元数据仍可列出，但模型侧 send_agent 不可用；
 * 2. 只读优先：list/show 不做任何写入；open 走 ActiveSessionController 的既有切换流程；
 * 3. 清理必须显式：delete 物理删除会话文件 + sidecar，不触碰父历史中的通知记录；
 *    cancel 只把运行中的任务置为 cancelled，保留会话供后续查看或删除。
 */

import {
  type DelegationSessionSummary,
  MAX_RETAINED_DELEGATIONS,
  listDelegationSessions,
  pruneDelegationSessions,
} from '@kiturone/kapibala-host/internal';
import { resolveCommandOutput } from '../command-output.js';
import type { CommandContext, CommandHandler } from './dispatcher.js';

/**
 * 按完整 ID 或唯一前缀解析委派会话；找不到与歧义都返回错误文案。
 */
function resolveDelegation(
  sessions: readonly DelegationSessionSummary[],
  id: string,
): { session?: DelegationSessionSummary; error?: string } {
  const trimmed = id.trim();
  const exact = sessions.find((item) => item.sessionId === trimmed);
  if (exact) return { session: exact };
  const matches = sessions.filter((item) => item.sessionId.startsWith(trimmed));
  if (!matches.length) return { error: `找不到委派会话: ${trimmed}` };
  if (matches.length > 1) return { error: `委派会话前缀不唯一: ${trimmed}` };
  return { session: matches[0] };
}

/** 运行状态文案：优先取运行时任务，缺失时按「可续聊」处理（跨进程边界）。 */
function describeStatus(
  ctx: CommandContext,
  session: DelegationSessionSummary,
): { label: string; summary?: string; agentId?: string } {
  const tasks =
    ctx.runtime
      ?.listTasks()
      .filter((task) => task.sessionId === session.sessionId)
      .sort((a, b) => b.createdAt - a.createdAt) ?? [];
  const task = tasks[0];
  if (!task) return { label: session.archived ? '已归档' : '可续聊' };
  const running =
    task.status === 'preparing' ||
    task.status === 'accepted' ||
    task.status === 'running' ||
    task.status === 'waiting_children' ||
    task.status === 'cancelling';
  return {
    label: running ? `运行中（${task.status}）` : `可续聊（${task.status}）`,
    ...(task.summary ? { summary: task.summary } : {}),
    agentId: task.agentId,
  };
}

/** 格式化时间戳为本地可读时间；仅用于展示。 */
function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

/**
 * `/delegations`：委派会话列表与生命周期操作。
 *
 * 子命令：无参 / `list`、`show <id>`、`open <id>`、`cancel <id>`、`delete <id>`。
 */
export const delegationsCommand: CommandHandler = async (args, ctx) => {
  const out = resolveCommandOutput(ctx);
  const manager = ctx.controller?.manager;
  if (!manager) {
    out.log('当前宿主无法访问会话管理器，暂时无法查看委派会话。');
    return;
  }

  const sub = args[0] ?? 'list';
  const sessions = await listDelegationSessions(manager);

  if (sub === 'list') {
    if (!sessions.length) {
      out.log('当前项目还没有委派会话。使用 /delegate <任务> 派发第一个。');
      return;
    }
    out.log(`委派会话（${sessions.length}/${MAX_RETAINED_DELEGATIONS}，含已归档）`);
    sessions.forEach((session, index) => {
      const status = describeStatus(ctx, session);
      out.log(
        `${index + 1}. ${session.title} | ${session.sessionId} | ${status.label} | ${formatTime(session.lastActivityAt)}`,
      );
    });
    out.log('使用 /delegations show|open|cancel|delete <id> 查看、接续、取消或删除。');
    return;
  }

  if (sub === 'prune') {
    const activeSessionIds = new Set(
      (ctx.runtime?.listTasks({ status: 'active' }) ?? []).flatMap((task) =>
        task.sessionId ? [task.sessionId] : [],
      ),
    );
    const deleted = await pruneDelegationSessions(manager, { activeSessionIds });
    for (const deletedId of deleted) {
      ctx.runtime?.forgetDelegationSession(deletedId);
    }
    out.log(
      deleted.length > 0
        ? `已清理 ${deleted.length} 个过期或超额委派会话。`
        : '当前没有需要清理的委派会话。',
    );
    return;
  }

  if (!['show', 'open', 'cancel', 'delete'].includes(sub)) {
    out.log(
      '用法: /delegations [list | prune | show <id> | open <id> | cancel <id> | delete <id>]',
    );
    return;
  }
  const target = args[1];
  if (!target) {
    out.log(`用法: /delegations ${sub} <id>`);
    return;
  }

  const resolved = resolveDelegation(sessions, target);
  if (!resolved.session) {
    out.log(resolved.error ?? '找不到委派会话。');
    return;
  }
  const session = resolved.session;

  if (sub === 'show') {
    const status = describeStatus(ctx, session);
    out.log(`── 委派会话详情 [${session.sessionId}] ──`);
    out.log(`标题: ${session.title}`);
    out.log(`任务: ${session.taskName}`);
    out.log(`父会话: ${session.parentTitle ?? '(未记录)'} (${session.parentSessionId})`);
    out.log(`状态: ${status.label}`);
    out.log(`最后活动: ${formatTime(session.lastActivityAt)}`);
    if (status.agentId) out.log(`运行时任务: ${status.agentId}`);
    if (status.summary) out.log(`最近结果: ${status.summary}`);
    out.log('接续: /delegations open <id>；删除: /delegations delete <id>');
    return;
  }

  if (sub === 'open') {
    // 运行中的委派会话仍持有单写者锁；open 会按 SESSION_LOCKED 失败，明确告知而不是抢锁。
    try {
      await ctx.controller!.resume(session.sessionId);
      out.log(`已切换到委派会话 ${session.sessionId}，后续输入将接续该会话。`);
      out.log('注意：这是用户级续聊；进程重启后模型侧 send_agent 不再可用。');
    } catch (error) {
      out.log(`切换失败: ${(error as Error).message}`);
    }
    return;
  }

  if (sub === 'cancel') {
    const status = describeStatus(ctx, session);
    if (!status.agentId) {
      out.log('该委派会话当前没有运行中的任务；如需清理请使用 /delegations delete。');
      return;
    }
    const task = ctx.runtime?.getTask(status.agentId);
    const terminal =
      !task ||
      task.status === 'completed' ||
      task.status === 'failed' ||
      task.status === 'cancelled' ||
      task.status === 'interrupted';
    if (terminal) {
      out.log('该委派任务已结束；如需清理请使用 /delegations delete。');
      return;
    }
    await ctx.runtime!.cancelTask(status.agentId, '用户通过 /delegations cancel 取消');
    out.log(`已取消委派任务 ${status.agentId}；会话文件保留，可继续查看或删除。`);
    return;
  }

  // delete：物理删除会话文件与 sidecar；父历史中的通知记录不在此处改动。
  try {
    await manager.deleteSession(session.sessionId);
    // 运行时仍保存着该会话身份的终态任务：一并清空，避免后续 send_agent
    // 在 resumer 里以未分类的打开错误失败。
    ctx.runtime?.forgetDelegationSession(session.sessionId);
    out.log(`已删除委派会话 ${session.sessionId}。`);
  } catch (error) {
    out.log(`删除失败: ${(error as Error).message}`);
  }
};
