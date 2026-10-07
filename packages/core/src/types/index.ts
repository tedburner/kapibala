/**
 * Canonical Message & Event Types for Kapibala
 */

import type { ModelErrorInfo } from '../errors/index.js';

/** 原生协议内容的来源；仅同一次运行、同模型和端点允许回传私有状态。 */
export interface ProtocolOrigin {
  version: 1;
  protocol: 'anthropic' | 'openai-responses';
  modelName: string;
  modelId?: string;
  runId: string;
  endpointScope: string;
}

/** Responses Item 与 canonical 块的对应关系；调用 Item 身份独立于业务 call_id。 */
export interface ProtocolItemMetadata {
  origin: ProtocolOrigin;
  itemIndex: number;
  itemId?: string;
  contentIndex?: number;
  phase?: 'commentary' | 'final_answer';
  contentType?: 'output_text' | 'refusal';
  arguments?: string;
}

/** 只保存受控 reasoning Item；密文不进入展示或摘要源。 */
export interface ProviderStateBlock {
  type: 'provider_state';
  origin: ProtocolOrigin;
  item: {
    type: 'reasoning';
    id: string;
    encrypted_content?: string;
    summary: { type: 'summary_text'; text: string }[];
    status?: 'in_progress' | 'completed' | 'incomplete';
  };
}

/** canonical 历史的内容块联合；provider_state 等私有块只在同 run、同模型与端点续答回传。 */
export type ContentBlock =
  | TextBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ProviderStateBlock;

export interface TextBlock {
  type: 'text';
  text: string;
  /** 源 wire Item 元数据；正文被改写后由调用方清除，不作为业务身份。 */
  protocolMeta?: ProtocolItemMetadata;
}

export interface ToolUseBlock {
  /** 工具执行语义来源；新运行记录，旧历史可缺省。未知插件不按内置只读工具剪裁。 */
  source?: string;
  /** 执行器记录的绝对工具根目录；仅作历史路径依据，不改变参数或恢复旧授权。旧历史可缺省。 */
  executionRoot?: string;
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** 源 wire Item 元数据；内容被改写后由调用方清除，不作为业务身份。 */
  protocolMeta?: ProtocolItemMetadata;
}

export interface ToolResultBlock {
  type: 'tool_result';
  toolUseId: string;
  content: string;
  isError?: boolean;
  /** 单次工具调用总耗时，包含 tool hooks 与实际执行。 */
  durationMs?: number;
  /** 稳定错误类别；旧历史中的该字段可缺省。 */
  errorCode?: string;
  /** 不代表自动重试，只描述调用方应如何处理该错误。 */
  retryPolicy?: 'never' | 'immediate' | 'backoff' | 'after_user_action';
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  /** 存在签名或来源时属于私有输出，改写内容会被整批拒绝。 */
  signature?: string;
  origin?: ProtocolOrigin;
}

/** Provider 提供的密文占位；仅按原样回传用于续答，不进入展示或摘要源。 */
export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data: string;
  origin?: ProtocolOrigin;
}

/** 单次模型请求的 token 用量；由 Provider 上报，缺失的字段不能按零推断。 */
export interface Usage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** Provider 明确提供的缓存命中输入量；缺失表示未知，不能按零推断。 */
  cachedPromptTokens?: number;
}

/** canonical 消息角色；'tool' 仅用于工具结果消息，wire 角色转换只发生在请求投影阶段。 */
export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

/**
 * 协议无关的历史真源；wire 格式只在请求投影时出现。
 * 不变量：assistant 消息中的 tool_use 进入历史后，对应 tool_result 消息必须紧跟其后。
 */
export interface CanonicalMessage {
  /** 派生背景锚点独立于真实用户输入，避免合并后丢失受保护原消息的来源身份。 */
  contextSummary?: { checkpointId: string };
  /** 稳定消息身份；旧 SDK 消息可省略，在进入受管历史时补齐。 */
  id?: string;
  /** 用户交互身份，与内部模型步骤及进程运行实例分别记录。 */
  interactionId?: string;
  /** 未完成正文不会进入模型请求视图。省略表示旧版已落盘正文。 */
  state?: 'completed' | 'draft' | 'failed' | 'interrupted';
  role: MessageRole;
  content: ContentBlock[];
  timestamp?: number;
}

/** 判别并收窄为文本块。 */
export function isTextBlock(block: ContentBlock): block is TextBlock {
  return block.type === 'text';
}

/** 判别并收窄为工具调用块。 */
export function isToolUseBlock(block: ContentBlock): block is ToolUseBlock {
  return block.type === 'tool_use';
}

/** 判别并收窄为工具结果块。 */
export function isToolResultBlock(block: ContentBlock): block is ToolResultBlock {
  return block.type === 'tool_result';
}

/** 判别并收窄为思考块。 */
export function isThinkingBlock(block: ContentBlock): block is ThinkingBlock {
  return block.type === 'thinking';
}

/** 单个 turn 的指标快照；错误与熔断路径也以统一构造产出（工具字段为零），保证结构一致。 */
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

/** 一次完整 run 的累计指标；token 数为各轮请求之和，上下文占用单独见 contextUsage。 */
export interface RunMetrics {
  startTime: number;
  endTime: number;
  totalDurationMs: number;
  modelDurationMs: number;
  toolDurationMs: number;
  ttftMs?: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  turns: number;
  toolCalls: number;
  status: 'completed' | 'failed' | 'aborted';
  /** 模型失败的脱敏汇总；保留具体阶段与原因，不携带请求或响应正文。 */
  failure?: ModelErrorInfo;
  /** 最近一次内部模型请求占用的上下文；不使用 run 累计 promptTokens。 */
  contextUsage?: ContextUsage;
}

/** 供宿主展示的上下文占用快照；估算值不能用于计费或精确预算。 */
export interface ContextUsage {
  usedTokens?: number;
  /** true 表示未收到当前请求 usage，输入占用使用预算估算，不能用于计费。 */
  estimatedUsage?: boolean;
  limitTokens: number;
  percent?: number;
  estimatedLimit: boolean;
}

/** 单 turn 内关键阶段的进度标记；顺序与 AgentLoop 的实际派发时序一致，供展示与诊断。 */
export type StepLogStage =
  | 'model_request_start'
  | 'first_token'
  | 'model_stream_finish'
  | 'tool_execution_start'
  | 'tool_execution_finish'
  | 'turn_finish';

/** 面向宿主的步骤日志；message 可直接展示，结构化数值放在 metadata 中。 */
export interface StepLogEntry {
  timestamp: number;
  turn: number;
  stage: StepLogStage;
  message: string;
  durationMs?: number;
  metadata?: Record<string, unknown>;
}

/**
 * AgentSession 面向宿主输出的统一进程内事件契约。
 *
 * 事件只描述 Agent 语义，不携带终端颜色、组件状态或具体 UI 类型，因此 CLI、TUI、
 * GUI 和 SDK 可以消费同一条事件流。跨进程或网络传输需要由宿主转换为独立的 wire DTO，
 * 不应直接把本类型当作长期兼容的网络协议。
 */
export type SessionEvent =
  | {
      type: 'session_resumed';
      conversationId: string;
      runtimeSessionId: string;
      messageCount: number;
    }
  | { type: 'session_switched'; conversationId: string; previousConversationId: string }
  | {
      type: 'compaction_start';
      conversationId: string;
      runId?: string;
      kind: 'prune' | 'summary';
      reason: 'threshold' | 'manual' | 'overflow';
      persistence: 'disk' | 'memory';
      beforeTokens: number;
    }
  | {
      type: 'compaction_finish';
      conversationId: string;
      runId?: string;
      kind: 'prune' | 'summary';
      reason: 'threshold' | 'manual' | 'overflow';
      persistence: 'disk' | 'memory';
      beforeTokens: number;
      afterTokens: number;
      checkpointId?: string;
      coveredEndMessageId?: string;
      prunedResults?: number;
      modelId?: string;
      durationMs: number;
    }
  | {
      type: 'compaction_failed';
      conversationId: string;
      runId?: string;
      kind: 'prune' | 'summary';
      reason: 'threshold' | 'manual' | 'overflow';
      persistence: 'disk' | 'memory';
      error: string;
      /** 脱敏失败分类，不包含 Provider 响应正文或历史内容。 */
      errorCode?: string;
      /** 摘要模型失败采用与主任务相同的脱敏说明；验证失败不回显摘要正文。 */
      modelError?: ModelErrorInfo;
      consecutiveFailures: number;
    }
  | {
      type: 'context_budget_exceeded';
      conversationId: string;
      runId?: string;
      usedTokens: number;
      inputBudget: number;
    }
  | { type: 'turn_start'; turn: number }
  | { type: 'step_log'; log: StepLogEntry }
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_block_start'; blockId: string }
  | { type: 'thinking_delta'; thinking: string; blockId?: string }
  | { type: 'thinking_block_stop'; blockId: string }
  | { type: 'tool_start'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_progress'; id: string; name: string; elapsedMs: number; outputBytes: number }
  | {
      type: 'tool_finish';
      id: string;
      name: string;
      result: string;
      isError: boolean;
      durationMs?: number;
    }
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
  | { type: 'run_finish'; metrics: RunMetrics }
  | { type: 'error'; error: Error; modelError?: ModelErrorInfo };

// 底层 Provider 吐出的原始事件流
export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_block_start'; blockId: string }
  | { type: 'thinking_delta'; thinking: string; blockId?: string }
  | { type: 'thinking_block_stop'; blockId: string }
  | { type: 'tool_call_start'; id: string; name: string }
  | { type: 'tool_call_delta'; id: string; argumentChunk: string }
  | {
      type: 'tool_call_finish';
      id: string;
      name: string;
      input: Record<string, unknown>;
      /** 参数 JSON 解析失败时置位，input 退化为 { _raw: '<原始字符串>' }，便于上游诊断而非静默吞错 */
      parseError?: boolean;
    }
  | {
      type: 'message_stop';
      usage?: Usage;
      ttftMs?: number;
      durationMs?: number;
      finishReason?: string;
      /** 完整且有序的最终内容；有此字段时增量只供展示，不重复装配或执行工具。 */
      finalContent?: ContentBlock[];
      refusal?: boolean;
    };

/** 投影给模型的工具描述；由注册表条目转换而来，仅暴露名称、描述与参数 Schema。 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

/** 协议无关的模型请求；messages 是 canonical 真源的克隆，wire 翻译只发生在 Provider 内。 */
export interface ModelRequest {
  systemPrompt?: string;
  messages: CanonicalMessage[];
  tools?: ToolDefinition[];
  signal?: AbortSignal;
  /** 以下两项可选覆盖采样温度与单次输出上限；未设置时由适配器按协议与能力决定。 */
  temperature?: number;
  maxTokens?: number;
  /** 宿主提供的本次运行来源；缺省时原生适配器不回传来源未知的私有状态。 */
  context?: { runId: string; modelId?: string };
}

/** runtime 通用请求准备契约；实现可以预算或投影，Loop 不依赖具体上下文管理器。 */
export type RequestPreparation = (
  request: ModelRequest,
  history: readonly CanonicalMessage[],
  reason?: 'threshold' | 'overflow',
) => AsyncGenerator<SessionEvent, ModelRequest>;
