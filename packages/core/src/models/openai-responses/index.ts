import { createHash } from 'node:crypto';
import { normalizeHistory } from '../../context/history.js';
import { ContextOverflowError, ModelError } from '../../errors/index.js';
import type {
  CanonicalMessage,
  ContentBlock,
  ModelEvent,
  ModelRequest,
  ProtocolOrigin,
  ToolResultBlock,
  Usage,
} from '../../types/index.js';
import { type ModelProvider, assembleCanonicalToolResults } from '../index.js';
import {
  createProtocolOrigin,
  projectProtocolHistory,
  validateProtocolContent,
} from '../protocol-state.js';
import {
  isContextOverflow,
  openModelResponse,
  parseToolArguments,
  parseWireEvent,
  safeTransportCode,
} from '../transport/http.js';
import { parseSSEFrames } from '../transport/sse.js';

/** 原生 Responses 的端点、模型及建连配置；输出预算由每次请求指定。 */
export interface OpenAIResponsesProviderOptions {
  baseURL: string;
  apiKey: string;
  modelName: string;
  supportsThinking?: boolean;
  connectTimeoutMs?: number;
}

type WireItem = Record<string, any>;
interface StreamItem {
  item: WireItem;
  done?: WireItem;
  arguments: string;
  argumentDone?: string;
  text: Map<number, { type: 'output_text' | 'refusal'; value: string }>;
  textDone?: Set<number>;
  summaries: Map<number, string>;
}

/** 响应结构异常不能成为可执行工具批次，诊断不包含正文或密文。 */
function invalid(message = 'Invalid Responses output Item'): never {
  throw new ModelError(message, {
    code: 'MODEL_INVALID_RESPONSE',
    stage: 'stream',
    retryable: false,
  });
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && !!value.trim();
}
function index(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** 跨协议业务调用 ID 超出安全形状时使用稳定别名；function_call 与 output 共用映射保持配对。 */
function wireCallId(id: string): string {
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

/** 单个 Item 只允许首版支持的类型及完整终态；未完成工具参数绝不按空对象恢复。 */
function validateItem(item: WireItem, final: boolean): void {
  if (!item || typeof item !== 'object' || !nonempty(item.id)) invalid();
  if (!['message', 'function_call', 'reasoning'].includes(item.type))
    invalid('Unsupported Responses output Item');
  if (
    final &&
    (item.type !== 'reasoning' || item.status !== undefined) &&
    item.status !== 'completed'
  )
    invalid('Responses output Item is not complete');
  if (item.type === 'message') {
    if (
      item.role !== 'assistant' ||
      !Array.isArray(item.content) ||
      (item.phase != null && !['commentary', 'final_answer'].includes(item.phase))
    )
      invalid();
    for (const part of item.content) {
      if (
        !part ||
        !['output_text', 'refusal'].includes(part.type) ||
        typeof (part.type === 'refusal' ? part.refusal : part.text) !== 'string'
      )
        invalid('Unsupported Responses message content');
    }
  } else if (item.type === 'function_call') {
    if (!nonempty(item.call_id) || !nonempty(item.name) || typeof item.arguments !== 'string')
      invalid();
    if (final) {
      if (!item.arguments.trim()) invalid('Responses function arguments are missing');
      parseToolArguments(item.arguments);
    }
  } else if (
    !Array.isArray(item.summary) ||
    item.summary.some(
      (part: any) => !part || part.type !== 'summary_text' || typeof part.text !== 'string',
    ) ||
    (item.encrypted_content != null && typeof item.encrypted_content !== 'string')
  )
    invalid();
}

/** 仅比较决定回放和执行的字段，不把 JSON 键顺序或非关键元数据当成内容变更。 */
function itemIdentity(item: WireItem): string {
  const common = { type: item.type, id: item.id, status: item.status };
  if (item.type === 'message')
    return JSON.stringify({
      ...common,
      role: item.role,
      phase: item.phase ?? undefined,
      content: item.content.map((part: WireItem) => ({
        type: part.type,
        value: part.type === 'refusal' ? part.refusal : part.text,
      })),
    });
  if (item.type === 'function_call')
    return JSON.stringify({
      ...common,
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
    });
  return JSON.stringify({
    ...common,
    encrypted_content: item.encrypted_content ?? undefined,
    summary: item.summary.map((part: WireItem) => ({ type: part.type, text: part.text })),
  });
}

/** 终态只抽取受控类型；业务调用身份、原 Item 顺序、消息阶段和原参数串分别保留。 */
function toCanonical(
  output: WireItem[],
  origin: ProtocolOrigin,
): { content: ContentBlock[]; refusal: boolean; toolCalls: boolean } {
  const content: ContentBlock[] = [];
  const itemIds = new Set<string>();
  const callIds = new Set<string>();
  let refusal = false;
  let finalAnswer = false;
  for (const [itemIndex, item] of output.entries()) {
    validateItem(item, true);
    if (itemIds.has(item.id)) invalid('Duplicate Responses Item identity');
    itemIds.add(item.id);
    if (item.type === 'function_call') {
      if (callIds.has(item.call_id)) invalid('Duplicate Responses function call identity');
      callIds.add(item.call_id);
      content.push({
        type: 'tool_use',
        id: item.call_id,
        name: item.name,
        input: parseToolArguments(item.arguments),
        protocolMeta: { origin, itemIndex, itemId: item.id, arguments: item.arguments },
      });
    } else if (item.type === 'reasoning') {
      content.push({
        type: 'provider_state',
        origin,
        item: {
          type: 'reasoning',
          id: item.id,
          summary: item.summary.map((part: WireItem) => ({
            type: 'summary_text' as const,
            text: part.text,
          })),
          ...(item.encrypted_content != null ? { encrypted_content: item.encrypted_content } : {}),
          ...(item.status !== undefined ? { status: item.status } : {}),
        },
      });
    } else {
      if (!item.content.length)
        content.push({
          type: 'text',
          text: '',
          protocolMeta: {
            origin,
            itemIndex,
            itemId: item.id,
            ...(item.phase ? { phase: item.phase } : {}),
          },
        });
      for (const [contentIndex, part] of item.content.entries()) {
        const text = part.type === 'refusal' ? part.refusal : part.text;
        refusal ||= part.type === 'refusal';
        finalAnswer ||= !!text.trim() && item.phase !== 'commentary';
        content.push({
          type: 'text',
          text,
          protocolMeta: {
            origin,
            itemIndex,
            itemId: item.id,
            contentIndex,
            contentType: part.type,
            ...(item.phase ? { phase: item.phase } : {}),
          },
        });
      }
    }
  }
  if (refusal && callIds.size) invalid('Responses refusal cannot contain executable functions');
  if (
    !callIds.size &&
    !finalAnswer &&
    !(refusal && content.some((block) => block.type === 'text' && !!block.text.trim()))
  )
    invalid('Responses completed without a final answer or function call');
  validateProtocolContent(content);
  return { content, refusal, toolCalls: callIds.size > 0 };
}

/** 独立请求视图按 canonical 工具事务回传，普通 phase 跨 run 保留，私有状态仅用于有效工具续答。 */
function toInput(messages: CanonicalMessage[]): WireItem[] {
  const input: WireItem[] = [];
  for (const message of messages) {
    let group: WireItem | undefined;
    let groupKey: string | undefined;
    const canReplayState =
      message.role === 'assistant' && message.content.some((block) => block.type === 'tool_use');
    for (const block of message.content) {
      if (block.type === 'provider_state') {
        group = undefined;
        if (canReplayState) input.push(structuredClone(block.item));
      } else if (block.type === 'tool_use') {
        group = undefined;
        const argumentsText = block.protocolMeta?.arguments ?? JSON.stringify(block.input);
        const parsed = parseToolArguments(argumentsText);
        if (JSON.stringify(parsed) !== JSON.stringify(block.input))
          invalid('Responses historical function arguments do not match canonical input');
        input.push({
          type: 'function_call',
          ...(block.protocolMeta?.itemId ? { id: block.protocolMeta.itemId } : {}),
          call_id: wireCallId(block.id),
          name: block.name,
          arguments: argumentsText,
          ...(block.protocolMeta ? { status: 'completed' } : {}),
        });
      } else if (block.type === 'tool_result') {
        group = undefined;
        input.push({
          type: 'function_call_output',
          call_id: wireCallId(block.toolUseId),
          output: block.content,
        });
      } else if (block.type === 'text' || block.type === 'thinking') {
        const text = block.type === 'text' ? block.text : block.thinking;
        const meta = block.type === 'text' ? block.protocolMeta : undefined;
        if (!text && !meta) continue;
        const key = meta
          ? `${meta.origin.runId}:${meta.itemIndex}:${meta.itemId ?? ''}`
          : 'ordinary';
        if (!group || key !== groupKey) {
          const sourced = message.role === 'assistant' && !!meta;
          group = {
            ...(sourced
              ? {
                  type: 'message',
                  ...(meta.itemId ? { id: meta.itemId } : {}),
                  status: 'completed',
                  ...(meta.phase ? { phase: meta.phase } : {}),
                }
              : {}),
            role: message.role,
            content: [],
          };
          groupKey = key;
          input.push(group);
        }
        if (!text && meta && meta.contentIndex === undefined) continue;
        // assistant 历史一律用 output_text（跨协议降级后的无 meta 文本同属 assistant 输出）；
        // input_text 仅用于 user 输入，与 codex/pi/opencode 的回传口径一致。
        const type =
          message.role === 'assistant' ? (meta?.contentType ?? 'output_text') : 'input_text';
        group.content.push(
          type === 'refusal'
            ? { type, refusal: text }
            : { type, text, ...(type === 'output_text' ? { annotations: [] } : {}) },
        );
      }
    }
  }
  // 空 message Item（源自原始响应的无内容 Item）按原样回传保持 Item 序列保真；
  // 跨协议降级的无 meta 分组总会在创建时携带至少一个内容部分，不会出现空组。
  return input;
}

/** 原生 Responses 适配器拥有手动无状态历史，完成边界与 Agent 的 canonical 工具事务一致。 */
export class OpenAIResponsesProvider implements ModelProvider {
  readonly name = 'openai-responses';
  readonly binding: { protocol: 'openai-responses'; modelName: string; baseURL: string };
  private readonly options: OpenAIResponsesProviderOptions;
  /** 表明该适配器已装载非空凭据，不暴露凭据内容。 */
  get credentialsReady(): boolean {
    return Boolean(this.options.apiKey.trim());
  }

  /** 绑定明确模型与端点；不从模型名推断协议，也不在失败后自动切换协议。非法配置在请求前失败。 */
  constructor(options: OpenAIResponsesProviderOptions) {
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
        (options.connectTimeoutMs !== undefined &&
          (!Number.isSafeInteger(options.connectTimeoutMs) || options.connectTimeoutMs <= 0))
      )
        throw new Error();
    } catch {
      throw new ModelError('Invalid Responses connection configuration', {
        code: 'MODEL_INVALID_REQUEST',
        stage: 'request',
        retryable: false,
      });
    }
    this.options = { ...options, baseURL: options.baseURL.replace(/\/+$/, '') };
    this.binding = Object.freeze({
      protocol: 'openai-responses',
      modelName: options.modelName,
      baseURL: this.options.baseURL,
    });
  }

  /** 消费完整 Responses 流，增量仅用于展示；终态与全部 Item 合法后才交付工具完成和最终内容。 */
  async *create(request: ModelRequest): AsyncIterable<ModelEvent> {
    const started = Date.now();
    let firstToken: number | undefined;
    const origin = createProtocolOrigin(this.binding, request.context);
    const projected = projectProtocolHistory(request.messages, this.binding, request.context);
    const input = toInput(normalizeHistory(projected).messages);
    const payload: Record<string, unknown> = {
      model: this.options.modelName,
      stream: true,
      store: false,
      input,
      include: ['reasoning.encrypted_content'],
    };
    if (request.systemPrompt) payload.instructions = request.systemPrompt;
    if (request.maxTokens !== undefined) {
      if (!Number.isSafeInteger(request.maxTokens) || request.maxTokens <= 0)
        throw new ModelError('Invalid Responses output budget', {
          stage: 'request',
          retryable: false,
        });
      payload.max_output_tokens = request.maxTokens;
    }
    if (request.temperature !== undefined && !this.options.supportsThinking)
      payload.temperature = request.temperature;
    if (request.tools?.length)
      payload.tools = request.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: structuredClone(tool.parameters),
        strict: false,
      }));
    const { response, close } = await openModelResponse({
      url: `${this.options.baseURL}/responses`,
      headers: { Authorization: `Bearer ${this.options.apiKey}` },
      payload,
      signal: request.signal,
      connectTimeoutMs: this.options.connectTimeoutMs,
    });
    const items = new Map<number, StreamItem>();
    const summariesOpen = new Set<string>();
    let terminal: WireItem | undefined;
    const target = (event: WireItem): StreamItem => {
      if (!index(event.output_index)) invalid();
      const item = items.get(event.output_index);
      if (!item || item.done || event.item_id !== item.item.id)
        invalid('Responses event Item identity or lifecycle mismatch');
      return item;
    };
    try {
      for await (const frame of parseSSEFrames(response.body!)) {
        if (frame.event === 'ping' && !frame.data.trim()) continue;
        const event = parseWireEvent(frame.data);
        if (
          typeof event.type !== 'string' ||
          (frame.event !== 'message' && frame.event !== event.type)
        )
          invalid('Responses event type mismatch');
        if (event.type === 'error' || event.error) this.throwWireError(event.error ?? event);
        if (event.type === 'response.failed') this.throwWireError(event.response?.error ?? {});
        if (event.type === 'response.incomplete')
          throw new ModelError('Responses generation was incomplete', {
            code: 'MODEL_STREAM_INCOMPLETE',
            stage: 'stream',
            retryable: false,
            providerCode: event.response?.incomplete_details?.reason,
          });
        if (event.type === 'response.completed') {
          if (event.response?.status !== 'completed' || !Array.isArray(event.response.output))
            invalid('Invalid Responses terminal event');
          terminal = event.response;
          break;
        }
        if (
          event.type === 'response.output_item.added' ||
          event.type === 'response.output_item.done'
        ) {
          if (!index(event.output_index)) invalid();
          validateItem(event.item, event.type.endsWith('.done'));
          const existing = items.get(event.output_index);
          if (event.type.endsWith('.added')) {
            if (existing || [...items.values()].some((item) => item.item.id === event.item.id))
              invalid('Duplicate Responses streaming Item');
            items.set(event.output_index, {
              item: event.item,
              arguments: '',
              text: new Map(),
              summaries: new Map(),
            });
            if (event.item.type === 'function_call')
              yield { type: 'tool_call_start', id: event.item.call_id, name: event.item.name };
          } else {
            if (
              existing?.done ||
              (existing &&
                (existing.item.id !== event.item.id ||
                  existing.item.type !== event.item.type ||
                  (event.item.type === 'function_call' &&
                    (existing.item.call_id !== event.item.call_id ||
                      existing.item.name !== event.item.name))))
            )
              invalid('Responses completed Item identity mismatch');
            const item: StreamItem = existing ?? {
              item: event.item,
              arguments: '',
              text: new Map(),
              summaries: new Map(),
            };
            item.done = event.item;
            items.set(event.output_index, item);
          }
          continue;
        }
        if (
          event.type === 'response.output_text.delta' ||
          event.type === 'response.refusal.delta'
        ) {
          const item = target(event);
          if (
            item.item.type !== 'message' ||
            !index(event.content_index) ||
            typeof event.delta !== 'string' ||
            item.textDone?.has(event.content_index)
          )
            invalid();
          const type = event.type === 'response.refusal.delta' ? 'refusal' : 'output_text';
          const part = item.text.get(event.content_index) ?? { type, value: '' };
          if (part.type !== type) invalid();
          part.value += event.delta;
          item.text.set(event.content_index, part);
          firstToken ??= Date.now();
          yield { type: 'text_delta', text: event.delta };
          continue;
        }
        if (event.type === 'response.output_text.done' || event.type === 'response.refusal.done') {
          const item = target(event);
          const type = event.type === 'response.refusal.done' ? 'refusal' : 'output_text';
          const value = type === 'refusal' ? event.refusal : event.text;
          if (
            item.item.type !== 'message' ||
            !index(event.content_index) ||
            typeof value !== 'string' ||
            item.textDone?.has(event.content_index)
          )
            invalid();
          const part = item.text.get(event.content_index);
          if (part && (part.type !== type || part.value !== value))
            invalid('Responses completed text does not match its deltas');
          item.text.set(event.content_index, { type, value });
          item.textDone ??= new Set();
          item.textDone.add(event.content_index);
          if (!part && value) yield { type: 'text_delta', text: value };
          continue;
        }
        if (
          event.type === 'response.content_part.added' ||
          event.type === 'response.content_part.done'
        ) {
          const item = target(event);
          const part = event.part;
          if (
            item.item.type !== 'message' ||
            !index(event.content_index) ||
            !part ||
            !['output_text', 'refusal'].includes(part.type) ||
            typeof (part.type === 'refusal' ? part.refusal : part.text) !== 'string'
          )
            invalid('Unsupported Responses message content');
          if (event.type.endsWith('.done')) {
            const streamed = item.text.get(event.content_index);
            if (
              streamed &&
              (streamed.type !== part.type ||
                streamed.value !== (part.type === 'refusal' ? part.refusal : part.text))
            )
              invalid('Responses content part does not match streamed text');
          }
          continue;
        }
        if (
          event.type === 'response.function_call_arguments.delta' ||
          event.type === 'response.function_call_arguments.done'
        ) {
          const item = target(event);
          if (item.item.type !== 'function_call' || item.argumentDone !== undefined) invalid();
          if (event.type.endsWith('.delta')) {
            if (typeof event.delta !== 'string') invalid();
            item.arguments += event.delta;
            yield { type: 'tool_call_delta', id: item.item.call_id, argumentChunk: event.delta };
          } else {
            if (
              typeof event.arguments !== 'string' ||
              (item.arguments && item.arguments !== event.arguments)
            )
              invalid('Responses function arguments changed after streaming');
            item.argumentDone = event.arguments;
          }
          continue;
        }
        if (
          event.type === 'response.reasoning_summary_text.delta' ||
          event.type === 'response.reasoning_summary_text.done'
        ) {
          const item = target(event);
          if (item.item.type !== 'reasoning' || !index(event.summary_index)) invalid();
          const blockId = `${item.item.id}:${event.summary_index}`;
          const old = item.summaries.get(event.summary_index) ?? '';
          if (event.type.endsWith('.delta')) {
            if (typeof event.delta !== 'string') invalid();
            if (!summariesOpen.has(blockId)) {
              summariesOpen.add(blockId);
              yield { type: 'thinking_block_start', blockId };
            }
            item.summaries.set(event.summary_index, old + event.delta);
            firstToken ??= Date.now();
            yield { type: 'thinking_delta', blockId, thinking: event.delta };
          } else {
            if (typeof event.text !== 'string' || (old && old !== event.text)) invalid();
            item.summaries.set(event.summary_index, event.text);
            if (summariesOpen.delete(blockId)) yield { type: 'thinking_block_stop', blockId };
          }
          continue;
        }
        if (
          [
            'response.created',
            'response.in_progress',
            'response.queued',
            'response.output_text.annotation.added',
            'response.reasoning_summary_part.added',
            'response.reasoning_summary_part.done',
          ].includes(event.type)
        )
          continue;
        invalid('Unsupported Responses stream event');
      }
      if (!terminal)
        throw new ModelError('Responses stream ended without completion', {
          code: 'MODEL_STREAM_INCOMPLETE',
          stage: 'stream',
          retryable: false,
        });
      const final = toCanonical(terminal.output, origin);
      const usage = this.toUsage(terminal.usage);
      for (const [outputIndex, item] of items) {
        const ended = terminal.output[outputIndex];
        if (!item.done || !ended || itemIdentity(item.done) !== itemIdentity(ended))
          invalid('Responses final Items do not match completed stream Items');
        if (
          ended.type === 'function_call' &&
          ((item.arguments && item.arguments !== ended.arguments) ||
            (item.argumentDone !== undefined && item.argumentDone !== ended.arguments))
        )
          invalid('Responses final function arguments do not match stream');
        for (const [contentIndex, part] of item.text) {
          const endedPart = ended.content?.[contentIndex];
          if (
            endedPart?.type !== part.type ||
            (part.type === 'refusal' ? endedPart.refusal : endedPart.text) !== part.value
          )
            invalid('Responses final text does not match stream');
        }
        for (const [summaryIndex, summary] of item.summaries)
          if (ended.summary?.[summaryIndex]?.text !== summary)
            invalid('Responses final summary does not match stream');
      }
      for (const blockId of summariesOpen) yield { type: 'thinking_block_stop', blockId };
      for (const [outputIndex, item] of terminal.output.entries()) {
        if (item.type === 'message')
          for (const [contentIndex, part] of item.content.entries()) {
            if (!items.get(outputIndex)?.text.has(contentIndex))
              yield {
                type: 'text_delta',
                text: part.type === 'refusal' ? part.refusal : part.text,
              };
          }
        else if (item.type === 'reasoning')
          for (const [summaryIndex, part] of item.summary.entries()) {
            if (!items.get(outputIndex)?.summaries.has(summaryIndex) && part.text) {
              const blockId = `${item.id}:${summaryIndex}`;
              yield { type: 'thinking_block_start', blockId };
              yield { type: 'thinking_delta', blockId, thinking: part.text };
              yield { type: 'thinking_block_stop', blockId };
            }
          }
        else if (item.type === 'function_call')
          yield {
            type: 'tool_call_finish',
            id: item.call_id,
            name: item.name,
            input: parseToolArguments(item.arguments),
          };
      }
      yield {
        type: 'message_stop',
        finishReason: final.toolCalls ? 'tool_calls' : 'stop',
        finalContent: final.content,
        ...(final.refusal ? { refusal: true } : {}),
        ...(usage ? { usage } : {}),
        ...(firstToken !== undefined ? { ttftMs: firstToken - started } : {}),
        durationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof ModelError || request.signal?.aborted) throw error;
      throw new ModelError('Responses stream was interrupted', {
        code: 'MODEL_STREAM_INTERRUPTED',
        stage: 'stream',
        retryable: false,
        transportCode: safeTransportCode(error),
      });
    } finally {
      close();
    }
  }

  /** 保持消息级 canonical tool 落盘，Responses function_call_output 仅存在于请求投影。 */
  assembleToolResults(results: ToolResultBlock[]): CanonicalMessage[] {
    return assembleCanonicalToolResults(results);
  }

  /** 服务端错误仅保留明确标识，不回显请求、输出正文、签名或加密 reasoning。 */
  private throwWireError(error: WireItem): never {
    const detail = {
      stage: 'stream' as const,
      retryable: false,
      providerCode: typeof error.code === 'string' ? error.code : undefined,
      providerType:
        typeof error.type === 'string' && error.type !== 'error' ? error.type : undefined,
    };
    if (isContextOverflow(error)) throw new ContextOverflowError(400, detail);
    throw new ModelError('Responses API reported an error', detail);
  }

  /** 只接受真实且合法的计数；缺失 usage 保持未知，推理 token 已包含在 output_tokens 中。 */
  private toUsage(value: WireItem | undefined): Usage | undefined {
    if (value === undefined || value === null) return undefined;
    if (![value.input_tokens, value.output_tokens, value.total_tokens].every(index))
      invalid('Invalid Responses usage');
    const cached = value.input_tokens_details?.cached_tokens;
    if (cached !== undefined && (!index(cached) || cached > value.input_tokens))
      invalid('Invalid Responses cached usage');
    return {
      promptTokens: value.input_tokens,
      completionTokens: value.output_tokens,
      totalTokens: value.total_tokens,
      ...(cached !== undefined ? { cachedPromptTokens: cached } : {}),
    };
  }
}
