import type { CanonicalMessage, SessionEvent } from '../../types/index.js';
import { createMessageId } from '../history.js';
import type { MessageStore } from '../store/index.js';

/**
 * 将已完成的 assistant 消息落盘；无 usage 的消息把会话标记为消耗未知。
 *
 * 保证：store 缺省时零动作（纯内存会话）；落盘顺序与调用方历史追加顺序一致，
 * 不在此函数内部改动历史，避免与调用方的事务状态机产生双重写入。
 */
export async function persistAssistantMessage(
  event: Extract<SessionEvent, { type: 'message_stop' }>,
  store: MessageStore | undefined,
  markUnknownUsage: () => void,
): Promise<void> {
  if (store) await store.append(event.message);
  if (!event.usage) markUnknownUsage();
}

/**
 * 将一批 tool 消息逐条落盘；store 缺省时为零成本空操作。
 *
 * 保证按数组顺序逐条 append，与 MessageStore 的消息级落盘契约一致；
 * 任一条失败即抛出，由调用方的事务回滚路径处理，不静默吞错。
 */
export async function persistToolMessages(
  messages: readonly CanonicalMessage[],
  store: MessageStore | undefined,
): Promise<void> {
  if (!store) return;
  for (const message of messages) await store.append(message);
}

/**
 * 为中断的 assistant 消息构造 OUTCOME_UNKNOWN 的闭合 tool 消息。
 *
 * 保证：仅为每个 tool_use 生成一条 error 结果，保持历史闭合不变量；
 * 不在此函数内部追加历史——调用方决定入史时机，函数保持纯构造语义。
 */
export function buildInterruptedToolMessage(
  assistantEvent: Extract<SessionEvent, { type: 'message_stop' }>,
): CanonicalMessage {
  return {
    id: createMessageId(),
    role: 'tool',
    content: assistantEvent.message.content
      .filter((block) => block.type === 'tool_use')
      .map((toolUse) => ({
        type: 'tool_result' as const,
        toolUseId: toolUse.id,
        content: JSON.stringify({
          code: 'OUTCOME_UNKNOWN',
          retryPolicy: 'after_user_action',
          message: 'Tool execution was interrupted; outcome is unknown',
        }),
        isError: true,
        errorCode: 'OUTCOME_UNKNOWN',
        retryPolicy: 'after_user_action' as const,
      })),
    timestamp: Date.now(),
  };
}

/**
 * 收集历史中紧跟该 assistant 的连续 tool 消息；仅当覆盖全部 tool_use 时视为已闭合。
 *
 * 保证：以消息对象同一性定位 assistant，找不到时返回空数组；存在未闭合的
 * tool_use（缺结果）时返回空数组，让调用方走 OUTCOME_UNKNOWN 补闭合路径。
 */
export function findClosedToolMessages(
  history: readonly CanonicalMessage[],
  assistantEvent: Extract<SessionEvent, { type: 'message_stop' }>,
): CanonicalMessage[] {
  const assistantIndex = history.lastIndexOf(assistantEvent.message);
  if (assistantIndex < 0) return [];

  const expected = new Set(
    assistantEvent.message.content
      .filter((block) => block.type === 'tool_use')
      .map((toolUse) => toolUse.id),
  );
  const messages: CanonicalMessage[] = [];
  for (let index = assistantIndex + 1; index < history.length; index++) {
    const message = history[index]!;
    if (message.role !== 'tool') break;
    messages.push(message);
    for (const block of message.content) {
      if (block.type === 'tool_result') expected.delete(block.toolUseId);
    }
  }
  return expected.size === 0 ? messages : [];
}
