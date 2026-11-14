import { ModelError } from '../../errors/index.js';
import type { CanonicalMessage, ToolUseBlock } from '../../types/index.js';

/**
 * 工具调用整批校验：名称、参数、ID 合法且不与历史重复；任一失败则整批不执行。
 *
 * 保证 fail-closed：与历史 tool_use 重复的 ID、空白名称、非对象参数都抛出
 * MODEL_INVALID_RESPONSE，调用方不得对部分合法的批次降级执行——避免同一
 * tool_use 身份被两次执行或结果无法闭合。
 */
export function assertToolCallsExecutable(
  history: readonly CanonicalMessage[],
  toolCalls: readonly ToolUseBlock[],
): void {
  const knownCalls = new Set(
    history.flatMap((message) =>
      message.content.filter((block) => block.type === 'tool_use').map((block) => block.id),
    ),
  );
  for (const call of toolCalls) {
    if (
      !call.name?.trim() ||
      !call.input ||
      typeof call.input !== 'object' ||
      Array.isArray(call.input)
    )
      throw new ModelError('Invalid tool call arguments or name; no tools executed', {
        code: 'MODEL_INVALID_RESPONSE',
        stage: 'stream',
        retryable: false,
      });
    if (!call.id?.trim() || knownCalls.has(call.id))
      throw new ModelError('Duplicate tool call ID; no tools executed');
    knownCalls.add(call.id);
  }
}
