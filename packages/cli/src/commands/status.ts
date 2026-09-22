import { formatContextUsage } from '../ui/metrics.js';
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
  console.log(`  - 最近请求上下文:       ${formatContextUsage(stats.contextUsage, ' / ')}`);

  if (stats.lastRunMetrics) {
    const m = stats.lastRunMetrics;
    const ttft = m.ttftMs !== undefined ? `${m.ttftMs}ms` : 'N/A';
    console.log('\n最近一次请求关键性能指标 (Metrics):');
    console.log(`  - 首Token耗时 (TTFT):   ${ttft}`);
    console.log(`  - 模型生成耗时:         ${m.modelDurationMs}ms`);
    console.log(`  - 工具执行耗时:         ${m.toolDurationMs}ms (${m.toolCalls} 次调用)`);
    console.log(`  - 请求总耗时:           ${m.totalDurationMs}ms (${m.turns} 个内部步骤)`);
    console.log(`  - 请求状态:             ${m.status}\n`);
  } else {
    console.log('');
  }
};
