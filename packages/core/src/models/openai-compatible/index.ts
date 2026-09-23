import { ModelError } from '../../errors/index.js';
import type {
  CanonicalMessage,
  ContentBlock,
  ModelEvent,
  ModelRequest,
  ToolDefinition,
  ToolResultBlock,
  Usage,
} from '../../types/index.js';
import type { ModelProvider } from '../index.js';
import { parseSSEStream } from './sse.js';

export interface OpenAIProviderOptions {
  baseURL: string;
  apiKey: string;
  modelName: string;
  supportsThinking?: boolean;
  /** 建立 HTTP 连接(收到响应头)的超时毫秒数；仅约束建连阶段，不限制流式读取总时长 */
  connectTimeoutMs?: number;
}

const DEFAULT_CONNECT_TIMEOUT_MS = 60_000;

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
  tool_call_id?: string;
  tool_calls?: WireToolCall[];
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name = 'openai-compatible';
  readonly baseURL: string;
  readonly apiKey: string;
  readonly modelName: string;
  readonly supportsThinking: boolean;
  readonly connectTimeoutMs: number;

  constructor(options: OpenAIProviderOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.modelName = options.modelName;
    this.supportsThinking = options.supportsThinking ?? false;
    this.connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  }

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
      stream_options: { include_usage: true },
      temperature: req.temperature ?? 0.7,
    };

    if (wireTools) {
      payload.tools = wireTools;
    }
    if (req.maxTokens) {
      payload.max_tokens = req.maxTokens;
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
          });
        }
        throw new ModelError(`Failed to connect to ${url}: ${(err as Error).message}`);
      } finally {
        // 只停止建连计时；外层 signal 的联动必须保留到响应流消费结束。
        clearTimeout(timeoutTimer);
      }

      if (!response.ok) {
        const errorText = await response.text();
        let errorMsg = `API request failed with status ${response.status}: ${response.statusText}`;
        try {
          const errorJson = JSON.parse(errorText);
          if (errorJson.error?.message) {
            errorMsg = errorJson.error.message;
          }
        } catch {
          if (errorText) errorMsg += ` - ${errorText.slice(0, 300)}`;
        }
        throw new ModelError(errorMsg, { status: response.status });
      }

      if (!response.body) {
        throw new ModelError('Response body is null');
      }

      // 状态机收集分片 tool_calls
      const pendingToolCalls = new Map<
        number,
        { id: string; name: string; argumentChunks: string[] }
      >();
      let usage: Usage | undefined;
      const requestStartTime = Date.now();
      let ttftMs: number | undefined;

      for await (const chunk of parseSSEStream(response.body)) {
        if (req.signal?.aborted) return;
        if (!chunk) continue;

        let json: any;
        try {
          json = JSON.parse(chunk);
        } catch {
          continue;
        }

        if (json.error) {
          const message =
            typeof json.error.message === 'string' ? json.error.message : 'Model API stream error';
          const details = [json.error.type, json.error.code]
            .filter((value) => typeof value === 'string' && value.length > 0)
            .join(', ');
          throw new ModelError(details ? `${message} (${details})` : message);
        }

        if (json.usage) {
          usage = {
            promptTokens: json.usage.prompt_tokens ?? 0,
            completionTokens: json.usage.completion_tokens ?? 0,
            totalTokens: json.usage.total_tokens ?? 0,
          };
        }

        const choice = json.choices?.[0];
        if (!choice) continue;

        const delta = choice.delta;
        if (!delta) continue;

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
            const index = tc.index ?? 0;
            let entry = pendingToolCalls.get(index);
            if (!entry) {
              entry = {
                id: tc.id ?? `call_${Date.now()}_${index}`,
                name: tc.function?.name ?? '',
                argumentChunks: [],
              };
              pendingToolCalls.set(index, entry);
              yield { type: 'tool_call_start', id: entry.id, name: entry.name };
            }

            if (tc.function?.name && !entry.name) {
              entry.name = tc.function.name;
            }

            if (tc.function?.arguments) {
              entry.argumentChunks.push(tc.function.arguments);
              yield {
                type: 'tool_call_delta',
                id: entry.id,
                argumentChunk: tc.function.arguments,
              };
            }
          }
        }
      }

      // 触发所有已收集完整的 tool_calls
      for (const [, tc] of pendingToolCalls.entries()) {
        const fullArgs = tc.argumentChunks.join('');
        let parsedInput: Record<string, unknown> = {};
        let parseError: boolean | undefined;
        try {
          parsedInput = fullArgs.trim() ? JSON.parse(fullArgs) : {};
        } catch {
          // 解析失败不静默吞掉：input 退化为 _raw 并显式标记，工具端报错时可定位根因
          parsedInput = { _raw: fullArgs };
          parseError = true;
        }

        yield {
          type: 'tool_call_finish',
          id: tc.id,
          name: tc.name,
          input: parsedInput,
          parseError,
        };
      }

      const durationMs = Date.now() - requestStartTime;
      yield { type: 'message_stop', usage, ttftMs, durationMs };
    } finally {
      req.signal?.removeEventListener('abort', onOuterAbort);
    }
  }

  assembleToolResults(results: ToolResultBlock[]): CanonicalMessage[] {
    return results.map((r) => ({
      role: 'tool' as const,
      content: [r],
      timestamp: Date.now(),
    }));
  }

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
          content: text || null,
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
