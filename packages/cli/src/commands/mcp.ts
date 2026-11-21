import { resolveCommandOutput } from '../command-output.js';
/**
 * @fileoverview /mcp 管理命令：查看服务状态、工具列表、重连与会话级开关
 *
 * 约束、边界与为什么：
 * 1. 纯本地只读命令忙碌放行：`/mcp`（列表）与 `/mcp tools <server>` 仅读取本地当前状态快照，
 *    不发起任何网络握手或外部进程重连，在会话忙碌期间允许安全执行；
 * 2. 变更命令忙碌阻断：`reconnect`、`enable`、`disable` 属于变更类操作，会递增代次并回收旧传输，
 *    在任务执行中、审批中或清理中严格拒绝执行；
 * 3. 宿主禁用硬防线：若 CLI 启动时传入了 `--no-mcp`，宿主彻底停用 MCP 生态，
 *    严禁用户通过 `/mcp enable` 绕过宿主启动限制；
 * 4. 纯内存临时变更约定：`enable` 与 `disable` 只改变当前会话内的服务可用性，
 *    严禁写回磁盘 `mcp.json` 配置文件，保证磁盘配置的声明性与只读完整性。
 */

import os from 'node:os';
import {
  McpServerApprovalStore,
  formatMcpToolLabel,
  getSessionMcpPlugin,
  isProjectTrusted,
  mutateMcpConfig,
  readMcpApprovalEntries,
  redactCommonSecrets,
} from '@kiturone/kapibala-host/internal';
import {
  type RawServerConfig,
  type ServerConfig,
  validateAndNormalizeServerConfig,
  validateServerName,
} from '@kiturone/kapibala-mcp';
import { color, sanitizeUntrustedOutput } from '../ui/events.js';
import type { CommandContext, CommandHandler } from './dispatcher.js';

/**
 * /mcp 命令处理器。
 *
 * 子命令：
 * - `/mcp`: 列出当前会话配置的全部 MCP 服务及其连接与目录状态；
 * - `/mcp tools <server>`: 查看指定服务在当前会话中成功注册并暴露的工具清单；
 * - `/mcp reconnect <server>`: 手动重连指定服务，递增代次并重新发现能力；
 * - `/mcp enable <server>`: 在当前会话内临时启用被禁用的服务（不写磁盘）；
 * - `/mcp disable <server>`: 在当前会话内临时禁用指定服务（不写磁盘）；
 * - `/mcp add|remove|edit`: 配置级增删改，走宿主 MCP 配置事务（全局默认，`--project` 需已信任项目）；
 * - `/mcp approve|revoke <server>`: 逐服务器启动批准——批准绑定当前配置摘要，
 *   任一字段变化后自动回到待批准，未批准的服务不会启动。
 */
export const mcpCommand: CommandHandler = async (args: string[], ctx: CommandContext) => {
  const subCommand = (args[0] ?? '').toLowerCase();
  // 配置级命令与运行期状态无关：即使当前没有 MCP 插件也必须可执行。
  if (subCommand === 'add' || subCommand === 'remove' || subCommand === 'edit') {
    mutateMcpConfigCommand(subCommand, args.slice(1), ctx);
    return;
  }
  if (subCommand === 'approve' || subCommand === 'revoke') {
    approvalCommand(subCommand, args.slice(1), ctx);
    return;
  }
  const plugin = getSessionMcpPlugin(ctx.session);

  // 1. 无 MCP 插件或被宿主彻底关闭的情况
  if (!plugin) {
    resolveCommandOutput(ctx).log('当前会话未启用 MCP 生态（未配置服务或已通过 --no-mcp 禁用）。');
    return;
  }

  const manager = plugin.manager;

  // 2. 裸 /mcp：列出全量服务状态
  if (args.length === 0) {
    const statuses = manager.getAllStatuses();
    if (statuses.length === 0) {
      resolveCommandOutput(ctx).log('未发现已配置的 MCP 服务。');
      return;
    }

    const isTTY = Boolean(process.stdout.isTTY);
    const approvals = readApprovalStatus(ctx);
    resolveCommandOutput(ctx).log(`\n🐾 MCP 服务状态清单（共 ${statuses.length} 个服务）：`);
    for (const s of statuses) {
      const connColorCode =
        s.connectionState === 'ready'
          ? 32
          : s.connectionState === 'connecting'
            ? 33
            : s.connectionState === 'disabled'
              ? 90
              : 31;
      const toolCount = manager.getServerTools(s.name).length;
      const promptCount = plugin.promptRegistry.getPromptsByServer(s.name).length;

      const title = color(sanitizeUntrustedOutput(s.name), 1, isTTY);
      const stateStr = color(s.connectionState, connColorCode, isTTY);
      const approvalStr =
        approvals.get(s.name) === undefined
          ? ''
          : ` | 批准: ${approvals.get(s.name) ? '已批准' : '待批准'}`;

      resolveCommandOutput(ctx).log(
        `  · ${title}: ${stateStr} | Tools: ${s.toolsState} (${toolCount} 个)` +
          ` | Prompts: ${s.promptsState} (${promptCount} 个)${approvalStr}`,
      );
      if (s.errorMessage) {
        resolveCommandOutput(ctx).log(
          `    ${color(`错误: ${sanitizeUntrustedOutput(s.errorMessage)}`, 31, isTTY)}`,
        );
      }
    }
    resolveCommandOutput(ctx).log(
      '\n提示: 使用 /mcp tools <server> 查看工具，或 /mcp reconnect|enable|disable <server> 管理服务。',
    );
    resolveCommandOutput(ctx).log(
      '逐服务器启动批准: /mcp approve <server>（配置改动后需重新批准）| /mcp revoke <server>。\n',
    );
    return;
  }

  const serverName = args[1]?.trim();

  // 3. /mcp tools <server>
  if (subCommand === 'tools') {
    if (!serverName) {
      resolveCommandOutput(ctx).log('用法: /mcp tools <server>');
      return;
    }
    const statuses = manager.getAllStatuses();
    const status = statuses.find((s) => s.name === serverName);
    if (!status) {
      resolveCommandOutput(ctx).log(`未知 MCP 服务: '${serverName}'`);
      return;
    }

    const tools = manager.getServerTools(serverName);
    if (tools.length === 0) {
      resolveCommandOutput(ctx).log(
        `服务 '${serverName}' 暂无已注册的工具（连接状态: ${status.connectionState}, 目录状态: ${status.toolsState}）。`,
      );
      return;
    }

    const isTTY = Boolean(process.stdout.isTTY);
    resolveCommandOutput(ctx).log(
      `\n🛠 服务 '${sanitizeUntrustedOutput(serverName)}' 工具清单（共 ${tools.length} 个）：`,
    );
    for (const tool of tools) {
      const readOnly = tool.metadata?.readOnlyHint ? color(' [只读]', 36, isTTY) : '';
      // 显示名与工具行同口径：`服务 · 工具` 归一格式（resolveToolDisplay 的 MCP 分支共用本函数）。
      // 工具名自身可能含 `__`，必须保留第 3 段之后的全部片段，不能只取 split 的第三个元素。
      const parts = tool.name.split('__');
      const toolPart = parts.length >= 3 ? parts.slice(2).join('__') : tool.name;
      resolveCommandOutput(ctx).log(
        `  · ${color(sanitizeUntrustedOutput(formatMcpToolLabel(serverName, toolPart)), 1, isTTY)}${readOnly}`,
      );
      if (tool.description) {
        resolveCommandOutput(ctx).log(`    ${sanitizeUntrustedOutput(tool.description)}`);
      }
    }
    resolveCommandOutput(ctx).log('');
    return;
  }

  // 4. 变更类子命令（reconnect / enable / disable）
  if (ctx.controller?.isBusy() || ctx.session.isBusy()) {
    throw new Error('会话正忙，无法执行 MCP 服务变更操作。');
  }

  if (subCommand === 'reconnect') {
    if (!serverName) {
      resolveCommandOutput(ctx).log('用法: /mcp reconnect <server>');
      return;
    }
    const statuses = manager.getAllStatuses();
    const status = statuses.find((s) => s.name === serverName);
    if (!status) {
      resolveCommandOutput(ctx).log(`未知 MCP 服务: '${serverName}'`);
      return;
    }

    resolveCommandOutput(ctx).log(`正在重连 MCP 服务 '${serverName}'...`);
    try {
      await manager.reconnectServer(serverName);
      const updated = manager.getAllStatuses().find((s) => s.name === serverName);
      if (updated?.connectionState === 'ready') {
        resolveCommandOutput(ctx).log(
          `✔ 服务 '${serverName}' 重连成功（Tools: ${updated.toolsState}, Prompts: ${updated.promptsState}）。`,
        );
      } else {
        resolveCommandOutput(ctx).log(
          `⚠ 服务 '${serverName}' 重连后状态为: ${updated?.connectionState}（原因: ${updated?.errorMessage ?? '未知'}）。`,
        );
      }
    } catch (err: unknown) {
      resolveCommandOutput(ctx).error(
        `重连服务 '${serverName}' 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  if (subCommand === 'enable') {
    if (!serverName) {
      resolveCommandOutput(ctx).log('用法: /mcp enable <server>');
      return;
    }
    const statuses = manager.getAllStatuses();
    const status = statuses.find((s) => s.name === serverName);
    if (!status) {
      resolveCommandOutput(ctx).log(`未知 MCP 服务: '${serverName}'`);
      return;
    }

    resolveCommandOutput(ctx).log(`正在当前会话中启用服务 '${serverName}'...`);
    try {
      await manager.enableServer(serverName);
      resolveCommandOutput(ctx).log(
        `✔ 已在当前会话启用服务 '${serverName}'（会话临时生效，不写回配置文件）。`,
      );
    } catch (err: unknown) {
      resolveCommandOutput(ctx).error(
        `启用服务 '${serverName}' 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  if (subCommand === 'disable') {
    if (!serverName) {
      resolveCommandOutput(ctx).log('用法: /mcp disable <server>');
      return;
    }
    const statuses = manager.getAllStatuses();
    const status = statuses.find((s) => s.name === serverName);
    if (!status) {
      resolveCommandOutput(ctx).log(`未知 MCP 服务: '${serverName}'`);
      return;
    }

    resolveCommandOutput(ctx).log(`正在当前会话中禁用服务 '${serverName}'...`);
    try {
      await manager.disableServer(serverName);
      resolveCommandOutput(ctx).log(
        `✔ 已在当前会话禁用服务 '${serverName}'（会话临时生效，不写回配置文件）。`,
      );
    } catch (err: unknown) {
      resolveCommandOutput(ctx).error(
        `禁用服务 '${serverName}' 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  resolveCommandOutput(ctx).log(
    '用法: /mcp [tools <server> | reconnect <server> | enable <server> | disable <server> | add|remove|edit ...]',
  );
};

/** `/mcp add|remove|edit` 的解析结果；值缺省时由调用方按 add/edit 语义判定。 */
export interface McpConfigCliOptions {
  scope: 'global' | 'project';
  transport?: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
  disabled: boolean;
  enabled: boolean;
}

/**
 * 解析配置级子命令参数：第一个位置参数是服务器名，其余是 `--flag value` 选项。
 *
 * 边界：只接受下方列出的选项；`--arg` / `--env` / `--header` 可重复；
 * 缺失值、未知选项、非法 KEY=VALUE 一律报错，不做猜测。
 */
export function parseMcpConfigArgs(args: string[]): {
  name?: string;
  options?: McpConfigCliOptions;
  error?: string;
} {
  const name = args[0]?.trim();
  if (!name) return { error: '缺少 MCP 服务器名' };
  const options: McpConfigCliOptions = {
    scope: 'global',
    env: {},
    headers: {},
    disabled: false,
    enabled: false,
  };
  for (let index = 1; index < args.length; index++) {
    const token = args[index]!;
    const read = (): string | undefined => args[++index];
    if (token === '--project') options.scope = 'project';
    else if (token === '--disabled') options.disabled = true;
    else if (token === '--enabled') options.enabled = true;
    else if (token === '--transport') {
      const value = read();
      if (value !== 'stdio' && value !== 'http')
        return { error: '--transport 只能是 stdio 或 http' };
      options.transport = value;
    } else if (token === '--command') {
      options.command = read();
      if (!options.command) return { error: '--command 需要一个值' };
    } else if (token === '--arg') {
      const value = read();
      if (value === undefined) return { error: '--arg 需要一个值' };
      options.args = [...(options.args ?? []), value];
    } else if (token === '--url') {
      options.url = read();
      if (!options.url) return { error: '--url 需要一个值' };
    } else if (token === '--env' || token === '--header') {
      const value = read();
      const separator = value?.indexOf('=') ?? -1;
      if (!value || separator <= 0)
        return { error: `${token} 需要 KEY=VALUE 形式，且 KEY 不能为空` };
      const key = value.slice(0, separator);
      const item = value.slice(separator + 1);
      if (token === '--env' && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        return { error: `非法环境变量名: ${key}` };
      if (token === '--header' && !/^[A-Za-z0-9-]+$/.test(key))
        return { error: `非法请求头名: ${key}` };
      if (token === '--env') options.env[key] = item;
      else options.headers[key] = item;
    } else return { error: `未知选项: ${token}` };
  }
  return { name, options };
}

/**
 * 配置级增删改命令；写入统一走 `mutateMcpConfig` 事务（锁、校验、原子替换、信任门）。
 *
 * `--project` 在未信任项目上由事务层直接拒绝；本函数不做第二套判定。
 */
function mutateMcpConfigCommand(
  kind: 'add' | 'remove' | 'edit',
  args: string[],
  ctx: CommandContext,
): void {
  const output = resolveCommandOutput(ctx);
  const parsed = parseMcpConfigArgs(args);
  if (!parsed.name || !parsed.options) {
    output.log(parsed.error ?? '缺少参数');
    return;
  }
  const { name, options } = parsed;
  const projectRoot = ctx.projectRoot;
  const target = {
    scope: options.scope,
    homeDir: ctx.homeDir ?? os.homedir(),
    projectRoot,
    projectTrusted: Boolean(projectRoot && isProjectTrusted(ctx.settings, projectRoot)),
  };
  let file: string;
  try {
    file = mutateMcpConfig((draft) => {
      if (!draft.mcpServers) draft.mcpServers = {};
      const servers = draft.mcpServers;
      if (kind === 'remove') {
        if (!servers[name]) throw new Error(`MCP 服务 '${name}' 不存在，无法移除`);
        delete servers[name];
        return;
      }
      if (kind === 'add' && servers[name])
        throw new Error(`MCP 服务 '${name}' 已存在；如需修改请用 /mcp edit`);
      if (kind === 'edit' && !servers[name])
        throw new Error(`MCP 服务 '${name}' 不存在；如需新增请用 /mcp add`);
      const next = buildServerConfig(name, options, servers[name]);
      servers[name] = next;
    }, target);
  } catch (error) {
    output.error(
      `${kind === 'add' ? '新增' : kind === 'edit' ? '编辑' : '移除'}失败: ${error instanceof Error ? error.message : String(error)}`,
    );
    return;
  }
  output.log(`✔ 已写入${options.scope === 'project' ? '项目' : '全局'} MCP 配置: ${file}`);
  output.log('新配置在新建会话后生效；当前会话可用 /mcp reconnect <server> 重连已存在的服务。');
}

/** 从磁盘重读配置构造批准条目表；共用宿主实现，避免桌面与 CLI 各写一套条目推导。 */
function readApprovalEntries(ctx: CommandContext): ReturnType<typeof readMcpApprovalEntries> {
  return readMcpApprovalEntries({
    homeDir: ctx.homeDir ?? os.homedir(),
    projectRoot: ctx.projectRoot,
    projectTrusted: Boolean(ctx.projectRoot && isProjectTrusted(ctx.settings, ctx.projectRoot)),
  });
}

/** 当前各服务的批准状态；读取或项目根缺失都不影响主列表展示。 */
function readApprovalStatus(ctx: CommandContext): Map<string, boolean> {
  const result = new Map<string, boolean>();
  const store = new McpServerApprovalStore({
    homeDir: ctx.homeDir ?? os.homedir(),
    projectRoot: ctx.projectRoot,
  });
  for (const [name, entry] of readApprovalEntries(ctx)) {
    try {
      result.set(name, store.status({ name, ...entry }).approved);
    } catch {
      /* 项目根缺失时跳过该项目服务的批准展示。 */
    }
  }
  return result;
}

/** `/mcp approve|revoke`：批准绑定当前配置摘要；输出只给摘要前缀，不打印任何密钥值。 */
function approvalCommand(kind: 'approve' | 'revoke', args: string[], ctx: CommandContext): void {
  const output = resolveCommandOutput(ctx);
  const name = args[0]?.trim();
  if (!name) {
    output.log(`用法: /mcp ${kind} <server>`);
    return;
  }
  const store = new McpServerApprovalStore({
    homeDir: ctx.homeDir ?? os.homedir(),
    projectRoot: ctx.projectRoot,
  });
  const entry = readApprovalEntries(ctx).get(name);
  if (kind === 'approve') {
    if (!entry) {
      output.log(`未知 MCP 服务: '${name}'（先用 /mcp add 添加或检查 mcp.json）`);
      return;
    }
    try {
      const record = store.approve({ name, ...entry });
      const prefix = record.digest.replace('sha256:', '').slice(0, 12);
      output.log(`批准目标: ${redactCommonSecrets(describeApprovalTarget(entry.config))}`);
      const secretKeys = Object.keys(describeApprovalSecretKeys(entry.config));
      if (secretKeys.length) output.log(`配置键（值不回显）: ${secretKeys.join(', ')}`);
      output.log(
        `✔ 已批准 MCP 服务 '${name}'（${entry.source}，配置摘要 ${prefix}…）；配置任一字段变化后需重新批准。`,
      );
    } catch (error) {
      output.error(`批准失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    return;
  }
  let removed = false;
  try {
    removed = entry
      ? store.revoke(name, entry.source)
      : store.revoke(name, 'global') || (ctx.projectRoot ? store.revoke(name, 'project') : false);
  } catch (error) {
    output.error(`撤销失败: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  output.log(removed ? `✔ 已撤销 MCP 服务 '${name}' 的批准。` : `未找到 '${name}' 的批准记录。`);
}

/** 批准目标摘要：stdio 拼命令行，http 取端点；展示前仍需脱敏。 */
function describeApprovalTarget(config: ServerConfig): string {
  if (config.type === 'http') return config.url ?? '';
  return [config.command, ...(config.args ?? [])].filter(Boolean).join(' ');
}

/** 需要提示「存在但值不回显」的配置键名（env / headers），仅返回键。 */
function describeApprovalSecretKeys(config: ServerConfig): Record<string, true> {
  const record = config as {
    env?: Record<string, string>;
    headers?: Record<string, string>;
  };
  const keys: Record<string, true> = {};
  for (const key of Object.keys(record.env ?? {})) keys[`env:${key}`] = true;
  for (const key of Object.keys(record.headers ?? {})) keys[`header:${key}`] = true;
  return keys;
}

/** 与传输无关的基础字段；编辑时原样保留，传输字段按目标 transport 重建。 */
const BASE_SERVER_FIELDS = [
  'enabled',
  'required',
  'protocol',
  'includeTools',
  'excludeTools',
  'startupTimeoutMs',
  'catalogTimeoutMs',
  'requestTimeoutMs',
] as const;

/** 按 transport 组装/更新单条声明；保留既有基础字段，只替换传输相关字段。 */
function buildServerConfig(
  name: string,
  options: McpConfigCliOptions,
  existing: RawServerConfig | undefined,
): RawServerConfig {
  const nameCheck = validateServerName(name);
  if (!nameCheck.valid) throw new Error(`服务器名非法: ${nameCheck.reason}`);
  const current = (existing ?? {}) as Record<string, unknown>;
  const transport =
    options.transport ?? (current.type === 'http' ? 'http' : options.url ? 'http' : 'stdio');
  const next: Record<string, unknown> = {};
  for (const key of BASE_SERVER_FIELDS) {
    if (current[key] !== undefined) next[key] = current[key];
  }
  if (options.disabled) next.enabled = false;
  else if (options.enabled) next.enabled = true;
  if (transport === 'http') {
    const headers = {
      ...((current.headers as Record<string, string> | undefined) ?? {}),
      ...options.headers,
    };
    const url = options.url ?? (current.url as string | undefined);
    if (!url) throw new Error('HTTP 传输需要 --url <url>');
    next.type = 'http';
    next.url = url;
    if (Object.keys(headers).length) next.headers = headers;
  } else {
    const env = {
      ...((current.env as Record<string, string> | undefined) ?? {}),
      ...options.env,
    };
    const command = options.command ?? (current.command as string | undefined);
    if (!command) throw new Error('stdio 传输需要 --command <命令>');
    next.type = 'stdio';
    next.command = command;
    const args = options.args ?? (current.args as string[] | undefined);
    if (args) next.args = args;
    if (typeof current.cwd === 'string') next.cwd = current.cwd;
    if (Object.keys(env).length) next.env = env;
  }
  const { config, diagnostics } = validateAndNormalizeServerConfig(name, next as RawServerConfig);
  const errors = diagnostics.filter((item) => item.severity === 'error');
  if (errors.length) throw new Error(errors.map((item) => item.message).join('; '));
  if (!config) throw new Error('配置校验未产出可用声明');
  return config;
}
