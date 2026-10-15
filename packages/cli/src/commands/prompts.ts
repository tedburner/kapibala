/**
 * @fileoverview /prompts 与 /prompt 命令：MCP 提示词模板检索与受控任务执行
 *
 * 约束、边界与为什么：
 * 1. 纯元数据快速检索：`/prompts [query]` 仅检索已发布的 Prompt 注册表元数据，
 *    绝不预取模板正文，不产生外部网络握手，在会话忙碌期安全放行；
 * 2. 严格参数与格式校验：`/prompt` 的参数部分（rawTail）必须为合法的单层 JSON 对象，
 *    缺少必填参数或包含未知参数时立即拦截，零网络零模型调用，防止隐式字段丢弃；
 * 3. 统一任务准备执行：`/prompt` 通过 Core 的 `runPreparedTask` 受控接入，
 *    在执行准备期受执行门保护，支持 Ctrl+C 统一取消与退出清理；
 * 4. 角色降级与上下文防线：远端服务端返回的 messages 转换为标准标签降级文本，
 *    绝不向模型伪造真实的 assistant 消息，不破坏模型合法续答前缀。
 */

import { prepareMcpPromptTask, validatePromptArguments } from '@kiturone/kapibala-mcp';
import { getSessionMcpPlugin } from '../mcp.js';
import { color, sanitizeUntrustedOutput } from '../ui/events.js';
import { parsePromptInvocation } from './catalog.js';
import type { CommandContext, CommandHandler } from './dispatcher.js';

/**
 * /prompts [query] 命令：检索 MCP 提示词模板元数据。
 */
export const promptsCommand: CommandHandler = async (args: string[], ctx: CommandContext) => {
  const plugin = getSessionMcpPlugin(ctx.session);
  if (!plugin) {
    console.log('当前会话未启用 MCP 生态（未配置服务或已通过 --no-mcp 禁用）。');
    return;
  }

  const query = args.length > 0 ? args[0].trim() : undefined;
  const results = plugin.promptRegistry.search(query);

  if (results.length === 0) {
    console.log(query ? `未找到与 '${query}' 匹配的提示词模板。` : '当前暂无已发现的提示词模板。');
    return;
  }

  const isTTY = Boolean(process.stdout.isTTY);
  console.log(`\n📝 MCP 提示词模板列表（共 ${results.length} 项）：`);
  for (const item of results) {
    console.log(`  · ${color(sanitizeUntrustedOutput(item.stableId), 1, isTTY)}`);
    if (item.description) {
      console.log(`    ${sanitizeUntrustedOutput(item.description)}`);
    }
    if (item.arguments && item.arguments.length > 0) {
      const argsDesc = item.arguments
        .map((a) => `${a.name}${a.required ? ' [必填]' : ''}`)
        .join(', ');
      console.log(`    ${color(`参数: ${argsDesc}`, 90, isTTY)}`);
    }
  }
  console.log('\n用法示例: /prompt <server/name> {"param": "value"}\n');
};

/**
 * /prompt <server/name> [arguments-json] 命令：执行受控 MCP 提示词模板任务。
 */
export const promptCommand: CommandHandler = async (args: string[], ctx: CommandContext) => {
  if (ctx.controller?.isBusy() || ctx.session.isBusy()) {
    throw new Error('会话正忙，无法执行提示词模板任务。');
  }

  const plugin = getSessionMcpPlugin(ctx.session);
  if (!plugin) {
    throw new Error('当前会话未启用 MCP 生态（未配置服务或已通过 --no-mcp 禁用）。');
  }

  // 1. rawTail 参数解析
  const rawInput = args[0] ?? '';
  const parsed = parsePromptInvocation(rawInput);
  if (!parsed) {
    throw new Error('用法: /prompt <server>/<name> [arguments-json]');
  }

  const { promptId, rawArgs } = parsed;
  const slashIdx = promptId.indexOf('/');
  const serverName = promptId.slice(0, slashIdx);

  // 2. 检查模板与服务连接是否存在
  const definition = plugin.promptRegistry.get(promptId);
  if (!definition) {
    throw new Error(`未找到提示词模板: '${promptId}'`);
  }

  const clientSession = plugin.manager.getServerSession(serverName);
  if (!clientSession) {
    throw new Error(`MCP 服务 '${serverName}' 尚未建立活动连接。`);
  }

  // 3. 严格校验必填参数与未知参数
  const validation = validatePromptArguments(definition, rawArgs);
  if (!validation.valid) {
    throw new Error(`提示词参数校验失败: ${validation.error}`);
  }

  // 检查模式硬限制：Plan 模式禁止发起外部模板获取
  const currentMode = ctx.session.getMode();
  if (currentMode === 'Plan') {
    throw new Error('Plan 模式下禁止执行远端提示词模板获取，必须在交互或执行模式下运行。');
  }

  // 检查权限策略硬拒绝
  const rules = ctx.session.getPermissionRules();
  if (rules && rules.length > 0) {
    const isDenied = rules.some((r) => {
      if (r.action !== 'deny') return false;
      if (r.tool && (r.tool === promptId || r.tool === `mcp__${serverName}__*`)) return true;
      if (r.capability === 'external:call') return true;
      return false;
    });
    if (isDenied) {
      throw new Error(`提示词模板 '${promptId}' 被当前会话安全策略显式拒绝。`);
    }
  }

  // 4. 包装准备函数
  const taskText = `/prompt ${promptId}`;
  const prepare = async (prepareCtx: import('@kiturone/kapibala').PreparedTaskContext) => {
    const prep = await prepareMcpPromptTask({
      prompt: definition,
      rawArguments: rawArgs,
      session: clientSession,
      signal: prepareCtx.signal,
      getCurrentPrompt: () => plugin.promptRegistry.get(promptId),
    });
    return prep.result;
  };

  // 5. 执行受控任务准备
  if (ctx.runPreparedTask) {
    await ctx.runPreparedTask(taskText, prepare);
  } else if (ctx.controller) {
    for await (const event of ctx.controller.runPreparedTask(taskText, prepare)) {
      ctx.renderEvent?.(event);
    }
  } else {
    for await (const event of ctx.session.runPreparedTask(taskText, prepare)) {
      ctx.renderEvent?.(event);
    }
  }
};
