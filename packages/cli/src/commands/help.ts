import { COMMAND_CATALOG } from './catalog.js';
import type { CommandHandler } from './dispatcher.js';

/**
 * 输出命令用法。挂载 dispatcher 时以实际注册的定义为准（含别名与状态门提示），
 * 否则回退到静态目录；按名称或别名查询单个命令时未命中即抛错。
 */
export const helpCommand: CommandHandler = (args, ctx) => {
  if (ctx.dispatcher) {
    const definitions = args[0]
      ? [ctx.dispatcher.getDefinition(args[0])]
      : ctx.dispatcher.getDefinitions();
    if (definitions.some((d) => !d)) throw new Error('未找到该命令');
    for (const definition of definitions) {
      if (!definition) continue;
      console.log(`${definition.usage} — ${definition.description}`);
      if (definition.aliases?.length)
        console.log(`  兼容别名: ${definition.aliases.map((alias) => `/${alias}`).join(', ')}`);
      console.log(
        `  状态: ${definition.mutates([]) || definition.mutates(['value']) ? '变更需空闲，查询读取快照' : '只读或退出等待清理'}`,
      );
    }
    return;
  }
  const definitions = args[0]
    ? COMMAND_CATALOG.filter(
        (definition) => definition.name === args[0] || definition.aliases?.includes(args[0]),
      )
    : COMMAND_CATALOG;
  if (!definitions.length) throw new Error('未找到该命令');
  for (const definition of definitions)
    console.log(`${definition.usage} — ${definition.description}`);
};
