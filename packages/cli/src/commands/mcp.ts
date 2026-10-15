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

import { getSessionMcpPlugin } from '../mcp.js';
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
 * - `/mcp disable <server>`: 在当前会话内临时禁用指定服务（不写磁盘）。
 */
export const mcpCommand: CommandHandler = async (args: string[], ctx: CommandContext) => {
  const plugin = getSessionMcpPlugin(ctx.session);

  // 1. 无 MCP 插件或被宿主彻底关闭的情况
  if (!plugin) {
    console.log('当前会话未启用 MCP 生态（未配置服务或已通过 --no-mcp 禁用）。');
    return;
  }

  const manager = plugin.manager;

  // 2. 裸 /mcp：列出全量服务状态
  if (args.length === 0) {
    const statuses = manager.getAllStatuses();
    if (statuses.length === 0) {
      console.log('未发现已配置的 MCP 服务。');
      return;
    }

    const isTTY = Boolean(process.stdout.isTTY);
    console.log(`\n🐾 MCP 服务状态清单（共 ${statuses.length} 个服务）：`);
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

      console.log(
        `  · ${title}: ${stateStr}` +
          ` | Tools: ${s.toolsState} (${toolCount} 个)` +
          ` | Prompts: ${s.promptsState} (${promptCount} 个)`,
      );
      if (s.errorMessage) {
        console.log(`    ${color(`错误: ${sanitizeUntrustedOutput(s.errorMessage)}`, 31, isTTY)}`);
      }
    }
    console.log(
      '\n提示: 使用 /mcp tools <server> 查看工具，或 /mcp reconnect|enable|disable <server> 管理服务。\n',
    );
    return;
  }

  const subCommand = args[0].toLowerCase();
  const serverName = args[1]?.trim();

  // 3. /mcp tools <server>
  if (subCommand === 'tools') {
    if (!serverName) {
      console.log('用法: /mcp tools <server>');
      return;
    }
    const statuses = manager.getAllStatuses();
    const status = statuses.find((s) => s.name === serverName);
    if (!status) {
      console.log(`未知 MCP 服务: '${serverName}'`);
      return;
    }

    const tools = manager.getServerTools(serverName);
    if (tools.length === 0) {
      console.log(
        `服务 '${serverName}' 暂无已注册的工具（连接状态: ${status.connectionState}, 目录状态: ${status.toolsState}）。`,
      );
      return;
    }

    const isTTY = Boolean(process.stdout.isTTY);
    console.log(
      `\n🛠 服务 '${sanitizeUntrustedOutput(serverName)}' 工具清单（共 ${tools.length} 个）：`,
    );
    for (const tool of tools) {
      const readOnly = tool.metadata?.readOnlyHint ? color(' [只读]', 36, isTTY) : '';
      console.log(`  · ${color(sanitizeUntrustedOutput(tool.name), 1, isTTY)}${readOnly}`);
      if (tool.description) {
        console.log(`    ${sanitizeUntrustedOutput(tool.description)}`);
      }
    }
    console.log('');
    return;
  }

  // 4. 变更类子命令（reconnect / enable / disable）
  if (ctx.controller?.isBusy() || ctx.session.isBusy()) {
    throw new Error('会话正忙，无法执行 MCP 服务变更操作。');
  }

  if (subCommand === 'reconnect') {
    if (!serverName) {
      console.log('用法: /mcp reconnect <server>');
      return;
    }
    const statuses = manager.getAllStatuses();
    const status = statuses.find((s) => s.name === serverName);
    if (!status) {
      console.log(`未知 MCP 服务: '${serverName}'`);
      return;
    }

    console.log(`正在重连 MCP 服务 '${serverName}'...`);
    try {
      await manager.reconnectServer(serverName);
      const updated = manager.getAllStatuses().find((s) => s.name === serverName);
      if (updated?.connectionState === 'ready') {
        console.log(
          `✔ 服务 '${serverName}' 重连成功（Tools: ${updated.toolsState}, Prompts: ${updated.promptsState}）。`,
        );
      } else {
        console.log(
          `⚠ 服务 '${serverName}' 重连后状态为: ${updated?.connectionState}（原因: ${updated?.errorMessage ?? '未知'}）。`,
        );
      }
    } catch (err: unknown) {
      console.error(
        `重连服务 '${serverName}' 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  if (subCommand === 'enable') {
    if (!serverName) {
      console.log('用法: /mcp enable <server>');
      return;
    }
    const statuses = manager.getAllStatuses();
    const status = statuses.find((s) => s.name === serverName);
    if (!status) {
      console.log(`未知 MCP 服务: '${serverName}'`);
      return;
    }

    console.log(`正在当前会话中启用服务 '${serverName}'...`);
    try {
      await manager.enableServer(serverName);
      console.log(`✔ 已在当前会话启用服务 '${serverName}'（会话临时生效，不写回配置文件）。`);
    } catch (err: unknown) {
      console.error(
        `启用服务 '${serverName}' 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  if (subCommand === 'disable') {
    if (!serverName) {
      console.log('用法: /mcp disable <server>');
      return;
    }
    const statuses = manager.getAllStatuses();
    const status = statuses.find((s) => s.name === serverName);
    if (!status) {
      console.log(`未知 MCP 服务: '${serverName}'`);
      return;
    }

    console.log(`正在当前会话中禁用服务 '${serverName}'...`);
    try {
      await manager.disableServer(serverName);
      console.log(`✔ 已在当前会话禁用服务 '${serverName}'（会话临时生效，不写回配置文件）。`);
    } catch (err: unknown) {
      console.error(
        `禁用服务 '${serverName}' 失败: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return;
  }

  console.log(
    '用法: /mcp [tools <server> | reconnect <server> | enable <server> | disable <server>]',
  );
};
