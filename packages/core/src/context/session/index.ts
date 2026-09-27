import {
  type InstructionSnapshot,
  loadInstructions,
} from '../../capabilities/instructions/index.js';
import { PromptAssembler } from '../../capabilities/prompt/index.js';
import {
  type ApprovalChannel,
  SessionApprovalCache,
} from '../../capabilities/security/approval.js';
import {
  type PermissionRule,
  type SessionMode,
  validatePermissionRules,
  visibleTools,
} from '../../capabilities/security/permissions.js';
import { ToolRegistry } from '../../capabilities/tools/registry.js';
import {
  AbortError,
  ModelError,
  type ModelErrorInfo,
  SessionBusyError,
  describeModelError,
} from '../../errors/index.js';
import { HookRegistry } from '../../extensibility/hooks/registry.js';
import {
  createDefaultLogSinks,
  recoverIncompleteAudit,
} from '../../extensibility/logging/file-sink.js';
import {
  type EventLogger,
  StructuredLogger,
  createLogId,
} from '../../extensibility/logging/index.js';
import type { AgentPlugin } from '../../extensibility/plugin/index.js';
import type { ModelProfile, ModelProvider, ModelRole } from '../../models/index.js';
import { SimpleModelRouter, resolveContextWindow } from '../../models/router.js';
import { ToolExecutor } from '../../runtime/executor/index.js';
import { AgentLoop } from '../../runtime/loop/index.js';
import { cancellableGenerator } from '../../types/cancellation.js';
import type {
  CanonicalMessage,
  ContextUsage,
  RunMetrics,
  SessionEvent,
  TurnMetrics,
  Usage,
} from '../../types/index.js';
import type { TokenEstimator } from '../budget.js';
import { createMessageId, identifyHistory } from '../history.js';
import { ContextManager, type ContextSnapshot } from '../manager.js';
import { resolveSessionProject } from '../session-manager.js';
import { supportsSessionState } from '../session-store.js';
import type { MessageStore } from '../store/index.js';

export interface SessionConfig {
  /** 持久会话身份；有版本化 Store 时须与头部一致，日志实例身份保持独立。 */
  conversationId?: string;
  tokenEstimator?: TokenEstimator;
  gitBranch?: string;
  defaultProfile: ModelProfile;
  defaultProvider: ModelProvider;
  store?: MessageStore;
  rootDir?: string;
  systemPrompt?: string;
  maxSteps?: number;
  logger?: (msg: string) => void;
  eventLogger?: EventLogger;
  loggingDirectory?: string;
  mode?: SessionMode;
  permissionRules?: readonly PermissionRule[];
  approvalChannel?: ApprovalChannel;
  projectRoot?: string;
  cwd?: string;
  userInstructionsPath?: string;
  auditRecoveryDirectory?: string;
  /** 接收普通运行日志失败的脱敏诊断；诊断失败也不得中断问答或替代审计。 */
  onDiagnostic?: (message: string) => void;
}

export interface SessionStats {
  conversationId?: string;
  /** 历史存在无 usage 的模型步骤时为 false，不将旧消耗伪装为精确零。 */
  usageKnown?: boolean;
  summaryUsage?: Usage;
  summaryUsageKnown?: boolean;
  contextSnapshot?: ContextSnapshot;
  totalTurns: number;
  totalTokens: Usage;
  activeModel: string;
  loadedToolsCount: number;
  lastMetrics?: TurnMetrics;
  lastRunMetrics?: RunMetrics;
  contextUsage: ContextUsage;
}

export class AgentSession {
  private persistentId: string;
  private readonly configuredConversationId?: string;
  private readonly estimator?: TokenEstimator;
  private readonly onDiagnostic?: (message: string) => void;
  private readonly gitBranch?: string;
  private context: ContextManager;
  private usageKnown = true;
  private summaryUsageKnown = true;
  private summaryUsage: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private readonly summaryAttempts = new Set<string>();
  private readonly accountedAttempts = new Set<string>();
  readonly rootDir: string;
  readonly tools: ToolRegistry;
  readonly hooks: HookRegistry;
  private readonly router: SimpleModelRouter;
  private readonly store?: MessageStore;
  private readonly customSystemPrompt?: string;
  private readonly maxSteps: number;
  private readonly logger?: (msg: string) => void;
  private readonly eventLogger: EventLogger;
  private readonly sessionId = createLogId();
  private mode: SessionMode;
  private readonly permissionRules: readonly PermissionRule[];
  private readonly approvalChannel?: ApprovalChannel;
  private readonly approvalCache = new SessionApprovalCache();
  private readonly projectRoot: string;
  private readonly cwd: string;
  private readonly userInstructionsPath?: string;
  private instructionSnapshot?: InstructionSnapshot;
  private readonly auditRecoveryDirectory?: string;

  private history: CanonicalMessage[] = [];
  private totalTurns = 0;
  private usageStats: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  private lastMetrics?: TurnMetrics;
  private lastRunMetrics?: RunMetrics;
  private initialized = false;
  private pendingResume = false;
  private destroyed = false;
  private cleanupStarted = false;
  private cleanupPromise?: Promise<void>;
  private sessionEndFinished = false;
  private activeRun = false;
  private readonly plugins: AgentPlugin[] = [];

  constructor(config: SessionConfig) {
    this.persistentId = config.conversationId ?? createMessageId();
    this.configuredConversationId = config.conversationId;
    this.estimator = config.tokenEstimator;
    this.onDiagnostic = config.onDiagnostic;
    this.gitBranch = config.gitBranch;
    resolveContextWindow(config.defaultProfile.contextWindow);
    this.rootDir = config.rootDir ?? process.cwd();
    this.tools = new ToolRegistry();
    this.hooks = new HookRegistry();
    this.router = new SimpleModelRouter(config.defaultProfile, config.defaultProvider);
    this.store = config.store;
    this.customSystemPrompt = config.systemPrompt;
    this.maxSteps = config.maxSteps ?? 20;
    this.logger = config.logger;
    validatePermissionRules(config.permissionRules ?? []);
    this.mode = config.mode ?? 'Approval';
    this.permissionRules = config.permissionRules ?? [];
    this.approvalChannel = config.approvalChannel;
    this.projectRoot = config.projectRoot ?? this.rootDir;
    this.cwd = config.cwd ?? this.rootDir;
    this.userInstructionsPath = config.userInstructionsPath;
    const sinks = config.eventLogger ? undefined : createDefaultLogSinks(config.loggingDirectory);
    const eventLogger =
      config.eventLogger ??
      new StructuredLogger({
        operationSink: sinks!.operationSink,
        auditSink: sinks!.auditSink,
        debug: config.logger !== undefined,
        onDiagnostic: config.onDiagnostic ?? config.logger,
      });
    this.eventLogger = {
      record: (input) => eventLogger.record({ ...input, conversationId: this.persistentId }),
      recordAudit: (input) =>
        eventLogger.recordAudit({ ...input, conversationId: this.persistentId }),
    };
    this.auditRecoveryDirectory = config.auditRecoveryDirectory ?? sinks?.auditSink.directory;
    this.context = this.createContextManager();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.auditRecoveryDirectory) {
      const count = await recoverIncompleteAudit(this.auditRecoveryDirectory);
      if (count > 0)
        await this.eventLogger.record({
          level: 'warn',
          event: 'audit.recovered_unknown',
          sessionId: this.sessionId,
          fields: { count },
        });
    }
    this.instructionSnapshot = loadInstructions({
      projectRoot: this.projectRoot,
      cwd: this.cwd,
      userFile: this.userInstructionsPath,
    });
    if (this.store) {
      this.history = identifyHistory(await this.store.load(), 'legacy-sdk');
      if (supportsSessionState(this.store)) {
        const state = await this.store.loadState();
        if (
          this.configuredConversationId &&
          this.configuredConversationId !== state.header.conversationId
        )
          throw new Error('Session conversation identity mismatch');
        this.persistentId = state.header.conversationId;
        this.totalTurns = state.records.filter((r) => r.type === 'run_started').length;
        for (const record of state.records.filter(
          (r) => r.type === 'usage' && r.payload.role === 'primary',
        )) {
          this.accountUsage(
            String(record.payload.attemptId),
            record.payload.usage as unknown as Usage,
          );
        }
        for (const record of state.records.filter(
          (r) => r.type === 'usage' && r.payload.role === 'summary',
        )) {
          this.accountSummaryUsage(
            String(record.payload.attemptId),
            record.payload.usage as unknown as Usage | undefined,
          );
        }
        this.usageKnown =
          !this.history.some((m) => m.role === 'assistant') ||
          (state.records.some((r) => r.type === 'usage' && r.payload.role === 'primary') &&
            !state.records.some(
              (r) => r.type === 'run_finished' && r.payload.usageKnown === false,
            ));
      } else this.usageKnown = this.history.length === 0;
    }
    this.context = this.createContextManager();
    await this.context.restore(this.history);
    this.pendingResume = this.history.length > 0;
    await this.hooks.emit('session:start', { logger: this.logger });
    await this.eventLogger.record({
      level: 'info',
      event: 'session.started',
      sessionId: this.sessionId,
      fields: { modelId: this.router.getProfile('default').id },
    });
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
    resolveContextWindow(profile.contextWindow);
    if (!provider) {
      // 默认使用当前角色的 provider
      provider = this.router.resolve(role);
    }
    this.router.setRole(role, profile, provider);
    this.context.invalidate();
    this.logger?.(`Switched model for role [${role}] to ${profile.name} (${profile.modelName})`);
  }

  getActiveProfile(role: ModelRole = 'default'): ModelProfile {
    return this.router.getProfile(role);
  }

  /** 只在空闲时切换本次会话模式；宿主负责 FullAccess 的显式选择交互。 */
  switchMode(mode: SessionMode): void {
    this.assertIdle('switch permission mode');
    this.mode = mode;
  }

  getMode(): SessionMode {
    return this.mode;
  }

  /** 返回最近一次成功装载的来源路径，不暴露指令正文。 */
  getInstructionSources(): string[] {
    return this.instructionSnapshot?.sources.map((source) => source.path) ?? [];
  }

  /** 稳定会话身份，独立于当前进程日志实例和每次用户交互。 */
  get conversationId(): string {
    return this.persistentId;
  }

  /** 返回原始历史独立快照，外部修改不会改变落盘事实或当前工具事务。 */
  getHistory(): CanonicalMessage[] {
    return structuredClone(this.history);
  }

  /** 返回当前投影视图，区别于原始历史；不执行模型或 Hook。 */
  getContextHistory(): CanonicalMessage[] {
    return this.context.project(this.history);
  }

  /** 查询最近最终请求的预算快照，尚未准备请求时返回 undefined。 */
  getContextSnapshot(): ContextSnapshot | undefined {
    const snapshot = this.context.getSnapshot();
    if (snapshot || !this.initialized) return snapshot;
    const assembler = new PromptAssembler({
      rootDir: this.rootDir,
      tools: this.tools,
      customInstructions: this.customSystemPrompt,
      instructionSources: this.instructionSnapshot?.sources,
      visibleTools: visibleTools(this.tools.list(), this.mode, this.permissionRules),
    });
    return this.context.inspect(
      this.history,
      {
        systemPrompt: assembler.assemble(),
        messages: this.context.project(this.history),
        tools: visibleTools(this.tools.list(), this.mode, this.permissionRules).map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
      this.router.getProfile('default'),
    );
  }

  /** 执行中止后的工具/摘要与存储收口期间仍返回 true。 */
  isBusy(): boolean {
    return this.activeRun;
  }

  /** 返回独立统计快照，宿主修改嵌套指标不会改变会话状态或预算展示。 */
  getStats(): SessionStats {
    return structuredClone({
      conversationId: this.persistentId,
      usageKnown: this.usageKnown,
      summaryUsage: { ...this.summaryUsage },
      summaryUsageKnown: this.summaryUsageKnown,
      contextSnapshot: this.getContextSnapshot(),
      totalTurns: this.totalTurns,
      totalTokens: { ...this.usageStats },
      activeModel: this.router.getProfile('default').name,
      loadedToolsCount: this.tools.list().length,
      lastMetrics: this.lastMetrics,
      lastRunMetrics: this.lastRunMetrics,
      contextUsage: this.lastRunMetrics?.contextUsage ?? this.createContextUsage(),
    });
  }

  /** 返回最近请求指标的独立副本；尚无完成请求时返回 undefined。 */
  getLastMetrics(): TurnMetrics | undefined {
    return this.lastMetrics ? structuredClone(this.lastMetrics) : undefined;
  }

  /** 返回最近用户任务指标的独立副本；恢复的 usage 不伪造实时任务指标。 */
  getLastRunMetrics(): RunMetrics | undefined {
    return this.lastRunMetrics ? structuredClone(this.lastRunMetrics) : undefined;
  }

  async reset(): Promise<void> {
    this.assertIdle('reset session');
    if (this.store) await this.store.clear();
    this.history = [];
    this.totalTurns = 0;
    this.pendingResume = false;
    this.usageStats = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.lastMetrics = undefined;
    this.lastRunMetrics = undefined;
    this.accountedAttempts.clear();
    this.usageKnown = true;
    this.summaryAttempts.clear();
    this.summaryUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.summaryUsageKnown = true;
    this.context.reset();
    this.logger?.('Session context cleared');
  }

  /**
   * 执行一次用户输入，并以宿主无关的语义事件流返回全过程。
   *
   * Core 不负责终端或图形界面渲染；CLI、TUI、GUI 与其它宿主应消费同一组
   * {@link SessionEvent}，分别完成展示、交互和中止控制。
   *
   * @param userInput 用户本轮输入。
   * @param options 可选的中止信号。
   * @returns 文本、思考、工具、指标和错误等结构化事件的异步流。
   * @throws {SessionBusyError} 当前会话已有正在执行的 run 时抛出。
   */
  run(userInput: string, options?: { signal?: AbortSignal }): AsyncIterable<SessionEvent> {
    return cancellableGenerator(
      (signal) => this.runOperation(userInput, { signal }),
      options?.signal,
    );
  }

  /** 单次任务执行主体；调用方 return 的中止与 finally 清理由外层统一协调。 */
  private async *runOperation(
    userInput: string,
    options?: { signal?: AbortSignal },
  ): AsyncGenerator<SessionEvent> {
    this.assertIdle('start another run');
    resolveContextWindow(this.router.getProfile('default').contextWindow);
    this.activeRun = true;
    const runId = createLogId();
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
    let lastPromptTokens: number | undefined;
    let lastEstimatedPromptTokens: number | undefined;
    let runStatus: RunMetrics['status'] = 'completed';
    let modelFailure: ModelErrorInfo | undefined;
    let runFinalized = false;
    let runStarted = false;

    const finalizeRun = (status: RunMetrics['status']): RunMetrics => {
      const endTime = Date.now();
      if (lastEstimatedPromptTokens !== undefined && lastPromptTokens === undefined)
        this.usageKnown = false;
      return {
        startTime: runStartTime,
        endTime,
        totalDurationMs: endTime - runStartTime,
        ...aggregate,
        status,
        ...(modelFailure ? { failure: modelFailure } : {}),
        contextUsage: this.createContextUsage(
          lastPromptTokens ?? lastEstimatedPromptTokens,
          lastPromptTokens === undefined && lastEstimatedPromptTokens !== undefined,
        ),
      };
    };

    try {
      if (!this.initialized) {
        await this.init();
      }
      if (this.pendingResume) {
        this.pendingResume = false;
        yield {
          type: 'session_resumed',
          conversationId: this.conversationId,
          runtimeSessionId: this.sessionId,
          messageCount: this.history.length,
        };
      }

      await this.eventLogger.record({
        level: 'info',
        event: 'run.started',
        sessionId: this.sessionId,
        runId,
      });

      try {
        this.instructionSnapshot = loadInstructions({
          projectRoot: this.projectRoot,
          cwd: this.cwd,
          userFile: this.userInstructionsPath,
        });
      } catch (error: unknown) {
        await this.eventLogger.record({
          level: 'warn',
          event: 'instructions.refresh_failed',
          sessionId: this.sessionId,
          runId,
          fields: { status: 'retained_previous_snapshot' },
        });
        if (!this.instructionSnapshot) throw error;
      }

      this.totalTurns++;
      if (this.store && supportsSessionState(this.store)) {
        const currentProject = resolveSessionProject(this.cwd);
        await this.store.appendRecord('run_started', {
          interactionId: runId,
          runId,
          runtimeSessionId: this.sessionId,
          gitBranch: currentProject.gitWorktree ? currentProject.gitBranch : this.gitBranch,
          modelId: this.router.getProfile('default').id,
        });
      }
      runStarted = true;

      // 1. 组装并记录 User 消息
      const userMessage: CanonicalMessage = {
        id: createMessageId(),
        interactionId: runId,
        state: 'completed',
        role: 'user',
        content: [{ type: 'text', text: userInput }],
        timestamp: Date.now(),
      };

      if (this.store) {
        await this.store.append(userMessage);
      }
      this.history.push(userMessage);

      // 2. 组装分层 System Prompt
      const promptAssembler = new PromptAssembler({
        tools: this.tools,
        rootDir: this.rootDir,
        customInstructions: this.customSystemPrompt,
        instructionSources: this.instructionSnapshot.sources,
        visibleTools: visibleTools(this.tools.list(), this.mode, this.permissionRules),
      });
      const assembledSystemPrompt = promptAssembler.assemble();

      // 3. 构建执行器与 Loop
      const executor = new ToolExecutor({
        tools: this.tools,
        hooks: this.hooks,
        rootDir: this.rootDir,
        signal: options?.signal,
        logger: this.logger,
        eventLogger: this.eventLogger,
        sessionId: this.sessionId,
        runId,
        mode: () => this.mode,
        permissionRules: this.permissionRules,
        approvalChannel: this.approvalChannel,
        approvalCache: this.approvalCache,
      });

      const loop = new AgentLoop({
        interactionId: runId,
        modelId: this.router.getProfile('default').id,
        projectHistory: (history) => this.context.project(history),
        prepareRequest: (request, history, reason) => {
          // 精确时间属于当前请求的动态后缀，不进入稳定系统前缀或原始历史。
          const dynamicId = `environment-${runId}`;
          const messages = request.messages.filter((message) => message.id !== dynamicId);
          messages.push({
            id: dynamicId,
            role: 'user',
            content: [
              {
                type: 'text',
                text: `[Current environment data: ${new Date(runStartTime).toISOString()}]`,
              },
            ],
            timestamp: runStartTime,
          });
          const context = this.context;
          const preparation = context.prepare(
            history,
            { ...request, messages },
            this.router.getProfile('default'),
            runId,
            reason,
          );
          return (async function* () {
            const prepared = yield* preparation;
            // 每个请求独立统计；不能将前一步实测 usage 冒充失败请求的当前上下文。
            lastPromptTokens = undefined;
            lastEstimatedPromptTokens = context.getSnapshot()?.estimate.total;
            return prepared;
          })();
        },
        onUsage: async (request, usage, attemptId) => {
          lastPromptTokens = usage.promptTokens;
          if (this.accountedAttempts.has(attemptId)) return;
          if (this.store && supportsSessionState(this.store))
            await this.store.appendRecord('usage', {
              attemptId,
              role: 'primary',
              modelId: this.router.getProfile('default').id,
              usage: { ...usage },
            });
          this.accountUsage(attemptId, usage);
          this.context.observe(request, usage, this.router.getProfile('default'));
        },
        provider: this.router.resolve('default'),
        executor,
        tools: this.tools,
        hooks: this.hooks,
        systemPrompt: assembledSystemPrompt,
        maxSteps: this.maxSteps,
        signal: options?.signal,
        eventLogger: this.eventLogger,
        sessionId: this.sessionId,
        runId,
        getMode: () => this.mode,
        permissionRules: this.permissionRules,
      });

      // 4. 执行循环并落盘。含 tool_use 的完成事件先缓冲，直到 tool_result 已进入历史并落盘，
      // 外部消费者因此无法在历史半闭合时终止迭代。
      let pendingAssistant: Extract<SessionEvent, { type: 'message_stop' }> | undefined;
      let pendingEvents: SessionEvent[] = [];
      let pendingClosedInMemory = false;
      let pendingAssistantPersisted = false;
      let pendingPersistenceStarted = false;
      let pendingToolMessages: CanonicalMessage[] = [];
      let persistedHistoryLength = this.history.length;
      let loopCompleted = false;
      let loopFailed = false;

      try {
        for await (const event of loop.run(this.history)) {
          await this.logContextEvent(event, runId);
          if (event.type === 'step_log') {
            this.logger?.(`[Turn ${event.log.turn} | ${event.log.stage}] ${event.log.message}`);
            await this.eventLogger.record({
              level: 'debug',
              event: 'diagnostic.step',
              sessionId: this.sessionId,
              runId,
              fields: {
                phase: event.log.stage,
                durationMs: event.log.durationMs ?? 0,
                attempt: event.log.turn,
              },
            });
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
            modelFailure =
              event.modelError ??
              (event.error instanceof ModelError
                ? describeModelError(event.error, {
                    operation: 'primary',
                    modelId: this.router.getProfile('default').id,
                    provider: this.router.resolve('default').name,
                  })
                : undefined);
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
            persistedHistoryLength = this.history.length;

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
          if (event.type === 'message_stop' || event.type === 'tool_messages') {
            persistedHistoryLength = this.history.length;
          }
          yield event;
        }
        loopCompleted = true;
      } catch (error: unknown) {
        loopFailed = true;
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
      } finally {
        // 早退时 Loop 的 finally 已等待工具并闭合历史，但不会再发出落盘事件。
        // 仅追加正常落盘游标之后的消息，避免重复已完成的事务或重试失败的写入。
        if (!loopCompleted && !loopFailed && this.store) {
          for (const message of this.history.slice(persistedHistoryLength)) {
            await this.store.append(message);
          }
        }
      }
      const metrics = finalizeRun(runStatus);
      this.lastRunMetrics = metrics;
      runFinalized = true;
      await this.eventLogger.record({
        level: 'info',
        event: 'run.finished',
        sessionId: this.sessionId,
        runId,
        fields: { status: metrics.status, durationMs: metrics.totalDurationMs },
      });
      yield { type: 'run_finish', metrics };
    } catch (error: unknown) {
      if (error instanceof ModelError)
        modelFailure = describeModelError(error, {
          operation: 'primary',
          modelId: this.router.getProfile('default').id,
          provider: this.router.resolve('default').name,
        });
      const status: RunMetrics['status'] =
        error instanceof AbortError || options?.signal?.aborted ? 'aborted' : 'failed';
      const metrics = finalizeRun(status);
      this.lastRunMetrics = metrics;
      runFinalized = true;
      await this.eventLogger.record({
        level: 'error',
        event: 'run.finished',
        sessionId: this.sessionId,
        runId,
        fields: { status: metrics.status, durationMs: metrics.totalDurationMs },
      });
      yield { type: 'run_finish', metrics };
      throw error;
    } finally {
      try {
        if (!runFinalized) this.lastRunMetrics = finalizeRun('aborted');
      } finally {
        try {
          if (runStarted) {
            const metricStatus = this.lastRunMetrics?.status;
            const terminalStatus =
              !runFinalized || metricStatus === 'aborted'
                ? 'interrupted'
                : metricStatus === 'failed'
                  ? 'failed'
                  : 'completed';
            if (this.store && supportsSessionState(this.store))
              await this.store.appendRecord('run_finished', {
                interactionId: runId,
                runId,
                status: terminalStatus,
                usageKnown: this.usageKnown,
              });
            this.context.finishInteraction({ interactionId: runId, status: terminalStatus });
          }
        } finally {
          this.activeRun = false;
        }
      }
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    if (this.activeRun) throw new SessionBusyError('destroy session');
    if (this.cleanupPromise) return this.cleanupPromise;
    this.cleanupStarted = true;
    this.cleanupPromise = (async () => {
      const failures: unknown[] = [];
      for (const plugin of [...this.plugins]) {
        try {
          await plugin.teardown?.();
          this.plugins.splice(this.plugins.indexOf(plugin), 1);
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Plugin teardown failed');
      if (!this.sessionEndFinished) {
        await this.hooks.emit('session:end', { logger: this.logger });
        this.sessionEndFinished = true;
      }
      this.destroyed = true;
    })();
    try {
      await this.cleanupPromise;
    } finally {
      this.cleanupPromise = undefined;
    }
  }

  private assertIdle(operation: string): void {
    if (this.destroyed) throw new Error('Session already destroyed');
    if (this.cleanupStarted) throw new Error('Session cleanup has started');
    if (this.activeRun) throw new SessionBusyError(operation);
  }

  /**
   * 计算最近一次内部模型请求的上下文占用；无 usage 时显式标注预算估算。
   * run 累计 promptTokens 会重复计算每一步都重发的历史，不能用于窗口占用率。
   */
  private createContextUsage(usedTokens?: number, estimatedUsage = false): ContextUsage {
    const contextWindow = resolveContextWindow(this.router.getProfile('default').contextWindow);
    return {
      usedTokens,
      limitTokens: contextWindow.tokens,
      percent: usedTokens === undefined ? undefined : (usedTokens / contextWindow.tokens) * 100,
      estimatedLimit: contextWindow.estimated,
      ...(estimatedUsage ? { estimatedUsage: true } : {}),
    };
  }

  private async persistAssistant(
    event: Extract<SessionEvent, { type: 'message_stop' }>,
  ): Promise<void> {
    if (this.store) await this.store.append(event.message);
    if (!event.usage) this.usageKnown = false;
  }

  /** 创建上下文协调器并注入当前路由；摘要不经过主任务 Loop，插件结果不默认为可剪裁。 */
  private createContextManager(): ContextManager {
    return new ContextManager({
      conversationId: this.persistentId,
      store: this.store,
      estimator: this.estimator,
      onDiagnostic: this.onDiagnostic,
      router: this.router,
      projectRoot: this.projectRoot,
      builtInToolNames: () =>
        new Set(
          this.tools
            .list()
            .filter((t) => t.metadata?.source === 'builtin')
            .map((t) => t.name),
        ),
      onSummaryUsage: async (attemptId, usage) => this.accountSummaryUsage(attemptId, usage),
    });
  }

  /** 摘要实际消耗按 attempt 身份独立累加；缺失消耗保留未知，不计入主任务指标。 */
  private accountSummaryUsage(attemptId: string, usage?: Usage): void {
    if (this.summaryAttempts.has(attemptId)) return;
    this.summaryAttempts.add(attemptId);
    if (
      !usage ||
      ![usage.promptTokens, usage.completionTokens, usage.totalTokens].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    ) {
      this.summaryUsageKnown = false;
      return;
    }
    this.summaryUsage.promptTokens += usage.promptTokens;
    this.summaryUsage.completionTokens += usage.completionTokens;
    this.summaryUsage.totalTokens += usage.totalTokens;
  }

  /**
   * 空闲时手动摘要旧完整前缀，不创建用户任务、不执行工具，不突破当前与最近成功交互。
   * 迭代结束或取消后等候摘要与提交收口，再释放执行状态；已提交检查点保持有效。
   */
  compact(options?: { signal?: AbortSignal }): AsyncGenerator<SessionEvent> {
    return cancellableGenerator((signal) => this.compactOperation({ signal }), options?.signal);
  }

  /** 手动压缩执行主体，接收由消费者生命周期拥有的中止信号。 */
  private async *compactOperation(options?: {
    signal?: AbortSignal;
  }): AsyncGenerator<SessionEvent> {
    this.assertIdle('compact context');
    this.activeRun = true;
    try {
      if (!this.initialized) await this.init();
      const assembler = new PromptAssembler({
        rootDir: this.rootDir,
        tools: this.tools,
        customInstructions: this.customSystemPrompt,
        instructionSources: this.instructionSnapshot?.sources,
        visibleTools: visibleTools(this.tools.list(), this.mode, this.permissionRules),
      });
      for await (const event of this.context.prepare(
        this.history,
        {
          systemPrompt: assembler.assemble(),
          messages: this.context.project(this.history),
          signal: options?.signal,
          tools: visibleTools(this.tools.list(), this.mode, this.permissionRules).map((t) => ({
            name: t.name,
            description: t.description,
            parameters: t.parameters,
          })),
        },
        this.router.getProfile('default'),
        undefined,
        'manual',
      )) {
        await this.logContextEvent(event);
        yield event;
      }
    } finally {
      this.activeRun = false;
    }
  }

  /** 以模型 attempt 身份幂等累加真实消耗；非法或缺失 usage 保持未知。 */
  private async logContextEvent(event: SessionEvent, runId?: string): Promise<void> {
    if (
      event.type !== 'compaction_start' &&
      event.type !== 'compaction_finish' &&
      event.type !== 'compaction_failed' &&
      event.type !== 'context_budget_exceeded'
    )
      return;
    await this.eventLogger.record({
      level: event.type === 'compaction_failed' ? 'warn' : 'info',
      event: event.type.replaceAll('_', '.'),
      sessionId: this.sessionId,
      runId,
      fields: {
        count: event.type === 'compaction_finish' ? event.prunedResults : undefined,
        status: event.type === 'compaction_finish' ? 'committed' : event.type,
        ...(event.type === 'compaction_failed'
          ? {
              errorCode: event.errorCode,
              providerCode: event.modelError?.providerCode,
              providerType: event.modelError?.providerType,
              transportCode: event.modelError?.transportCode,
              retryPolicy: event.modelError?.retryPolicy,
              phase: event.modelError?.stage,
              httpStatus: event.modelError?.status,
              category: event.modelError?.category,
            }
          : {}),
      },
    });
  }

  /** 以模型 attempt 身份幂等累加真实消耗；非法或缺失 usage 保持未知。 */
  private accountUsage(attemptId: string, usage: Usage): void {
    if (this.accountedAttempts.has(attemptId)) return;
    if (
      !usage ||
      ![usage.promptTokens, usage.completionTokens, usage.totalTokens].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    ) {
      this.usageKnown = false;
      return;
    }
    this.accountedAttempts.add(attemptId);
    this.usageStats.promptTokens += usage.promptTokens;
    this.usageStats.completionTokens += usage.completionTokens;
    this.usageStats.totalTokens += usage.totalTokens;
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
      id: createMessageId(),
      role: 'tool',
      content: assistantEvent.message.content
        .filter((block) => block.type === 'tool_use')
        .map((toolUse) => ({
          type: 'tool_result' as const,
          toolUseId: toolUse.id,
          content: JSON.stringify({
            code: 'OUTCOME_UNKNOWN',
            retryPolicy: 'after_user_action',
            message: 'Tool execution was interrupted; outcome is unknown',
          }),
          isError: true,
          errorCode: 'OUTCOME_UNKNOWN',
          retryPolicy: 'after_user_action' as const,
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
