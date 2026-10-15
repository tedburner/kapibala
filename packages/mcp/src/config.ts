/**
 * @fileoverview MCP (Model Context Protocol) 配置解析与校验
 *
 * 约束、边界与为什么：
 * 1. 严格命名约束：Server 名称必须匹配 `^[a-zA-Z0-9_-]+$` 且禁止 `/`、`\` 以及连续双下划线 `__`。
 *    原因：MCP 工具命名格式为 `mcp__<server>__<tool>`，Prompt ID 为 `<server>/<prompt>`，
 *    包含上述字符会导致双向逆向映射出现歧义，埋下命名碰撞或注入风险。
 * 2. 整项覆盖（Whole-Item Override）：同名 Server 声明，项目级配置整项覆盖全局定义。
 *    显式禁止字段浅合并、数组拼接或嵌套对象补字段，杜绝环境变量或参数被隐式拼凑产生的安全漏洞。
 * 3. 项目信任边界：只有受信任项目方可应用项目级配置；未信任项目的声明被排除并输出诊断，
 *    严禁未信任项目覆盖全局合法的 Server 配置。
 * 4. 禁用不回退：项目级配置若声明 `{ enabled: false }`，该 Server 处于禁用状态，
 *    严禁在禁用后悄悄回退到全局定义的启用配置。
 */

/**
 * 基础 Server 配置字段（stdio 与 http 共享）。
 */
export interface BaseServerConfig {
  /** 是否启用本服务；未指定时默认为 true。 */
  enabled?: boolean;
  /** 是否为核心必需服务；若启动失败或目录就绪失败，阻断当前任务执行。 */
  required?: boolean;
  /** 协议协商版本；legacy 协商 2024-11-05，modern 使用 2026-07-28，auto 自动探测。 */
  protocol?: 'legacy' | 'auto' | 'modern';
  /** 工具白名单模式（名称数组）；仅白名单内工具对外暴露。 */
  includeTools?: string[];
  /** 工具黑名单模式（名称数组）；黑名单内工具被剔除。 */
  excludeTools?: string[];
  /** 进程/连接启动超时毫秒数；超时后终止启动并回收资源。 */
  startupTimeoutMs?: number;
  /** 目录发现与分页超时毫秒数；超时后放弃本次刷新。 */
  catalogTimeoutMs?: number;
  /** 单次调用请求超时毫秒数；超时后触发取消收口。 */
  requestTimeoutMs?: number;
}

/**
 * Stdio 进程传输服务配置。
 */
export interface StdioServerConfig extends BaseServerConfig {
  type?: 'stdio';
  /** 启动命令或可执行程序路径。 */
  command: string;
  /** 命令行参数数组；整项覆盖时不与全局配置拼接。 */
  args?: string[];
  /** 进程工作目录；必须在项目授权物理路径范围内。 */
  cwd?: string;
  /** 注入的环境变量；仅透传白名单允许或显式声明的非敏感变量。 */
  env?: Record<string, string>;
}

/**
 * Streamable HTTP 传输服务配置。
 */
export interface HttpServerConfig extends BaseServerConfig {
  type: 'http';
  /** 服务端端点 URL；默认强制 HTTPS，仅回环地址允许 HTTP。 */
  url: string;
  /** 自定义请求头（如固定 Authorization 等凭据）。 */
  headers?: Record<string, string>;
}

/**
 * 纯禁用覆盖配置（项目级允许仅通过 `{ enabled: false }` 禁用全局同名服务，无需提供 command 或 url）。
 */
export interface DisabledServerConfig extends BaseServerConfig {
  enabled: false;
  command?: string;
  url?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  type?: 'stdio' | 'http';
}

/**
 * 判别联合：标准合法 Server 配置。
 */
export type ServerConfig = StdioServerConfig | HttpServerConfig | DisabledServerConfig;

/**
 * 未经校验的原始配置对象类型（宽松输入）。
 */
export type RawServerConfig =
  | Partial<StdioServerConfig>
  | Partial<HttpServerConfig>
  | Record<string, unknown>;

/**
 * mcp.json 配置文件顶层 Schema。
 */
export interface McpConfigFile {
  mcpServers?: Record<string, RawServerConfig>;
}

/**
 * 配置诊断信息。
 */
export interface McpConfigDiagnostic {
  severity: 'error' | 'warning' | 'info';
  code: string;
  serverName?: string;
  message: string;
}

/**
 * 经解析与信任过滤后物化的 Server 条目。
 */
export interface ResolvedServerEntry {
  name: string;
  source: 'global' | 'project';
  config: ServerConfig;
  diagnostics: McpConfigDiagnostic[];
}

/**
 * 配置解析最终结果。
 */
export interface ResolveMcpConfigResult {
  /** 成功解析并生效的服务映射表，键为经过校验的规范化 Server 名称。 */
  servers: Map<string, ResolvedServerEntry>;
  /** 全量诊断记录（包含忽略未信任项目、非法命名等详细信息）。 */
  diagnostics: McpConfigDiagnostic[];
  /** 是否存在阻断性的致命错误（例如 required 服务的配置非法）。 */
  hasFatalError: boolean;
}

const SERVER_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MAX_SERVER_NAME_LENGTH = 64;

/**
 * 严格校验 Server 名称合法性。
 *
 * 保证：
 * - 长度在 1 到 64 字符之间；
 * - 仅包含字母、数字、下划线 `_` 和短横线 `-`；
 * - 显式禁止 `/` 和 `\`（防止 Prompt ID 解析歧义）；
 * - 显式禁止连续双下划线 `__`（防止工具命名 `mcp__<server>__<tool>` 映射碰撞）。
 */
export function validateServerName(name: string): { valid: boolean; reason?: string } {
  if (!name || typeof name !== 'string') {
    return { valid: false, reason: 'Server name must be a non-empty string' };
  }
  if (name.length > MAX_SERVER_NAME_LENGTH) {
    return {
      valid: false,
      reason: `Server name exceeds maximum allowed length of ${MAX_SERVER_NAME_LENGTH} characters`,
    };
  }
  if (name.includes('/') || name.includes('\\')) {
    return { valid: false, reason: 'Server name cannot contain slashes' };
  }
  if (name.includes('__')) {
    return {
      valid: false,
      reason: "Server name cannot contain consecutive double underscores ('__')",
    };
  }
  if (!SERVER_NAME_PATTERN.test(name)) {
    return {
      valid: false,
      reason:
        "Server name must only contain alphanumeric characters, underscores, and dashes ('^[a-zA-Z0-9_-]+$')",
    };
  }
  return { valid: true };
}

/**
 * 校验并规范化单个 Server 配置条目。
 * 纯函数，不产生任何副作用。
 */
export function validateAndNormalizeServerConfig(
  name: string,
  raw: unknown,
): { config?: ServerConfig; diagnostics: McpConfigDiagnostic[] } {
  const diagnostics: McpConfigDiagnostic[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    diagnostics.push({
      severity: 'error',
      code: 'MCP_CONFIG_INVALID',
      serverName: name,
      message: `Server configuration for '${name}' must be an object`,
    });
    return { diagnostics };
  }

  const rawConfig = raw as Record<string, unknown>;

  // 纯禁用覆盖情况：enabled 明确为 false 时，允许不包含传输必需字段
  if (rawConfig.enabled === false) {
    const disabledConfig: DisabledServerConfig = {
      enabled: false,
      required: Boolean(rawConfig.required),
      protocol:
        typeof rawConfig.protocol === 'string' &&
        ['legacy', 'auto', 'modern'].includes(rawConfig.protocol)
          ? (rawConfig.protocol as 'legacy' | 'auto' | 'modern')
          : undefined,
    };
    return { config: disabledConfig, diagnostics };
  }

  // 判别类型判定：显式声明 type 或根据 url / command 字段自动推导
  const explicitType = rawConfig.type;
  const hasUrl = typeof rawConfig.url === 'string' && rawConfig.url.trim().length > 0;
  const hasCommand = typeof rawConfig.command === 'string' && rawConfig.command.trim().length > 0;

  if (explicitType === 'http' || (!explicitType && hasUrl)) {
    if (!hasUrl) {
      diagnostics.push({
        severity: 'error',
        code: 'MCP_CONFIG_INVALID',
        serverName: name,
        message: `HTTP server '${name}' missing required 'url' field`,
      });
      return { diagnostics };
    }
    const httpConfig: HttpServerConfig = {
      type: 'http',
      url: String(rawConfig.url).trim(),
      enabled: rawConfig.enabled !== false,
      required: Boolean(rawConfig.required),
      protocol:
        typeof rawConfig.protocol === 'string' &&
        ['legacy', 'auto', 'modern'].includes(rawConfig.protocol)
          ? (rawConfig.protocol as 'legacy' | 'auto' | 'modern')
          : undefined,
      headers:
        typeof rawConfig.headers === 'object' &&
        rawConfig.headers !== null &&
        !Array.isArray(rawConfig.headers)
          ? (rawConfig.headers as Record<string, string>)
          : undefined,
      includeTools: Array.isArray(rawConfig.includeTools)
        ? rawConfig.includeTools.map(String)
        : undefined,
      excludeTools: Array.isArray(rawConfig.excludeTools)
        ? rawConfig.excludeTools.map(String)
        : undefined,
      startupTimeoutMs:
        typeof rawConfig.startupTimeoutMs === 'number' ? rawConfig.startupTimeoutMs : undefined,
      catalogTimeoutMs:
        typeof rawConfig.catalogTimeoutMs === 'number' ? rawConfig.catalogTimeoutMs : undefined,
      requestTimeoutMs:
        typeof rawConfig.requestTimeoutMs === 'number' ? rawConfig.requestTimeoutMs : undefined,
    };
    return { config: httpConfig, diagnostics };
  }

  if (explicitType === 'stdio' || (!explicitType && hasCommand) || (!explicitType && !hasUrl)) {
    if (!hasCommand) {
      diagnostics.push({
        severity: 'error',
        code: 'MCP_CONFIG_INVALID',
        serverName: name,
        message: `Stdio server '${name}' missing required 'command' field`,
      });
      return { diagnostics };
    }
    const stdioConfig: StdioServerConfig = {
      type: 'stdio',
      command: String(rawConfig.command).trim(),
      args: Array.isArray(rawConfig.args) ? rawConfig.args.map(String) : undefined,
      cwd: typeof rawConfig.cwd === 'string' ? rawConfig.cwd : undefined,
      env:
        typeof rawConfig.env === 'object' && rawConfig.env !== null && !Array.isArray(rawConfig.env)
          ? (rawConfig.env as Record<string, string>)
          : undefined,
      enabled: rawConfig.enabled !== false,
      required: Boolean(rawConfig.required),
      protocol:
        typeof rawConfig.protocol === 'string' &&
        ['legacy', 'auto', 'modern'].includes(rawConfig.protocol)
          ? (rawConfig.protocol as 'legacy' | 'auto' | 'modern')
          : undefined,
      includeTools: Array.isArray(rawConfig.includeTools)
        ? rawConfig.includeTools.map(String)
        : undefined,
      excludeTools: Array.isArray(rawConfig.excludeTools)
        ? rawConfig.excludeTools.map(String)
        : undefined,
      startupTimeoutMs:
        typeof rawConfig.startupTimeoutMs === 'number' ? rawConfig.startupTimeoutMs : undefined,
      catalogTimeoutMs:
        typeof rawConfig.catalogTimeoutMs === 'number' ? rawConfig.catalogTimeoutMs : undefined,
      requestTimeoutMs:
        typeof rawConfig.requestTimeoutMs === 'number' ? rawConfig.requestTimeoutMs : undefined,
    };
    return { config: stdioConfig, diagnostics };
  }

  diagnostics.push({
    severity: 'error',
    code: 'MCP_CONFIG_INVALID',
    serverName: name,
    message: `Server '${name}' has ambiguous or invalid transport configuration`,
  });
  return { diagnostics };
}

/**
 * 输入参数选项：合并全局与项目两层 MCP 配置。
 */
export interface ResolveMcpConfigOptions {
  /** 全局配置对象（~/.kapibala/mcp.json）。 */
  globalConfig?: McpConfigFile | null;
  /** 项目级配置对象（<projectRoot>/.kapibala/mcp.json）。 */
  projectConfig?: McpConfigFile | null;
  /**
   * 当前项目是否已被用户授权信任。
   * 为 false 时，项目级配置被全量忽略，不得执行其任何声明，也不得覆盖全局配置。
   */
  isProjectTrusted: boolean;
}

/**
 * 纯函数：根据项目信任状态和整项覆盖规则解析最终生效的 MCP 服务配置清单。
 *
 * 不访问文件系统、不发起网络调用、不启动任何进程。
 */
export function resolveMcpConfig(options: ResolveMcpConfigOptions): ResolveMcpConfigResult {
  const { globalConfig, projectConfig, isProjectTrusted } = options;
  const servers = new Map<string, ResolvedServerEntry>();
  const diagnostics: McpConfigDiagnostic[] = [];
  let hasFatalError = false;

  // 1. 解析全局层配置
  if (globalConfig?.mcpServers && typeof globalConfig.mcpServers === 'object') {
    for (const [rawName, rawServer] of Object.entries(globalConfig.mcpServers)) {
      const nameValidation = validateServerName(rawName);
      if (!nameValidation.valid) {
        const isRequired =
          typeof rawServer === 'object' &&
          rawServer !== null &&
          Boolean((rawServer as Record<string, unknown>).required);
        diagnostics.push({
          severity: 'error',
          code: 'MCP_CONFIG_INVALID',
          serverName: rawName,
          message: `Global server '${rawName}' has invalid name: ${nameValidation.reason}`,
        });
        if (isRequired) hasFatalError = true;
        continue;
      }

      const { config, diagnostics: itemDiagnostics } = validateAndNormalizeServerConfig(
        rawName,
        rawServer,
      );
      diagnostics.push(...itemDiagnostics);
      const isRequired =
        typeof rawServer === 'object' &&
        rawServer !== null &&
        Boolean((rawServer as Record<string, unknown>).required);
      if (!config) {
        if (isRequired) hasFatalError = true;
        continue;
      }

      servers.set(rawName, {
        name: rawName,
        source: 'global',
        config,
        diagnostics: itemDiagnostics,
      });
    }
  }

  // 2. 解析项目层配置（依据项目信任状态）
  if (projectConfig?.mcpServers && typeof projectConfig.mcpServers === 'object') {
    if (!isProjectTrusted) {
      // 未信任项目：记录诊断并排除，严禁覆盖全局声明
      for (const rawName of Object.keys(projectConfig.mcpServers)) {
        diagnostics.push({
          severity: 'warning',
          code: 'MCP_PROJECT_UNTRUSTED',
          serverName: rawName,
          message: `Ignored project MCP server '${rawName}' because project is not trusted`,
        });
      }
    } else {
      // 受信任项目：整项覆盖全局定义
      for (const [rawName, rawServer] of Object.entries(projectConfig.mcpServers)) {
        const nameValidation = validateServerName(rawName);
        if (!nameValidation.valid) {
          const isRequired =
            typeof rawServer === 'object' &&
            rawServer !== null &&
            Boolean((rawServer as Record<string, unknown>).required);
          diagnostics.push({
            severity: 'error',
            code: 'MCP_CONFIG_INVALID',
            serverName: rawName,
            message: `Project server '${rawName}' has invalid name: ${nameValidation.reason}`,
          });
          if (isRequired) hasFatalError = true;
          // 命名违规的项目条目不能生效，若此前有全局同名项，也不得保留可能导致歧义的状态
          servers.delete(rawName);
          continue;
        }

        const { config, diagnostics: itemDiagnostics } = validateAndNormalizeServerConfig(
          rawName,
          rawServer,
        );
        diagnostics.push(...itemDiagnostics);
        const isRequired =
          typeof rawServer === 'object' &&
          rawServer !== null &&
          Boolean((rawServer as Record<string, unknown>).required);
        if (!config) {
          if (isRequired) hasFatalError = true;
          // 项目配置有严重错误时，直接移除该 Server，严禁错误项静默回退到全局配置
          servers.delete(rawName);
          continue;
        }

        // 整项覆盖：直接覆盖 Map，不拼接 args / headers，不合并字段
        servers.set(rawName, {
          name: rawName,
          source: 'project',
          config,
          diagnostics: itemDiagnostics,
        });
      }
    }
  }

  return {
    servers,
    diagnostics,
    hasFatalError,
  };
}
