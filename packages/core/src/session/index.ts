import { AbortError, SessionBusyError } from '../errors/index.js';
import { ToolExecutor } from '../executor/index.js';
import { HookRegistry } from '../hooks/registry.js';
import { AgentLoop } from '../loop/index.js';
import type { ModelProfile, ModelProvider, ModelRole } from '../models/index.js';
import { SimpleModelRouter } from '../models/router.js';
import type { AgentPlugin } from '../plugin/index.js';
import { PromptAssembler } from '../prompt/index.js';
import type { MessageStore } from '../store/index.js';
import { ToolRegistry } from '../tools/registry.js';
import type {
  CanonicalMessage,
  RunMetrics,
  SessionEvent,
  TurnMetrics,
  Usage,
} from '../types/index.js';

export interface SessionConfig {
  defaultProfile: ModelProfile;
  defaultProvider: ModelProvider;
  store?: MessageStore;
  rootDir?: string;
  systemPrompt?: string;
  maxSteps?: number;
  logger?: (msg: string) => void;
}

export interface SessionStats {
  totalTurns: number;
  totalTokens: Usage;
  activeModel: string;
  loadedToolsCount: number;
  lastMetrics?: TurnMetrics;
  lastRunMetrics?: RunMetrics;
}

export class AgentSession {
  readonly rootDir: string;
  readonly tools: ToolRegistry;
  readonly hooks: HookRegistry;
  private readonly router: SimpleModelRouter;
  private readonly store?: MessageStore;
  private readonly customSystemPrompt?: string;
  private readonly maxSteps: number;
  private readonly logger?: (msg: string) => void;

  private history: CanonicalMessage[] = [];
  private totalTurns = 0;
  private usageStats: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private lastMetrics?: TurnMetrics;
  private lastRunMetrics?: RunMetrics;
  private initialized = false;
  private destroyed = false;
  private activeRun = false;
  private readonly plugins: AgentPlugin[] = [];

  constructor(config: SessionConfig) {
    this.rootDir = config.rootDir ?? process.cwd();
    this.tools = new ToolRegistry();
    this.hooks = new HookRegistry();
    this.router = new SimpleModelRouter(config.defaultProfile, config.defaultProvider);
    this.store = config.store;
    this.customSystemPrompt = config.systemPrompt;
    this.maxSteps = config.maxSteps ?? 20;
    this.logger = config.logger;
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.store) {
      this.history = await this.store.load();
    }
    await this.hooks.emit('session:start', { logger: this.logger });
    this.initialized = true;
  }

  async use(plugin: AgentPlugin): Promise<void> {
    if (this.destroyed) {
      throw new Error(`Cannot mount plugin '${plugin.name}': session already destroyed`);
    }
    this.assertIdle(`mount plugin '${plugin.name}'`);
    await plugin.setup({
      tools: this.tools,
      hooks: this.hooks,
      rootDir: this.rootDir,
      logger: this.logger,
    });
    this.plugins.push(plugin);
  }

  switchModel(profile: ModelProfile, role: ModelRole = 'default', provider?: ModelProvider): void {
    this.assertIdle('switch models');
    if (!provider) {
      // 默认使用当前角色的 provider
      provider = this.router.resolve(role);
    }
    this.router.setRole(role, profile, provider);
    this.logger?.(`Switched model for role [${role}] to ${profile.name} (${profile.modelName})`);
  }

  getActiveProfile(role: ModelRole = 'default'): ModelProfile {
    return this.router.getProfile(role);
  }

  getHistory(): CanonicalMessage[] {
    return [...this.history];
  }

  getStats(): SessionStats {
    return {
      totalTurns: this.totalTurns,
      totalTokens: { ...this.usageStats },
      activeModel: this.router.getProfile('default').name,
      loadedToolsCount: this.tools.list().length,
      lastMetrics: this.lastMetrics,
      lastRunMetrics: this.lastRunMetrics,
    };
  }

  getLastMetrics(): TurnMetrics | undefined {
    return this.lastMetrics;
  }

  getLastRunMetrics(): RunMetrics | undefined {
    return this.lastRunMetrics;
  }

  async reset(): Promise<void> {
    this.assertIdle('reset session');
    this.history = [];
    this.totalTurns = 0;
    this.usageStats = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.lastMetrics = undefined;
    this.lastRunMetrics = undefined;
    if (this.store) {
      await this.store.clear();
    }
    this.logger?.('Session context cleared');
  }

  async *run(userInput: string, options?: { signal?: AbortSignal }): AsyncIterable<SessionEvent> {
    this.assertIdle('start another run');
    this.activeRun = true;
    const runStartTime = Date.now();
    const aggregate = {
      modelDurationMs: 0,
      toolDurationMs: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      turns: 0,
      toolCalls: 0,
      ttftMs: undefined as number | undefined,
    };
    let runStatus: RunMetrics['status'] = 'completed';
    let runFinalized = false;

    const finalizeRun = (status: RunMetrics['status']): RunMetrics => {
      const endTime = Date.now();
      return {
        startTime: runStartTime,
        endTime,
        totalDurationMs: endTime - runStartTime,
        ...aggregate,
        status,
      };
    };

    try {
      if (!this.initialized) {
        await this.init();
      }

      this.totalTurns++;

      // 1. 组装并记录 User 消息
      const userMessage: CanonicalMessage = {
        role: 'user',
        content: [{ type: 'text', text: userInput }],
        timestamp: Date.now(),
      };

      this.history.push(userMessage);
      if (this.store) {
        await this.store.append(userMessage);
      }

      // 2. 组装分层 System Prompt
      const promptAssembler = new PromptAssembler({
        tools: this.tools,
        rootDir: this.rootDir,
        customInstructions: this.customSystemPrompt,
      });
      const assembledSystemPrompt = promptAssembler.assemble();

      // 3. 构建执行器与 Loop
      const executor = new ToolExecutor({
        tools: this.tools,
        hooks: this.hooks,
        rootDir: this.rootDir,
        signal: options?.signal,
        logger: this.logger,
      });

      const loop = new AgentLoop({
        provider: this.router.resolve('default'),
        executor,
        tools: this.tools,
        hooks: this.hooks,
        systemPrompt: assembledSystemPrompt,
        maxSteps: this.maxSteps,
        signal: options?.signal,
      });

      // 4. 执行循环并落盘。含 tool_use 的完成事件先缓冲，直到 tool_result 已进入历史并落盘，
      // 外部消费者因此无法在历史半闭合时终止迭代。
      let pendingAssistant: Extract<SessionEvent, { type: 'message_stop' }> | undefined;
      let pendingEvents: SessionEvent[] = [];
      let pendingClosedInMemory = false;
      let pendingAssistantPersisted = false;
      let pendingPersistenceStarted = false;
      let pendingToolMessages: CanonicalMessage[] = [];

      try {
        for await (const event of loop.run(this.history)) {
          if (event.type === 'step_log') {
            this.logger?.(`[Turn ${event.log.turn} | ${event.log.stage}] ${event.log.message}`);
          }
          if (event.type === 'turn_finish') {
            this.lastMetrics = event.metrics;
            aggregate.modelDurationMs += event.metrics.modelDurationMs;
            aggregate.toolDurationMs += event.metrics.toolDurationMs;
            aggregate.promptTokens += event.metrics.promptTokens;
            aggregate.completionTokens += event.metrics.completionTokens;
            aggregate.totalTokens += event.metrics.totalTokens;
            aggregate.turns++;
            aggregate.toolCalls += event.metrics.toolCallsCount;
            aggregate.ttftMs ??= event.metrics.ttftMs;
          }
          if (event.type === 'error') {
            runStatus = 'failed';
          }

          if (
            event.type === 'message_stop' &&
            event.message.content.some((block) => block.type === 'tool_use')
          ) {
            pendingAssistant = event;
            pendingEvents = [event];
            pendingToolMessages = this.findClosedToolMessages(event);
            pendingClosedInMemory = pendingToolMessages.length > 0;
            pendingAssistantPersisted = false;
            pendingPersistenceStarted = false;
            continue;
          }

          if (pendingAssistant) {
            pendingEvents.push(event);
            if (event.type !== 'tool_messages') continue;

            pendingClosedInMemory = true;
            pendingToolMessages = event.messages;
            pendingPersistenceStarted = true;
            await this.persistAssistant(pendingAssistant);
            pendingAssistantPersisted = true;
            await this.persistToolMessages(event.messages);

            const releasable = pendingEvents;
            pendingAssistant = undefined;
            pendingEvents = [];
            for (const buffered of releasable) yield buffered;
            continue;
          }

          if (event.type === 'message_stop') {
            await this.persistAssistant(event);
          } else if (event.type === 'tool_messages') {
            await this.persistToolMessages(event.messages);
          }
          yield event;
        }
      } catch (error: unknown) {
        if (pendingAssistant && !pendingPersistenceStarted) {
          const interruptedMessages = pendingClosedInMemory
            ? pendingToolMessages
            : this.closeInterruptedToolCalls(pendingAssistant, error);
          if (!pendingAssistantPersisted) {
            await this.persistAssistant(pendingAssistant);
          }
          await this.persistToolMessages(interruptedMessages);

          for (const buffered of pendingEvents) yield buffered;
          yield { type: 'tool_messages', messages: interruptedMessages };
        }
        throw error;
      }
      const metrics = finalizeRun(runStatus);
      this.lastRunMetrics = metrics;
      runFinalized = true;
      yield { type: 'run_finish', metrics };
    } catch (error: unknown) {
      const status: RunMetrics['status'] =
        error instanceof AbortError || options?.signal?.aborted ? 'aborted' : 'failed';
      const metrics = finalizeRun(status);
      this.lastRunMetrics = metrics;
      runFinalized = true;
      yield { type: 'run_finish', metrics };
      throw error;
    } finally {
      if (!runFinalized) {
        this.lastRunMetrics = finalizeRun('aborted');
      }
      this.activeRun = false;
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.assertIdle('destroy session');
    this.destroyed = true;

    // 先逐个回收插件资源(MCP 连接、子进程、文件句柄)，再派发 session:end
    for (const plugin of this.plugins) {
      try {
        await plugin.teardown?.();
      } catch (err: unknown) {
        this.logger?.(`Plugin '${plugin.name}' teardown failed: ${(err as Error).message}`);
      }
    }
    this.plugins.length = 0;

    await this.hooks.emit('session:end', { logger: this.logger });
  }

  private assertIdle(operation: string): void {
    if (this.activeRun) throw new SessionBusyError(operation);
  }

  private async persistAssistant(
    event: Extract<SessionEvent, { type: 'message_stop' }>,
  ): Promise<void> {
    if (this.store) await this.store.append(event.message);
    if (event.usage) {
      this.usageStats.promptTokens += event.usage.promptTokens;
      this.usageStats.completionTokens += event.usage.completionTokens;
      this.usageStats.totalTokens += event.usage.totalTokens;
    }
  }

  private async persistToolMessages(messages: CanonicalMessage[]): Promise<void> {
    if (!this.store) return;
    for (const message of messages) await this.store.append(message);
  }

  private closeInterruptedToolCalls(
    assistantEvent: Extract<SessionEvent, { type: 'message_stop' }>,
    error: unknown,
  ): CanonicalMessage[] {
    const message: CanonicalMessage = {
      role: 'tool',
      content: assistantEvent.message.content
        .filter((block) => block.type === 'tool_use')
        .map((toolUse) => ({
          type: 'tool_result' as const,
          toolUseId: toolUse.id,
          content: `Tool execution interrupted before completion: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        })),
      timestamp: Date.now(),
    };
    this.history.push(message);
    return [message];
  }

  private findClosedToolMessages(
    assistantEvent: Extract<SessionEvent, { type: 'message_stop' }>,
  ): CanonicalMessage[] {
    const assistantIndex = this.history.lastIndexOf(assistantEvent.message);
    if (assistantIndex < 0) return [];

    const expected = new Set(
      assistantEvent.message.content
        .filter((block) => block.type === 'tool_use')
        .map((toolUse) => toolUse.id),
    );
    const messages: CanonicalMessage[] = [];
    for (let index = assistantIndex + 1; index < this.history.length; index++) {
      const message = this.history[index]!;
      if (message.role !== 'tool') break;
      messages.push(message);
      for (const block of message.content) {
        if (block.type === 'tool_result') expected.delete(block.toolUseId);
      }
    }
    return expected.size === 0 ? messages : [];
  }
}
