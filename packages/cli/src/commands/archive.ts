/**
 * @fileoverview 会话逻辑归档与恢复命令（/archive）。
 *
 * 约束、边界与为什么：
 * 1. 活动会话绝对拒绝归档：
 *    正在使用的会话禁止归档，避免写锁与会话生命周期失配；Core 抛出 SESSION_IN_USE，
 *    CLI 在命令层预先拦截并友好提示。
 * 2. 逻辑可逆恢复：
 *    归档通过追加 archive_state 控制记录实现，历史文件不物理重命名或移动，
 *    restoreSession 追加恢复记录后即可恢复为正常可续答会话。
 */

import { KapibalaError, sanitizeSessionTitle } from '@kiturone/kapibala';
import type { CommandContext, CommandHandler } from './dispatcher.js';

function getController(ctx: CommandContext) {
  if (!ctx.controller) throw new Error('当前宿主未提供受管历史会话');
  return ctx.controller;
}

/**
 * 会话逻辑归档与恢复命令处理器。
 * 支持：
 * - `/archive <id>`：归档指定历史会话；
 * - `/archive list [page]`：查看已归档的会话列表；
 * - `/archive restore <id>`：恢复指定的已归档会话。
 */
export const archiveCommand: CommandHandler = async (args, ctx) => {
  const active = getController(ctx);

  if (args.length === 0) {
    console.log('用法: /archive <id> | /archive list [page] | /archive restore <id>');
    return;
  }

  // 1. 列出已归档会话: /archive list [page]
  if (args[0] === 'list') {
    const pageNum = args[1] ? Number(args[1]) : 1;
    const page = await active.manager.list(pageNum, { includeArchived: true });
    const archivedItems = page.items.filter((item) => item.archived);

    console.log(`已归档会话列表（当前页包含 ${archivedItems.length} 项）:`);
    for (const item of archivedItems) {
      console.log(
        `[归档] ${item.conversationId} | ${new Date(item.lastActivityAt).toISOString()} | ${item.messageCount} 条 | ${sanitizeSessionTitle(item.title)}`,
      );
    }
    if (archivedItems.length === 0) {
      console.log('没有找到已归档的会话。');
    }
    return;
  }

  // 2. 恢复已归档会话: /archive restore <id>
  if (args[0] === 'restore') {
    const targetId = args[1]?.trim();
    if (!targetId) {
      console.log('用法: /archive restore <id>');
      return;
    }
    await active.manager.restoreSession(targetId);
    console.log(`已成功恢复会话 ${targetId}，现在可使用 /resume ${targetId} 继续对话。`);
    return;
  }

  // 3. 归档指定会话: /archive <id>
  const targetId = args[0].trim();
  if (targetId === active.session.conversationId) {
    console.error('❌ 当前会话正在使用中，活动会话禁止归档。请先新建或切换会话后再归档。');
    return;
  }

  try {
    await active.manager.archiveSession(targetId);
    console.log(`已成功归档会话: ${targetId}（后续默认历史列表将自动排除）`);
  } catch (error) {
    if (error instanceof KapibalaError && error.code === 'SESSION_IN_USE') {
      console.error('❌ 该会话正在被其他进程使用，禁止归档。');
      return;
    }
    throw error;
  }
};
