import type { CommandHandler } from './dispatcher.js';

export const statusCommand: CommandHandler = (_args, ctx) => {
  const stats = ctx.session.getStats();
  console.log('\n\x1b[36m=== 会话状态统计 ===\x1b[0m');
  console.log(`活跃模型: \x1b[32m${stats.activeModel}\x1b[0m`);
  console.log(`交互轮次: ${stats.totalTurns}`);
  console.log(`已加载工具数: ${stats.loadedToolsCount}`);
  console.log('Token 消耗统计:');
  console.log(`  - 提示词 (Prompt):     ${stats.totalTokens.promptTokens}`);
  console.log(`  - 输出生成 (Completion): ${stats.totalTokens.completionTokens}`);
  console.log(`  - 总计消耗 (Total):      ${stats.totalTokens.totalTokens}`);

  if (stats.lastMetrics) {
    const m = stats.lastMetrics;
    const ttft = m.ttftMs !== undefined ? `${m.ttftMs}ms` : 'N/A';
    console.log('\n最近一轮关键性能指标 (Metrics):');
    console.log(`  - 首Token耗时 (TTFT):   ${ttft}`);
    console.log(`  - 模型生成耗时:         ${m.modelDurationMs}ms`);
    console.log(`  - 工具执行耗时:         ${m.toolDurationMs}ms (${m.toolCallsCount} 次调用)`);
    console.log(`  - 单轮总耗时:           ${m.totalDurationMs}ms\n`);
  } else {
    console.log('');
  }
};
