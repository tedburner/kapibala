import { persistDefaultModel } from '../default-model.js';
import { resolveCommandOutput } from '../host/command-output.js';
import { runSetupWizard } from '../wizard.js';
import type { CommandHandler } from './dispatcher.js';

/**
 * `/settings`：无参展示生效配置文件、默认模型与场景路由；`setup` 启动配置向导并切换到
 * 新模型；`default <id>` 设置下次启动的默认模型。写回统一走 default-model 的持久化入口。
 */
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
    ctx.onCredentialsUpdated?.(profile.id);
    return;
  }

  if (sub === 'default' && args[1]) {
    const defaultId = args[1];
    const found = ctx.settings.profiles.find((p) => p.id === defaultId);
    if (!found) {
      resolveCommandOutput(ctx).log(`未找到模型 Profile '${defaultId}'。`);
      return;
    }
    persistDefaultModel(found, ctx.settings);
    resolveCommandOutput(ctx).log(`✔ 已将 '${found.name}' 设为全局默认模型。`);
    return;
  }

  resolveCommandOutput(ctx).log('\n=== 系统设置 ===');
  resolveCommandOutput(ctx).log(`生效配置文件: ${ctx.settingsPath ?? '未加载文件 (使用默认内置)'}`);
  resolveCommandOutput(ctx).log(`默认启动模型: ${ctx.settings.defaultModel}`);
  resolveCommandOutput(ctx).log(`已配置模型数: ${ctx.settings.profiles.length}`);
  if (ctx.settings.modelRouting) {
    resolveCommandOutput(ctx).log(
      '场景路由（使用 /model route <role> 显式选择；summary 仅用于摘要）:',
    );
    if (ctx.settings.modelRouting.planning)
      resolveCommandOutput(ctx).log(
        `  - 规划场景 (planning): ${ctx.settings.modelRouting.planning}`,
      );
    if (ctx.settings.modelRouting.execution)
      resolveCommandOutput(ctx).log(
        `  - 执行场景 (execution): ${ctx.settings.modelRouting.execution}`,
      );
    if (ctx.settings.modelRouting.summary)
      resolveCommandOutput(ctx).log(`  - 总结场景 (summary): ${ctx.settings.modelRouting.summary}`);
    if (ctx.settings.modelRouting.fast)
      resolveCommandOutput(ctx).log(`  - 快速问答 (fast): ${ctx.settings.modelRouting.fast}`);
  }
  resolveCommandOutput(ctx).log('\n提示: 可使用 /settings setup 唤起向导重置设置。\n');
};
