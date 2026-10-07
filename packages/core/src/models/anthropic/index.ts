import { createHash } from 'node:crypto';
import { AbortError, ContextOverflowError, ModelError } from '../../errors/index.js';
import type {
  CanonicalMessage,
  ContentBlock,
  ModelEvent,
  ModelRequest,
  ToolResultBlock,
  Usage,
} from '../../types/index.js';
import { type ModelProvider, assembleCanonicalToolResults } from '../index.js';
import { createProtocolOrigin, projectProtocolHistory } from '../protocol-state.js';
import {
  isContextOverflow,
  openModelResponse,
  parseToolArguments,
  parseWireEvent,
  safeTransportCode,
} from '../transport/http.js';
import { parseSSEFrames } from '../transport/sse.js';

/** Messages 原生连接配置；baseURL 包含版本前缀，workspaceId 仅选择请求工作区。 */
export interface AnthropicProviderOptions {
  baseURL: string;
  apiKey: string;
  modelName: string;
  connectTimeoutMs?: number;
  workspaceId?: string;
}

type WireBlock = Record<string, unknown>;
interface WireMessage {
  role: 'user' | 'assistant';
  content: WireBlock[];
}
interface PendingBlock {
  content: ContentBlock;
  argumentText: string;
  blockId: string;
  stopped: boolean;
}

/** 无效协议状态统一脱敏；任何未完成响应都不能成为可执行工具批次。 */
function invalidResponse(): never {
  throw new ModelError('Invalid Anthropic response state', {
    code: 'MODEL_INVALID_RESPONSE',
    stage: 'stream',
    retryable: false,
  });
}

/** 非原生工具 ID 使用稳定别名；调用与结果共用映射，canonical ID 始终保留。 */
function wireToolId(id: string): string {
  if (typeof id !== 'string' || !id)
    throw new ModelError('Invalid tool history identity', {
      code: 'MODEL_INVALID_RESPONSE',
      stage: 'request',
      retryable: false,
    });
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
    ? id
    : `call_${createHash('sha256').update(id).digest('hex').slice(0, 48)}`;
}

/** 独立 Messages 适配器；复用 canonical 工具事务及来源校验，不拥有工具执行权限。 */
export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic';
  readonly baseURL: string;
  readonly modelName: string;
  readonly workspaceId?: string;
  readonly connectTimeoutMs: number;
  private readonly apiKey: string;
  /** 表明该适配器已装载非空凭据，不暴露凭据内容。 */
  get credentialsReady(): boolean {
    return Boolean(this.apiKey.trim());
  }

  /** 暴露不含凭据的请求目标；用于宿主校验 Profile 与 Provider 的原子绑定。 */
  get binding() {
    return {
      protocol: 'anthropic' as const,
      baseURL: this.baseURL,
      modelName: this.modelName,
      workspaceId: this.workspaceId,
    };
  }

  /** 初始化连接；无效 URL/凭据/超时在请求前失败，错误不回显配置值。 */
  constructor(options: AnthropicProviderOptions) {
    try {
      const url = new URL(options.baseURL);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error();
      if (
        !options.modelName?.trim() ||
        !options.apiKey?.trim() ||
        /[\r\n]/.test(options.apiKey) ||
        (options.workspaceId !== undefined &&
          (!options.workspaceId.trim() || /[\r\n]/.test(options.workspaceId))) ||
        (options.connectTimeoutMs !== undefined &&
          (!Number.isSafeInteger(options.connectTimeoutMs) || options.connectTimeoutMs <= 0))
      )
        throw new Error();
    } catch {
      throw new ModelError('Invalid Anthropic connection configuration', {
        code: 'MODEL_INVALID_REQUEST',
        stage: 'request',
        retryable: false,
      });
    }
    this.baseURL = options.baseURL.replace(/\/+$/, '');
    this.modelName = options.modelName;
    this.apiKey = options.apiKey;
    this.workspaceId = options.workspaceId;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 60_000;
  }

  /** 装配统一 tool 历史；Messages 的 user/tool_result 转换只作用于请求视图。 */
  assembleToolResults(results: ToolResultBlock[]): CanonicalMessage[] {
    return assembleCanonicalToolResults(results);
  }

  /**
   * 发送 Messages 流并按索引组装完整内容；增量仅供展示，终态提供有序落盘来源。
   * maxTokens 包含思考消耗，缺省为 4096；缺终态、坏参数与服务端流错误均抛错。
   * pause_turn 表示服务端工具暂停；当前不支持其续答，明确失败而非报告完成或调度客户端工具。
   * 同 run/模型/端点的来源校验允许私有续答；来源不匹配的可见思考降为普通文字。
   * 取消或消费者提前结束会等待 reader 清理并解除 HTTP 取消监听，不自动重发请求。
   */
  async *create(req: ModelRequest): AsyncIterable<ModelEvent> {
    if (req.signal?.aborted) throw new AbortError();
    const payload = this.createPayload(req);
    const origin = createProtocolOrigin(this.binding, req.context);
    const startedAt = Date.now();
    const opened = await openModelResponse({
      protocol: 'anthropic',
      url: `${this.baseURL}/messages`,
      headers: {
        // 官方 API 以 x-api-key 为标准鉴权头，部分网关只识别 Bearer；两者同时发送以覆盖两类端点。
        'x-api-key': this.apiKey,
        Authorization: `Bearer ${this.apiKey}`,
        'anthropic-version': '2023-06-01',
        ...(this.workspaceId ? { 'anthropic-workspace-id': this.workspaceId } : {}),
      },
      payload,
      signal: req.signal,
      connectTimeoutMs: this.connectTimeoutMs,
    });
    const blocks: PendingBlock[] = [];
    const toolIds = new Set<string>();
    let activeIndex: number | undefined;
    let messageId = '';
    let messageStarted = false;
    let messageDeltaStarted = false;
    let messageStopped = false;
    let finishReason: string | undefined;
    let refusal = false;
    let ttftMs: number | undefined;
    const counters: Record<string, number> = {};

    /** usage 为累计值；总输入包含缓存读与创建，缓存命中单独保留且缺失不冒充零。 */
    const updateUsage = (value: unknown) => {
      if (value === undefined) return;
      if (!value || typeof value !== 'object' || Array.isArray(value)) invalidResponse();
      const usage = value as Record<string, unknown>;
      for (const key of [
        'input_tokens',
        'output_tokens',
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
      ]) {
        if (usage[key] === undefined) continue;
        if (
          !Number.isSafeInteger(usage[key]) ||
          (usage[key] as number) < 0 ||
          (counters[key] !== undefined && (usage[key] as number) < counters[key])
        )
          invalidResponse();
        counters[key] = usage[key] as number;
      }
    };

    try {
      for await (const frame of parseSSEFrames(opened.response.body!)) {
        if (req.signal?.aborted) throw new AbortError();
        const value = parseWireEvent(frame.data);
        if (typeof value.type !== 'string' || !value.type) invalidResponse();
        if (frame.event !== 'message' && frame.event !== value.type) invalidResponse();
        if (value.type === 'ping') continue;
        if (value.type === 'error') {
          const detail = value.error;
          const options = {
            stage: 'stream' as const,
            providerCode: typeof detail?.code === 'string' ? detail.code : undefined,
            providerType: typeof detail?.type === 'string' ? detail.type : undefined,
          };
          if (isContextOverflow(detail, 'anthropic'))
            throw new ContextOverflowError(undefined, options);
          throw new ModelError('Anthropic stream failed', options);
        }
        if (value.type === 'message_start') {
          if (
            messageStarted ||
            !value.message ||
            value.message.role !== 'assistant' ||
            typeof value.message.id !== 'string' ||
            !value.message.id ||
            !Array.isArray(value.message.content) ||
            value.message.content.length
          )
            invalidResponse();
          messageStarted = true;
          messageId = value.message.id;
          updateUsage(value.message.usage);
          continue;
        }
        if (!messageStarted || messageStopped) invalidResponse();
        if (value.type === 'content_block_start') {
          if (messageDeltaStarted || activeIndex !== undefined || value.index !== blocks.length)
            invalidResponse();
          const block = value.content_block;
          if (!block || typeof block !== 'object') invalidResponse();
          let content: ContentBlock;
          if (block.type === 'text' && typeof block.text === 'string')
            content = { type: 'text', text: block.text };
          else if (
            block.type === 'thinking' &&
            typeof block.thinking === 'string' &&
            (block.signature === undefined || typeof block.signature === 'string')
          )
            content = {
              type: 'thinking',
              thinking: block.thinking,
              ...(block.signature ? { signature: block.signature } : {}),
              origin,
            };
          else if (
            block.type === 'redacted_thinking' &&
            typeof block.data === 'string' &&
            block.data
          )
            content = { type: 'redacted_thinking', data: block.data, origin };
          else if (
            block.type === 'tool_use' &&
            typeof block.id === 'string' &&
            block.id &&
            typeof block.name === 'string' &&
            /^[A-Za-z0-9_-]{1,64}$/.test(block.name) &&
            block.input &&
            typeof block.input === 'object' &&
            !Array.isArray(block.input)
          ) {
            if (toolIds.has(block.id)) invalidResponse();
            toolIds.add(block.id);
            content = {
              type: 'tool_use',
              id: block.id,
              name: block.name,
              input: structuredClone(block.input),
            };
          } else invalidResponse();
          const blockId = `${messageId}:${value.index}`;
          blocks.push({ content, argumentText: '', blockId, stopped: false });
          activeIndex = value.index;
          ttftMs ??= Date.now() - startedAt;
          if (content.type === 'thinking') {
            yield { type: 'thinking_block_start', blockId };
            if (content.thinking)
              yield { type: 'thinking_delta', thinking: content.thinking, blockId };
          } else if (content.type === 'text' && content.text)
            yield { type: 'text_delta', text: content.text };
          else if (content.type === 'tool_use')
            yield { type: 'tool_call_start', id: content.id, name: content.name };
          continue;
        }
        if (value.type === 'content_block_delta' || value.type === 'content_block_stop') {
          if (
            messageDeltaStarted ||
            !Number.isSafeInteger(value.index) ||
            value.index !== activeIndex
          )
            invalidResponse();
          const entry = blocks[value.index];
          if (!entry || entry.stopped) invalidResponse();
          const content = entry.content;
          if (value.type === 'content_block_stop') {
            if (content.type === 'tool_use') {
              if (entry.argumentText) content.input = parseToolArguments(entry.argumentText);
              yield {
                type: 'tool_call_finish',
                id: content.id,
                name: content.name,
                input: structuredClone(content.input),
              };
            } else if (content.type === 'thinking') {
              if (!content.signature) invalidResponse();
              yield { type: 'thinking_block_stop', blockId: entry.blockId };
            }
            entry.stopped = true;
            activeIndex = undefined;
            continue;
          }
          const change = value.delta;
          if (!change || typeof change !== 'object') invalidResponse();
          if (
            content.type === 'text' &&
            change.type === 'text_delta' &&
            typeof change.text === 'string'
          ) {
            content.text += change.text;
            if (change.text) yield { type: 'text_delta', text: change.text };
          } else if (
            content.type === 'thinking' &&
            change.type === 'thinking_delta' &&
            typeof change.thinking === 'string'
          ) {
            if (content.signature) invalidResponse();
            content.thinking += change.thinking;
            if (change.thinking)
              yield { type: 'thinking_delta', thinking: change.thinking, blockId: entry.blockId };
          } else if (
            content.type === 'thinking' &&
            change.type === 'signature_delta' &&
            typeof change.signature === 'string'
          )
            content.signature = (content.signature ?? '') + change.signature;
          else if (
            content.type === 'tool_use' &&
            change.type === 'input_json_delta' &&
            typeof change.partial_json === 'string'
          ) {
            if (Object.keys(content.input).length) invalidResponse();
            entry.argumentText += change.partial_json;
            if (entry.argumentText.length > 16 * 1024 * 1024) invalidResponse();
            yield { type: 'tool_call_delta', id: content.id, argumentChunk: change.partial_json };
          } else invalidResponse();
          continue;
        }
        if (value.type === 'message_delta') {
          if (activeIndex !== undefined || !value.delta || typeof value.delta !== 'object')
            invalidResponse();
          messageDeltaStarted = true;
          updateUsage(value.usage);
          const reason = value.delta.stop_reason;
          if (reason === undefined || reason === null) continue;
          if (finishReason !== undefined) invalidResponse();
          if (reason === 'end_turn' || reason === 'stop_sequence') finishReason = 'stop';
          else if (reason === 'tool_use') finishReason = 'tool_calls';
          else if (reason === 'max_tokens' || reason === 'model_context_window_exceeded')
            finishReason = 'length';
          else if (reason === 'refusal') {
            finishReason = 'content_filter';
            refusal = true;
          } else if (reason === 'pause_turn') {
            throw new ModelError(
              'Anthropic paused a server-tool turn; continuation is unsupported',
              {
                code: 'MODEL_INVALID_RESPONSE',
                stage: 'stream',
                retryable: false,
                providerCode: 'pause_turn',
              },
            );
          } else
            throw new ModelError('Anthropic returned an unsupported stop_reason', {
              stage: 'stream',
              retryable: false,
              providerCode: typeof reason === 'string' ? reason : undefined,
            });
          continue;
        }
        if (value.type === 'message_stop') {
          if (
            !messageDeltaStarted ||
            !finishReason ||
            activeIndex !== undefined ||
            blocks.some((block) => !block.stopped) ||
            (finishReason === 'tool_calls' && !toolIds.size) ||
            (finishReason === 'stop' && toolIds.size)
          )
            invalidResponse();
          messageStopped = true;
          break;
        }
        // 无业务语义的新增事件可忽略；未知内容块或增量在各分支明确拒绝。
      }
      if (req.signal?.aborted) throw new AbortError();
      if (!messageStopped)
        throw new ModelError('Anthropic stream ended before message_stop', {
          code: 'MODEL_STREAM_INCOMPLETE',
          stage: 'stream',
          retryable: false,
        });
      let usage: Usage | undefined;
      if (counters.input_tokens !== undefined && counters.output_tokens !== undefined) {
        const promptTokens =
          counters.input_tokens +
          (counters.cache_read_input_tokens ?? 0) +
          (counters.cache_creation_input_tokens ?? 0);
        usage = {
          promptTokens,
          completionTokens: counters.output_tokens,
          totalTokens: promptTokens + counters.output_tokens,
          ...(counters.cache_read_input_tokens !== undefined
            ? { cachedPromptTokens: counters.cache_read_input_tokens }
            : {}),
        };
      }
      yield {
        type: 'message_stop',
        finishReason,
        finalContent: blocks.map((block) => block.content),
        ...(usage ? { usage } : {}),
        ...(refusal ? { refusal } : {}),
        ttftMs,
        durationMs: Date.now() - startedAt,
      };
    } catch (error) {
      if (req.signal?.aborted) throw new AbortError();
      if (error instanceof ModelError || error instanceof AbortError) throw error;
      throw new ModelError('Anthropic response stream interrupted', {
        code: 'MODEL_STREAM_INTERRUPTED',
        stage: 'stream',
        transportCode: safeTransportCode(error),
      });
    } finally {
      opened.close();
    }
  }

  /**
   * 投影 system、普通内容与工具结果；连续结果合并为下一 user 内容并置于文字之前。
   * 私有块由共享来源规则筛选，原始消息和工具 ID 不被改写；不发送能力标签推测的思考参数。
   */
  private createPayload(req: ModelRequest): Record<string, unknown> {
    const maxTokens = req.maxTokens ?? 4096;
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0)
      throw new ModelError('Invalid Anthropic output token budget', {
        code: 'MODEL_INVALID_REQUEST',
        stage: 'request',
        retryable: false,
      });
    const messages: WireMessage[] = [];
    const system: string[] = req.systemPrompt ? [req.systemPrompt] : [];
    for (const message of projectProtocolHistory(req.messages, this.binding, req.context)) {
      if (message.role === 'system') {
        for (const block of message.content) if (block.type === 'text') system.push(block.text);
        continue;
      }
      const content: WireBlock[] = [];
      for (const block of message.content) {
        if (block.type === 'text') content.push({ type: 'text', text: block.text });
        else if (block.type === 'tool_use')
          content.push({
            type: 'tool_use',
            id: wireToolId(block.id),
            name: block.name,
            input: block.input,
          });
        else if (block.type === 'tool_result')
          content.push({
            type: 'tool_result',
            tool_use_id: wireToolId(block.toolUseId),
            content: block.content,
            ...(block.isError !== undefined ? { is_error: block.isError } : {}),
          });
        else if (block.type === 'thinking') {
          if (!block.signature)
            throw new ModelError('Invalid Anthropic thinking history', {
              code: 'MODEL_INVALID_RESPONSE',
              stage: 'request',
              retryable: false,
            });
          content.push({ type: 'thinking', thinking: block.thinking, signature: block.signature });
        } else if (block.type === 'redacted_thinking')
          content.push({ type: 'redacted_thinking', data: block.data });
      }
      if (!content.length) continue;
      const role = message.role === 'assistant' ? 'assistant' : 'user';
      const previous = messages.at(-1);
      if (role === 'user' && previous?.role === 'user') {
        const all = [...previous.content, ...content];
        previous.content = [
          ...all.filter((block) => block.type === 'tool_result'),
          ...all.filter((block) => block.type !== 'tool_result'),
        ];
      } else messages.push({ role, content });
    }
    return {
      model: this.modelName,
      messages,
      stream: true,
      max_tokens: maxTokens,
      ...(system.length ? { system: system.join('\n\n') } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.tools?.length
        ? {
            tools: req.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
              input_schema: tool.parameters,
            })),
          }
        : {}),
    };
  }
}
