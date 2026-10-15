/**
 * @fileoverview MCP 宿主插件集成与会话所有权绑定
 *
 * 约束与边界：
 * 1. 严格遵守「一 Session 一插件实例」约束：严禁将同一个 McpPlugin 实例挂载到多个不同的 Session，或在同一 Session 内重复挂载；
 * 2. setup 阶段若发生任何致命错误（如 Required 服务未就绪、启动超时），必须自动回滚已启动的所有资源，绝不遗留未受管的孤儿进程；
 * 3. 所有创建的底层传输句柄与子进程均由对应的 McpServerManager 统一管理与回收，失败资源必须具备唯一明确的所有者；
 * 4. teardown 保证幂等执行，重复调用安全无害。
 */

import type { AgentPlugin, PluginContext } from '@kiturone/kapibala';
import { McpServerManager, type McpServersInput } from './manager.js';
import type { McpPromptRegistry } from './prompts/registry.js';
import type { McpManagerOptions } from './types.js';

/**
 * MCP 插件配置选项。
 */
export interface McpPluginOptions extends McpManagerOptions {
  /** 插件自定义名称，默认 'mcp-ecosystem'。 */
  name?: string;
  /** 插件版本，默认 '0.0.5'。 */
  version?: string;
}

/**
 * 受管 MCP 插件实例，扩展了底层的服务管理器访问接口。
 */
export interface McpPluginInstance extends AgentPlugin {
  /** 关联的 MCP 服务管理器。 */
  readonly manager: McpServerManager;
  /** Prompt 集中式注册表。 */
  readonly promptRegistry: McpPromptRegistry;
  /** 当前插件是否已被挂载到会话。 */
  readonly isMounted: boolean;
  /** 当前挂载的会话识别标识（未挂载返回 null）。 */
  readonly mountedSessionId: string | null;
}

/**
 * 创建受管 MCP 宿主插件。
 *
 * 保证一 Session 一插件实例契约。若该插件实例已被挂载，再次调用 setup 将被直接拒绝。
 *
 * @param config - 已解析并校验的 MCP 配置。
 * @param options - 插件与管理器选项。
 * @returns 具备生命周期管理能力的 AgentPlugin 实例。
 */
export function createMcpPlugin(
  config: McpServersInput,
  options: McpPluginOptions = {},
): McpPluginInstance {
  const pluginName = options.name ?? 'mcp-ecosystem';
  const pluginVersion = options.version ?? '0.0.5';
  const manager = new McpServerManager(options);

  let mounted = false;
  let mountedSessionId: string | null = null;

  const plugin: McpPluginInstance = {
    name: pluginName,
    version: pluginVersion,
    description: 'Model Context Protocol (MCP) ecosystem integration for tools and prompts',
    contributes: {
      commands: [
        {
          name: 'mcp',
          description: '查看 MCP 服务状态、已注册工具或重连/开关当前会话服务',
          usage: '/mcp [tools <server> | reconnect <server> | enable <server> | disable <server>]',
          mutates: true,
        },
        {
          name: 'prompts',
          description: '搜索 MCP 提示词模板与参数',
          usage: '/prompts [query]',
          mutates: false,
        },
        {
          name: 'prompt',
          description: '执行 MCP 提示词模板任务',
          usage: '/prompt <server/name> [arguments-json]',
          mutates: true,
        },
      ],
    },
    manager,
    promptRegistry: manager.promptRegistry,
    get isMounted(): boolean {
      return mounted;
    },
    get mountedSessionId(): string | null {
      return mountedSessionId;
    },

    async setup(ctx: PluginContext): Promise<void> {
      // 1. 验证一 Session 一插件约束：禁止重复挂载或跨会话复用
      if (mounted) {
        throw new Error(
          `McpPlugin '${pluginName}' is already mounted to a session (bound to '${mountedSessionId}') and cannot be reused across sessions.`,
        );
      }

      // 提取会话唯一标识（以 rootDir 或 logger 作为上下文绑定）
      mounted = true;
      mountedSessionId = ctx.rootDir;

      try {
        // 2. 绑定工具注册表，并启动初始化所有配置服务
        manager.setToolRegistry(ctx.tools);
        await manager.startupAll(config, options);
      } catch (error: unknown) {
        // 3. setup 失败时确保资源彻底回滚，禁止遗留孤儿进程
        try {
          await manager.teardown(options.cleanupTimeoutMs ?? 5000);
        } catch {
          /* 忽略回滚阶段清理错误 */
        }
        throw error;
      }
    },

    async teardown(): Promise<void> {
      await manager.teardown(options.cleanupTimeoutMs ?? 5000);
    },
  };

  return plugin;
}
