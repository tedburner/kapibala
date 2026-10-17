import { resolveCommandOutput } from '../host/command-output.js';
/**
 * @fileoverview /plugins 与 /plugin 命令：查看当前会话已挂载的扩展插件与能力贡献清单
 *
 * 约束、边界与为什么：
 * 1. 纯只读诊断命令：仅读取当前活动会话已生效的插件列表与声明元数据，
 *    不产生外部网络握手或进程启停，在会话忙碌期间允许安全执行；
 * 2. 统一展示贡献面：清晰呈现各插件贡献的交互命令、技能目录与运行概况，
 *    实现外部生态（如 MCP、未来 Browser 扩展）在终端统一纳管与可观测；
 * 3. 宿主隔离防线：仅展示当前活动会话内实例，跨会话隔离。
 */

import { getSessionMcpPlugin } from '../mcp.js';
import { color } from '../ui/events.js';
import type { CommandContext, CommandHandler } from './dispatcher.js';

/**
 * /plugins [name] 命令处理器。
 *
 * 用法：
 * - `/plugins`: 列出当前会话已挂载的全部扩展插件及其版本、贡献命令和运行状态；
 * - `/plugins <name>`: 查看指定插件的详细扩展贡献元数据（如命令规范、技能根目录、服务概况）。
 */
export const pluginsCommand: CommandHandler = async (args: string[], ctx: CommandContext) => {
  const plugins = ctx.session.getPlugins();

  if (plugins.length === 0) {
    resolveCommandOutput(ctx).log(
      '当前会话未挂载任何扩展插件（可通过配置文件或启动参数启用扩展生态）。',
    );
    return;
  }

  const queryName = args[0]?.trim().toLowerCase();

  // 1. 指定插件详情模式
  if (queryName) {
    const matched = plugins.find((p) => p.name.toLowerCase() === queryName);
    if (!matched) {
      resolveCommandOutput(ctx).log(
        `未找到扩展插件: '${queryName}'。输入 /plugins 查看已挂载插件列表。`,
      );
      return;
    }

    const isTTY = Boolean(process.stdout.isTTY);
    resolveCommandOutput(ctx).log(
      `\n🧩 扩展插件详情: ${color(matched.name, 1, isTTY)} (v${matched.version ?? 'unknown'})`,
    );
    if (matched.description) {
      resolveCommandOutput(ctx).log(`  描述: ${matched.description}`);
    }

    const contrib = matched.contributes;
    if (contrib?.commands && contrib.commands.length > 0) {
      resolveCommandOutput(ctx).log(`\n  🛠 贡献命令（共 ${contrib.commands.length} 个）：`);
      for (const cmd of contrib.commands) {
        resolveCommandOutput(ctx).log(
          `    · ${color(`/${cmd.name}`, 1, isTTY)}: ${cmd.description}`,
        );
        if (cmd.usage) {
          resolveCommandOutput(ctx).log(`      用法: ${cmd.usage}`);
        }
      }
    }

    if (contrib?.skillsRoots && contrib.skillsRoots.length > 0) {
      resolveCommandOutput(ctx).log(
        `\n  📚 附加技能根目录（共 ${contrib.skillsRoots.length} 个）：`,
      );
      for (const root of contrib.skillsRoots) {
        resolveCommandOutput(ctx).log(`    · ${root}`);
      }
    }

    // 若关联受管 MCP 插件，打印实时服务概况
    const mcpPlugin = getSessionMcpPlugin(ctx.session);
    if (mcpPlugin && mcpPlugin.name === matched.name) {
      const statuses = mcpPlugin.manager.getAllStatuses();
      resolveCommandOutput(ctx).log(
        `\n  🐾 MCP 运行状态概况（共 ${statuses.length} 个配置服务）：`,
      );
      for (const s of statuses) {
        const toolCount = mcpPlugin.manager.getServerTools(s.name).length;
        const promptCount = mcpPlugin.promptRegistry.getPromptsByServer(s.name).length;
        resolveCommandOutput(ctx).log(
          `    · ${s.name}: ${s.connectionState} (Tools: ${toolCount}, Prompts: ${promptCount})`,
        );
      }
    }
    resolveCommandOutput(ctx).log('');
    return;
  }

  // 2. 全量插件列表模式
  const isTTY = Boolean(process.stdout.isTTY);
  resolveCommandOutput(ctx).log(`\n🧩 当前会话已挂载扩展插件清单（共 ${plugins.length} 个）：`);
  for (const p of plugins) {
    const ver = p.version ? `(v${p.version})` : '';
    resolveCommandOutput(ctx).log(`  · ${color(p.name, 1, isTTY)} ${ver}`);
    if (p.description) {
      resolveCommandOutput(ctx).log(`    描述: ${p.description}`);
    }

    const cmds = p.contributes?.commands;
    if (cmds && cmds.length > 0) {
      const cmdNames = cmds.map((c) => `/${c.name}`).join(', ');
      resolveCommandOutput(ctx).log(`    贡献命令: ${color(cmdNames, 36, isTTY)}`);
    }

    const mcpPlugin = getSessionMcpPlugin(ctx.session);
    if (mcpPlugin && mcpPlugin.name === p.name) {
      const statuses = mcpPlugin.manager.getAllStatuses();
      const readyCount = statuses.filter((s) => s.connectionState === 'ready').length;
      resolveCommandOutput(ctx).log(
        `    生态概况: ${statuses.length} 个 MCP 服务 (已就绪 ${readyCount} 个)`,
      );
    }
  }
  resolveCommandOutput(ctx).log(
    '\n提示: 使用 /plugins <name> 查看特定插件的详细贡献清单与运行状态。\n',
  );
};
