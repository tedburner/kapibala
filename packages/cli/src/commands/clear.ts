import type { CommandHandler } from './dispatcher.js';

export const clearCommand: CommandHandler = async (_args, ctx) => {
  await ctx.session.reset();
  console.log('\x1b[32m✔ 会话上下文已清空，开启全新对话。\x1b[0m');
};
