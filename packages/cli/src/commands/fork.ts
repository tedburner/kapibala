import { resolveCommandOutput } from '../host/command-output.js';
/**
 * @fileoverview 独立会话导出命令（/fork）。
 *
 * 约束、边界与为什么：
 * 1. 独立会话隔离：
 *    forkSession 从当前有效活动路径导出生成全新独立会话文件，Header 记录来源关联与 forkPointRecordId。
 *    独立导出后，原会话与新会话的历史、状态与后台任务完全解耦隔离。
 * 2. 导出即切换：
 *    成功导出后原子切换至新会话，原会话保留在存储中。
 */

import { sanitizeSessionTitle } from '@kiturone/kapibala';
import type { CommandContext, CommandHandler } from './dispatcher.js';

function getController(ctx: CommandContext) {
  if (!ctx.controller) throw new Error('当前宿主未提供受管历史会话');
  return ctx.controller;
}

/**
 * 导出独立会话命令处理器。
 * 用法: `/fork [title]`
 */
export const forkCommand: CommandHandler = async (args, ctx) => {
  const active = getController(ctx);
  const rawTitle = args[0]?.trim();
  const title = rawTitle && rawTitle.length > 0 ? rawTitle : undefined;

  const currentId = active.session.conversationId;
  const forked = await active.manager.forkSession({ sourceSessionId: currentId });
  if (title) {
    await active.manager.rename(forked.conversationId, title);
  }

  // 切换到新派生的独立会话
  await active.resume(forked.conversationId);

  const titleDesc = title ? `（标题: ${sanitizeSessionTitle(title)}）` : '';
  resolveCommandOutput(ctx).log(
    `已成功从会话 ${currentId} 导出独立新会话: ${forked.conversationId}${titleDesc}`,
  );
};
