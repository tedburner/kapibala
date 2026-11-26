import type { ViewMessage, ViewUsage } from '@kiturone/kapibala-host/view-model';

/**
 * 累加同一 `assistant-turn` 视觉回合内多步模型请求的 Token 消耗（与宿主层 `managed-session` 的 `runUsage` 口径严格一致）。
 *
 * 前置约束与边界：
 * - 本地会话多步工具调用中每条中间 assistant 消息携带该步模型请求的独立 `usage`，不能只取最后一步导致漏算中间消耗；
 * - 任一步缺失 `usage` 时仅累加已提供项，若整轮均无有效计数则返回 `undefined` 不渲染空标签；
 * - 所有计数钳制在 `Number.MAX_SAFE_INTEGER` 以内防溢出。
 */
export function aggregateTurnUsage(
  messages: readonly Pick<ViewMessage, 'usage'>[],
): ViewUsage | undefined {
  let promptTokens = 0;
  let completionTokens = 0;
  let totalTokens = 0;
  let found = false;

  for (const msg of messages) {
    if (!msg.usage) continue;
    found = true;
    promptTokens = Math.min(Number.MAX_SAFE_INTEGER, promptTokens + msg.usage.promptTokens);
    completionTokens = Math.min(
      Number.MAX_SAFE_INTEGER,
      completionTokens + msg.usage.completionTokens,
    );
    totalTokens = Math.min(Number.MAX_SAFE_INTEGER, totalTokens + msg.usage.totalTokens);
  }

  return found ? { promptTokens, completionTokens, totalTokens } : undefined;
}
