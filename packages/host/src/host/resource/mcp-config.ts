import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  type HttpServerConfig,
  type McpConfigDiagnostic,
  type McpConfigFile,
  type RawServerConfig,
  type ServerConfig,
  type StdioServerConfig,
  validateAndNormalizeServerConfig,
  validateServerName,
} from '@kiturone/kapibala-mcp';
import { readMcpConfigFile, resolveCliMcpOptions } from '../mcp.js';
import { redactCommonSecrets } from '../redaction.js';

/** 面板可见的 MCP 服务器摘要；不含环境变量值与请求头原文。 */
export interface McpServerSummary {
  name: string;
  /** 声明来源；project 侧仅做只读展示，管理操作只作用于 global。 */
  source: 'global' | 'project';
  type: 'stdio' | 'http' | 'disabled';
  /** 目标摘要（命令行或端点 URL），经既有脱敏管道处理。 */
  target: string;
  /** 声明中是否携带环境变量或自定义请求头（只报存在性，不报值）。 */
  hasSecretSurface: boolean;
  /**
   * 编辑回填面：未脱敏的原始 command/args/url，仅供编辑表单无损往返。
   * 仅当目标串本身不触发脱敏（无内嵌密钥）且来源为 global 时提供；缺失时
   * 编辑只能改名与启停，传输字段由写侧保留原文——绝不能拿脱敏后的 `target`
   * 冒充原始值回写，那会把合并串写进 command、把掩码写回配置文件。
   */
  edit?: { command?: string; args?: string[]; url?: string };
  enabled: boolean;
  required: boolean;
  diagnostics: McpConfigDiagnostic[];
}

/** 资源面板的 MCP 快照：全局清单 + 项目只读声明 + 诊断，全部经信任规则投影。 */
export interface McpResourceSnapshot {
  globalConfigPath: string;
  projectConfigPath: string | undefined;
  projectTrusted: boolean;
  /** 面板禁用状态：宿主级 --no-mcp 语义由宿主自行叠加，此处只反映配置事实。 */
  servers: McpServerSummary[];
  diagnostics: McpConfigDiagnostic[];
}

/** 全局 MCP 配置文件绝对路径（`~/.kapibala/mcp.json`）。 */
export function getGlobalMcpConfigPath(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), '.kapibala', 'mcp.json');
}

/** 项目级 MCP 配置文件绝对路径（`<projectRoot>/.kapibala/mcp.json`）。 */
export function getProjectMcpConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.kapibala', 'mcp.json');
}

function summarizeServer(
  name: string,
  source: 'global' | 'project',
  config: ServerConfig | undefined,
  diagnostics: McpConfigDiagnostic[],
  required: boolean,
): McpServerSummary {
  const type = !config || config.enabled === false ? 'disabled' : (config.type ?? 'stdio');
  const effectiveType = config ? (config.type ?? 'stdio') : undefined;
  let target = '';
  let edit: McpServerSummary['edit'];
  if (effectiveType === 'http') {
    const url = (config as HttpServerConfig | undefined)?.url;
    target = url ?? '';
    // 编辑面只给 global 且原始值不触发脱敏的声明：脱敏意味着目标串内嵌了密钥，
    // 回填编辑框会把掩码文本写回配置文件。
    if (url && source === 'global' && redactCommonSecrets(url) === url) edit = { url };
  } else if (effectiveType === 'stdio') {
    const stdio = config as StdioServerConfig | undefined;
    target = [stdio?.command, ...(stdio?.args ?? [])].filter(Boolean).join(' ');
    if (stdio?.command && source === 'global' && redactCommonSecrets(target) === target)
      edit = { command: stdio.command, args: stdio.args ?? [] };
  }
  const stdioEnv = (config as StdioServerConfig | undefined)?.env;
  const httpHeaders = (config as HttpServerConfig | undefined)?.headers;
  return {
    name,
    source,
    type,
    target: redactCommonSecrets(target),
    ...(edit ? { edit } : {}),
    hasSecretSurface:
      Boolean(stdioEnv && Object.keys(stdioEnv).length > 0) ||
      Boolean(type === 'http' && httpHeaders && Object.keys(httpHeaders).length > 0),
    enabled: config?.enabled !== false && type !== 'disabled',
    required,
    diagnostics,
  };
}

/**
 * 读取资源面板的 MCP 快照：全局 + 项目级声明的只读投影。
 *
 * 保证：
 * - 与会话装配同源——复用 `resolveCliMcpOptions` 的同一解析管道（信任排除、整项覆盖、诊断）；
 * - 项目未信任时其声明仍以「已排除」形态可见（enabled=false 且携带排除诊断），绝不在摘要中隐藏；
 * - 环境变量与请求头只报存在性，目标摘要经脱敏管道，密钥值不进入快照。
 */
export function readMcpResourceSnapshot(options: {
  homeDir?: string;
  projectRoot?: string;
  isProjectTrusted: boolean;
}): McpResourceSnapshot {
  const home = options.homeDir ?? os.homedir();
  const globalConfigPath = getGlobalMcpConfigPath(home);
  const projectConfigPath = options.projectRoot
    ? getProjectMcpConfigPath(options.projectRoot)
    : undefined;
  const resolved = resolveCliMcpOptions({
    homeDir: home,
    projectRoot: options.projectRoot ?? globalConfigPath,
    isProjectTrusted: options.isProjectTrusted,
  });
  const servers: McpServerSummary[] = [];
  const emitted = new Set<string>();
  for (const entry of resolved.servers.values()) {
    servers.push(
      summarizeServer(
        entry.name,
        entry.source,
        entry.config,
        entry.diagnostics,
        Boolean((entry.config as { required?: boolean } | undefined)?.required),
      ),
    );
    emitted.add(entry.name);
  }
  // 被 trust/禁用规则排除的声明也要可见：重新读原始文件，补齐未进入 resolved 集合的名称。
  const rawFiles: Array<{
    source: 'global' | 'project';
    file: McpConfigFile | null;
    path: string;
  }> = [
    { source: 'global', file: null, path: globalConfigPath },
    ...(projectConfigPath
      ? [{ source: 'project' as const, file: null, path: projectConfigPath }]
      : []),
  ];
  const rawDiagnostics: McpConfigDiagnostic[] = [];
  for (const item of rawFiles) {
    let file: McpConfigFile | null = null;
    try {
      file = readMcpConfigFile(item.path);
    } catch (error: unknown) {
      rawDiagnostics.push({
        severity: 'error',
        code: 'MCP_CONFIG_READ_FAILED',
        message: `读取 ${item.source} 配置失败 [${item.path}]: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    item.file = file;
  }
  const projectUntrusted =
    projectConfigPath !== undefined && rawFiles[1]?.file?.mcpServers && !options.isProjectTrusted;
  for (const item of rawFiles) {
    for (const [name, raw] of Object.entries(item.file?.mcpServers ?? {})) {
      if (emitted.has(name)) continue;
      // 未进入 resolved 集合 = 被排除（未信任项目声明或纯禁用覆盖的全局项）；展示排除事实。
      const { config, diagnostics } = validateAndNormalizeServerConfig(
        name,
        raw as RawServerConfig,
      );
      servers.push(
        summarizeServer(
          name,
          item.source,
          config,
          [
            ...diagnostics,
            ...(item.source === 'project' && projectUntrusted
              ? [
                  {
                    severity: 'info' as const,
                    code: 'MCP_PROJECT_UNTRUSTED',
                    serverName: name,
                    message: '项目未被信任：该声明已从会话装配中排除',
                  },
                ]
              : []),
          ],
          Boolean((raw as { required?: boolean } | undefined)?.required),
        ),
      );
      emitted.add(name);
    }
  }
  return {
    globalConfigPath,
    projectConfigPath,
    projectTrusted: options.isProjectTrusted,
    servers,
    diagnostics: [...resolved.diagnostics, ...rawDiagnostics],
  };
}

/**
 * 全局 MCP 配置短事务：独占锁内重读、同步修改、全量校验并原子替换。
 *
 * 保证与边界：
 * - 与 `mutateGlobalSettings` 同一锁语义：竞争立即报 MCP_CONFIG_BUSY，不按 PID/时间抢占遗留锁；
 *   释放时核验随机所有者，绝不删除他人的锁；
 * - 配置文件损坏时中止写入（不静默重建），写回前对每个 server 执行名称与配置校验，
 *   任一 error 级诊断都拒绝整个事务并保留原文件；
 * - 回调必须同步完成；不校验、不写项目级文件。
 */
export function mutateGlobalMcpConfig(
  mutate: (file: McpConfigFile) => void,
  options: { homeDir?: string } = {},
): string {
  const file = getGlobalMcpConfigPath(options.homeDir);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const lock = `${file}.lock`;
  const owner = randomUUID();
  let descriptor: number;
  try {
    descriptor = fs.openSync(lock, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      throw Object.assign(
        new Error(
          `MCP_CONFIG_BUSY: MCP 配置锁 ${lock} 已存在；请确认所有写入进程退出后人工核验，不能自动抢锁。`,
        ),
        { code: 'MCP_CONFIG_BUSY' },
      );
    throw error;
  }
  try {
    fs.writeFileSync(descriptor, JSON.stringify({ owner, pid: process.pid }));
    let draft: McpConfigFile;
    try {
      draft = readMcpConfigFile(file) ?? {};
    } catch (error: unknown) {
      throw new Error(
        `全局 MCP 配置损坏，拒绝写入：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const result: unknown = mutate(draft);
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(result).catch(() => {});
      throw new Error('MCP 配置事务回调必须同步完成');
    }
    // 写回前全量校验：任一 server 的 error 级诊断都使整个事务失败。
    const failures: string[] = [];
    for (const [name, raw] of Object.entries(draft.mcpServers ?? {})) {
      const nameCheck = validateServerName(name);
      if (!nameCheck.valid) {
        failures.push(`服务器名称非法 '${name}': ${nameCheck.reason}`);
        continue;
      }
      const { diagnostics } = validateAndNormalizeServerConfig(name, raw);
      for (const diagnostic of diagnostics) {
        if (diagnostic.severity === 'error') failures.push(`[${name}] ${diagnostic.message}`);
      }
    }
    if (failures.length)
      throw Object.assign(
        new Error(`MCP_CONFIG_INVALID: 配置校验失败，未写入。\n${failures.join('\n')}`),
        { code: 'MCP_CONFIG_INVALID' },
      );
    const content = `${JSON.stringify(draft, null, 2)}\n`;
    const temporaryPath = `${file}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporaryPath, content, {
        encoding: 'utf-8',
        mode: 0o600,
        flag: 'wx',
      });
      fs.renameSync(temporaryPath, file);
    } catch (error) {
      try {
        fs.unlinkSync(temporaryPath);
      } catch {
        /* 写入失败或临时文件尚未建立。 */
      }
      throw error;
    }
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      /* 平台不支持 POSIX mode 时写入仍然成功。 */
    }
    return file;
  } finally {
    fs.closeSync(descriptor);
    try {
      if (JSON.parse(fs.readFileSync(lock, 'utf8')).owner === owner) fs.unlinkSync(lock);
    } catch {
      /* 锁被移除、替换或损坏时保留现场。 */
    }
  }
}
