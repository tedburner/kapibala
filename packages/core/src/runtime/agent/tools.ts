/**
 * @fileoverview 子代理四大调度与管理工具实现（spawn_agent、list_agents、wait_agent、cancel_agent）。
 *
 * 约束、边界与为什么：
 * 1. 启动事务闭合不变量（Launch Transaction Closure）：
 *    spawn_agent 在准备阶段完成校验并预留容量后，立即返回 accepted 回执，
 *    父工具事务即刻闭合，父代理继续推进后续步骤；父事务确认后异步激活启动子代理，
 *    严禁在 spawn_agent 的 execute 中 await 子任务完成。
 * 2. 权限与能力声明：
 *    四大管理工具均显式声明 agent:spawn capability，经正常 PermissionPolicy 策略检查，
 *    Plan 模式自动隐藏与拦截。
 * 3. 超时自管理（managesTimeout: true）：
 *    spawn_agent、wait_agent、cancel_agent 自行管理超时与资源清理，不受通用工具超时误杀。
 */

import type { SubagentRole } from '../../capabilities/security/subagent-policy.js';
import { type Tool, defineTool } from '../../capabilities/tools/index.js';
import { KapibalaError } from '../../errors/index.js';
import type { AgentRuntime, SpawnContext } from './runtime.js';
import type { ListAgentsFilter, SpawnAgentParams, SpawnAgentReceipt } from './types.js';

/**
 * 创建 spawn_agent 工具。
 *
 * @param runtime AgentRuntime 调度器实例
 */
export function createSpawnAgentTool(
  runtime: AgentRuntime,
): Tool<SpawnAgentParams, SpawnAgentReceipt> {
  return defineTool({
    name: 'spawn_agent',
    description:
      'Spawn an autonomous background subagent with a specialized role, bounded capabilities, and isolated execution context.',
    metadata: {
      source: 'builtin',
      permissions: ['agent:spawn'],
      managesTimeout: true,
    },
    parameters: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'A brief description of the subagent task.',
        },
        prompt: {
          type: 'string',
          description: 'Detailed instructions and prompt for the subagent to execute.',
        },
        role: {
          type: 'string',
          enum: ['explore', 'planner', 'implement', 'advisor', 'custom'],
          description:
            'Specialized role preset: explore (read-only discovery), planner (architecture planning), implement (code edits and execution), advisor (pure reasoning without tools), custom (explicit allowedTools whitelist).',
        },
        allowedTools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional subset of tools to grant to the subagent.',
        },
        cwd: {
          type: 'string',
          description: 'Optional subdirectory relative to the workspace root for execution.',
        },
        isolation: {
          type: 'string',
          enum: ['inherit', 'worktree'],
          description: 'Workspace isolation mode.',
        },
        modelOverride: {
          type: 'string',
          description: 'Optional model override identifier.',
        },
        limits: {
          type: 'object',
          properties: {
            maxSteps: {
              type: 'integer',
              description: 'Maximum model interaction steps allowed (default 15).',
            },
            timeoutMs: {
              type: 'integer',
              description: 'Maximum wall-clock execution timeout in ms (default 300,000).',
            },
          },
        },
      },
      required: ['description', 'prompt', 'role'],
    },
    async execute(input: SpawnAgentParams, ctx): Promise<SpawnAgentReceipt> {
      if (!ctx.leaseCoordinator)
        throw new KapibalaError('Missing parent lease coordinator', {
          code: 'CONFIG_INVALID',
          safeMessage: '缺少父会话写租约协调器',
        });
      const workspaceRoot = ctx.workspaceRoot ?? ctx.rootDir;
      const executionCwd = ctx.executionCwd ?? workspaceRoot;

      const spawnContext: SpawnContext = {
        leaseCoordinator: ctx.leaseCoordinator,
        rootTaskId: ctx.rootTaskId,
        sessionId: ctx.sessionId ?? 'session-default',
        branchId: ctx.branchId ?? 'main',
        runId: ctx.runId ?? 'run-default',
        toolCallId: ctx.toolCallId ?? 'call-default',
        depth: ctx.depth ?? 0,
        agentId: ctx.agentId,
        workspaceRoot,
        executionCwd,
        parentPolicy: ctx.parentPolicy,
      };

      // 准备并受理启动请求（原子预留槽位并记录 preparing 状态）
      const receipt = await runtime.prepareSpawn(spawnContext, input);

      // 仅当父工具事务持久化提交成功后才激活启动子代理，防止父崩溃时留下游离后台任务
      if (ctx.onCommitted) {
        ctx.onCommitted(async () => {
          await runtime.activateSpawn(receipt.agentId);
        });
      } else {
        // 脱机/测试未接入事务时同步激活，不使用异步微任务进行推测激活
        await runtime.activateSpawn(receipt.agentId);
      }

      if (ctx.onRollback) {
        ctx.onRollback(async () => {
          await runtime.rollbackPreparedSpawn(receipt.agentId);
        });
      }

      return receipt;
    },
  });
}

/**
 * 创建 list_agents 工具。
 */
export function createListAgentsTool(runtime: AgentRuntime): Tool<ListAgentsFilter, unknown> {
  return defineTool({
    name: 'list_agents',
    description: 'List accessible subagent tasks and their current lifecycle statuses.',
    metadata: {
      source: 'builtin',
      permissions: ['agent:spawn'],
      readOnlyHint: true,
    },
    parameters: {
      type: 'object',
      properties: {
        rootTaskId: {
          type: 'string',
          description: 'Filter by root task ID.',
        },
        status: {
          type: 'string',
          enum: [
            'preparing',
            'accepted',
            'running',
            'waiting_children',
            'cancelling',
            'completed',
            'failed',
            'cancelled',
            'interrupted',
            'active',
            'terminal',
          ],
          description: 'Filter by task status.',
        },
      },
    },
    async execute(input: ListAgentsFilter, ctx): Promise<unknown> {
      if (!ctx.rootTaskId) {
        throw new KapibalaError(
          'Subagent listing requires an authorized rootTaskId in execution context',
          {
            code: 'PERMISSION_DENIED',
            safeMessage: '子代理查询必须在已授权的任务树上下文内执行',
          },
        );
      }
      if (input.rootTaskId && input.rootTaskId !== ctx.rootTaskId) {
        throw new KapibalaError('Cannot list agents outside authorized root task tree', {
          code: 'PERMISSION_DENIED',
          safeMessage: '无法查询非当前授权任务树的子代理',
        });
      }
      const filter: ListAgentsFilter = {
        ...input,
        rootTaskId: ctx.rootTaskId,
      };
      const tasks = runtime.listTasks(filter);
      return {
        count: tasks.length,
        agents: tasks.map((t) => ({
          agentId: t.agentId,
          role: t.role,
          description: t.description,
          status: t.status,
          depth: t.origin.depth,
          rootTaskId: t.origin.rootTaskId,
          parentAgentId: t.origin.parentAgentId,
          createdAt: t.createdAt,
          startedAt: t.startedAt,
          finishedAt: t.finishedAt,
          summary: t.summary,
          error: t.error,
          modelId: t.modelId,
        })),
      };
    },
  });
}

/**
 * 创建 wait_agent 工具。
 */
export function createWaitAgentTool(
  runtime: AgentRuntime,
): Tool<{ agentIds: string[]; timeoutMs?: number }, unknown> {
  return defineTool({
    name: 'wait_agent',
    description: 'Wait for specified subagent tasks to complete or reach terminal status.',
    metadata: {
      source: 'builtin',
      permissions: ['agent:spawn'],
      managesTimeout: true,
    },
    parameters: {
      type: 'object',
      properties: {
        agentIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of subagent IDs to wait for.',
        },
        timeoutMs: {
          type: 'integer',
          description: 'Maximum time to wait in ms (default 30,000; maximum 60,000).',
        },
      },
      required: ['agentIds'],
    },
    async execute(input: { agentIds: string[]; timeoutMs?: number }, ctx): Promise<unknown> {
      if (!ctx.rootTaskId) {
        throw new KapibalaError(
          'Subagent wait requires an authorized rootTaskId in execution context',
          {
            code: 'PERMISSION_DENIED',
            safeMessage: '等待子代理必须在已授权的任务树上下文内执行',
          },
        );
      }
      for (const targetId of input.agentIds) {
        const t = runtime.getTask(targetId);
        if (!t || t.origin.rootTaskId !== ctx.rootTaskId) {
          throw new KapibalaError(`Target agent ${targetId} is not in the authorized task tree`, {
            code: 'PERMISSION_DENIED',
            safeMessage: '目标子代理不属于当前授权任务树',
          });
        }
        if (
          ctx.agentId &&
          targetId !== ctx.agentId &&
          !runtime.isDescendantOf(targetId, ctx.agentId)
        ) {
          throw new KapibalaError(
            `Cannot wait task ${targetId} which is outside current subagent subtree`,
            {
              code: 'PERMISSION_DENIED',
              safeMessage: '无法等待当前子任务子树范围外的祖先或同级任务',
            },
          );
        }
      }
      const result = await runtime.waitAgents(input.agentIds, input.timeoutMs, ctx.signal);
      return {
        completed: result.completed,
        pending: result.pending,
        allCompleted: result.pending.length === 0,
      };
    },
  });
}

/**
 * 创建 cancel_agent 工具。
 */
export function createCancelAgentTool(
  runtime: AgentRuntime,
): Tool<{ agentId: string; reason?: string }, unknown> {
  return defineTool({
    name: 'cancel_agent',
    description: 'Cancel a running subagent task and all its descendants.',
    metadata: {
      source: 'builtin',
      permissions: ['agent:spawn'],
      managesTimeout: true,
    },
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'The agent ID to cancel.',
        },
        reason: {
          type: 'string',
          description: 'Optional cancellation rationale.',
        },
      },
      required: ['agentId'],
    },
    async execute(input: { agentId: string; reason?: string }, ctx): Promise<unknown> {
      if (!ctx.rootTaskId) {
        throw new KapibalaError(
          'Subagent cancellation requires an authorized rootTaskId in execution context',
          {
            code: 'PERMISSION_DENIED',
            safeMessage: '取消子代理必须在已授权的任务树上下文内执行',
          },
        );
      }
      const t = runtime.getTask(input.agentId);
      if (!t || t.origin.rootTaskId !== ctx.rootTaskId) {
        throw new KapibalaError(
          `Target agent ${input.agentId} is not in the authorized task tree`,
          {
            code: 'PERMISSION_DENIED',
            safeMessage: '目标子代理不属于当前授权任务树',
          },
        );
      }
      if (
        ctx.agentId &&
        input.agentId !== ctx.agentId &&
        !runtime.isDescendantOf(input.agentId, ctx.agentId)
      ) {
        throw new KapibalaError(
          `Cannot cancel task ${input.agentId} which is outside current subagent subtree`,
          {
            code: 'PERMISSION_DENIED',
            safeMessage: '无法取消当前子任务子树范围外的祖先或同级任务',
          },
        );
      }
      await runtime.cancelTask(input.agentId, input.reason);
      const task = runtime.getTask(input.agentId);
      return {
        agentId: input.agentId,
        status: task?.status ?? 'cancelled',
        message: 'Task and all its descendants cancelled',
      };
    },
  });
}

/**
 * 创建完整的子代理四大管理工具集合。
 */
export function createAgentTools(runtime: AgentRuntime): Tool[] {
  return [
    createSpawnAgentTool(runtime),
    createListAgentsTool(runtime),
    createWaitAgentTool(runtime),
    createCancelAgentTool(runtime),
  ];
}
