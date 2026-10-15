/**
 * @fileoverview MCP 客户端封装与协议能力协商
 *
 * 约束与边界：
 * 1. 严格遵守协议协商（legacy 使用 2024-11-05，modern 使用 2025-11-25，auto 自动降级）；
 * 2. 严格核验服务端 capabilities：未声明 tools 的 Prompt-only 服务严禁发送 tools/list，未声明 prompts 的服务严禁发送 prompts/list；
 * 3. 维护独立 toolsCatalogEpoch 与 promptsCatalogEpoch，通过 generation 与 refreshToken 双重防护丢弃过期迟到回调；
 * 4. 一类能力（如 tools）的变更通知与刷新绝不影响或撤销另一类能力（如 prompts）。
 */

import { randomUUID } from 'node:crypto';
import {
  Client,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/client';
import type { Transport } from '@modelcontextprotocol/client';
import type { ServerConfig } from './config.js';
import type {
  CapabilityCatalogState,
  McpProtocolMode,
  McpServerStatus,
  ServerConnectionState,
} from './types.js';

/** Legacy 协议版本标识（2024-11-05）。 */
export const MCP_LEGACY_PROTOCOL_VERSION = '2024-11-05';

/** Modern 协议版本标识（2025-11-25）。 */
export const MCP_MODERN_PROTOCOL_VERSION = '2025-11-25';

/**
 * MCP 客户端会话配置选项。
 */
export interface McpClientSessionOptions {
  /** 客户端识别名称，默认 'Kapibala'。 */
  clientName?: string;
  /** 客户端版本号，默认 '0.0.5'。 */
  clientVersion?: string;
  /** 强制指定的协议协商模式（legacy/modern/auto），默认遵循配置或 'auto'。 */
  protocol?: McpProtocolMode;
  /** 建立连接握手超时时间（毫秒），默认 10000ms。 */
  startupTimeoutMs?: number;
  /** 目录发现超时时间（毫秒），默认 10000ms。 */
  catalogTimeoutMs?: number;
  /** 显式取消信号。 */
  signal?: AbortSignal;
  /** 服务端目录变更通知与刷新完成回调。 */
  onCatalogChanged?: (
    kind: 'tools' | 'prompts',
    session: McpClientSession,
    status: { epoch: number; state: CapabilityCatalogState },
  ) => Promise<void> | void;
}

/**
 * 包装单个 MCP 服务的客户端会话实例。
 */
export class McpClientSession {
  readonly serverName: string;
  readonly config: ServerConfig;
  readonly client: Client;
  private readonly transport: Transport;
  private readonly options: McpClientSessionOptions;

  private _connectionState: ServerConnectionState = 'connecting';
  private _toolsState: CapabilityCatalogState = 'pending';
  private _promptsState: CapabilityCatalogState = 'pending';

  private _generation: number;
  private _toolsCatalogEpoch = 1;
  private _promptsCatalogEpoch = 1;

  private _latestToolsRefreshToken: string | null = null;
  private _latestPromptsRefreshToken: string | null = null;

  private _discoveredTools: any[] = [];
  private _discoveredPrompts: any[] = [];

  private _errorMessage?: string;
  private _closed = false;

  /**
   * 创建 MCP 客户端会话。
   *
   * @param serverName - 服务名称。
   * @param config - 服务配置。
   * @param transport - 已初始化的底层传输（如 Stdio 或 HTTP 传输）。
   * @param generation - 当前连接代次。
   * @param options - 客户端选项。
   */
  constructor(
    serverName: string,
    config: ServerConfig,
    transport: Transport,
    generation = 1,
    options: McpClientSessionOptions = {},
  ) {
    this.serverName = serverName;
    this.config = config;
    this.transport = transport;
    this._generation = generation;
    this.options = options;

    const protocolMode = options.protocol ?? config.protocol ?? 'auto';
    const supportedProtocolVersions = this.resolveSupportedProtocolVersions(protocolMode);

    this.client = new Client(
      {
        name: options.clientName ?? 'Kapibala',
        version: options.clientVersion ?? '0.0.5',
      },
      {
        capabilities: {},
        supportedProtocolVersions,
      },
    );

    this.registerNotificationHandlers();
  }

  /**
   * 解析协议版本列表。
   */
  private resolveSupportedProtocolVersions(mode: McpProtocolMode): string[] {
    if (mode === 'legacy') {
      return [MCP_LEGACY_PROTOCOL_VERSION];
    }
    if (mode === 'modern') {
      return [MCP_MODERN_PROTOCOL_VERSION];
    }
    return [...SUPPORTED_PROTOCOL_VERSIONS];
  }

  private _toolsRefreshing = false;
  private _toolsDirty = false;
  private _toolsRefreshRounds = 0;
  private _toolsCycleDeadline = 0;

  private _promptsRefreshing = false;
  private _promptsDirty = false;
  private _promptsRefreshRounds = 0;
  private _promptsCycleDeadline = 0;

  /**
   * 触发工具目录有界刷新周期（每能力单个在途 + dirty 合并 + 每周期最多 3 轮）。
   */
  private async triggerToolsRefresh(): Promise<void> {
    if (this._closed || this._toolsState === 'unsupported') return;
    this._toolsCatalogEpoch += 1;
    const targetGeneration = this._generation;

    // 立即失效既有目录状态
    this._toolsState = 'stale';
    try {
      await this.options.onCatalogChanged?.('tools', this, {
        epoch: this._toolsCatalogEpoch,
        state: 'stale',
      });
    } catch {
      /* 忽略通知前置回调异常 */
    }

    if (this._toolsRefreshing) {
      this._toolsDirty = true;
      return;
    }

    this._toolsRefreshing = true;
    this._toolsDirty = false;
    this._toolsRefreshRounds = 0;
    const timeoutMs = this.options.catalogTimeoutMs ?? this.config.catalogTimeoutMs ?? 10000;
    this._toolsCycleDeadline = Date.now() + timeoutMs;

    try {
      while (true) {
        if (
          this._closed ||
          (this._toolsState as CapabilityCatalogState) === 'unsupported' ||
          this._generation !== targetGeneration
        ) {
          this._toolsRefreshing = false;
          this._toolsDirty = false;
          break;
        }

        this._toolsRefreshRounds += 1;
        this._toolsDirty = false;

        if (this._toolsRefreshRounds > 3) {
          // 耗尽每周期 3 轮上限，保持 unavailable，停止无限自旋
          this._toolsState = 'unavailable';
          this._toolsRefreshing = false;
          this._toolsDirty = false;
          try {
            await this.options.onCatalogChanged?.('tools', this, {
              epoch: this._toolsCatalogEpoch,
              state: 'unavailable',
            });
          } catch {}
          break;
        }

        const remainingMs = this._toolsCycleDeadline - Date.now();
        if (remainingMs <= 0) {
          this._toolsState = 'unavailable';
          this._toolsRefreshing = false;
          this._toolsDirty = false;
          try {
            await this.options.onCatalogChanged?.('tools', this, {
              epoch: this._toolsCatalogEpoch,
              state: 'unavailable',
            });
          } catch {}
          break;
        }

        try {
          const result = await this.withTimeout(
            this.client.listTools(),
            remainingMs,
            'Tools list refresh timed out',
          );
          if (this._generation === targetGeneration && !this._closed) {
            this._discoveredTools = (result as any).tools ?? [];
            if (this._toolsDirty) {
              if (this._toolsRefreshRounds < 3 && Date.now() < this._toolsCycleDeadline) {
                continue;
              }
              this._toolsState = 'unavailable';
              this._toolsRefreshing = false;
              this._toolsDirty = false;
              try {
                await this.options.onCatalogChanged?.('tools', this, {
                  epoch: this._toolsCatalogEpoch,
                  state: 'unavailable',
                });
              } catch {}
              break;
            }
            this._toolsState = 'ready';
            this._toolsRefreshing = false;
            try {
              await this.options.onCatalogChanged?.('tools', this, {
                epoch: this._toolsCatalogEpoch,
                state: 'ready',
              });
            } catch {}
            break;
          }
        } catch {
          if (this._generation === targetGeneration && !this._closed) {
            if (
              this._toolsDirty &&
              this._toolsRefreshRounds < 3 &&
              Date.now() < this._toolsCycleDeadline
            ) {
              continue;
            }
            this._toolsState = 'unavailable';
            this._toolsRefreshing = false;
            this._toolsDirty = false;
            try {
              await this.options.onCatalogChanged?.('tools', this, {
                epoch: this._toolsCatalogEpoch,
                state: 'unavailable',
              });
            } catch {}
            break;
          }
        }
      }
    } finally {
      this._toolsRefreshing = false;
    }
  }

  /**
   * 触发 Prompt 目录有界刷新周期（每能力单个在途 + dirty 合并 + 每周期最多 3 轮）。
   */
  private async triggerPromptsRefresh(): Promise<void> {
    if (this._closed || this._promptsState === 'unsupported') return;
    this._promptsCatalogEpoch += 1;
    const targetGeneration = this._generation;

    this._promptsState = 'stale';
    try {
      await this.options.onCatalogChanged?.('prompts', this, {
        epoch: this._promptsCatalogEpoch,
        state: 'stale',
      });
    } catch {
      /* 忽略通知前置回调异常 */
    }

    if (this._promptsRefreshing) {
      this._promptsDirty = true;
      return;
    }

    this._promptsRefreshing = true;
    this._promptsDirty = false;
    this._promptsRefreshRounds = 0;
    const timeoutMs = this.options.catalogTimeoutMs ?? this.config.catalogTimeoutMs ?? 10000;
    this._promptsCycleDeadline = Date.now() + timeoutMs;

    try {
      while (true) {
        if (
          this._closed ||
          (this._promptsState as CapabilityCatalogState) === 'unsupported' ||
          this._generation !== targetGeneration
        ) {
          this._promptsRefreshing = false;
          this._promptsDirty = false;
          break;
        }

        this._promptsRefreshRounds += 1;
        this._promptsDirty = false;

        if (this._promptsRefreshRounds > 3) {
          this._promptsState = 'unavailable';
          this._promptsRefreshing = false;
          this._promptsDirty = false;
          try {
            await this.options.onCatalogChanged?.('prompts', this, {
              epoch: this._promptsCatalogEpoch,
              state: 'unavailable',
            });
          } catch {}
          break;
        }

        const remainingMs = this._promptsCycleDeadline - Date.now();
        if (remainingMs <= 0) {
          this._promptsState = 'unavailable';
          this._promptsRefreshing = false;
          this._promptsDirty = false;
          try {
            await this.options.onCatalogChanged?.('prompts', this, {
              epoch: this._promptsCatalogEpoch,
              state: 'unavailable',
            });
          } catch {}
          break;
        }

        try {
          const result = await this.withTimeout(
            this.client.listPrompts(),
            remainingMs,
            'Prompts list refresh timed out',
          );
          if (this._generation === targetGeneration && !this._closed) {
            this._discoveredPrompts = (result as any).prompts ?? [];
            if (this._promptsDirty) {
              if (this._promptsRefreshRounds < 3 && Date.now() < this._promptsCycleDeadline) {
                continue;
              }
              this._promptsState = 'unavailable';
              this._promptsRefreshing = false;
              this._promptsDirty = false;
              try {
                await this.options.onCatalogChanged?.('prompts', this, {
                  epoch: this._promptsCatalogEpoch,
                  state: 'unavailable',
                });
              } catch {}
              break;
            }
            this._promptsState = 'ready';
            this._promptsRefreshing = false;
            try {
              await this.options.onCatalogChanged?.('prompts', this, {
                epoch: this._promptsCatalogEpoch,
                state: 'ready',
              });
            } catch {}
            break;
          }
        } catch {
          if (this._generation === targetGeneration && !this._closed) {
            if (
              this._promptsDirty &&
              this._promptsRefreshRounds < 3 &&
              Date.now() < this._promptsCycleDeadline
            ) {
              continue;
            }
            this._promptsState = 'unavailable';
            this._promptsRefreshing = false;
            this._promptsDirty = false;
            try {
              await this.options.onCatalogChanged?.('prompts', this, {
                epoch: this._promptsCatalogEpoch,
                state: 'unavailable',
              });
            } catch {}
            break;
          }
        }
      }
    } finally {
      this._promptsRefreshing = false;
    }
  }

  /**
   * 注册服务端变更通知处理器。
   */
  private registerNotificationHandlers(): void {
    try {
      this.client.setNotificationHandler('notifications/tools/list_changed', async () => {
        await this.triggerToolsRefresh();
      });
    } catch {
      /* 容忍非法通知注册环境 */
    }

    try {
      this.client.setNotificationHandler('notifications/prompts/list_changed', async () => {
        await this.triggerPromptsRefresh();
      });
    } catch {
      /* 容忍非法通知注册环境 */
    }
  }

  /**
   * 建立连接并完成初始化握手与能力目录初始发现。
   *
   * @returns 初始连接与目录就绪状态。
   */
  async connect(): Promise<boolean> {
    if (this._closed) {
      this._connectionState = 'disconnected';
      return false;
    }

    this._connectionState = 'connecting';
    const startupTimeoutMs = this.options.startupTimeoutMs ?? this.config.startupTimeoutMs ?? 10000;

    try {
      // 1. 握手连接
      await this.withTimeout(
        this.client.connect(this.transport),
        startupTimeoutMs,
        `Server '${this.serverName}' connection and initialization handshake timed out after ${startupTimeoutMs}ms`,
      );

      this._connectionState = 'ready';

      // 2. 检查服务端支持的能力
      const serverCapabilities = this.client.getServerCapabilities();
      const hasTools = Boolean(serverCapabilities?.tools);
      const hasPrompts = Boolean(serverCapabilities?.prompts);

      const catalogTimeoutMs =
        this.options.catalogTimeoutMs ?? this.config.catalogTimeoutMs ?? 10000;

      // 3. 初始 Tools 目录发现
      if (!hasTools) {
        this._toolsState = 'unsupported';
        this._discoveredTools = [];
      } else {
        this._toolsState = 'pending';
        try {
          const toolsResult = await this.withTimeout(
            this.client.listTools(),
            catalogTimeoutMs,
            `Tools discovery timed out for '${this.serverName}'`,
          );
          this._discoveredTools = (toolsResult as any).tools ?? [];
          this._toolsState = 'ready';
        } catch (err: unknown) {
          this._toolsState = 'unavailable';
          this._errorMessage = (err as Error).message;
        }
      }

      // 4. 初始 Prompts 目录发现
      if (!hasPrompts) {
        this._promptsState = 'unsupported';
        this._discoveredPrompts = [];
      } else {
        this._promptsState = 'pending';
        try {
          const promptsResult = await this.withTimeout(
            this.client.listPrompts(),
            catalogTimeoutMs,
            `Prompts discovery timed out for '${this.serverName}'`,
          );
          this._discoveredPrompts = (promptsResult as any).prompts ?? [];
          this._promptsState = 'ready';
        } catch (err: unknown) {
          // 混合服务 Prompt 发现失败不撤销已成功的 Tools
          this._promptsState = 'unavailable';
          if (!this._errorMessage) {
            this._errorMessage = (err as Error).message;
          }
        }
      }

      return true;
    } catch (error: unknown) {
      this._connectionState = 'failed';
      this._toolsState = 'unavailable';
      this._promptsState = 'unavailable';
      this._errorMessage = (error as Error).message;
      return false;
    }
  }

  /**
   * 获取当前会话状态快照。
   */
  getStatus(): McpServerStatus {
    const serverInfo =
      typeof this.client.getServerVersion === 'function'
        ? this.client.getServerVersion()
        : (this.client as any)._serverVersion;
    const protocolVersion =
      typeof this.client.getNegotiatedProtocolVersion === 'function'
        ? this.client.getNegotiatedProtocolVersion()
        : (this.client as any)._negotiatedProtocolVersion;

    return {
      name: this.serverName,
      connectionState: this._connectionState,
      toolsState: this._toolsState,
      promptsState: this._promptsState,
      generation: this._generation,
      toolsCatalogEpoch: this._toolsCatalogEpoch,
      promptsCatalogEpoch: this._promptsCatalogEpoch,
      protocolVersion,
      serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : undefined,
      errorMessage: this._errorMessage,
    };
  }

  /**
   * 判定该服务在给定 required 要求下是否属于可用就绪状态。
   *
   * 规则：
   * - 底层连接必须为 'ready'；
   * - 若两者均 unsupported，判定为 false（没有可用能力）；
   * - 若为 Prompt-only 服务（tools unsupported 且 prompts ready），判定为 true；
   * - 若 tools ready，无论 prompts 如何（混合服务 prompts 失败不影响 tools），判定为 true；
   * - 否则判定为 false。
   */
  isReady(): boolean {
    if (this._connectionState !== 'ready') return false;

    // 没有声明任何本版支持的能力
    if (this._toolsState === 'unsupported' && this._promptsState === 'unsupported') {
      return false;
    }

    // Prompt-only 服务
    if (this._toolsState === 'unsupported' && this._promptsState === 'ready') {
      return true;
    }

    // 声明 Tools 且 Tools ready
    if (this._toolsState === 'ready') {
      return true;
    }

    return false;
  }

  /** 获取当前已发现并缓存的工具列表。 */
  get discoveredTools(): readonly any[] {
    return this._discoveredTools;
  }

  /** 获取当前已发现并缓存的提示词列表。 */
  get discoveredPrompts(): readonly any[] {
    return this._discoveredPrompts;
  }

  /** 连接代次。 */
  get generation(): number {
    return this._generation;
  }

  /** Tools 目录纪元。 */
  get toolsCatalogEpoch(): number {
    return this._toolsCatalogEpoch;
  }

  /** Prompts 目录纪元。 */
  get promptsCatalogEpoch(): number {
    return this._promptsCatalogEpoch;
  }

  /** 底层连接状态。 */
  get connectionState(): ServerConnectionState {
    return this._connectionState;
  }

  /** 工具能力状态。 */
  get toolsState(): CapabilityCatalogState {
    return this._toolsState;
  }

  /** 提示词能力状态。 */
  get promptsState(): CapabilityCatalogState {
    return this._promptsState;
  }

  /**
   * 关闭客户端连接并释放资源。
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    this._connectionState = 'closing';

    try {
      this.client.setNotificationHandler('notifications/tools/list_changed', undefined as any);
      this.client.setNotificationHandler('notifications/prompts/list_changed', undefined as any);
    } catch {
      /* 忽略通知反注册异常 */
    }

    try {
      await this.client.close();
    } catch {
      /* 忽略客户端关闭异常 */
    }

    this._connectionState = 'disconnected';
  }

  /**
   * 超时包装辅助函数。
   */
  private withTimeout<T>(promise: Promise<T>, timeoutMs: number, errorMessage: string): Promise<T> {
    if (timeoutMs <= 0) return promise;
    let timer: NodeJS.Timeout | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error(errorMessage));
      }, timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
