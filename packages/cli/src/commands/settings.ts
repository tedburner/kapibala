import { saveGlobalSettings } from '../settings.js';
import { runSetupWizard } from '../wizard.js';
import type { CommandHandler } from './dispatcher.js';

export const settingsCommand: CommandHandler = async (args, ctx) => {
  const sub = args[0];

  if (sub === 'setup') {
    const { profile } = await runSetupWizard();
    ctx.onModelSwitched(profile.id);
    return;
  }

  if (sub === 'default' && args[1]) {
    const defaultId = args[1];
    const found = ctx.settings.profiles.find((p) => p.id === defaultId);
    if (!found) {
      console.log(`\x1b[31m未找到模型 Profile '${defaultId}'。\x1b[0m`);
      return;
    }
    ctx.settings.defaultModel = defaultId;
    saveGlobalSettings(ctx.settings);
    console.log(`\x1b[32m✔ 已将 '${found.name}' 设为全局默认模型。\x1b[0m`);
    return;
  }

  console.log('\n\x1b[36m=== 系统设置 ===\x1b[0m');
  console.log(`生效配置文件: ${ctx.settingsPath ?? '未加载文件 (使用默认内置)'}`);
  console.log(`默认启动模型: \x1b[32m${ctx.settings.defaultModel}\x1b[0m`);
  console.log(`已配置模型数: ${ctx.settings.profiles.length}`);
  if (ctx.settings.modelRouting) {
    console.log('场景路由规划:');
    if (ctx.settings.modelRouting.planning)
      console.log(`  - 规划场景 (planning): ${ctx.settings.modelRouting.planning}`);
    if (ctx.settings.modelRouting.execution)
      console.log(`  - 执行场景 (execution): ${ctx.settings.modelRouting.execution}`);
    if (ctx.settings.modelRouting.summary)
      console.log(`  - 总结场景 (summary): ${ctx.settings.modelRouting.summary}`);
  }
  console.log('\n提示: 可使用 \x1b[36m/settings setup\x1b[0m 唤起向导重置设置。\n');
};
