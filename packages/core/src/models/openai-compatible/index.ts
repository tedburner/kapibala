import { ContextOverflowError, ModelError } from '../../errors/index.js';
import type {
  CanonicalMessage,
  ModelEvent,
  ModelRequest,
  ToolResultBlock,
  Usage,
} from '../../types/index.js';
import { type ModelProvider, assembleCanonicalToolResults } from '../index.js';
import type { ChatCapabilities } from '../router.js';
import { isContextOverflow, parseToolArguments, safeTransportCode } from '../transport/http.js';
import { parseSSEFrames } from '../transport/sse.js';

/** Chat 端点配置；能力覆盖只改变请求字段和完成边界，不改变协议身份。 */
export interface OpenAIProviderOptions {
  baseURL: string;
  apiKey: string;
  modelName: string;
  supportsThinking?: boolean;
  /** 回传 assistant 思考历史；默认仅为 DeepSeek 官方端点启用，自建兼容网关可显式开启。 */
  replayReasoningContent?: boolean;
  /** 显式端点能力；缺省保留 max_tokens、usage 和 temperature 请求基线，要求 DONE。 */
  chatCapabilities?: ChatCapabilities;
  /** 建立 HTTP 连接(收到响应头)的超时毫秒数；仅约束建连阶段，不限制流式读取总时长 */
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

/** 协议结构错误统一失败；不回显原始参数或私有响应内容。 */
function invalidResponse(message: string): ModelError {
  return new ModelError(message, {
    code: 'MODEL_INVALID_RESPONSE',
    stage: 'stream',
    retryable: false,
  });
}

interface WireToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  reasoning_content?: string;
  tool_call_id?: string;
  tool_calls?: WireToolCall[];
}

/** 将 canonical 历史投影为 Chat 请求，在完整终态和全部工具验证后交付可执行结果。 */
export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';
  readonly baseURL: string;
  readonly apiKey: string;
  /** 未提供凭据时由 Session 在记录用户消息前拒绝请求。 */
  get credentialsReady(): boolean {
    return Boolean(this.apiKey.trim());
  }
  readonly modelName: string;
  readonly supportsThinking: boolean;
  readonly replayReasoningContent: boolean;
  readonly connectTimeoutMs: number;
  readonly chatCapabilities: Readonly<ChatCapabilities>;

  /** 暴露实际请求目标供原子绑定校验，不包含凭据。 */
  get binding() {
    return {
      protocol: 'openai-compatible' as const,
      baseURL: this.baseURL,
      modelName: this.modelName,
    };
  }

  /**
   * 初始化 Chat 协议适配；显式端点能力优先，思考回传独立于模型 supportsThinking 标签。
   * @param options 请求目标、凭据和能力配置；缺省只有 DeepSeek 官方端点回传可见思考。
   */
  constructor(options: OpenAIProviderOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.modelName = options.modelName;
    this.supportsThinking = options.supportsThinking ?? false;
    this.chatCapabilities = Object.freeze({ ...options.chatCapabilities });
    this.replayReasoningContent =
      this.chatCapabilities.replayReasoningContent ??
      options.replayReasoningContent ??
      new URL(this.baseURL).hostname === 'api.deepseek.com';
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

  /**
   * 发送 Chat 流式请求；默认同时要求合法 finish_reason 和 DONE，只有显式例外允许完整 EOF。
   * 全部工具的 ID、名称和对象参数在任何完成事件之前校验；截断、过滤或中断不交付工具。
   * @param req canonical 历史、工具、预算与取消信号；能力覆盖来自端点配置。
   * @returns 文本、可见思考和工具增量，完整响应最后产生 message_stop。
   * @throws ModelError 响应缺少合法终态、工具身份或完整对象参数时失败，不自动重放请求。
   */
  async *create(req: ModelRequest): AsyncIterable<ModelEvent> {
    const url = `${this.baseURL}/chat/completions`;
    const wireMessages = this.translateMessagesToWire(req.messages, req.systemPrompt);

    const wireTools =
      req.tools && req.tools.length > 0
        ? req.tools.map((t) => ({
            type: 'function' as const,
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters,
            },
          }))
        : undefined;

    const payload: Record<string, unknown> = {
      model: this.modelName,
      messages: wireMessages,
      stream: true,
    };
    if (this.chatCapabilities.supportsStreamingUsage !== false)
      payload.stream_options = { include_usage: true };
    if (this.chatCapabilities.supportsTemperature !== false)
      payload.temperature = req.temperature ?? 0.7;

    if (wireTools) {
      payload.tools = wireTools;
    }
    if (req.maxTokens) {
      payload[this.chatCapabilities.maxTokensField ?? 'max_tokens'] = req.maxTokens;
    }

    let response: Response;
    // 建连超时护栏：服务端无响应时不能永久挂起(流式读取阶段不受此限制)。
    // 手动组合外层 signal 与超时 signal，避免依赖 Node 20.3+ 的 AbortSignal.any。
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(), this.connectTimeoutMs);
    const onOuterAbort = () => timeoutController.abort();
    if (req.signal?.aborted) {
      timeoutController.abort();
    } else {
      req.signal?.addEventListener('abort', onOuterAbort, { once: true });
    }

    try {
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: timeoutController.signal,
        });
      } catch (err: unknown) {
        if (req.signal?.aborted) {
          throw err;
        }
        if (timeoutController.signal.aborted) {
          throw new ModelError(`Connection to ${url} timed out after ${this.connectTimeoutMs}ms`, {
            status: 408,
            retryable: true,
            stage: 'connect',
          });
        }
        throw new ModelError(`Failed to connect to ${url}: ${(err as Error).message}`, {
          transportCode: safeTransportCode(err),
          stage: 'connect',
        });
      } finally {
        // 只停止建连计时；外层 signal 的联动必须保留到响应流消费结束。
        clearTimeout(timeoutTimer);
      }

      if (!response.ok) {
        const errorText = await response.text();
        let errorDetails: unknown;
        let errorMsg = `API request failed with status ${response.status}: ${response.statusText}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorDetails = errorJson.error;
          if (typeof errorJson.error?.message === 'string') {
            errorMsg = errorJson.error.message;
          }
        } catch {
          if (errorText) errorMsg += ` - ${errorText.slice(0, 300)}`;
        }
        const details = errorDetails as { code?: unknown; type?: unknown } | undefined;
        const options = {
          status: response.status,
          providerCode: typeof details?.code === 'string' ? details.code : undefined,
          providerType: typeof details?.type === 'string' ? details.type : undefined,
          stage: 'response' as const,
        };
        if ([400, 413, 422].includes(response.status) && isContextOverflow(errorDetails))
          throw new ContextOverflowError(response.status, { ...options, message: errorMsg });
        throw new ModelError(errorMsg, options);
      }

      if (!response.body) {
        throw new ModelError('Response body is null', {
          code: 'MODEL_INVALID_RESPONSE',
          stage: 'response',
        });
      }

      // 状态机收集分片 tool_calls
      const pendingToolCalls = new Map<
        number,
        {
          id: string;
          name: string;
          argumentChunks: string[];
          emittedChunks: number;
          started: boolean;
        }
      >();
      let usage: Usage | undefined;
      let finishReason: string | undefined;
      let streamDone = false;
      const requestStartTime = Date.now();
      let ttftMs: number | undefined;

      for await (const frame of parseSSEFrames(response.body)) {
        if (req.signal?.aborted) return;
        const chunk = frame.data;
        if (chunk.trim() === '[DONE]') {
          streamDone = true;
          break;
        }
        if (!chunk) continue;

        let json: any;
        try {
          json = JSON.parse(chunk);
        } catch {
          throw new ModelError('Model response contained invalid JSON', {
            code: 'MODEL_INVALID_RESPONSE',
            stage: 'stream',
            retryable: false,
          });
        }
        if (!json || typeof json !== 'object' || Array.isArray(json))
          throw new ModelError('Model response contained an invalid event', {
            code: 'MODEL_INVALID_RESPONSE',
            stage: 'stream',
            retryable: false,
          });

        const wireError = json.error ?? (frame.event === 'error' ? json : undefined);
        if (wireError) {
          const message =
            typeof wireError.message === 'string' ? wireError.message : 'Model API stream error';
          const details = [wireError.type, wireError.code]
            .filter((value) => typeof value === 'string' && value.length > 0)
            .join(', ');
          const options = {
            providerCode: typeof wireError.code === 'string' ? wireError.code : undefined,
            providerType: typeof wireError.type === 'string' ? wireError.type : undefined,
            stage: 'stream' as const,
          };
          if (isContextOverflow(wireError))
            throw new ContextOverflowError(undefined, { ...options, message });
          throw new ModelError(details ? `${message} (${details})` : message, options);
        }

        if (json.usage) {
          usage = {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens: json.usage.total_tokens ?? 0,
          };
          const cached =
            json.usage.prompt_tokens_details?.cached_tokens ?? json.usage.prompt_cache_hit_tokens;
          if (Number.isSafeInteger(cached) && cached >= 0) usage.cachedPromptTokens = cached;
        }

        const choice = json.choices?.[0];
        if (!choice) continue;
        if (finishReason !== undefined)
          throw invalidResponse('Model response contained a choice after its terminal state');
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (typeof choice.finish_reason !== 'string')
            throw invalidResponse('Model response contained an invalid finish reason');
          finishReason = choice.finish_reason;
        }

        const delta = choice.delta;
        if (!delta) continue;
        if (typeof delta !== 'object' || Array.isArray(delta))
          throw invalidResponse('Model response contained an invalid delta');
        if (delta.function_call)
          throw invalidResponse('Model response used an unsupported legacy function call');
        for (const field of ['content', 'reasoning_content'])
          if (delta[field] != null && typeof delta[field] !== 'string')
            throw invalidResponse('Model response contained an invalid text delta');
        if (delta.tool_calls != null && !Array.isArray(delta.tool_calls))
          throw invalidResponse('Model response contained invalid tool calls');

        if (
          (delta.content ||
            delta.reasoning_content ||
            (delta.tool_calls && delta.tool_calls.length > 0)) &&
          ttftMs === undefined
        ) {
          ttftMs = Date.now() - requestStartTime;
        }

        // 1. 普通文本增量
        if (delta.content) {
          yield { type: 'text_delta', text: delta.content };
        }

        // 2. 深度思考增量 (DeepSeek reasoning_content)
        if (delta.reasoning_content) {
          yield { type: 'thinking_delta', thinking: delta.reasoning_content };
        }

        // 3. 工具调用增量
        if (delta.tool_calls && Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            if (!tc || typeof tc !== 'object' || !Number.isSafeInteger(tc.index) || tc.index < 0)
              throw invalidResponse('Model response contained an invalid tool index');
            if (tc.type != null && tc.type !== 'function')
              throw invalidResponse('Model response contained an unsupported tool type');
            const index = tc.index;
            let entry = pendingToolCalls.get(index);
            if (!entry) {
              entry = {
                id: '',
                name: '',
                argumentChunks: [],
                emittedChunks: 0,
                started: false,
              };
              pendingToolCalls.set(index, entry);
            }
            for (const [field, value] of [
              ['id', tc.id],
              ['name', tc.function?.name],
            ] as const) {
              if (value === undefined || value === null) continue;
              if (
                typeof value !== 'string' ||
                !value.trim() ||
                (entry[field] && entry[field] !== value)
              )
                throw invalidResponse(
                  'Model response contained an invalid or changed tool identity',
                );
              entry[field] = value;
            }
            if (tc.function?.arguments !== undefined) {
              if (typeof tc.function.arguments !== 'string')
                throw invalidResponse('Model response contained an invalid tool argument delta');
              if (tc.function.arguments) entry.argumentChunks.push(tc.function.arguments);
            }
            if (entry.id && entry.name && !entry.started) {
              entry.started = true;
              yield { type: 'tool_call_start', id: entry.id, name: entry.name };
            }
            while (entry.started && entry.emittedChunks < entry.argumentChunks.length) {
              yield {
                type: 'tool_call_delta',
                id: entry.id,
                argumentChunk: entry.argumentChunks[entry.emittedChunks++],
              };
            }
          }
        }
      }

      if (req.signal?.aborted) return;
      if (
        finishReason === undefined ||
        (!streamDone && this.chatCapabilities.requiresDone !== false)
      )
        throw new ModelError('Model response stream ended without a completion marker', {
          retryable: false,
          code: 'MODEL_STREAM_INCOMPLETE',
          stage: 'stream',
        });

      if (finishReason !== 'stop' && finishReason !== 'tool_calls' && finishReason !== 'length')
        throw invalidResponse('Model response contained an unsupported or filtered finish reason');
      // 截断语义与 Anthropic/Responses 一致：length 由 Loop 统一裁决——
      // 无工具的截断文本按最终回答交付，有工具的整批拒绝执行；本层不做提前收口。
      if (pendingToolCalls.size > 0 && !['tool_calls', 'length'].includes(finishReason))
        throw invalidResponse('Model response finish reason did not match its tool calls');
      if (pendingToolCalls.size === 0 && finishReason === 'tool_calls')
        throw invalidResponse('Model response finish reason did not match its tool calls');

      // 先验证整批工具，避免较早的合法调用在较晚的坏调用之前成为可执行结果。
      const ids = new Set<string>();
      const completedTools = [...pendingToolCalls.values()].map((tc) => {
        if (!tc.id || !tc.name || ids.has(tc.id))
          throw invalidResponse('Model response contained missing or duplicate tool identities');
        ids.add(tc.id);
        return {
          type: 'tool_call_finish',
          id: tc.id,
          name: tc.name,
          input: parseToolArguments(tc.argumentChunks.join('')),
        } as const;
      });
      for (const tool of completedTools) yield tool;

      const durationMs = Date.now() - requestStartTime;
      yield { type: 'message_stop', usage, ttftMs, durationMs, finishReason };
    } catch (error) {
      if (error instanceof ModelError || req.signal?.aborted) throw error;
      const transportCode = safeTransportCode(error);
      throw new ModelError(
        `Model response stream failed${transportCode ? ` (${transportCode})` : ''}`,
        {
          retryable: false,
          code: 'MODEL_STREAM_INTERRUPTED',
          transportCode,
          stage: 'stream',
        },
      );
    } finally {
      req.signal?.removeEventListener('abort', onOuterAbort);
      timeoutController.abort();
    }
  }

  /**
   * 将工具结果装配为 canonical tool 消息，wire 角色仅在下一请求投影时转换。
   * @param results 已完成的工具结果，保持调用 ID 与内容，不重放工具。
   * @returns 逐条克隆的 canonical tool 消息，允许消息级落盘。
   */
  assembleToolResults(results: ToolResultBlock[]): CanonicalMessage[] {
    return assembleCanonicalToolResults(results);
  }

  /**
   * 将历史投影为 Chat 消息；合并连续 user，剔除空 assistant，保持工具调用与结果身份。
   * 仅显式允许的端点回传可见思考；签名、脱敏思考和原生私有 Item 不适用于 Chat。
   * @param messages canonical 历史；只投影文本、可选可见思考和工具语义。
   * @param systemPrompt 可选全局提示词，去除首尾空白后作为首条 system。
   * @returns 与输入历史独立的 Chat wire 消息数组。
   */
  private translateMessagesToWire(
    messages: CanonicalMessage[],
    systemPrompt?: string,
  ): WireMessage[] {
    const wire: WireMessage[] = [];

    if (systemPrompt?.trim()) {
      wire.push({ role: 'system', content: systemPrompt.trim() });
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        const text = msg.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        if (text) wire.push({ role: 'system', content: text });
      } else if (msg.role === 'user') {
        const text = msg.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        const previous = wire[wire.length - 1];
        if (previous?.role === 'user' && typeof previous.content === 'string') {
          previous.content = [previous.content, text].filter(Boolean).join('\n\n');
        } else {
          wire.push({ role: 'user', content: text });
        }
      } else if (msg.role === 'assistant') {
        const text = msg.content
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('\n');

        const toolCalls: WireToolCall[] = [];
        for (const block of msg.content) {
          if (block.type === 'tool_use') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: {
                name: block.name,
                arguments: JSON.stringify(block.input),
              },
            });
          }
        }

        // 失败轮次或中断可能留下空 assistant；不要把它发给要求严格消息序列的端点。
        if (!text && toolCalls.length === 0) continue;

        wire.push({
          role: 'assistant',
          content: text || (this.replayReasoningContent ? '' : null),
          ...(this.replayReasoningContent
            ? {
                reasoning_content: msg.content
                  .filter((block) => block.type === 'thinking')
                  .map((block) => block.thinking)
                  .join(''),
              }
            : {}),
          tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        });
      } else if (msg.role === 'tool') {
        for (const block of msg.content) {
          if (block.type === 'tool_result') {
            wire.push({
              role: 'tool',
              tool_call_id: block.toolUseId,
              content: block.content,
            });
          }
        }
      }
    }

    return wire;
  }
}
