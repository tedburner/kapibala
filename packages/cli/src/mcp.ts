/**
 * @fileoverview CLI 宿主 MCP 生态接入与启动授权适配
 *
 * 约束、边界与为什么：
 * 1. 独立配置文件契约：MCP 服务定义从 `~/.kapibala/mcp.json` 与 `<projectRoot>/.kapibala/mcp.json` 读取，
 *    完全独立于主 `settings.json`，遵循整项覆盖与严格命名规则；
 * 2. 项目信任防线：未受用户信任的项目，其 `.kapibala/mcp.json` 的全部声明被严格排除并输出诊断，
 *    严禁未信任项目注入外部 Stdio 命令或覆盖全局合法的服务定义；
 * 3. 宿主禁用硬防线（`--no-mcp`）：当用户通过命令行参数显式传入 `--no-mcp` 时，整个会话的 MCP 功能
 *    被宿主彻底关闭，后续任何 `/mcp enable` 均必须直接拒绝，严禁运行时绕过；
 * 4. 零开销零等待不变量：当无任何已配置 MCP 服务或被 `--no-mcp` 禁用时，不创建任何后台探测、不发起
 *    任何网络请求，实现零技术等待与零启动开销；
 * 5. 启动授权串行与会话隔离：启动 Stdio 服务必须经用户显式批准，审批在输入协调器内串行执行；
 *    会话启动批准缓存仅在当前活动会话内生效，切换会话或切换项目后自动失效，严禁跨会话转移授权。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentSession } from '@kiturone/kapibala';
import {
  type McpConfigDiagnostic,
  type McpConfigFile,
  type McpPluginInstance,
  type ResolvedServerEntry,
  type ServerStartApprovalDecision,
  type ServerStartAuthorizer,
  ServerStartupApprovalCache,
  type ServerStartupDescriptor,
  createMcpPlugin,
  resolveMcpConfig,
} from '@kiturone/kapibala-mcp';
import type { CliInputCoordinator } from './input-coordinator.js';

/**
 * CLI 解析后的 MCP 宿主状态。
 */
export interface CliMcpHostOptions {
  /** 是否启用了 MCP 机制（无配置或被 --no-mcp 禁用时为 false）。 */
  enabled: boolean;
  /** 是否被命令行 `--no-mcp` 显式禁用（用于阻止后续 /mcp enable 绕过）。 */
  disabledByFlag: boolean;
  /** 经信任校验与整项覆盖合并后的 Server 清单。 */
  servers: Map<string, ResolvedServerEntry>;
  /** 解析过程收集到的全量诊断（未信任项目排除、格式错误等）。 */
  diagnostics: McpConfigDiagnostic[];
  /** 全局配置文件路径。 */
  globalConfigPath?: string;
  /** 项目级配置文件路径。 */
  projectConfigPath?: string;
}

/**
 * 安全尝试读取单个 mcp.json 文件；若文件不存在返回 null，若读取或解析失败抛出带路径的友好错误。
 *
 * @param filePath - 待读取的绝对路径。
 * @returns 成功解析的 JSON 对象，或在文件缺失时返回 null。
 */
export function readMcpConfigFile(filePath: string): McpConfigFile | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('配置文件根节点必须为 JSON 对象');
    }
    return parsed as McpConfigFile;
  } catch (error: unknown) {
    throw new Error(
      `读取 MCP 配置文件失败 [${filePath}]: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * 解析 CLI 宿主环境下的 MCP 配置与项目信任。
 *
 * @param options - 包含工作目录、用户主目录、项目根目录、信任状态及命令行开关。
 * @returns 规范化的 MCP 宿主选项。
 */
export function resolveCliMcpOptions(options: {
  cwd?: string;
  homeDir?: string;
  projectRoot: string;
  isProjectTrusted: boolean;
  noMcp?: boolean;
}): CliMcpHostOptions {
  const { projectRoot, isProjectTrusted, noMcp } = options;
  const home = options.homeDir ?? os.homedir();
  const globalConfigPath = path.join(home, '.kapibala', 'mcp.json');
  const projectConfigPath = path.join(projectRoot, '.kapibala', 'mcp.json');

  if (noMcp) {
    return {
      enabled: false,
      disabledByFlag: true,
      servers: new Map(),
      diagnostics: [
        {
          severity: 'info',
          code: 'MCP_DISABLED_BY_FLAG',
          message: 'MCP ecosystem disabled by --no-mcp flag',
        },
      ],
      globalConfigPath,
      projectConfigPath,
    };
  }

  let globalConfig: McpConfigFile | null = null;
  let projectConfig: McpConfigFile | null = null;
  const diagnostics: McpConfigDiagnostic[] = [];

  try {
    globalConfig = readMcpConfigFile(globalConfigPath);
  } catch (err: unknown) {
    diagnostics.push({
      severity: 'error',
      code: 'MCP_GLOBAL_CONFIG_READ_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    projectConfig = readMcpConfigFile(projectConfigPath);
  } catch (err: unknown) {
    diagnostics.push({
      severity: 'error',
      code: 'MCP_PROJECT_CONFIG_READ_FAILED',
      message: err instanceof Error ? err.message : String(err),
    });
  }

  // 零开销判断：两处配置文件均不存在且无 servers 时，直接返回禁用状态，不进入任何探测逻辑
  const hasGlobalServers =
    globalConfig?.mcpServers && Object.keys(globalConfig.mcpServers).length > 0;
  const hasProjectServers =
    projectConfig?.mcpServers && Object.keys(projectConfig.mcpServers).length > 0;

  if (!hasGlobalServers && !hasProjectServers && diagnostics.length === 0) {
    return {
      enabled: false,
      disabledByFlag: false,
      servers: new Map(),
      diagnostics: [],
      globalConfigPath,
      projectConfigPath,
    };
  }

  const result = resolveMcpConfig({
    globalConfig,
    projectConfig,
    isProjectTrusted,
  });

  diagnostics.push(...result.diagnostics);

  return {
    enabled: result.servers.size > 0,
    disabledByFlag: false,
    servers: result.servers,
    diagnostics,
    globalConfigPath,
    projectConfigPath,
  };
}

/**
 * 创建交互式 CLI 启动授权决策器。
 *
 * 保证：
 * 1. 非交互环境零静默放行：非 TTY 环境下，未预授权的 Server 启动直接拒绝；
 * 2. 交互环境下向用户清晰展示服务命令、目标物理路径、参数与工作目录；
 * 3. 支持本次授权 (allow_once)、会话级授权 (allow_session) 或拒绝。
 *
 * @param inputCoordinator - 统一输入协调器。
 * @param interactive - 当前终端是否具备交互能力。
 * @returns 规范的 ServerStartAuthorizer 回调。
 */
export function createCliServerStartAuthorizer(
  inputCoordinator: CliInputCoordinator,
  interactive: boolean,
): ServerStartAuthorizer {
  return async (
    descriptor: ServerStartupDescriptor,
    signal?: AbortSignal,
  ): Promise<ServerStartApprovalDecision> => {
    if (signal?.aborted) {
      return 'deny_once';
    }

    if (!interactive || !inputCoordinator.interactive) {
      // 非交互环境一律拒绝
      return 'deny_once';
    }

    // 格式化审批提示文本
    const lines = [
      `\x1b[33m[MCP 启动审批]\x1b[0m 正在请求启动外部服务: \x1b[1m${descriptor.serverName}\x1b[0m (${descriptor.source})`,
      `  传输协议: ${descriptor.type}`,
      `  执行目标: ${descriptor.target}`,
    ];
    if (descriptor.args && descriptor.args.length > 0) {
      lines.push(`  执行参数: ${descriptor.args.join(' ')}`);
    }
    if (descriptor.cwd) {
      lines.push(`  工作目录: ${descriptor.cwd}`);
    }
    if (descriptor.credentialAlertVars && descriptor.credentialAlertVars.length > 0) {
      lines.push(
        `  \x1b[31m[风险警示] 检测到潜在敏感环境变量引用:\x1b[0m ${descriptor.credentialAlertVars.join(', ')}`,
      );
    }
    lines.push('是否允许启动此服务？[y: 仅本次 | s: 本会话内允许 | n: 拒绝 (默认 n)]: ');

    const promptText = lines.join('\n');

    let answer: string;
    try {
      answer = await inputCoordinator.question(promptText);
    } catch {
      return 'deny_once';
    }

    const trimmed = answer.trim().toLowerCase();
    if (trimmed === 's' || trimmed === 'session') {
      return 'allow_session';
    }
    if (trimmed === 'y' || trimmed === 'yes') {
      return 'allow_once';
    }
    return 'deny_once';
  };
}

/** 弱引用表：记录 AgentSession 实例与对应挂载的 McpPluginInstance 的关联。 */
const SESSION_MCP_MAP = new WeakMap<AgentSession, McpPluginInstance>();

/**
 * 绑定指定会话与 MCP 插件实例关联。
 *
 * @param session - 目标会话。
 * @param plugin - 待绑定的插件实例。
 */
export function bindSessionMcpPlugin(session: AgentSession, plugin: McpPluginInstance): void {
  SESSION_MCP_MAP.set(session, plugin);
}

/**
 * 获取指定会话挂载的 MCP 插件实例。
 *
 * @param session - 目标活动会话。
 * @returns 绑定的 McpPluginInstance，若该会话未接入 MCP 则返回 undefined。
 */
export function getSessionMcpPlugin(session: AgentSession): McpPluginInstance | undefined {
  return SESSION_MCP_MAP.get(session);
}

/**
 * 将活动会话接入 MCP 插件生态，维护生命周期隔离与独立会话缓存。
 *
 * @param session - 待初始化的目标会话。
 * @param hostOptions - CLI 解析的 MCP 宿主配置。
 * @param inputCoordinator - 统一输入协调器。
 * @param interactive - 是否具备终端交互能力。
 * @returns 创建并成功挂载的插件实例；若 MCP 禁用则返回 undefined。
 */
export async function attachMcpToSession(
  session: AgentSession,
  hostOptions: CliMcpHostOptions,
  inputCoordinator: CliInputCoordinator,
  interactive: boolean,
): Promise<McpPluginInstance | undefined> {
  if (!hostOptions.enabled || hostOptions.servers.size === 0) {
    return undefined;
  }

  // 1. 创建独立的会话启动审批缓存（确保会话间审批状态严格隔离）
  const startupCache = new ServerStartupApprovalCache();
  const authorizer = createCliServerStartAuthorizer(inputCoordinator, interactive);

  // 2. 组装 Manager 配置格式
  const serversConfig: Record<string, import('@kiturone/kapibala-mcp').ServerConfig> = {};
  for (const [name, entry] of hostOptions.servers) {
    serversConfig[name] = entry.config;
  }

  // 3. 创建受管 McpPluginInstance
  const plugin = createMcpPlugin(serversConfig, {
    authorizer,
    startupCache,
  });

  // 4. 挂载到 AgentSession 并执行 setup
  await session.use(plugin);

  // 5. 绑定弱引用，供 CLI 命令交互获取
  SESSION_MCP_MAP.set(session, plugin);

  return plugin;
}
