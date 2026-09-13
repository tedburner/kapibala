/**
 * Canonical Message & Event Types for Kapibala
 */

export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock;

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface CanonicalMessage {
  role: MessageRole;
  content: ContentBlock[];
  timestamp?: number;
}

export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result';
}

export function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === 'thinking';
}

export interface TurnMetrics {
  turn: number;
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  ttftMs?: number; // 首 token 耗时 Time To First Token
  modelDurationMs: number;
  toolDurationMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  toolCallsCount: number;
}

export type StepLogStage =
  | 'model_request_start'
  | 'first_token'
  | 'model_stream_finish'
  | 'tool_execution_start'
  | 'tool_execution_finish'
  | 'turn_finish';

export interface StepLogEntry {
  timestamp: number;
  turn: number;
  stage: StepLogStage;
  message: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

// 统一事件流 SessionEvent
export type SessionEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'step_log'; log: StepLogEntry }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_finish'; id: string; name: string; result: string; isError: boolean }
  /**
   * 工具结果已完成 canonical 装配并写入历史。
   * 消费方(SessionStore)据此落盘 —— 见设计文档 §4.4「tool:after 落一条 tool_result message」。
   * 该事件在熔断/中断判定之前派发，保证任何终止路径下历史结构都合法(§4.3)。
   */
  | { type: 'tool_messages'; messages: CanonicalMessage[] }
  | {
      type: 'message_stop';
      message: CanonicalMessage;
      usage?: Usage;
      ttftMs?: number;
      durationMs?: number;
    }
  | { type: 'turn_finish'; turn: number; usage?: Usage; metrics: TurnMetrics }
  | { type: 'error'; error: Error };

// 底层 Provider 吐出的原始事件流
export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argumentChunk: string }
  | { type: 'tool_call_finish'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'message_stop'; usage?: Usage; ttftMs?: number; durationMs?: number };

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

export interface ModelRequest {
  systemPrompt?: string;
  messages: CanonicalMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
}
