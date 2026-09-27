import { createContextBudget } from '@kiturone/kapibala';
import type { CommandHandler } from './dispatcher.js';

/** 从已发布快照渲染预算；不执行 Hook 或 Provider，不将未知/过期值伪装为下一请求的精确输入。 */
export const contextCommand: CommandHandler = (_args, ctx) => {
  const snapshot = ctx.session.getContextSnapshot();
  const budget =
    snapshot?.budget ?? createContextBudget(ctx.session.getActiveProfile().contextWindow);
  console.log(
    `上下文 ${snapshot?.modelId ?? ctx.session.getActiveProfile().id} | ${snapshot ? (!snapshot.dynamicKnown ? '静态估算，动态 Hook 未知' : snapshot.stale ? '过期快照' : '最近最终请求快照') : '尚无请求快照'} | 窗口${budget.estimatedWindow ? '保守估算' : '模型配置'}`,
  );
  console.log(
    `窗口 ${budget.contextWindow} | 输出预留 ${budget.outputReserve} | 安全余量 ${budget.safetyReserve}`,
  );
  console.log(
    `输入预算 ${budget.inputBudget} | 触发阈值 ${budget.trigger} | 目标 ${budget.target}`,
  );
  if (!snapshot) {
    console.log('本次动态 Hook 内容和输入占用未知，下一请求准备后刷新。');
    return;
  }
  const e = snapshot.estimate;
  const retained = Math.max(0, e.history - snapshot.summaryTokens);
  console.log(
    `输入 ${e.total}（${e.source === 'calibrated' ? 'usage 校准估算' : '估算'}）| 系统 ${e.system} | 工具 ${e.tools} | 摘要 ${snapshot.summaryTokens} | 保留消息 ${retained} | 协议 ${e.overhead}`,
  );
  if (process.stdout.isTTY) {
    const segments = [
      e.system,
      e.tools,
      snapshot.summaryTokens,
      retained,
      e.overhead,
      Math.max(0, budget.inputBudget - e.total),
    ];
    const colors = [34, 33, 35, 32, 36, 90];
    const bar = segments
      .map(
        (value, i) =>
          `\x1b[${colors[i]}m${'█'.repeat(Math.round(Math.min(value / budget.inputBudget, 1) * 36))}\x1b[0m`,
      )
      .join('');
    console.log(`[${bar}] ${((e.total / budget.inputBudget) * 100).toFixed(1)}%`);
    console.log('比例条: 系统 / 工具 / 摘要 / 保留消息 / 协议 / 可用余量');
  }
  console.log(
    `保护 ${snapshot.protectedMessageIds.length} 条原始消息 | 原始 ${snapshot.rawMessageCount} / 投影 ${snapshot.projectedMessageCount}`,
  );
  console.log(
    `检查点 ${snapshot.checkpointId ?? '无'} | 摘要成功 ${snapshot.summaryCount} | 剪裁结果 ${snapshot.prunedResults} | ${snapshot.persistence}`,
  );
  console.log(
    `自动摘要 ${snapshot.automaticSummaryPaused ? '已暂停' : '可用'} | 连续失败 ${snapshot.consecutiveFailures}`,
  );
  console.log(
    `实测最近 prompt tokens: ${snapshot.actualPromptTokens ?? '未知'} | 缓存 usage: ${snapshot.actualCachedPromptTokens ?? '未知'}`,
  );
};

/** 手动压缩不新增用户消息；无可压缩前缀时零调用并明确提示。 */
export const compactCommand: CommandHandler = async (_args, ctx) => {
  let attempted = false;
  const stream = ctx.controller ? ctx.controller.compact() : ctx.session.compact();
  for await (const event of stream) {
    if (event.type === 'compaction_start') attempted = true;
    if (ctx.renderEvent) ctx.renderEvent(event);
    else if (event.type === 'compaction_finish')
      console.log(`压缩已提交: ${event.beforeTokens} → ${event.afterTokens} (${event.kind})`);
    else if (event.type === 'compaction_failed')
      console.log(`摘要失败，保留最近有效投影: ${event.error}`);
  }
  if (!attempted) console.log('没有可摘要的旧完整交互，当前任务与最近成功交互保持原文。');
};
