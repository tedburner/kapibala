import type { CommandHandler } from './dispatcher.js';

export const instructionsCommand: CommandHandler = (_args, ctx) => {
  const sources = ctx.session.getInstructionSources();
  console.log('当前项目指令来源:');
  if (sources.length === 0) console.log('  无');
  else for (const source of sources) console.log(`  ${source}`);
  console.log('项目指令不改变工具注册、权限模式或审批规则。');
};
