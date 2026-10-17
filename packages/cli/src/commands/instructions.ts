import { resolveCommandOutput } from '../host/command-output.js';
import type { CommandHandler } from './dispatcher.js';

/** 列出当前会话生效的项目指令来源；无来源时明确输出「无」。只读诊断。 */
export const instructionsCommand: CommandHandler = (_args, ctx) => {
  const sources = ctx.session.getInstructionSources();
  resolveCommandOutput(ctx).log('当前项目指令来源:');
  if (sources.length === 0) resolveCommandOutput(ctx).log('  无');
  else for (const source of sources) resolveCommandOutput(ctx).log(`  ${source}`);
  resolveCommandOutput(ctx).log('项目指令不改变工具注册、权限模式或审批规则。');
};
