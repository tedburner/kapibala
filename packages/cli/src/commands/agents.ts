import { resolveCommandOutput } from '../host/command-output.js';
/**
 * @fileoverview 后台子代理任务树管理命令（/agents）。
 *
 * 约束、边界与为什么：
 * 1. 任务树生命周期与状态观测：
 *    提供对后台子代理任务状态机（preparing、accepted、running、waiting_children、
 *    completed、failed、cancelled、interrupted）的直接观测能力。
 * 2. 分支安全调度与收集（Branch-Safe Collection）：
 *    收集子代理通知与执行结果时，若当前会话未处于子代理派生的来源分支，
 *    严格提示用户切换至来源分支，绝不发生跨分支自动乱插历史。
 */

import { SessionInbox, sanitizeSessionTitle } from '@kiturone/kapibala';
import type { CommandContext, CommandHandler } from './dispatcher.js';

/**
 * 子代理任务树管理命令处理器。
 * 支持：
 * - `/agents`：列出当前后台所有子代理任务树及状态；
 * - `/agents show <id>`：查看指定子代理任务的详细配置与运行结果；
 * - `/agents cancel <id>`：取消指定子代理任务及其所有派生后代；
 * - `/agents collect <id>`：手动收集指定子代理的结果到当前会话分支。
 */
export const agentsCommand: CommandHandler = async (args, ctx) => {
  const runtime = ctx.runtime;
  if (!runtime) {
    resolveCommandOutput(ctx).log('当前运行时未启用子代理后台调度器。');
    return;
  }

  // 1. 无参：列出任务树
  if (args.length === 0) {
    const tasks = runtime.listTasks();
    if (tasks.length === 0) {
      resolveCommandOutput(ctx).log('当前没有任何后台子代理任务。');
      return;
    }
    resolveCommandOutput(ctx).log(`后台子代理任务列表（共 ${tasks.length} 个任务）:`);
    for (const t of tasks) {
      const indent = '  '.repeat(Math.max(0, t.origin.depth - 1));
      const statusIcon =
        t.status === 'completed'
          ? '✓'
          : t.status === 'running' || t.status === 'waiting_children'
            ? '⚙'
            : t.status === 'cancelled' || t.status === 'failed'
              ? '✗'
              : '•';
      const duration =
        t.finishedAt && t.startedAt
          ? ` [${Math.round((t.finishedAt - t.startedAt) / 1000)}s]`
          : t.startedAt
            ? ` [运行中 ${Math.round((Date.now() - t.startedAt) / 1000)}s]`
            : '';
      resolveCommandOutput(ctx).log(
        `${indent}${statusIcon} [${t.agentId}] (${t.role}) ${t.status}${duration} — ${sanitizeSessionTitle(t.description, 60)}`,
      );
    }
    return;
  }

  const sub = args[0];
  const targetId = args[1]?.trim();

  // 2. 查看详情: /agents show <id>
  if (sub === 'show') {
    if (!targetId) {
      resolveCommandOutput(ctx).log('用法: /agents show <agentId>');
      return;
    }
    const task = runtime.getTask(targetId);
    if (!task) {
      resolveCommandOutput(ctx).error(`❌ 未找到指定的子代理任务: ${targetId}`);
      return;
    }
    resolveCommandOutput(ctx).log(`── 子代理任务详情 [${task.agentId}] ──`);
    resolveCommandOutput(ctx).log(`状态: ${task.status}`);
    resolveCommandOutput(ctx).log(`角色: ${task.role}`);
    resolveCommandOutput(ctx).log(`描述: ${task.description}`);
    resolveCommandOutput(ctx).log(`模型: ${task.modelId ?? '默认场景路由'}`);
    resolveCommandOutput(ctx).log(
      `深度: ${task.origin.depth} (父: ${task.origin.parentAgentId ?? '根会话'})`,
    );
    resolveCommandOutput(ctx).log(`根任务 ID: ${task.origin.rootTaskId}`);
    resolveCommandOutput(ctx).log(
      `来源会话 / 分支: ${task.origin.parentSessionId} / ${task.origin.originBranchId}`,
    );
    resolveCommandOutput(ctx).log(`创建时间: ${new Date(task.createdAt).toISOString()}`);
    if (task.startedAt)
      resolveCommandOutput(ctx).log(`启动时间: ${new Date(task.startedAt).toISOString()}`);
    if (task.finishedAt)
      resolveCommandOutput(ctx).log(`结束时间: ${new Date(task.finishedAt).toISOString()}`);
    if (task.summary) resolveCommandOutput(ctx).log(`结果摘要:\n${task.summary}`);
    if (task.error) resolveCommandOutput(ctx).log(`错误信息: ${task.error}`);
    return;
  }

  // 3. 取消任务: /agents cancel <id>
  if (sub === 'cancel') {
    if (!targetId) {
      resolveCommandOutput(ctx).log('用法: /agents cancel <agentId>');
      return;
    }
    await runtime.cancelTask(targetId, 'User cancelled via /agents cancel');
    resolveCommandOutput(ctx).log(`已成功请求取消子代理任务及其所有后代: ${targetId}`);
    return;
  }

  // 4. 收集结果: /agents collect <id>
  if (sub === 'collect') {
    if (!targetId) {
      resolveCommandOutput(ctx).log('用法: /agents collect <agentId>');
      return;
    }
    const task = runtime.getTask(targetId);
    if (!task) {
      resolveCommandOutput(ctx).error(`❌ 未找到指定的子代理任务: ${targetId}`);
      return;
    }
    // 优先检查来源分支，异分支绝对拒绝收集
    const store = ctx.controller?.handle.store;
    if (!store) {
      resolveCommandOutput(ctx).error('❌ 当前会话存储通道不可用，无法收集任务结果。');
      return;
    }
    const currentBranchId =
      'getActiveBranchId' in store && typeof store.getActiveBranchId === 'function'
        ? store.getActiveBranchId()
        : 'main';
    if (task.origin.originBranchId !== currentBranchId) {
      resolveCommandOutput(ctx).log(
        `⚠️ 该任务来源于分支 [${task.origin.originBranchId}]，当前活动分支为 [${currentBranchId}]。请先切换至来源分支再收集: /branch switch ${task.origin.originBranchId}`,
      );
      return;
    }

    if (
      task.status === 'running' ||
      task.status === 'preparing' ||
      task.status === 'waiting_children'
    ) {
      resolveCommandOutput(ctx).log(
        `⏳ 任务 ${targetId} 仍处于 ${task.status} 状态，尚未产生终态结果。`,
      );
      return;
    }

    const outbox = runtime.getOutbox();
    let notification = outbox.getPendingNotifications().find((n) => n.agentId === targetId);
    if (!notification) {
      notification = outbox.enqueueFromTask(task);
    }
    const inbox = new SessionInbox(store);
    const newlyConsumed = await inbox.consume(notification);
    outbox.acknowledge(notification.eventId);
    if (newlyConsumed) {
      resolveCommandOutput(ctx).log(
        `✅ 任务 ${targetId} 已在来源分支 [${currentBranchId}] 成功收集并持久化至历史。`,
      );
    } else {
      resolveCommandOutput(ctx).log(`ℹ️ 任务 ${targetId} 此前已完成收集落盘，无需重复消费。`);
    }
    return;
  }

  resolveCommandOutput(ctx).log('用法: /agents [show <id> | cancel <id> | collect <id>]');
};
