import { sanitizeSessionTitle } from '@kiturone/kapibala';
import type { CommandContext, CommandHandler } from './dispatcher.js';

function controller(ctx: CommandContext) {
  if (!ctx.controller) throw new Error('当前宿主未提供受管历史会话');
  return ctx.controller;
}

/** 按项目分页列出缓存元数据，不切换、重放工具或改变最近活动时间。 */
export const historyCommand: CommandHandler = async (args, ctx) => {
  const active = controller(ctx);
  const page = await active.manager.list(args[0] ? Number(args[0]) : 1);
  console.log(`历史会话 ${page.page}/${page.pages}（${page.total} 项，每页 20 项）`);
  for (const item of page.items)
    console.log(
      `${item.conversationId === active.session.conversationId ? '*' : ' '} ${item.conversationId} | ${new Date(item.lastActivityAt).toISOString()} | ${item.messageCount} 条 | ${sanitizeSessionTitle(item.title)}`,
    );
  if (!page.items.length) console.log('本页没有历史会话。');
};

/** 新建会话保留旧文件；/clear 在受管 CLI 使用同一实现，SDK reset 独立保留清空语义。 */
export const newCommand: CommandHandler = async (_args, ctx) => {
  await controller(ctx).newSession();
  console.log(`已新建会话: ${ctx.session.conversationId}`);
};

/** 标题完整尾部交由 Core 转义与有界保存，不把命令文本送入模型。 */
export const renameCommand: CommandHandler = async (args, ctx) => {
  const active = controller(ctx);
  await active.manager.rename(active.session.conversationId, args[0]);
  console.log(`会话标题已更新: ${sanitizeSessionTitle(args[0])}`);
};

/** 指定 ID 恢复或共享输入选择；非 TTY 只展示列表与用法，不等待菜单。 */
export const resumeCommand: CommandHandler = async (args, ctx) => {
  const active = controller(ctx);
  let id = args[0];
  if (!id) {
    if (!process.stdin.isTTY || !process.stdout.isTTY || !ctx.select) {
      await historyCommand([], ctx);
      console.log('使用 /resume <id> 续答，支持唯一 ID 前缀。');
      return;
    }
    let pageNumber = 1;
    while (!id) {
      const page = await active.manager.list(pageNumber);
      const options = page.items.map((item) => ({
        label: sanitizeSessionTitle(item.title, 80),
        value: item.conversationId,
        description: `${item.conversationId} | ${item.messageCount} 条 | ${new Date(item.lastActivityAt).toISOString()}`,
        badge: item.conversationId === active.session.conversationId ? '当前' : undefined,
      }));
      if (pageNumber > 1)
        options.push({ label: '上一页', value: '__previous', description: '', badge: undefined });
      if (pageNumber < page.pages)
        options.push({ label: '下一页', value: '__next', description: '', badge: undefined });
      const choice = await ctx.select({
        message: `恢复历史会话 ${pageNumber}/${page.pages}`,
        options,
      });
      if (!choice) return;
      if (choice === '__previous') pageNumber--;
      else if (choice === '__next') pageNumber++;
      else id = choice;
    }
  }
  await active.resume(id);
  const drift = active.handle.branchDrift;
  if (drift)
    console.log(
      `环境分支提示: 创建于 ${sanitizeSessionTitle(drift.createdBranch ?? '非分支状态')}，当前 ${sanitizeSessionTitle(drift.currentBranch ?? '非分支状态')}；工作目录保持本次启动目录。`,
    );
  const preview = ctx.session
    .getHistory()
    .filter((m) => m.role === 'user')
    .at(-1)
    ?.content.filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join(' ');
  console.log(
    `已恢复会话: ${ctx.session.conversationId}（${ctx.session.getHistory().length} 条消息）`,
  );
  if (preview) console.log(`最近输入: ${sanitizeSessionTitle(preview, 120)}`);
};
