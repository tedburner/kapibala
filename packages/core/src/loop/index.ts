import { AbortError } from '../errors/index.js';
import type { ToolExecutor } from '../executor/index.js';
import type { HookRegistry } from '../hooks/registry.js';
import type { ModelProvider } from '../models/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import type {
  CanonicalMessage,
  ContentBlock,
  ModelRequest,
  SessionEvent,
  ToolUseBlock,
  TurnMetrics,
  Usage,
} from '../types/index.js';

export interface AgentLoopOptions {
  provider: ModelProvider;
  executor: ToolExecutor;
  tools: ToolRegistry;
  hooks: HookRegistry;
  systemPrompt?: string;
  maxSteps?: number;
  maxConsecutiveErrors?: number;
  signal?: AbortSignal;
}

export class AgentLoop {
  private readonly provider: ModelProvider;
  private readonly executor: ToolExecutor;
  private readonly tools: ToolRegistry;
  private readonly hooks: HookRegistry;
  private readonly systemPrompt?: string;
  private readonly maxSteps: number;
  private readonly maxConsecutiveErrors: number;
  private readonly signal?: AbortSignal;

  constructor(options: AgentLoopOptions) {
    this.provider = options.provider;
    this.executor = options.executor;
    this.tools = options.tools;
    this.hooks = options.hooks;
    this.systemPrompt = options.systemPrompt;
    this.maxSteps = options.maxSteps ?? 20;
    this.maxConsecutiveErrors = options.maxConsecutiveErrors ?? 3;
    this.signal = options.signal;
  }

  async *run(history: CanonicalMessage[]): AsyncIterable<SessionEvent> {
    let step = 0;
    let consecutiveErrors = 0;
    // 标记循环是否已"有结论"地结束(正常回答/熔断/模型错误)。
    // while 条件自然退出 = 每一轮都以工具调用收尾直到步数耗尽，需要显式告知消费方。
    let completed = false;

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
        messages: history,
        tools: this.tools.definitions(),
        signal: this.signal,
      };

      // 触发 model:before hooks
      const beforeModelHooks = this.hooks.get('model:before');
      const hookCtx = { signal: this.signal };
      for (const hook of beforeModelHooks) {
        request = await hook(hookCtx, request);
      }

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
      let turnUsage: Usage | undefined;
      let turnTtftMs: number | undefined;
      const modelStartTime = Date.now();
      let firstTokenReceived = false;

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
        for await (const event of this.provider.create(request)) {
          if (this.signal?.aborted) throw new AbortError();

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
            yield { type: 'thinking_delta', thinking: event.thinking };
          } else if (event.type === 'tool_call_finish') {
            const toolUse: ToolUseBlock = {
              type: 'tool_use',
              id: event.id,
              name: event.name,
              input: event.input,
            };
            toolCalls.push(toolUse);
          } else if (event.type === 'message_stop') {
            turnUsage = event.usage;
            if (event.ttftMs && turnTtftMs === undefined) {
              turnTtftMs = event.ttftMs;
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof AbortError || this.signal?.aborted) {
          throw new AbortError();
        }
        const modelError = err instanceof Error ? err : new Error(String(err));
        await this.hooks.emit('error', hookCtx, modelError);
        yield { type: 'error', error: modelError };
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

      // 3. 构建完整的 Canonical Assistant Message
      const contentBlocks: ContentBlock[] = [];
      if (accumulatedThinking) {
        contentBlocks.push({ type: 'thinking', thinking: accumulatedThinking });
      }
      if (accumulatedText) {
        contentBlocks.push({ type: 'text', text: accumulatedText });
      }
      for (const tc of toolCalls) {
        contentBlocks.push(tc);
      }

      const assistantMessage: CanonicalMessage = {
        role: 'assistant',
        content: contentBlocks,
        timestamp: Date.now(),
      };

      // 触发 model:after hooks
      await this.hooks.emit('model:after', hookCtx, { message: assistantMessage });

      // 4. 判断是否需要调用工具
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
      const toolResults = await this.executor.runAll(toolCalls);
      const toolDurationMs = Date.now() - toolStartTime;

      const hasError = toolResults.some((result) => result.isError);
      const metrics = buildMetrics(modelDurationMs, toolDurationMs, toolCalls.length);

      // 6. 工具结果回填历史 + 派发落盘事件
      //    assistant 与所有 tool_result 在同一个同步临界段进入历史，并且发生在下一次 yield 前。
      //    因此直接消费 AgentLoop 的调用方即使在任意对外事件后停止，也看不到半闭合历史。
      //    熔断只决定「是否继续循环」，不改变历史的合法性(设计文档 §4.3 / §4.4)。
      const toolMessages = this.provider.assembleToolResults(toolResults);
      history.push(assistantMessage, ...toolMessages);

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
