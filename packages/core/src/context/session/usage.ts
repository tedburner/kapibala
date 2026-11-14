import type { ModelProfile } from '../../models/index.js';
import { resolveContextWindow } from '../../models/router.js';
import type { ContextUsage, Usage } from '../../types/index.js';

/** 记账结果：recorded 表示已累加；duplicate 表示重复 attempt 幂等跳过；unknown 表示消耗不可信。 */
export type UsageAccountOutcome = 'recorded' | 'duplicate' | 'unknown';

/**
 * 以模型 attempt 身份幂等累加真实主任务消耗。
 *
 * 保证：同一 attemptId 只累加一次；usage 缺失或含非法数值时返回 unknown 且
 * 不进入已记账集合（后续同 attempt 重放仍会再次尝试），由调用方把会话标记为
 * 消耗未知，不把旧消耗伪装成精确零。
 */
export function recordUsage(
  attemptId: string,
  usage: Usage | undefined,
  accountedAttempts: Set<string>,
  usageStats: Usage,
): UsageAccountOutcome {
  if (accountedAttempts.has(attemptId)) return 'duplicate';
  if (
    !usage ||
    ![usage.promptTokens, usage.completionTokens, usage.totalTokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    return 'unknown';
  accountedAttempts.add(attemptId);
  usageStats.promptTokens += usage.promptTokens;
  usageStats.completionTokens += usage.completionTokens;
  usageStats.totalTokens += usage.totalTokens;
  return 'recorded';
}

/**
 * 摘要实际消耗按 attempt 身份独立累加；缺失消耗保留未知，不计入主任务指标。
 *
 * 保证：与 recordUsage 同一幂等与非法值语义，但写入独立的摘要统计桶，
 * 摘要消耗不得混入主任务 usageStats。
 */
export function recordSummaryUsage(
  attemptId: string,
  usage: Usage | undefined,
  summaryAttempts: Set<string>,
  summaryUsage: Usage,
): UsageAccountOutcome {
  if (summaryAttempts.has(attemptId)) return 'duplicate';
  if (
    !usage ||
    ![usage.promptTokens, usage.completionTokens, usage.totalTokens].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    )
  )
    return 'unknown';
  summaryAttempts.add(attemptId);
  summaryUsage.promptTokens += usage.promptTokens;
  summaryUsage.completionTokens += usage.completionTokens;
  summaryUsage.totalTokens += usage.totalTokens;
  return 'recorded';
}

/**
 * 计算最近一次内部模型请求的上下文占用；无 usage 时显式标注预算估算。
 *
 * 保证：run 累计 promptTokens 会重复计算每一步都重发的历史，调用方必须传入
 * 最近单次请求的实测（或估算）值而非 run 累计值；窗口上限来自 profile 声明，
 * 未经 resolveContextWindow 归一化前不得直接使用。
 */
export function computeContextUsage(
  profile: ModelProfile,
  usedTokens?: number,
  estimatedUsage = false,
): ContextUsage {
  const contextWindow = resolveContextWindow(profile.contextWindow);
  return {
    usedTokens,
    limitTokens: contextWindow.tokens,
    percent: usedTokens === undefined ? undefined : (usedTokens / contextWindow.tokens) * 100,
    estimatedLimit: contextWindow.estimated,
    ...(estimatedUsage ? { estimatedUsage: true } : {}),
  };
}
