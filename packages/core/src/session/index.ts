import { ToolExecutor } from '../executor/index.js';
import { HookRegistry } from '../hooks/registry.js';
import { AgentLoop } from '../loop/index.js';
import type { ModelProfile, ModelProvider, ModelRole } from '../models/index.js';
import { SimpleModelRouter } from '../models/router.js';
import type { AgentPlugin } from '../plugin/index.js';
import { PromptAssembler } from '../prompt/index.js';
import type { MessageStore } from '../store/index.js';
import { ToolRegistry } from '../tools/registry.js';
import type { CanonicalMessage, SessionEvent, TurnMetrics, Usage } from '../types/index.js';

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
  private initialized = false;
  private destroyed = false;
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
    await plugin.setup({
      tools: this.tools,
      hooks: this.hooks,
      rootDir: this.rootDir,
      logger: this.logger,
    });
    this.plugins.push(plugin);
  }

  switchModel(profile: ModelProfile, role: ModelRole = 'default', provider?: ModelProvider): void {
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
    };
  }

  getLastMetrics(): TurnMetrics | undefined {
    return this.lastMetrics;
  }

  async reset(): Promise<void> {
    this.history = [];
    this.totalTurns = 0;
    this.usageStats = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    if (this.store) {
      await this.store.clear();
    }
    this.logger?.('Session context cleared');
  }

  async *run(userInput: string, options?: { signal?: AbortSignal }): AsyncIterable<SessionEvent> {
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

    // 4. 执行循环并落盘
    for await (const event of loop.run(this.history)) {
      if (event.type === 'step_log') {
        this.logger?.(`[Turn ${event.log.turn} | ${event.log.stage}] ${event.log.message}`);
      }
      if (event.type === 'turn_finish') {
        this.lastMetrics = event.metrics;
      }
      if (event.type === 'message_stop') {
        if (this.store) {
          await this.store.append(event.message);
        }
        if (event.usage) {
          this.usageStats.promptTokens += event.usage.promptTokens;
          this.usageStats.completionTokens += event.usage.completionTokens;
          this.usageStats.totalTokens += event.usage.totalTokens;
        }
      }
      if (event.type === 'tool_messages') {
        // 消息级落盘(设计文档 §4.4)：tool_result 必须落盘，
        // 否则重启后历史里只有 tool_use 而缺 tool_result，下一次请求直接 400。
        if (this.store) {
          for (const message of event.messages) {
            await this.store.append(message);
          }
        }
      }
      yield event;
    }
  }

  async destroy(): Promise<void> {
    if (this.destroyed) return;
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
}
