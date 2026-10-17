import type { CanonicalMessage, ToolResultBlock } from '@kiturone/kapibala';
import { sanitizeUntrustedOutput } from '../ui/text-safety.js';
import {
  formatToolDetail,
  formatToolInvocation,
  sanitizeToolName,
} from '../ui/tool-presentation.js';
import type { ViewBlock, ViewMessage, ViewTool } from '../view-model/index.js';

interface MatchedResult {
  block: ToolResultBlock;
  messageId?: string;
}

/** canonical ID 优先；旧消息按源序号补展示身份，同正文不合并，不伪造 Core ID。 */
export function displayMessageId(message: CanonicalMessage, index: number, scope: string): string {
  return JSON.stringify([scope, 'message', message.id ?? null, message.id ? null : index]);
}

/** 块身份依附原消息与原内容序号，剥离私有块后也不重新编号。 */
export function displayBlockId(messageId: string, index: number): string {
  return JSON.stringify([messageId, 'block', index]);
}

/**
 * 只从原始 getHistory() 的公开字段重建展示；不使用压缩上下文、不重放任何工具。
 * 工具结果按历史顺序匹配最近尚未闭合的调用，合入调用卡片，兼容逆序结束与后续复用 ID。
 * 未配对结果保留为可检查卡片；历史中缺结果的调用标中断，不恢复为仍在执行。
 */
export function projectHistory(history: readonly CanonicalMessage[], scope: string): ViewMessage[] {
  const waiting = new Map<string, string>();
  const results = new Map<string, MatchedResult>();
  const pairedResults = new Set<string>();
  for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
    const message = history[messageIndex];
    const id = displayMessageId(message, messageIndex, scope);
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex];
      const key = displayBlockId(id, blockIndex);
      if (block.type === 'tool_use') waiting.set(block.id, key);
      else if (block.type === 'tool_result') {
        const use = waiting.get(block.toolUseId);
        if (!use) continue;
        waiting.delete(block.toolUseId);
        results.set(use, { block, messageId: message.id });
        pairedResults.add(key);
      }
    }
  }

  const projected: ViewMessage[] = [];
  for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
    const message = history[messageIndex];
    const id = displayMessageId(message, messageIndex, scope);
    const blocks: ViewBlock[] = [];
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex];
      const blockId = displayBlockId(id, blockIndex);
      if (block.type === 'text' || block.type === 'thinking') {
        blocks.push({
          id: blockId,
          kind: block.type,
          state:
            message.state === 'draft' ||
            message.state === 'failed' ||
            message.state === 'interrupted'
              ? 'interrupted'
              : 'completed',
          revision: 0,
          text: sanitizeUntrustedOutput(block.type === 'text' ? block.text : block.thinking),
        });
      } else if (block.type === 'tool_use') {
        const result = results.get(blockId);
        const tool: ViewTool = {
          callId: block.id,
          name: sanitizeToolName(block.name),
          invocation: sanitizeUntrustedOutput(formatToolInvocation(block.name, block.input)),
          input: sanitizeUntrustedOutput(formatToolDetail(block.input)),
          status: result ? (result.block.isError ? 'failed' : 'succeeded') : 'interrupted',
          ...(result
            ? {
                result: sanitizeUntrustedOutput(formatToolDetail(result.block.content)),
                durationMs: result.block.durationMs,
                resultMessageId: result.messageId,
              }
            : {}),
        };
        blocks.push({
          id: blockId,
          kind: 'tool',
          text: tool.invocation,
          state: result ? 'completed' : 'interrupted',
          revision: 0,
          tool,
        });
      } else if (block.type === 'tool_result' && !pairedResults.has(blockId)) {
        const tool: ViewTool = {
          callId: block.toolUseId,
          name: 'unknown',
          invocation: '工具结果',
          input: '',
          status: block.isError ? 'failed' : 'succeeded',
          result: sanitizeUntrustedOutput(formatToolDetail(block.content)),
          durationMs: block.durationMs,
          resultMessageId: message.id,
        };
        blocks.push({
          id: blockId,
          kind: 'tool',
          text: '工具结果',
          state: 'completed',
          revision: 0,
          tool,
        });
      }
      // provider_state、redacted_thinking、签名与协议元数据不进入白名单。
    }
    if (blocks.length)
      projected.push({
        id,
        role: message.role,
        persisted: true,
        blocks,
        state:
          message.state === 'draft' || message.state === 'failed' || message.state === 'interrupted'
            ? 'interrupted'
            : 'completed',
      });
  }
  return projected;
}
