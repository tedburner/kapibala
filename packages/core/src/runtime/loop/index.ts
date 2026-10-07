import {
  type PermissionRule,
  type SessionMode,
  visibleTools,
} from '../../capabilities/security/permissions.js';
import { toToolDefinition } from '../../capabilities/tools/index.js';
import type { ToolRegistry } from '../../capabilities/tools/registry.js';
import {
  AbortError,
  ContextOverflowError,
  KapibalaError,
  ModelError,
  describeModelError,
} from '../../errors/index.js';
import type { HookRegistry } from '../../extensibility/hooks/registry.js';
import type { EventLogger } from '../../extensibility/logging/index.js';
import type { ModelProvider } from '../../models/index.js';
import { validateProtocolContent } from '../../models/protocol-state.js';
import type { PrimaryModelRole } from '../../models/router.js';
import { createMessageId } from '../../types/identity.js';
import type {
  CanonicalMessage,
  ContentBlock,
  ModelRequest,
  RequestPreparation,
  SessionEvent,
  ToolResultBlock,
  ToolUseBlock,
  TurnMetrics,
  Usage,
} from '../../types/index.js';
import { stableSerialize } from '../../types/serialization.js';
import type { ToolExecutor } from '../executor/index.js';

export interface AgentLoopOptions {
  /** 本次交互身份，内部步骤仍独立编号。 */
  interactionId?: string;
  /** 仅用于诊断、用量归因与脱敏说明，不参与请求构造。 */
  modelId?: string;
  modelRole?: PrimaryModelRole;
  /** 请求视图投影：只允许变换克隆出的请求消息，不得改动真实历史。 */
  projectHistory?: (history: readonly CanonicalMessage[]) => CanonicalMessage[];
  /** 请求准备契约；可在请求前产出事件，并在上下文溢出时参与一次预算重试。 */
  prepareRequest?: RequestPreparation;
  /** 每次收到 usage 后回调；attemptId 标识 run:step:attempt，便于按尝试归因。 */
  onUsage?: (request: ModelRequest, usage: Usage, attemptId: string) => Promise<void>;
  provider: ModelProvider;
  executor: ToolExecutor;
  tools: ToolRegistry;
  hooks: HookRegistry;
  systemPrompt?: string;
  /** 单次 run 的最大 turn 数，耗尽时以 error 事件收尾；缺省 20。 */
  maxSteps?: number;
  /** 连续工具失败达到该阈值即熔断终止本轮 run；缺省 3。 */
  maxConsecutiveErrors?: number;
  signal?: AbortSignal;
  eventLogger?: EventLogger;
  sessionId?: string;
  runId?: string;
  /** 每轮开始时读取；工具可见性与权限模式可随宿主状态变化。 */
  getMode?: () => SessionMode;
  permissionRules?: readonly PermissionRule[];
}

/**
 * 主执行循环：按 turn 推进「模型请求 → 整批校验 → 工具调度 → 历史闭合」。
 * run 会就地追加传入的 history，assistant 与全部 tool_result 在同一同步临界段落入，
 * 消费方在任何对外事件后停止迭代都不会看到半闭合历史（设计文档 §4.3 / §4.4）。
 */
export class AgentLoop {
  private readonly interactionId?: string;
  private readonly modelId?: string;
  private readonly modelRole?: PrimaryModelRole;
  private readonly projectHistory?: AgentLoopOptions['projectHistory'];
  private readonly prepareRequest?: RequestPreparation;
  private readonly onUsage?: AgentLoopOptions['onUsage'];
  private readonly provider: ModelProvider;
  private readonly executor: ToolExecutor;
  private readonly tools: ToolRegistry;
  private readonly hooks: HookRegistry;
  private readonly systemPrompt?: string;
  private readonly maxSteps: number;
  private readonly maxConsecutiveErrors: number;
  private readonly signal?: AbortSignal;
  private readonly eventLogger?: EventLogger;
  private readonly sessionId?: string;
  private readonly runId?: string;
  private readonly getMode: () => SessionMode;
  private readonly permissionRules: readonly PermissionRule[];

  constructor(options: AgentLoopOptions) {
    this.interactionId = options.interactionId;
    this.modelId = options.modelId;
    this.modelRole = options.modelRole;
    this.projectHistory = options.projectHistory;
    this.prepareRequest = options.prepareRequest;
    this.onUsage = options.onUsage;
    this.provider = options.provider;
    this.executor = options.executor;
    this.tools = options.tools;
    this.hooks = options.hooks;
    this.systemPrompt = options.systemPrompt;
    this.maxSteps = options.maxSteps ?? 20;
    this.maxConsecutiveErrors = options.maxConsecutiveErrors ?? 3;
    this.signal = options.signal;
    this.eventLogger = options.eventLogger;
    this.sessionId = options.sessionId;
    this.runId = options.runId;
    this.getMode = options.getMode ?? (() => 'Approval');
    this.permissionRules = options.permissionRules ?? [];
  }

  /**
   * 执行一次交互并流式产出事件。
   *
   * 语义要点：
   * - message_stop 携带完整 canonical 消息，是唯一落盘来源；text / thinking 增量仅供展示。
   * - 模型失败以 error + turn_finish 事件收尾并结束 run（不抛出）；用户中止抛 AbortError。
   * - turn_start / turn_finish 严格配对，错误、熔断与步数耗尽路径均保证收口。
   */
  async *run(history: CanonicalMessage[]): AsyncIterable<SessionEvent> {
    let step = 0;
    let consecutiveErrors = 0;
    // 标记循环是否已"有结论"地结束(正常回答/熔断/模型错误)。
    // while 条件自然退出 = 每一轮都以工具调用收尾直到步数耗尽，需要显式告知消费方。
    let completed = false;
    let overflowRetried = false;

    while (step < this.maxSteps) {
      step++;
      const turnStartTime = Date.now();
      yield { type: 'turn_start', turn: step };

      if (this.signal?.aborted) {
        throw new AbortError();
      }

      // 1. 构建请求
      let request: ModelRequest = {
        systemPrompt: this.systemPrompt,
        messages: structuredClone(this.projectHistory?.(history) ?? history),
        tools: visibleTools(this.tools.list(), this.getMode(), this.permissionRules).map(
          toToolDefinition,
        ),
        signal: this.signal,
        context: this.runId ? { runId: this.runId, modelId: this.modelId } : undefined,
      };

      // 触发 model:before hooks
      const beforeModelHooks = this.hooks.get('model:before');
      const hookCtx = { signal: this.signal };
      for (const hook of beforeModelHooks) {
        request = await hook(hookCtx, request);
      }
      if (this.prepareRequest) request = yield* this.prepareRequest(request, history);

      yield {
        type: 'step_log',
        log: {
          timestamp: Date.now(),
          turn: step,
          stage: 'model_request_start',
          message: `Sending request to model with ${request.messages.length} messages and ${request.tools?.length ?? 0} tools`,
        },
      };

      // 2. 请求模型并流式组装 Assistant 消息
      let accumulatedText = '';
      let accumulatedThinking = '';
      const toolCalls: ToolUseBlock[] = [];
      let finalContent: ContentBlock[] | undefined;
      let responseStopped = false;
      let invalidToolArguments = false;
      let refused = false;
      let turnUsage: Usage | undefined;
      let finishReason: string | undefined;
      let turnTtftMs: number | undefined;
      const modelStartTime = Date.now();
      if (this.eventLogger && this.sessionId) {
        await this.eventLogger.record({
          level: 'info',
          event: 'model.requested',
          sessionId: this.sessionId,
          runId: this.runId,
          fields: { attempt: step, count: request.messages.length },
        });
      }
      let firstTokenReceived = false;
      let outputSeen = false;

      // 统一的 TurnMetrics 构造：保证错误/熔断/正常三条路径的指标结构一致
      const buildMetrics = (
        modelDurationMs: number,
        toolDurationMs: number,
        toolCallsCount: number,
      ): TurnMetrics => {
        const endTime = Date.now();
        return {
          turn: step,
          startTime: turnStartTime,
          endTime,
          totalDurationMs: endTime - turnStartTime,
          ttftMs: turnTtftMs,
          modelDurationMs,
          toolDurationMs,
          promptTokens: turnUsage?.promptTokens ?? 0,
          completionTokens: turnUsage?.completionTokens ?? 0,
          totalTokens: turnUsage?.totalTokens ?? 0,
          toolCallsCount,
        };
      };

      try {
        let attempt = 0;
        while (true) {
          attempt++;
          try {
            for await (const event of this.provider.create(request)) {
              if (this.signal?.aborted) throw new AbortError();
              if (responseStopped)
                throw new ModelError('Model emitted output after its stop event', {
                  stage: 'stream',
                  retryable: false,
                });
              if (
                event.type === 'text_delta' ||
                event.type === 'thinking_delta' ||
                event.type === 'thinking_block_start' ||
                event.type === 'thinking_block_stop' ||
                event.type === 'message_stop' ||
                event.type === 'tool_call_start' ||
                event.type === 'tool_call_delta' ||
                event.type === 'tool_call_finish'
              )
                outputSeen = true;

              if (
                !firstTokenReceived &&
                (event.type === 'text_delta' ||
                  event.type === 'thinking_delta' ||
                  event.type === 'tool_call_start')
              ) {
                firstTokenReceived = true;
                turnTtftMs = Date.now() - modelStartTime;
                yield {
                  type: 'step_log',
                  log: {
                    timestamp: Date.now(),
                    turn: step,
                    stage: 'first_token',
                    message: `First token received (TTFT: ${turnTtftMs}ms)`,
                    durationMs: turnTtftMs,
                  },
                };
              }

              if (event.type === 'text_delta') {
                accumulatedText += event.text;
                yield { type: 'text_delta', text: event.text };
              } else if (event.type === 'thinking_delta') {
                accumulatedThinking += event.thinking;
                yield event;
              } else if (
                event.type === 'thinking_block_start' ||
                event.type === 'thinking_block_stop'
              ) {
                yield event;
              } else if (event.type === 'tool_call_finish') {
                invalidToolArguments ||= event.parseError === true;
                const toolUse: ToolUseBlock = {
                  type: 'tool_use',
                  id: event.id,
                  name: event.name,
                  source: this.tools.get(event.name)?.metadata?.source,
                  input: event.input,
                };
                toolCalls.push(toolUse);
              } else if (event.type === 'message_stop') {
                if (responseStopped) throw new ModelError('Duplicate response stop event');
                responseStopped = true;
                finalContent = event.finalContent ? structuredClone(event.finalContent) : undefined;
                refused = event.refusal === true;
                finishReason = event.finishReason;
                turnUsage = event.usage;
                if (event.usage)
                  await this.onUsage?.(
                    request,
                    event.usage,
                    `${this.runId ?? this.interactionId ?? 'loop'}:${step}:${attempt}`,
                  );
                if (event.ttftMs && turnTtftMs === undefined) {
                  turnTtftMs = event.ttftMs;
                }
              }
            }
            if (this.signal?.aborted) throw new AbortError();
            if (!responseStopped)
              throw new ModelError('Model response ended without a stop event', {
                code: 'MODEL_STREAM_INCOMPLETE',
                stage: 'stream',
                retryable: false,
              });
            if (
              finishReason !== undefined &&
              !['stop', 'tool_calls', 'length', 'end_turn', 'tool_use'].includes(finishReason)
            )
              throw new ModelError('Model response has an invalid stop reason', {
                stage: 'stream',
                retryable: false,
              });
            if (finalContent) {
              // 终态 finalContent 优先：丢弃增量装配结果，改为对完整内容做整批校验。
              validateProtocolContent(finalContent);
              if (finalContent.some((block) => block.type === 'tool_result'))
                throw new ModelError('Assistant response cannot supply tool results', {
                  stage: 'stream',
                  retryable: false,
                });
              toolCalls.length = 0;
              for (const block of finalContent)
                if (block.type === 'tool_use') {
                  block.source = this.tools.get(block.name)?.metadata?.source;
                  toolCalls.push(block);
                }
              accumulatedText = finalContent
                .filter((block) => block.type === 'text')
                .map((block) => block.text)
                .join('');
            }
            if (
              finishReason !== undefined &&
              ((['tool_calls', 'tool_use'].includes(finishReason) && !toolCalls.length) ||
                (['stop', 'end_turn'].includes(finishReason) && toolCalls.length))
            )
              throw new ModelError('Model stop reason does not match its tool content', {
                stage: 'stream',
                retryable: false,
              });
            if (
              invalidToolArguments ||
              finishReason === 'content_filter' ||
              (toolCalls.length && (finishReason === 'length' || refused))
            )
              throw new ModelError('Model tool call was truncated; no tools executed', {
                code: 'MODEL_INVALID_RESPONSE',
                stage: 'stream',
                retryable: false,
              });
            // 工具调用整批校验：名称、参数、ID 合法且不与历史重复；任一失败则整批不执行。
            const knownCalls = new Set(
              history.flatMap((message) =>
                message.content
                  .filter((block) => block.type === 'tool_use')
                  .map((block) => block.id),
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
            break;
          } catch (error) {
            // 溢出重试只允许一次，且要求模型尚未产出任何输出、准备器可用且未被取消。
            if (
              !(error instanceof ContextOverflowError) ||
              outputSeen ||
              accumulatedText ||
              accumulatedThinking ||
              toolCalls.length ||
              overflowRetried ||
              !this.prepareRequest ||
              this.signal?.aborted
            )
              throw error;
            overflowRetried = true;
            const before = JSON.stringify({
              systemPrompt: request.systemPrompt,
              messages: request.messages,
              tools: request.tools,
              maxTokens: request.maxTokens,
            });
            const candidate = yield* this.prepareRequest(request, history, 'overflow');
            const after = JSON.stringify({
              systemPrompt: candidate.systemPrompt,
              messages: candidate.messages,
              tools: candidate.tools,
              maxTokens: candidate.maxTokens,
            });
            if (before === after) throw error;
            request = candidate;
          }
        }
      } catch (err: unknown) {
        if (err instanceof AbortError || this.signal?.aborted) {
          throw new AbortError();
        }
        const modelError = err instanceof Error ? err : new Error(String(err));
        if (this.eventLogger && this.sessionId) {
          await this.eventLogger.record({
            level: 'error',
            event: 'model.failed',
            sessionId: this.sessionId,
            runId: this.runId,
            fields: {
              attempt: step,
              durationMs: Date.now() - modelStartTime,
              errorCode: modelError instanceof KapibalaError ? modelError.code : 'MODEL_ERROR',
              transportCode:
                modelError instanceof ModelError ? modelError.transportCode : undefined,
              status: modelError instanceof ModelError ? modelError.status : undefined,
              retryPolicy: modelError instanceof KapibalaError ? modelError.retryPolicy : 'never',
              providerCode: modelError instanceof ModelError ? modelError.providerCode : undefined,
              providerType: modelError instanceof ModelError ? modelError.providerType : undefined,
              phase: modelError instanceof ModelError ? modelError.stage : 'request',
              category: modelError instanceof ModelError ? modelError.category : 'unknown',
            },
          });
        }
        await this.hooks.emit('error', hookCtx, modelError);
        yield {
          type: 'error',
          error: modelError,
          modelError: describeModelError(
            modelError instanceof ModelError
              ? modelError
              : new ModelError(modelError.message, { stage: 'request' }),
            {
              modelId: this.modelId,
              modelRole: this.modelRole,
              provider: this.provider.name,
              operation: 'primary',
            },
          ),
        };
        // 与熔断路径保持一致：turn_start 必须有配对的 turn_finish，消费方(如指标统计)才能正确收口
        yield {
          type: 'turn_finish',
          turn: step,
          metrics: buildMetrics(Date.now() - modelStartTime, 0, 0),
        };
        completed = true;
        break;
      }

      const modelDurationMs = Date.now() - modelStartTime;
      if (this.eventLogger && this.sessionId) {
        await this.eventLogger.record({
          level: 'info',
          event: 'model.finished',
          sessionId: this.sessionId,
          runId: this.runId,
          fields: {
            attempt: step,
            durationMs: modelDurationMs,
            promptTokens: turnUsage?.promptTokens ?? 0,
            completionTokens: turnUsage?.completionTokens ?? 0,
          },
        });
      }

      yield {
        type: 'step_log',
        log: {
          timestamp: Date.now(),
          turn: step,
          stage: 'model_stream_finish',
          message: `Model streaming completed in ${modelDurationMs}ms (prompt: ${turnUsage?.promptTokens ?? 0}, completion: ${turnUsage?.completionTokens ?? 0})`,
          durationMs: modelDurationMs,
          metadata: { usage: turnUsage, ttftMs: turnTtftMs },
        },
      };

      // 构建完整的 Canonical Assistant Message
      const contentBlocks: ContentBlock[] = finalContent ?? [];
      if (!finalContent && accumulatedThinking) {
        contentBlocks.push({ type: 'thinking', thinking: accumulatedThinking });
      }
      if (!finalContent && accumulatedText) {
        contentBlocks.push({ type: 'text', text: accumulatedText });
      }
      if (!finalContent) contentBlocks.push(...toolCalls);

      // 截断或既无正文又无工具调用的回合标记为 failed，由消费方按失败轮次收口。
      const assistantMessage: CanonicalMessage = {
        id: createMessageId(),
        interactionId: this.interactionId,
        state:
          finishReason === 'length' || (!accumulatedText.trim() && !toolCalls.length)
            ? 'failed'
            : 'completed',
        role: 'assistant',
        content: contentBlocks,
        timestamp: Date.now(),
      };

      // 触发 model:after hooks
      validateProtocolContent(assistantMessage.content);
      // 钩子不得改动消息身份、已校验的工具输出与私有状态（签名/密文）；违规即拒绝本轮结果。
      const originalContent = stableSerialize(assistantMessage.content);
      const identity = stableSerialize({ ...assistantMessage, content: undefined });
      const originalTools = stableSerialize(
        assistantMessage.content.filter(
          (block) => block.type === 'tool_use' || block.type === 'tool_result',
        ),
      );
      const privateOutput = assistantMessage.content.some(
        (block) =>
          block.type === 'provider_state' ||
          block.type === 'redacted_thinking' ||
          (block.type === 'thinking' && Boolean(block.origin || block.signature)),
      );
      await this.hooks.emit('model:after', hookCtx, { message: assistantMessage });
      if (identity !== stableSerialize({ ...assistantMessage, content: undefined }))
        throw new ModelError('Hook changed assistant message identity', {
          stage: 'request',
          retryable: false,
        });
      if (
        originalTools !==
        stableSerialize(
          assistantMessage.content.filter(
            (block) => block.type === 'tool_use' || block.type === 'tool_result',
          ),
        )
      )
        throw new ModelError('Hook changed validated tool model output', {
          stage: 'request',
          retryable: false,
        });
      if (originalContent !== stableSerialize(assistantMessage.content)) {
        if (
          privateOutput ||
          assistantMessage.content.some(
            (block) =>
              block.type === 'provider_state' ||
              block.type === 'redacted_thinking' ||
              (block.type === 'thinking' && Boolean(block.origin || block.signature)),
          )
        )
          throw new ModelError('Hook changed signed or private model output', {
            stage: 'request',
            retryable: false,
          });
        // 普通正文改写后不得继承源 Item 身份；有工具的整批不能被 Hook 偷换。
        if (toolCalls.length)
          throw new ModelError('Hook changed validated tool model output', {
            stage: 'request',
            retryable: false,
          });
        for (const block of assistantMessage.content)
          if (block.type === 'text' || block.type === 'tool_use') block.protocolMeta = undefined;
      }
      validateProtocolContent(assistantMessage.content);

      // 判断是否需要调用工具
      if (toolCalls.length === 0) {
        history.push(assistantMessage);
        yield {
          type: 'message_stop',
          message: assistantMessage,
          usage: turnUsage,
          ttftMs: turnTtftMs,
          durationMs: modelDurationMs,
        };

        const metrics = buildMetrics(modelDurationMs, 0, 0);
        if (assistantMessage.state === 'failed')
          yield {
            type: 'error',
            error: new ModelError('Model did not produce a complete final answer', {
              code: 'MODEL_INVALID_RESPONSE',
              stage: 'stream',
              retryable: false,
            }),
          };

        yield {
          type: 'step_log',
          log: {
            timestamp: metrics.endTime,
            turn: step,
            stage: 'turn_finish',
            message: `Turn ${step} finished in ${metrics.totalDurationMs}ms (TTFT: ${metrics.ttftMs ?? 0}ms, Tokens: ${metrics.totalTokens})`,
            durationMs: metrics.totalDurationMs,
            metadata: { metrics },
          },
        };

        yield { type: 'turn_finish', turn: step, usage: turnUsage, metrics };
        completed = true;
        break; // 没有工具调用，正常回答完毕，结束本轮交互
      }

      // 5. 调度工具执行
      yield {
        type: 'step_log',
        log: {
          timestamp: Date.now(),
          turn: step,
          stage: 'tool_execution_start',
          message: `Executing ${toolCalls.length} tool(s): ${toolCalls.map((c) => c.name).join(', ')}`,
        },
      };

      for (const call of toolCalls) {
        yield { type: 'tool_start', id: call.id, name: call.name, input: call.input };
      }

      const toolStartTime = Date.now();
      const progressQueue: SessionEvent[] = [];
      let progressWake: (() => void) | undefined;
      let toolsFinished = false;
      const toolRun = this.executor.runAll(toolCalls, (progress) => {
        progressQueue.push({ type: 'tool_progress', ...progress });
        progressWake?.();
      });
      void toolRun.then(
        () => {
          toolsFinished = true;
          progressWake?.();
        },
        () => {
          toolsFinished = true;
          progressWake?.();
        },
      );
      let toolResults: ToolResultBlock[];
      let toolMessages: CanonicalMessage[];
      try {
        while (!toolsFinished || progressQueue.length > 0) {
          const next = progressQueue.shift();
          if (next) yield next;
          else
            await new Promise<void>((resolve) => {
              progressWake = resolve;
            });
          progressWake = undefined;
        }
      } finally {
        // 消费方 return/throw 时也必须先回收工具并闭合事务；已完成的真实结果原样保留。
        if (!toolsFinished) this.executor.cancel();
        toolResults = await toolRun;
        toolMessages = this.provider.assembleToolResults(toolResults);
        for (const message of toolMessages) {
          message.id ??= createMessageId();
          message.interactionId = this.interactionId;
          message.state = 'completed';
        }
        history.push(assistantMessage, ...toolMessages);
      }
      const toolDurationMs = Date.now() - toolStartTime;

      const hasError = toolResults.some((result) => result.isError);
      const metrics = buildMetrics(modelDurationMs, toolDurationMs, toolCalls.length);

      // 6. 工具结果回填历史 + 派发落盘事件
      //    assistant 与所有 tool_result 在同一个同步临界段进入历史，并且发生在下一次 yield 前。
      //    因此直接消费 AgentLoop 的调用方即使在任意对外事件后停止，也看不到半闭合历史。
      //    熔断只决定「是否继续循环」，不改变历史的合法性(设计文档 §4.3 / §4.4)。
      yield {
        type: 'message_stop',
        message: assistantMessage,
        usage: turnUsage,
        ttftMs: turnTtftMs,
        durationMs: modelDurationMs,
      };

      for (const res of toolResults) {
        const matchingCall = toolCalls.find((c) => c.id === res.toolUseId);
        yield {
          type: 'tool_finish',
          id: res.toolUseId,
          name: matchingCall?.name ?? 'unknown',
          result: res.content,
          isError: res.isError ?? false,
          durationMs: res.durationMs,
        };
      }

      yield {
        type: 'step_log',
        log: {
          timestamp: Date.now(),
          turn: step,
          stage: 'tool_execution_finish',
          message: `Tools execution finished in ${toolDurationMs}ms (${hasError ? 'with errors' : 'success'})`,
          durationMs: toolDurationMs,
        },
      };

      yield { type: 'tool_messages', messages: toolMessages };

      if (toolResults.some((result) => result.retryPolicy === 'after_user_action')) {
        if (this.signal?.aborted) {
          yield { type: 'turn_finish', turn: step, usage: turnUsage, metrics };
          throw new AbortError();
        }
        yield {
          type: 'error',
          error: new Error('Tool execution requires user action before continuing'),
        };
        yield { type: 'turn_finish', turn: step, usage: turnUsage, metrics };
        completed = true;
        break;
      }

      if (hasError) {
        consecutiveErrors++;
        if (consecutiveErrors >= this.maxConsecutiveErrors) {
          const breakerError = new Error(
            `Circuit breaker triggered: ${consecutiveErrors} consecutive tool failures`,
          );
          await this.hooks.emit('error', hookCtx, breakerError);
          yield { type: 'error', error: breakerError };
          yield { type: 'turn_finish', turn: step, usage: turnUsage, metrics };
          completed = true;
          break;
        }
      } else {
        consecutiveErrors = 0;
      }

      yield {
        type: 'step_log',
        log: {
          timestamp: metrics.endTime,
          turn: step,
          stage: 'turn_finish',
          message: `Turn ${step} completed in ${metrics.totalDurationMs}ms (tool duration: ${toolDurationMs}ms). Continuing loop.`,
          durationMs: metrics.totalDurationMs,
          metadata: { metrics },
        },
      };

      yield { type: 'turn_finish', turn: step, usage: turnUsage, metrics };
    }

    // 步数耗尽：显式告知消费方"未产出最终回答"，否则用户只会看到 tool_finish 就回到提示符。
    if (!completed) {
      yield {
        type: 'error',
        error: new Error(
          `Reached max steps limit (${this.maxSteps}); loop terminated before a final answer was produced`,
        ),
      };
    }
  }
}
