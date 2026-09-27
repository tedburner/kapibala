import { persistDefaultModel } from '../default-model.js';
import { runSetupWizard } from '../wizard.js';
import type { CommandHandler } from './dispatcher.js';

export const settingsCommand: CommandHandler = async (args, ctx) => {
  const sub = args[0];

  if (sub === 'setup') {
    if (!ctx.question || !ctx.readSecret || !process.stdin.isTTY)
      throw new Error('配置向导需要交互终端');
    const { profile } = await runSetupWizard({
      question: ctx.question,
      secretReader: ctx.readSecret,
    });
    ctx.onModelSwitched(profile.id);
    return;
  }

  if (sub === 'default' && args[1]) {
    const defaultId = args[1];
    const found = ctx.settings.profiles.find((p) => p.id === defaultId);
    if (!found) {
      console.log(`未找到模型 Profile '${defaultId}'。`);
      return;
    }
    persistDefaultModel(found, ctx.settings);
    console.log(`✔ 已将 '${found.name}' 设为全局默认模型。`);
    return;
  }

  console.log('\n=== 系统设置 ===');
  console.log(`生效配置文件: ${ctx.settingsPath ?? '未加载文件 (使用默认内置)'}`);
  console.log(`默认启动模型: ${ctx.settings.defaultModel}`);
  console.log(`已配置模型数: ${ctx.settings.profiles.length}`);
  if (ctx.settings.modelRouting) {
    console.log('场景路由（本版运行 default/summary，其余为后续配置）:');
    if (ctx.settings.modelRouting.planning)
      console.log(`  - 规划场景 (planning): ${ctx.settings.modelRouting.planning}`);
    if (ctx.settings.modelRouting.execution)
      console.log(`  - 执行场景 (execution): ${ctx.settings.modelRouting.execution}`);
    if (ctx.settings.modelRouting.summary)
      console.log(`  - 总结场景 (summary): ${ctx.settings.modelRouting.summary}`);
  }
  console.log('\n提示: 可使用 /settings setup 唤起向导重置设置。\n');
};
