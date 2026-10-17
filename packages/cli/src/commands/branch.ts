import { resolveCommandOutput } from '../host/command-output.js';
/**
 * @fileoverview 分支创建、切换与查看命令（/branch）。
 *
 * 约束、边界与为什么：
 * 1. 事务闭合保护：
 *    历史若处于未闭合的工具事务（半事务），调用 createBranch 或 selectBranch
 *    将被 Core 拦截并抛出 UNCLOSED_TOOL_TRANSACTION_FORK，命令层友好提示用户，
 *    绝对拒绝半事务分叉破坏历史闭合不变量。
 * 2. 状态原子切换：
 *    分支切换持久化写入 branch_selected 事件确认后，才重载当前活动投影，
 *    失败时不移动游标、不损坏当前投影。
 */

import { KapibalaError, sanitizeSessionTitle } from '@kiturone/kapibala';
import type { CommandContext, CommandHandler } from './dispatcher.js';

function getController(ctx: CommandContext) {
  if (!ctx.controller) throw new Error('当前宿主未提供受管历史会话');
  return ctx.controller;
}

/**
 * 分支管理命令处理器。
 * 支持：
 * - `/branch`：查看所有分支与当前活动分支；
 * - `/branch switch <branchId>`：切换至已有分支；
 * - `/branch create <recordId> [name]` 或 `/branch <recordId> [name]`：在指定记录处创建并切换新分支。
 */
export const branchCommand: CommandHandler = async (args, ctx) => {
  const active = getController(ctx);
  const store = active.handle.store;

  // 1. 无参：列出当前会话的所有分支
  if (args.length === 0) {
    if (typeof store.getBranches !== 'function') {
      resolveCommandOutput(ctx).log('当前会话存储格式不支持持久分支操作。');
      return;
    }
    const branches = await store.getBranches();
    const activeBranchId = store.getActiveBranchId?.() ?? 'main';
    resolveCommandOutput(ctx).log(`会话分支列表（共 ${branches.length} 个分支）:`);
    for (const b of branches) {
      const isCurrent = b.branchId === activeBranchId;
      const marker = isCurrent ? '*' : ' ';
      const created = new Date(b.createdAt).toISOString();
      resolveCommandOutput(ctx).log(
        `${marker} ${b.branchId} | 消息数: ${b.messageCount} | 叶子记录: ${b.leafRecordId} | 创建时间: ${created}`,
      );
    }
    return;
  }

  // 2. 切换分支: /branch switch <branchId>
  if (args[0] === 'switch') {
    const targetBranchId = args[1]?.trim();
    if (!targetBranchId) {
      resolveCommandOutput(ctx).log('用法: /branch switch <branchId>');
      return;
    }
    try {
      if (typeof store.selectBranch !== 'function') {
        throw new Error('当前存储不支持分支切换');
      }
      await store.selectBranch(targetBranchId);
      // 切换成功后通过 reloadCurrent 重新加载内存因果投影
      await active.reloadCurrent();
      resolveCommandOutput(ctx).log(`已成功切换至分支: ${targetBranchId}`);
    } catch (error) {
      if (error instanceof KapibalaError && error.code === 'UNCLOSED_TOOL_TRANSACTION_FORK') {
        resolveCommandOutput(ctx).error(
          '❌ 当前历史存在未闭合的工具事务（半事务），禁止切换分支。请等待工具调用完成。',
        );
        return;
      }
      throw error;
    }
    return;
  }

  // 3. 创建分支: /branch create <recordId> [name] 或 /branch <recordId> [name]
  const isExplicitCreate = args[0] === 'create';
  const recordId = (isExplicitCreate ? args[1] : args[0])?.trim();
  const branchName = (isExplicitCreate ? args[2] : args[1])?.trim();

  if (!recordId) {
    resolveCommandOutput(ctx).log('用法: /branch [recordId [name]] | /branch switch <branchId>');
    return;
  }

  try {
    if (typeof store.createBranch !== 'function') {
      throw new Error('当前存储不支持创建分支');
    }
    const targetBranchId =
      branchName && /^[a-zA-Z0-9_-]+$/.test(branchName)
        ? branchName
        : `branch-${Date.now().toString(36)}`;
    await store.createBranch(targetBranchId, recordId);
    // 自动切换到新创建的分支
    if (typeof store.selectBranch === 'function') {
      await store.selectBranch(targetBranchId);
    }
    await active.reloadCurrent();
    const nameDesc = branchName ? ` (${sanitizeSessionTitle(branchName)})` : '';
    resolveCommandOutput(ctx).log(
      `已成功在记录 ${recordId} 处创建并切换至新分支: ${targetBranchId}${nameDesc}`,
    );
  } catch (error) {
    if (error instanceof KapibalaError && error.code === 'UNCLOSED_TOOL_TRANSACTION_FORK') {
      resolveCommandOutput(ctx).error(
        '❌ 当前历史存在未闭合的工具事务（半事务），禁止创建分支。请等待工具调用完成。',
      );
      return;
    }
    throw error;
  }
};
