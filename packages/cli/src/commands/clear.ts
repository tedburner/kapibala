import type { CommandHandler } from './dispatcher.js';

/**
 * 原地清空当前会话：重置历史、上下文与用量计数，不新建也不切换会话。
 * 注意与目录里 `/new`（别名 clear）区分——后者由控制器新建会话并保留旧历史文件。
 */
export const clearCommand: CommandHandler = async (_args, ctx) => {
  await ctx.session.reset();
  console.log('\x1b[32m✔ 会话上下文已清空，开启全新对话。\x1b[0m');
};
