/**
 * @fileoverview MCP 服务管理器与连接所有权状态编排
 *
 * 约束与边界：
 * 1. 负责单个宿主会话下的所有 MCP 服务连接生命周期管理与并发限制（默认并发 4，整体截止 15s）；
 * 2. 严格遵循 Required 门禁：声明为 required 的服务若未能达到可用就绪状态，整体启动失败并自动执行完全回滚（rollback）；
 * 3. 失败回滚与 teardown 保证所有创建的子进程与网络传输均被彻底回收，禁止遗留孤儿进程或悬挂异步任务；
 * 4. 手动重连（reconnectServer）必须沿用当前内存中已解析授权的配置，严禁在重连时重新读取磁盘或篡改配置；
 * 5. 每次重连单调递增 generation，彻底防范旧代次的迟到关闭或异步回调污染新连接状态。
 */

import type { Tool, ToolRegistry } from '@kiturone/kapibala';
import {
  type ServerStartAuthorizationResult,
  type ServerStartAuthorizer,
  type ServerStartupApprovalCache,
  ServerStartupCoordinator,
  type ServerStartupDescriptor,
} from './auth.js';
import { McpClientSession } from './client.js';
import type {
  HttpServerConfig,
  ResolveMcpConfigResult,
  ResolvedServerEntry,
  ServerConfig,
  StdioServerConfig,
} from './config.js';
import { detectCredentialAlerts, extractReferencedEnvVars } from './env.js';
import { McpPromptRegistry, discoverAndPublishPrompts } from './prompts/registry.js';
import { discoverAndPublishTools } from './tools/catalog.js';
import { type ManagedHttpTransport, createManagedHttpTransport } from './transports/http.js';
import { type ManagedStdioTransport, createManagedStdioTransport } from './transports/stdio.js';
import type {
  CapabilityCatalogState,
  McpManagerOptions,
  McpServerStatus,
  McpStartupResult,
  ServerConnectionState,
  ServerStartupOptions,
} from './types.js';

/**
 * MCP 服务配置输入类型，支持完整解析结果、Map 或普通字典。
 */
export type McpServersInput =
  | ResolveMcpConfigResult
  | Map<string, ResolvedServerEntry>
  | Map<string, ServerConfig>
  | Record<string, ServerConfig>;

/**
 * 判断是否为 Stdio 服务配置。
 */
export function isStdioConfig(config: ServerConfig): config is StdioServerConfig {
  return 'command' in config && typeof (config as StdioServerConfig).command === 'string';
}

/**
 * 判断是否为 HTTP 服务配置。
 */
export function isHttpConfig(config: ServerConfig): config is HttpServerConfig {
  return 'url' in config && typeof (config as HttpServerConfig).url === 'string';
}

/**
 * 内部受管服务项记录。
 */
interface ManagedServerEntry {
  name: string;
  config: ServerConfig;
  enabled: boolean;
  source?: 'global' | 'project';
  generation: number;
  connectionState: ServerConnectionState;
  toolsState: CapabilityCatalogState;
  promptsState: CapabilityCatalogState;
  session?: McpClientSession;
  managedTransport?: ManagedStdioTransport;
  managedHttpTransport?: ManagedHttpTransport;
  errorMessage?: string;
}

/**
 * 提取规范化后的配置映射表。
 */
function extractServerConfigMap(
  input: McpServersInput,
): Map<string, { config: ServerConfig; source?: 'global' | 'project' }> {
  const result = new Map<string, { config: ServerConfig; source?: 'global' | 'project' }>();
  if ('servers' in input && input.servers instanceof Map) {
    for (const [k, v] of input.servers.entries()) {
      result.set(k, { config: v.config, source: v.source });
    }
  } else if (input instanceof Map) {
    for (const [k, v] of input.entries()) {
      result.set(k, { config: (v as any).config ?? v, source: (v as any).source });
    }
  } else {
    for (const [k, v] of Object.entries(input)) {
      result.set(k, { config: (v as any).config ?? v, source: (v as any).source });
    }
  }
  return result;
}

/**
 * MCP 客户端服务连接池与生命周期管理器。
 */
export class McpServerManager {
  readonly promptRegistry = new McpPromptRegistry();
  readonly coordinator: ServerStartupCoordinator;
  private readonly servers = new Map<string, ManagedServerEntry>();
  private readonly options: McpManagerOptions;
  private readonly _startupAbortController = new AbortController();
  private _isTornDown = false;
  private _teardownPromise: Promise<void> | null = null;

  /**
   * 创建 MCP 服务管理器。
   *
   * @param options - 管理器全局启动与超时配置。
   */
  constructor(options: McpManagerOptions = {}) {
    this.options = {
      maxConcurrentStartups: 4,
      overallDeadlineMs: 15000,
      startupTimeoutMs: 10000,
      catalogTimeoutMs: 10000,
      cleanupTimeoutMs: 5000,
      ...options,
    };
    if (options.startupCoordinator) {
      this.coordinator = options.startupCoordinator;
    } else {
      this.coordinator = new ServerStartupCoordinator({
        authorizer: options.authorizer,
        cache: options.startupCache,
      });
    }
  }

  private toolRegistry?: ToolRegistry;

  /**
   * 绑定宿主会话的 ToolRegistry，供服务发布与注销工具使用。
   */
  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
  }

  /**
   * 构造会话目录变更通知回调，将服务端的 list_changed 事件实时同步到宿主注册表。
   */
  private createSessionCatalogChangeHandler(serverName: string, config: ServerConfig) {
    return async (
      kind: 'tools' | 'prompts',
      session: McpClientSession,
      status: { epoch: number; state: CapabilityCatalogState },
    ) => {
      const entry = this.servers.get(serverName);
      if (!entry || entry.session !== session) return;

      const initialGen = entry.generation;
      const initialEpoch = status.epoch;

      if (kind === 'tools') {
        if (status.state === 'ready' && this.toolRegistry) {
          try {
            await discoverAndPublishTools(
              session,
              config,
              this.toolRegistry,
              this.options.catalogTimeoutMs ?? config.catalogTimeoutMs ?? 10000,
              () =>
                !this._isTornDown &&
                entry.session === session &&
                entry.generation === initialGen &&
                session.toolsCatalogEpoch === initialEpoch &&
                session.isReady(),
            );
            if (entry.session === session && entry.generation === initialGen) {
              entry.toolsState = 'ready';
            }
          } catch {
            if (entry.session === session && entry.generation === initialGen) {
              entry.toolsState = 'unavailable';
            }
          }
        } else if (status.state === 'unavailable') {
          if (entry.session === session && entry.generation === initialGen) {
            entry.toolsState = 'unavailable';
            this.toolRegistry?.unregisterSource(`mcp:${serverName}`);
          }
        } else {
          if (entry.session === session && entry.generation === initialGen) {
            entry.toolsState = status.state;
          }
        }
      } else if (kind === 'prompts') {
        if (status.state === 'ready') {
          try {
            await discoverAndPublishPrompts(
              session,
              this.promptRegistry,
              this.options.catalogTimeoutMs ?? config.catalogTimeoutMs ?? 10000,
              () =>
                !this._isTornDown &&
                entry.session === session &&
                entry.generation === initialGen &&
                session.promptsCatalogEpoch === initialEpoch &&
                session.isReady(),
            );
            if (entry.session === session && entry.generation === initialGen) {
              entry.promptsState = 'ready';
            }
          } catch {
            if (entry.session === session && entry.generation === initialGen) {
              entry.promptsState = 'unavailable';
            }
          }
        } else if (status.state === 'unavailable') {
          if (entry.session === session && entry.generation === initialGen) {
            entry.promptsState = 'unavailable';
            this.promptRegistry.removeServerPrompts(serverName);
          }
        } else {
          if (entry.session === session && entry.generation === initialGen) {
            entry.promptsState = status.state;
          }
        }
      }
    };
  }

  /**
   * 启动并初始化配置清单中的全部服务。
   *
   * 遵循并发调度与整体截止时间控制。
   * 若任一 required 服务未满足就绪条件，启动宣告失败，并自动调用 rollback 销毁已启动的全部资源。
   *
   * @param input - 已解析并校验的 MCP 配置集合（支持 ResolveMcpConfigResult、Map 或字典）。
   * @param overrideOptions - 单次启动覆盖选项。
   * @returns 启动结果摘要。
   * @throws 当 required 服务失败或达到总体截止时间时抛出异常。
   */
  async startupAll(
    input: McpServersInput,
    overrideOptions: McpManagerOptions = {},
  ): Promise<McpStartupResult> {
    if (this._isTornDown) {
      throw new Error('McpServerManager has been torn down and cannot be reused.');
    }

    const mergedOptions: McpManagerOptions = {
      ...this.options,
      ...overrideOptions,
    };

    const maxConcurrent = mergedOptions.maxConcurrentStartups ?? 4;
    const overallDeadlineMs = mergedOptions.overallDeadlineMs ?? 15000;

    const configMap = extractServerConfigMap(input);

    // 1. 初始化待处理条目
    const enabledServers: { name: string; config: ServerConfig }[] = [];

    for (const [name, item] of configMap.entries()) {
      const { config, source } = item;
      const isEnabled = config.enabled !== false;
      const entry: ManagedServerEntry = {
        name,
        config,
        enabled: isEnabled,
        source,
        generation: isEnabled ? 1 : 0,
        connectionState: isEnabled ? 'connecting' : 'disabled',
        toolsState: isEnabled ? 'pending' : 'unsupported',
        promptsState: isEnabled ? 'pending' : 'unsupported',
      };
      this.servers.set(name, entry);
      if (isEnabled) {
        enabledServers.push({ name, config });
      }
    }

    // 2. 并发限制与总体截止执行
    let deadlineTimer: NodeJS.Timeout | null = null;
    let timedOut = false;
    let remainingMs = overallDeadlineMs;
    let deadlineScheduledAt = Date.now();
    let approvalCount = 0;
    let rejectDeadline: (err: Error) => void = () => {};

    const batchAbortController = new AbortController();
    const abortBatch = () => batchAbortController.abort();
    if (mergedOptions.signal) {
      if (mergedOptions.signal.aborted) {
        batchAbortController.abort();
      } else {
        mergedOptions.signal.addEventListener('abort', abortBatch, { once: true });
      }
    }
    const unbindManagerAbort = () => {
      this._startupAbortController.signal.removeEventListener('abort', abortBatch);
    };
    this._startupAbortController.signal.addEventListener('abort', abortBatch, { once: true });

    const scheduleDeadline = (ms: number) => {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (timedOut) return;
      deadlineScheduledAt = Date.now();
      remainingMs = ms;
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        batchAbortController.abort();
        rejectDeadline(
          new Error(`MCP overall startup deadline exceeded after ${overallDeadlineMs}ms`),
        );
      }, ms);
    };

    const deadlinePromise = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
      scheduleDeadline(overallDeadlineMs);
    });

    const pauseDeadline = () => {
      approvalCount += 1;
      if (approvalCount === 1) {
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = null;
        }
        const elapsed = Date.now() - deadlineScheduledAt;
        remainingMs = Math.max(0, remainingMs - elapsed);
      }
    };

    const resumeDeadline = () => {
      approvalCount = Math.max(0, approvalCount - 1);
      if (approvalCount === 0 && !timedOut) {
        scheduleDeadline(remainingMs);
      }
    };

    const executionPromise = this.runWithConcurrencyLimit(
      enabledServers,
      maxConcurrent,
      async (item) => {
        if (timedOut || this._isTornDown || batchAbortController.signal.aborted) return;
        await this.startSingleServer(
          item.name,
          item.config,
          {
            ...mergedOptions,
            signal: batchAbortController.signal,
          },
          pauseDeadline,
          resumeDeadline,
        );
      },
      batchAbortController.signal,
      () => {
        batchAbortController.abort();
      },
    );

    try {
      await Promise.race([executionPromise, deadlinePromise]);
    } catch (error: unknown) {
      timedOut = true;
      batchAbortController.abort();
      // 等待在途任务观察到取消并收口，绝不泄漏后续孤儿进程
      await Promise.allSettled([executionPromise]);
      // 启动超时或异常，执行资源回滚
      await this.rollback(mergedOptions.cleanupTimeoutMs ?? 5000);
      throw error;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      unbindManagerAbort();
      if (mergedOptions.signal) {
        mergedOptions.signal.removeEventListener('abort', abortBatch);
      }
    }

    // 3. 校验所有 required 服务是否就绪
    const readyServers: string[] = [];
    const failedServers: Record<string, string> = {};

    for (const [name, entry] of this.servers.entries()) {
      const isReady = entry.session?.isReady() ?? false;
      if (isReady) {
        readyServers.push(name);
      } else if (entry.enabled) {
        failedServers[name] =
          entry.errorMessage ??
          `Server '${name}' connection or catalog state is not ready (connection=${entry.connectionState}, tools=${entry.toolsState}, prompts=${entry.promptsState})`;
      }

      // 若为 required 服务且未就绪，整体启动宣告失败
      if (entry.config.required && !isReady) {
        const failureReason = failedServers[name];
        await this.rollback(mergedOptions.cleanupTimeoutMs ?? 5000);
        throw new Error(
          `MCP required server '${name}' failed to achieve ready status: ${failureReason}`,
        );
      }
    }

    return {
      success: true,
      readyServers,
      failedServers,
      statuses: this.getAllStatuses(),
    };
  }

  /**
   * 启动单个服务（仅供内部并发调度调用）。
   */
  private async startSingleServer(
    name: string,
    config: ServerConfig,
    options: McpManagerOptions,
    pauseDeadline?: () => void,
    resumeDeadline?: () => void,
  ): Promise<void> {
    const entry = this.servers.get(name);
    if (!entry) return;

    try {
      // 提取配置中引用的环境变量并进行前置存在性与敏感凭据告警校验
      let referencedVars: string[] = [];
      if (isStdioConfig(config) && config.env) {
        referencedVars = extractReferencedEnvVars(config.env);
      } else if (isHttpConfig(config) && config.headers) {
        referencedVars = extractReferencedEnvVars(config.headers);
      }

      // 缺失变量校验：引用的环境变量若在宿主环境中缺失或为空，必须报错阻断
      const missingVars = referencedVars.filter(
        (v) => process.env[v] === undefined || process.env[v] === '',
      );
      if (missingVars.length > 0) {
        entry.connectionState = 'failed';
        entry.errorMessage = `Missing required environment variables referenced in configuration: ${missingVars.join(', ')}`;
        if (config.required) {
          throw new Error(`Required MCP Server '${name}' failed: ${entry.errorMessage}`);
        }
        return;
      }

      const alertResult = detectCredentialAlerts(referencedVars, entry.source ?? 'global');
      const credentialAlertVars = alertResult.hasAlert ? alertResult.sensitiveVars : undefined;

      const descriptor: ServerStartupDescriptor = {
        serverName: name,
        source: entry.source ?? 'global',
        type: isStdioConfig(config) ? 'stdio' : 'http',
        target: isStdioConfig(config) ? config.command : (config as HttpServerConfig).url,
        args: isStdioConfig(config) ? config.args : undefined,
        cwd: isStdioConfig(config) ? config.cwd : undefined,
        envVarNames: referencedVars.length > 0 ? referencedVars : undefined,
        credentialAlertVars,
        required: config.required,
      };

      pauseDeadline?.();
      let auth: ServerStartAuthorizationResult;
      try {
        auth = await this.coordinator.authorize(descriptor, { signal: options.signal });
      } finally {
        resumeDeadline?.();
      }

      if (!auth.permitted) {
        entry.connectionState = 'blocked';
        entry.errorMessage = auth.reason ?? 'Startup unauthorized';
        if (config.required) {
          throw new Error(`Required MCP Server '${name}' was blocked: ${entry.errorMessage}`);
        }
        return;
      }

      // 授权返回后复核是否已被取消或销毁，防止迟到审批启动孤儿资源
      if (this._isTornDown || options.signal?.aborted) {
        entry.connectionState = 'disconnected';
        return;
      }

      if (isStdioConfig(config)) {
        if (this._isTornDown || options.signal?.aborted) {
          entry.connectionState = 'disconnected';
          return;
        }

        // 创建受管 Stdio 传输
        const managedTransport = createManagedStdioTransport(config, {
          source: entry.source,
        });
        entry.managedTransport = managedTransport;

        if (this._isTornDown || options.signal?.aborted) {
          await managedTransport.close(options.cleanupTimeoutMs ?? 5000);
          entry.connectionState = 'disconnected';
          return;
        }

        // 创建客户端会话
        const session = new McpClientSession(
          name,
          config,
          managedTransport.transport,
          entry.generation,
          {
            startupTimeoutMs: options.startupTimeoutMs ?? config.startupTimeoutMs,
            catalogTimeoutMs: options.catalogTimeoutMs ?? config.catalogTimeoutMs,
            signal: options.signal,
            onCatalogChanged: this.createSessionCatalogChangeHandler(name, config),
          },
        );
        entry.session = session;

        // 执行握手连接
        const success = await session.connect();

        if (this._isTornDown || options.signal?.aborted) {
          await session.close();
          await managedTransport.close(options.cleanupTimeoutMs ?? 5000);
          entry.connectionState = 'disconnected';
          return;
        }

        const status = session.getStatus();
        entry.connectionState = status.connectionState;
        entry.toolsState = status.toolsState;
        entry.promptsState = status.promptsState;
        // 若连接成功且 tools 能力就绪，发布 Tools 目录
        if (success && entry.toolsState === 'ready' && this.toolRegistry) {
          try {
            await discoverAndPublishTools(
              session,
              config,
              this.toolRegistry,
              options.catalogTimeoutMs ?? config.catalogTimeoutMs ?? 10000,
            );
          } catch {
            /* Tools 发布失败由 discoverAndPublishTools 处理 */
          }
        }

        // 若连接成功且 prompts 能力就绪，发布 Prompts 目录
        if (success && entry.promptsState === 'ready') {
          try {
            await discoverAndPublishPrompts(
              session,
              this.promptRegistry,
              options.catalogTimeoutMs ?? config.catalogTimeoutMs ?? 10000,
            );
          } catch {
            /* Prompts 加载失败不破坏已就绪的 Tools */
          }
        }

        // 若可选服务失败，及时释放其底层子进程资源
        if (!success && !config.required) {
          await managedTransport.close(options.cleanupTimeoutMs ?? 5000);
        }
      } else if (isHttpConfig(config)) {
        if (this._isTornDown || options.signal?.aborted) {
          entry.connectionState = 'disconnected';
          return;
        }

        // 创建受管 Streamable HTTP 传输
        const managedHttpTransport = createManagedHttpTransport(config, {
          requestTimeoutMs: config.requestTimeoutMs ?? 60000,
          source: entry.source,
        });
        entry.managedHttpTransport = managedHttpTransport;

        if (this._isTornDown || options.signal?.aborted) {
          await managedHttpTransport.close();
          entry.connectionState = 'disconnected';
          return;
        }

        // 创建客户端会话
        const session = new McpClientSession(
          name,
          config,
          managedHttpTransport.transport,
          entry.generation,
          {
            startupTimeoutMs: options.startupTimeoutMs ?? config.startupTimeoutMs,
            catalogTimeoutMs: options.catalogTimeoutMs ?? config.catalogTimeoutMs,
            signal: options.signal,
            onCatalogChanged: this.createSessionCatalogChangeHandler(name, config),
          },
        );
        entry.session = session;

        // 执行握手连接
        const success = await session.connect();

        if (this._isTornDown || options.signal?.aborted) {
          await session.close();
          await managedHttpTransport.close();
          entry.connectionState = 'disconnected';
          return;
        }

        const status = session.getStatus();
        entry.connectionState = status.connectionState;
        entry.toolsState = status.toolsState;
        entry.promptsState = status.promptsState;
        // 若连接成功且 tools 能力就绪，发布 Tools 目录
        if (success && entry.toolsState === 'ready' && this.toolRegistry) {
          try {
            await discoverAndPublishTools(
              session,
              config,
              this.toolRegistry,
              options.catalogTimeoutMs ?? config.catalogTimeoutMs ?? 10000,
            );
          } catch {
            /* Tools 发布失败由 discoverAndPublishTools 处理 */
          }
        }

        // 若连接成功且 prompts 能力就绪，发布 Prompts 目录
        if (success && entry.promptsState === 'ready') {
          try {
            await discoverAndPublishPrompts(
              session,
              this.promptRegistry,
              options.catalogTimeoutMs ?? config.catalogTimeoutMs ?? 10000,
            );
          } catch {
            /* Prompts 加载失败不破坏已就绪的 Tools */
          }
        }

        // 若可选服务失败，及时释放其传输资源
        if (!success && !config.required) {
          await managedHttpTransport.close();
        }
      } else {
        entry.connectionState = 'failed';
        entry.toolsState = 'unavailable';
        entry.promptsState = 'unavailable';
        entry.errorMessage = `Unknown or unsupported transport configuration for server '${name}'`;
      }
    } catch (err: unknown) {
      entry.connectionState = 'failed';
      entry.toolsState = 'unavailable';
      entry.promptsState = 'unavailable';
      entry.errorMessage = (err as Error).message;

      // 释放已创建的资源
      if (entry.managedTransport) {
        try {
          await entry.managedTransport.close(options.cleanupTimeoutMs ?? 5000);
        } catch {
          /* 忽略清理错误 */
        }
      }
      if (entry.managedHttpTransport) {
        try {
          await entry.managedHttpTransport.close();
        } catch {
          /* 忽略清理错误 */
        }
      }
    }
  }

  /**
   * 手动重新连接指定服务。
   *
   * 约束：
   * 1. 绝不重新读取磁盘配置（"重连不重载配置"），严格沿用当前内存中的已授权配置；
   * 2. generation 单调递增，旧代次的迟到回调与退出事件自动失效；
   * 3. 优雅清理旧连接后再建立新连接。
   *
   * @param serverName - 目标服务名称。
   * @param options - 单次重连启动配置。
   * @throws 当服务未注册或当前管理器已销毁时抛出异常。
   */
  async reconnectServer(serverName: string, options: ServerStartupOptions = {}): Promise<void> {
    if (this._isTornDown) {
      throw new Error('McpServerManager has been torn down.');
    }

    const entry = this.servers.get(serverName);
    if (!entry) {
      throw new Error(`MCP server '${serverName}' is not registered in current session.`);
    }

    if (!entry.enabled) {
      throw new Error(`MCP server '${serverName}' is disabled.`);
    }

    // 1. 递增代次
    entry.generation += 1;
    const currentGeneration = entry.generation;

    // 2. 清理旧连接资源
    const oldSession = entry.session;
    const oldTransport = entry.managedTransport;
    const oldHttpTransport = entry.managedHttpTransport;
    entry.session = undefined;
    entry.managedTransport = undefined;
    entry.managedHttpTransport = undefined;

    if (oldSession) {
      try {
        await oldSession.close();
      } catch {
        /* 忽略旧会话关闭异常 */
      }
    }
    if (oldTransport) {
      try {
        await oldTransport.close(options.cleanupTimeoutMs ?? 5000);
      } catch {
        /* 忽略旧传输关闭异常 */
      }
    }
    if (oldHttpTransport) {
      try {
        await oldHttpTransport.close();
      } catch {
        /* 忽略旧 HTTP 传输关闭异常 */
      }
    }
    this.promptRegistry.removeServerPrompts(serverName);
    this.toolRegistry?.unregisterSource(`mcp:${serverName}`);

    // 3. 建立新连接
    let referencedVars: string[] = [];
    if (isStdioConfig(entry.config) && entry.config.env) {
      referencedVars = extractReferencedEnvVars(entry.config.env);
    } else if (isHttpConfig(entry.config) && entry.config.headers) {
      referencedVars = extractReferencedEnvVars(entry.config.headers);
    }

    const missingVars = referencedVars.filter(
      (v) => process.env[v] === undefined || process.env[v] === '',
    );
    if (missingVars.length > 0) {
      entry.connectionState = 'failed';
      entry.errorMessage = `Missing required environment variables referenced in configuration: ${missingVars.join(', ')}`;
      if (entry.config.required) {
        throw new Error(`Required MCP Server '${serverName}' failed: ${entry.errorMessage}`);
      }
      return;
    }

    const alertResult = detectCredentialAlerts(referencedVars, entry.source ?? 'global');
    const credentialAlertVars = alertResult.hasAlert ? alertResult.sensitiveVars : undefined;

    const descriptor: ServerStartupDescriptor = {
      serverName,
      source: entry.source ?? 'global',
      type: isStdioConfig(entry.config) ? 'stdio' : 'http',
      target: isStdioConfig(entry.config)
        ? entry.config.command
        : (entry.config as HttpServerConfig).url,
      args: isStdioConfig(entry.config) ? entry.config.args : undefined,
      cwd: isStdioConfig(entry.config) ? entry.config.cwd : undefined,
      envVarNames: referencedVars.length > 0 ? referencedVars : undefined,
      credentialAlertVars,
      required: entry.config.required,
    };
    const auth = await this.coordinator.authorize(descriptor, { signal: options.signal });
    if (!auth.permitted) {
      entry.connectionState = 'blocked';
      entry.errorMessage = auth.reason ?? 'Startup unauthorized';
      return;
    }

    if (isStdioConfig(entry.config)) {
      const managedTransport = createManagedStdioTransport(entry.config, {
        source: entry.source,
      });
      entry.managedTransport = managedTransport;

      const session = new McpClientSession(
        serverName,
        entry.config,
        managedTransport.transport,
        currentGeneration,
        {
          startupTimeoutMs: options.startupTimeoutMs ?? entry.config.startupTimeoutMs,
          catalogTimeoutMs: options.catalogTimeoutMs ?? entry.config.catalogTimeoutMs,
          signal: options.signal,
          onCatalogChanged: this.createSessionCatalogChangeHandler(serverName, entry.config),
        },
      );
      entry.session = session;

      await session.connect();
      const status = session.getStatus();

      // 复核 generation
      if (entry.generation === currentGeneration) {
        entry.connectionState = status.connectionState;
        entry.toolsState = status.toolsState;
        entry.promptsState = status.promptsState;
        entry.errorMessage = status.errorMessage;

        if (status.toolsState === 'ready' && this.toolRegistry) {
          try {
            await discoverAndPublishTools(
              session,
              entry.config,
              this.toolRegistry,
              options.catalogTimeoutMs ?? entry.config.catalogTimeoutMs ?? 10000,
            );
          } catch {
            /* 忽略 tools 失败 */
          }
        }

        if (status.promptsState === 'ready') {
          try {
            await discoverAndPublishPrompts(
              session,
              this.promptRegistry,
              options.catalogTimeoutMs ?? entry.config.catalogTimeoutMs ?? 10000,
            );
          } catch {
            /* 忽略 prompts 失败 */
          }
        }
      }
    } else if (isHttpConfig(entry.config)) {
      const managedHttpTransport = createManagedHttpTransport(entry.config, {
        requestTimeoutMs: entry.config.requestTimeoutMs ?? 60000,
        source: entry.source,
      });
      entry.managedHttpTransport = managedHttpTransport;

      const session = new McpClientSession(
        serverName,
        entry.config,
        managedHttpTransport.transport,
        currentGeneration,
        {
          startupTimeoutMs: options.startupTimeoutMs ?? entry.config.startupTimeoutMs,
          catalogTimeoutMs: options.catalogTimeoutMs ?? entry.config.catalogTimeoutMs,
          signal: options.signal,
          onCatalogChanged: this.createSessionCatalogChangeHandler(serverName, entry.config),
        },
      );
      entry.session = session;

      await session.connect();
      const status = session.getStatus();

      // 复核 generation
      if (entry.generation === currentGeneration) {
        entry.connectionState = status.connectionState;
        entry.toolsState = status.toolsState;
        entry.promptsState = status.promptsState;
        entry.errorMessage = status.errorMessage;

        if (status.toolsState === 'ready' && this.toolRegistry) {
          try {
            await discoverAndPublishTools(
              session,
              entry.config,
              this.toolRegistry,
              options.catalogTimeoutMs ?? entry.config.catalogTimeoutMs ?? 10000,
            );
          } catch {
            /* 忽略 tools 失败 */
          }
        }

        if (status.promptsState === 'ready') {
          try {
            await discoverAndPublishPrompts(
              session,
              this.promptRegistry,
              options.catalogTimeoutMs ?? entry.config.catalogTimeoutMs ?? 10000,
            );
          } catch {
            /* 忽略 prompts 失败 */
          }
        }
      }
    }
  }

  /**
   * 在当前会话中禁用指定 MCP 服务。
   *
   * 约束：
   * 1. 纯会话级内存状态变更，严禁写回磁盘配置文件；
   * 2. 递增 generation 并优雅回收底层连接与子进程树；
   * 3. 及时从 ToolRegistry 和 PromptRegistry 注销该服务的所有工具与提示词。
   *
   * @param serverName - 目标服务名。
   */
  async disableServer(serverName: string): Promise<void> {
    if (this._isTornDown) throw new Error('McpServerManager has been torn down.');
    const entry = this.servers.get(serverName);
    if (!entry) throw new Error(`MCP server '${serverName}' is not registered in current session.`);
    if (!entry.enabled) return;

    entry.enabled = false;
    entry.generation += 1;
    entry.connectionState = 'disabled';
    entry.toolsState = 'unsupported';
    entry.promptsState = 'unsupported';

    const oldSession = entry.session;
    const oldTransport = entry.managedTransport;
    const oldHttp = entry.managedHttpTransport;
    entry.session = undefined;
    entry.managedTransport = undefined;
    entry.managedHttpTransport = undefined;

    if (oldSession) {
      try {
        await oldSession.close();
      } catch {
        /* 忽略关闭错误 */
      }
    }
    if (oldTransport) {
      try {
        await oldTransport.close(this.options.cleanupTimeoutMs ?? 5000);
      } catch {
        /* 忽略清理错误 */
      }
    }
    if (oldHttp) {
      try {
        await oldHttp.close();
      } catch {
        /* 忽略清理错误 */
      }
    }

    this.promptRegistry.removeServerPrompts(serverName);
    this.toolRegistry?.unregisterSource(`mcp:${serverName}`);
  }

  /**
   * 在当前会话中启用指定 MCP 服务。
   *
   * 约束：
   * 1. 纯会话级内存状态变更，严禁写回磁盘配置文件；
   * 2. 重新触发连接与目录协商；
   * 3. 若当前已处于 ready 状态则幂等直接返回。
   *
   * @param serverName - 目标服务名。
   */
  async enableServer(serverName: string): Promise<void> {
    if (this._isTornDown) throw new Error('McpServerManager has been torn down.');
    const entry = this.servers.get(serverName);
    if (!entry) throw new Error(`MCP server '${serverName}' is not registered in current session.`);
    if (entry.enabled && entry.connectionState === 'ready') return;

    entry.enabled = true;
    await this.reconnectServer(serverName);
  }

  /**
   * 获取指定服务在当前会话中成功注册并暴露的所有工具。
   *
   * @param serverName - 目标服务名。
   */
  getServerTools(serverName: string): Tool[] {
    if (!this.toolRegistry) return [];
    const source = `mcp:${serverName}`;
    return this.toolRegistry.list().filter((t) => this.toolRegistry!.sourceOf(t.name) === source);
  }

  /**
   * 获取指定服务在当前会话中的活动客户端会话句柄。
   *
   * @param serverName - 目标服务名。
   * @returns 活动 McpClientSession，未建立或已销毁返回 undefined。
   */
  getServerSession(serverName: string): McpClientSession | undefined {
    return this.servers.get(serverName)?.session;
  }

  /**
   * 启动失败时的全量资源回滚。
   *
   * 回收所有已创建的客户端会话与底层子进程树，保证无孤儿进程遗留。
   *
   * @param cleanupTimeoutMs - 回收超时时间（毫秒）。
   */
  private async rollback(cleanupTimeoutMs: number): Promise<void> {
    const promises: Promise<any>[] = [];

    for (const entry of this.servers.values()) {
      if (entry.session) {
        promises.push(entry.session.close());
      }
      if (entry.managedTransport) {
        promises.push(entry.managedTransport.close(cleanupTimeoutMs));
      }
      if (entry.managedHttpTransport) {
        promises.push(entry.managedHttpTransport.close());
      }
      if (!entry.enabled) {
        entry.connectionState = 'disabled';
      } else {
        entry.connectionState = 'failed';
      }
    }

    await Promise.allSettled(promises);
  }

  /**
   * 优雅销毁管理器并释放全部连接与进程树。
   *
   * 保证幂等执行，重复调用安全。
   *
   * @param cleanupTimeoutMs - 回收超时时间（毫秒），默认 5000ms。
   */
  async teardown(cleanupTimeoutMs = 5000): Promise<void> {
    if (this._teardownPromise) return this._teardownPromise;

    this._teardownPromise = (async () => {
      this._isTornDown = true;
      this._startupAbortController.abort();
      const cleanupPromises: Promise<any>[] = [];

      for (const entry of this.servers.values()) {
        if (!entry.enabled) {
          entry.connectionState = 'disabled';
        } else {
          const wasFailed = entry.connectionState === 'failed';
          entry.connectionState = wasFailed ? 'failed' : 'disconnected';
        }
        if (entry.session) {
          cleanupPromises.push(entry.session.close());
        }
        if (entry.managedTransport) {
          cleanupPromises.push(entry.managedTransport.close(cleanupTimeoutMs));
        }
        if (entry.managedHttpTransport) {
          cleanupPromises.push(entry.managedHttpTransport.close());
        }
      }

      await Promise.allSettled(cleanupPromises);
    })();

    return this._teardownPromise;
  }

  /**
   * 获取指定服务的状态快照。
   *
   * @param serverName - 服务名称。
   */
  getStatus(serverName: string): McpServerStatus | undefined {
    const entry = this.servers.get(serverName);
    if (!entry) return undefined;

    const baseStatus = entry.session?.getStatus();
    const pid = entry.managedTransport?.getPid() ?? null;
    const stderrTail = entry.managedTransport?.stderrBuffer.getText() || undefined;

    return {
      name: entry.name,
      connectionState: baseStatus?.connectionState ?? entry.connectionState,
      toolsState: baseStatus?.toolsState ?? entry.toolsState,
      promptsState: baseStatus?.promptsState ?? entry.promptsState,
      generation: entry.generation,
      toolsCatalogEpoch: baseStatus?.toolsCatalogEpoch ?? 1,
      promptsCatalogEpoch: baseStatus?.promptsCatalogEpoch ?? 1,
      protocolVersion: baseStatus?.protocolVersion,
      serverInfo: baseStatus?.serverInfo,
      errorMessage: baseStatus?.errorMessage ?? entry.errorMessage,
      stderrTail,
      pid,
    };
  }

  /**
   * 获取所有注册服务的状态快照列表。
   */
  getAllStatuses(): McpServerStatus[] {
    return Array.from(this.servers.keys()).map((name) => this.getStatus(name)!);
  }

  /**
   * 获取指定服务的活动客户端会话实例。
   *
   * @param serverName - 服务名称。
   */
  getActiveSession(serverName: string): McpClientSession | undefined {
    return this.servers.get(serverName)?.session;
  }

  /**
   * 是否已被销毁。
   */
  get isTornDown(): boolean {
    return this._isTornDown;
  }

  /**
   * 受控并发限制执行器。
   */
  private async runWithConcurrencyLimit<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
    signal?: AbortSignal,
    onError?: (err: unknown) => void,
  ): Promise<void> {
    const queue = [...items];
    let firstError: unknown = null;

    const workers = Array.from({ length: Math.min(items.length, concurrency) }, async () => {
      while (queue.length > 0) {
        if (signal?.aborted || firstError) break;
        const item = queue.shift();
        if (!item) break;
        try {
          await fn(item);
        } catch (err) {
          if (!firstError) {
            firstError = err;
            onError?.(err);
          }
          break;
        }
      }
    });

    await Promise.allSettled(workers);
    if (firstError) {
      throw firstError;
    }
  }
}
