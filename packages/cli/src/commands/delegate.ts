/**
 * @fileoverview `/delegate`：用户级直接派发保留型委派会话。
 *
 * 约束、边界与为什么：
 * 1. 只经既有 AgentRuntime 受理面派发：不绕过容量、深度、角色预设与权限策略；
 * 2. 强制 detached：用户级入口的目的就是留下可续聊的会话，ephemeral 不满足；
 * 3. 复用当前会话的写租约协调器：与父会话共享工作区写互斥，绝不另建隐式单例；
 * 4. 受理即可见：打印 agentId 与查看方式，真正结果经 outbox 通知回传父会话。
 */

import type { SubagentRole } from '@kiturone/kapibala';
import {
  MAX_RETAINED_DELEGATIONS,
  countRetainedDelegations,
} from '@kiturone/kapibala-host/internal';
import { resolveCommandOutput } from '../command-output.js';
import type { CommandHandler } from './dispatcher.js';

/** 可用角色白名单；custom 需要显式工具白名单，命令行入口不提供。 */
const ROLE_WHITELIST: readonly SubagentRole[] = ['explore', 'planner', 'implement', 'advisor'];

/**
 * 命令行词法分词：按空白切分，保留单双引号包裹的多词文本并剥离引号。
 *
 * 保证：
 * - 支持独立引号词（`--name "hello world"`）与内嵌引号词（`--model="gpt-4o"`）；
 * - 未闭合引号按剩余字符串整体保留，不抛错、不丢弃用户输入；
 * - 空输入返回空数组。
 */
function tokenizeCommandLine(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let inQuotes: '"' | "'" | null = null;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (inQuotes) {
      if (char === inQuotes) {
        inQuotes = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      inQuotes = char;
    } else if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += char;
    }
  }
  if (current.length > 0) tokens.push(current);
  return tokens;
}

/**
 * 解析 `/delegate` 的原始输入。
 *
 * 支持 `--role <角色>`、`--model <模型 id>`、`--name <展示名>`，标志可出现在任意位置；
 * 支持单双引号包裹带空格的参数值（如 `--name "复杂 任务"`）以及 `--key=value` 形式；
 * 其余词按顺序拼回任务描述。未知标志按任务正文处理，不静默吞掉用户输入。
 *
 * @param raw 原始命令行文本
 * @returns 结构化参数对象（task / role / model / name）
 */
export function parseDelegateInput(raw: string): {
  task: string;
  role?: SubagentRole;
  model?: string;
  name?: string;
} {
  const tokens = tokenizeCommandLine(raw.trim());
  const words: string[] = [];
  let role: string | undefined;
  let model: string | undefined;
  let name: string | undefined;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token === '--role' && tokens[index + 1]) {
      role = tokens[++index];
      continue;
    }
    if (token.startsWith('--role=')) {
      role = token.slice('--role='.length);
      continue;
    }
    if (token === '--model' && tokens[index + 1]) {
      model = tokens[++index];
      continue;
    }
    if (token.startsWith('--model=')) {
      model = token.slice('--model='.length);
      continue;
    }
    if (token === '--name' && tokens[index + 1]) {
      name = tokens[++index];
      continue;
    }
    if (token.startsWith('--name=')) {
      name = token.slice('--name='.length);
      continue;
    }
    words.push(token);
  }
  return {
    task: words.join(' '),
    ...(role ? { role: role as SubagentRole } : {}),
    ...(model ? { model } : {}),
    ...(name ? { name } : {}),
  };
}

/**
 * `/delegate`：以当前会话策略快照派发一个 detached 委派会话。
 *
 * 前置：宿主必须注入 AgentRuntime；角色缺省 implement，custom 被拒绝；
 * 保留上限先在命令层预检（可即时反馈），runner 内仍再裁决一次兜底并发与竞态。
 */
export const delegateCommand: CommandHandler = async (args, ctx) => {
  const out = resolveCommandOutput(ctx);
  const runtime = ctx.runtime;
  if (!runtime) {
    out.log('当前运行时未启用子代理后台调度器。');
    return;
  }

  const parsed = parseDelegateInput(args[0] ?? '');
  if (!parsed.task) {
    out.log('用法: /delegate <任务描述> [--role <角色>] [--model <模型 id>] [--name <名称>]');
    return;
  }
  if (parsed.role && !ROLE_WHITELIST.includes(parsed.role)) {
    out.log(
      parsed.role === 'custom'
        ? 'custom 角色需要显式 allowedTools 白名单，请改用 spawn_agent 工具派发。'
        : `未知角色: ${parsed.role}；可用: ${ROLE_WHITELIST.join(' / ')}。`,
    );
    return;
  }

  // 保留上限预检：runner 在创建会话前才判定，命令层先查一次，避免先回报「已派发」再异步失败。
  const manager = ctx.controller?.manager;
  if (manager && (await countRetainedDelegations(manager)) >= MAX_RETAINED_DELEGATIONS) {
    out.log(
      `已达保留上限（${MAX_RETAINED_DELEGATIONS} 个委派会话），请先 /delegations delete <id> 清理后再派发。`,
    );
    return;
  }

  const branchId = ctx.controller?.handle.store.getActiveBranchId?.() ?? 'main';
  const requestStamp = Date.now();
  const receipt = await runtime.prepareSpawn(
    {
      leaseCoordinator: ctx.session.getLeaseCoordinator(),
      sessionId: ctx.session.conversationId,
      branchId,
      runId: `cli-delegate-${requestStamp}`,
      toolCallId: `cli-delegate-${requestStamp}`,
      depth: 0,
      workspaceRoot: ctx.session.workspaceRoot,
      executionCwd: ctx.session.executionCwd,
      ...(ctx.controller?.handle.metadata?.title
        ? { parentTitle: ctx.controller.handle.metadata.title }
        : {}),
    },
    {
      description: parsed.name ?? parsed.task,
      prompt: parsed.task,
      role: parsed.role ?? 'implement',
      mode: 'detached',
      ...(parsed.model ? { modelOverride: parsed.model } : {}),
    },
  );
  await runtime.activateSpawn(receipt.agentId);

  out.log(
    `已派发委派任务 ${receipt.agentId}（角色 ${receipt.role}，模型场景 ${receipt.modelRole}）。`,
  );
  out.log(`任务: ${receipt.description}`);
  out.log('使用 /delegations 查看委派会话；子会话建立后可用 /delegations open <id> 接续。');
  out.log('结果会以子代理通知回传当前会话，无需等待。');
};
