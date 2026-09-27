import { createHash } from 'node:crypto';
import type { CanonicalMessage, ToolResultBlock } from '../types/index.js';
export { createMessageId } from '../types/identity.js';

/** 按来源及原始位置生成旧消息身份；复制输入，不改变调用者持有的正文或已有身份。 */
export function identifyHistory(
  messages: readonly CanonicalMessage[],
  source: string,
): CanonicalMessage[] {
  return messages.map((message, position) => ({
    ...structuredClone(message),
    id:
      message.id ??
      `legacy-${createHash('sha256')
        .update(`${source}\0${position}\0${JSON.stringify(message)}`)
        .digest('hex')}`,
  }));
}

export interface HistoryRepair {
  assistantId: string;
  toolCallId: string;
  result: ToolResultBlock;
}

export interface NormalizedHistory {
  messages: CanonicalMessage[];
  /** 与 messages 同序的原始消息 ID 集合；修复结果关联原始 assistant。 */
  sources: string[][];
  repairs: HistoryRepair[];
  diagnostics: string[];
}

/**
 * 构造合法且独立的请求视图：只接受紧邻事务的结果，缺失结果标为未知；重复调用身份明确失败。
 * 合并仅适用于纯文本的同角色消息，失败正文不重放，所有来源均可追踪。
 */
export function normalizeHistory(input: readonly CanonicalMessage[]): NormalizedHistory {
  const result: NormalizedHistory = { messages: [], sources: [], repairs: [], diagnostics: [] };
  const messages = identifyHistory(input, 'unmanaged');
  const calls = new Set<string>();
  const push = (message: CanonicalMessage, sources: string[]) => {
    const last = result.messages.at(-1);
    const pure = (m: CanonicalMessage) => m.content.every((b) => b.type === 'text');
    if (
      last &&
      !last.contextSummary &&
      !message.contextSummary &&
      last.role === message.role &&
      ['user', 'assistant'].includes(message.role) &&
      pure(last) &&
      pure(message)
    ) {
      last.content.push(...message.content);
      result.sources.at(-1)!.push(...sources);
    } else {
      result.messages.push(message);
      result.sources.push(sources);
    }
  };
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'tool') {
      result.diagnostics.push(`Ignored orphan or late tool result: ${message.id}`);
      continue;
    }
    if (message.state && message.state !== 'completed') continue;
    if (
      message.role === 'assistant' &&
      !message.content.some((b) => b.type !== 'text' || b.text.trim())
    )
      continue;
    const toolCalls = message.content.filter((b) => b.type === 'tool_use');
    for (const call of toolCalls) {
      if (calls.has(call.id)) throw new Error(`Duplicate tool call ID: ${call.id}`);
      calls.add(call.id);
    }
    push(message, [message.id!]);
    if (!toolCalls.length) continue;
    const pending = new Set(toolCalls.map((c) => c.id));
    const content: ToolResultBlock[] = [];
    const sources: string[] = [];
    let firstResult: CanonicalMessage | undefined;
    while (messages[i + 1]?.role === 'tool') {
      const tool = messages[++i];
      firstResult ??= tool;
      for (const block of tool.content) {
        if (block.type === 'tool_result' && pending.delete(block.toolUseId)) {
          content.push(block);
          if (!sources.includes(tool.id!)) sources.push(tool.id!);
        } else result.diagnostics.push(`Ignored duplicate or orphan tool result: ${tool.id}`);
      }
    }
    for (const id of pending) {
      const repair: ToolResultBlock = {
        type: 'tool_result',
        toolUseId: id,
        content: 'Tool execution was interrupted or crashed in previous session',
        isError: true,
        errorCode: 'OUTCOME_UNKNOWN',
        retryPolicy: 'after_user_action',
      };
      content.push(repair);
      result.repairs.push({
        assistantId: message.id!,
        toolCallId: id,
        result: structuredClone(repair),
      });
      if (!sources.includes(message.id!)) sources.push(message.id!);
    }
    push(
      { ...firstResult, id: firstResult?.id ?? `repair-${message.id}`, role: 'tool', content },
      sources,
    );
  }
  return result;
}

export interface InteractionBoundary {
  interactionId: string;
  status: 'completed' | 'failed' | 'interrupted';
  messageIds: string[];
}

export interface InteractionTerminal {
  interactionId: string;
  status: InteractionBoundary['status'];
}

/**
 * 以显式终态为准恢复用户交互；旧历史仅在完整工具事务之后存在非空最终答复时推断成功。
 * 保护最近成功交互及其后的所有交互，没有成功证据时保护全部历史。
 */
export function indexInteractions(
  input: readonly CanonicalMessage[],
  terminals: readonly InteractionTerminal[] = [],
): {
  interactions: InteractionBoundary[];
  protectedMessageIds: string[];
} {
  const messages = identifyHistory(input, 'unmanaged');
  const interactions: InteractionBoundary[] = [];
  const groups: CanonicalMessage[][] = [];
  for (const message of messages) {
    const current = interactions.at(-1);
    if (
      !current ||
      (message.role === 'user' &&
        (!message.interactionId || message.interactionId !== current.interactionId))
    ) {
      interactions.push({
        interactionId: message.interactionId ?? message.id!,
        status: 'interrupted',
        messageIds: [],
      });
      groups.push([]);
    }
    interactions.at(-1)!.messageIds.push(message.id!);
    groups.at(-1)!.push(message);
  }
  for (let i = 0; i < interactions.length; i++) {
    const boundary = interactions[i];
    const terminal = [...terminals]
      .reverse()
      .find((t) => t.interactionId === boundary.interactionId);
    if (terminal) {
      boundary.status = terminal.status;
      continue;
    }
    const group = groups[i];
    const last = group.at(-1)!;
    const normalized = normalizeHistory(group);
    if (
      last.role === 'assistant' &&
      (!last.state || last.state === 'completed') &&
      last.content.every(
        (b) => b.type === 'text' || b.type === 'thinking' || b.type === 'redacted_thinking',
      ) &&
      last.content.some((b) => b.type === 'text' && b.text.trim()) &&
      !normalized.repairs.length
    )
      boundary.status = 'completed';
  }
  const successIndex = interactions.map((i) => i.status).lastIndexOf('completed');
  return {
    interactions,
    protectedMessageIds: interactions.slice(Math.max(0, successIndex)).flatMap((i) => i.messageIds),
  };
}
