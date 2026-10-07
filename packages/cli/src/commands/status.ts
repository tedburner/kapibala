import { createDefaultLogSinks } from '@kiturone/kapibala';
import { formatContextUsage } from '../ui/metrics.js';
import type { CommandHandler } from './dispatcher.js';

/** 会话概况只读展示；管道不包含 ANSI，历史缺失 usage 明确标记未知。 */
export const statusCommand: CommandHandler = (_args, ctx) => {
  const stats = ctx.session.getStats();
  const snapshot = stats.contextSnapshot;
  console.log('\n=== 会话状态统计 ===');
  console.log(`会话: ${stats.conversationId ?? ctx.session.conversationId ?? '未提供'}`);
  if (ctx.controller) console.log(`标题: ${ctx.controller.handle.metadata?.title ?? '缓存未知'}`);
  console.log(`活跃模型: ${stats.activeModel}`);
  console.log(`主任务角色: ${ctx.session.getModelRole?.() ?? 'default'}`);
  console.log(`交互轮次: ${stats.totalTurns} | 工具数: ${stats.loadedToolsCount}`);
  console.log(`权限模式: ${ctx.session.getMode()}`);
  console.log(`命令环境: ${ctx.session.tools.get('run_command')?.description ?? '已关闭或不可用'}`);
  const sinks = createDefaultLogSinks();
  console.log(`运行日志: ${sinks.operationSink.directory}`);
  console.log(`审批审计: ${sinks.auditSink.directory} (${sinks.auditSink.getUsageBytes()} bytes)`);
  console.log(
    `主任务消耗: prompt ${stats.totalTokens.promptTokens} / completion ${stats.totalTokens.completionTokens} / total ${stats.totalTokens.totalTokens}${stats.usageKnown === false ? '（历史消耗不完整，未知部分未计入）' : ''}`,
  );
  const summary = stats.summaryUsage;
  console.log(
    `摘要消耗: ${summary?.totalTokens ?? '未知'}${stats.summaryUsageKnown === false ? '（有未知部分）' : ''}`,
  );
  console.log(`最近请求上下文: ${formatContextUsage(stats.contextUsage, ' / ')}`);
  console.log(
    `有效检查点: ${snapshot?.checkpointId ?? '无'} | 摘要成功: ${snapshot?.summaryCount ?? 0} | 剪裁结果: ${snapshot?.prunedResults ?? 0}`,
  );
  console.log(
    `自动摘要: ${snapshot?.automaticSummaryPaused ? '已暂停' : '可用'} | 快照: ${snapshot?.stale ? '过期或动态内容未知' : snapshot ? '最近最终请求' : '未知'}`,
  );
  if (stats.lastRunMetrics) {
    const metric = stats.lastRunMetrics;
    console.log(
      `最近任务: ${metric.status} | ${metric.totalDurationMs}ms | TTFT ${metric.ttftMs ?? '未知'} | ${metric.turns} 步 / ${metric.toolCalls} 次工具`,
    );
  }
};
