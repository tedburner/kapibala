import { resolveCommandOutput } from '../host/command-output.js';
import { sanitizeToolName } from '../ui/tool-presentation.js';
import type { CommandHandler } from './dispatcher.js';

/** 解析一个技能名和原始任务；只消费一个分隔空白，保留任务的引号、其余空格与换行。 */
export function parseSkillTask(tail: string): { name: string; task: string } | undefined {
  const match = tail.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)(\s)([\s\S]*)$/);
  if (!match || match[1].length > 64 || !match[3].trim()) return undefined;
  return { name: match[1], task: match[3] };
}

/** 只读当前集合、覆盖诊断和活动状态；禁用技能仍可检查，不触发正文读取或运行。 */
export const skillsCommand: CommandHandler = (args, ctx) => {
  const snapshot = ctx.session.getSkills(args[0] ?? '');
  resolveCommandOutput(ctx).log('当前技能:');
  if (!snapshot.skills.length) resolveCommandOutput(ctx).log('  无匹配技能');
  for (const skill of snapshot.skills) {
    const active = snapshot.activations.find((item) => item.definition.name === skill.name);
    resolveCommandOutput(ctx).log(
      `  ${sanitizeToolName(skill.name)} [${skill.scope}] 用户:${skill.userInvocable ? '可用' : '禁用'} 模型:${skill.modelInvocable ? '可用' : '禁用'}${active ? ` 活动:${active.state}` : ''}`,
    );
    resolveCommandOutput(ctx).log(`    ${sanitizeToolName(skill.description)}`);
    resolveCommandOutput(ctx).log(
      `    来源: ${sanitizeToolName(skill.filePath)}${skill.available && !skill.disabled ? '' : ` · 不可用: ${sanitizeToolName(skill.unavailableReason ?? '已禁用')}`}`,
    );
  }
  resolveCommandOutput(ctx).log(`模型目录遗漏: ${snapshot.catalog.omitted}`);
  for (const diagnostic of snapshot.diagnostics)
    resolveCommandOutput(ctx).log(
      `  [${sanitizeToolName(diagnostic.code)}] ${sanitizeToolName(diagnostic.path)} · ${sanitizeToolName(diagnostic.message)}`,
    );
};

/** 仅将合法名称与原始任务交给宿主受管运行；命令本身不读取文件、不扩大权限。 */
export const skillCommand: CommandHandler = async (args, ctx) => {
  const parsed = parseSkillTask(args[0] ?? '');
  if (!parsed) throw new Error('用法: /skill <name> <task...>');
  if (!ctx.runSkill) throw new Error('当前宿主未提供技能执行入口');
  await ctx.runSkill(parsed.name, parsed.task);
};
