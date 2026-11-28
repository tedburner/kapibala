import path from 'node:path';
/**
 * @fileoverview CLI 生产环境真实子代理会话执行器（runner 与续聊 resumer）工厂。
 *
 * 约束、边界与为什么：
 * 1. 独立 Store 与生命周期隔离：
 *    每个子代理任务通过 SessionManager.create 分配独立的会话文件与写锁，
 *    拥有完全隔离的因果历史与状态，严禁与父会话共用同一 Store 导致历史交错。
 * 2. 物理与沙箱严格受限：
 *    子代理会话的 PathSandbox 严格限定于 task.workspaceRoot，
 *    并以 task.executionCwd 作为执行基准目录，严禁逃逸出工作区根。
 * 3. 角色预设与工具白名单强制收紧：
 *    根据 task.role（explore / planner / implement / advisor / custom）和 task.allowedTools
 *    构建受限工具注册表，不可越权调用父级未授权或角色禁止的工具。
 * 4. 生命周期分流：
 *    ephemeral 终态销毁会话；detached 终态保留会话文件供 send_agent 续聊，
 *    但每次都释放单写者句柄，下次续聊走正常的 SessionManager.open 重新取锁。
 */

import {
  type AgentRuntime,
  AgentSession,
  type AgentTaskRecord,
  type ApprovalChannel,
  KapibalaError,
  type ManagedSession,
  PathSandbox,
  type PermissionRule,
  type PrimaryModelRole,
  type SessionManager,
  type SessionMode,
  type SubagentRunnerContext,
  type SubagentSessionResumer,
  type SubagentSessionRunner,
  ToolRegistry,
  type WorkspaceLeaseCoordinator,
  computeProjectKey,
  createDelegationError,
  deriveChildPolicy,
  formatDelegationTitle,
  sessionToolResultsDirectory,
  toNativePhysicalPath,
} from '@kiturone/kapibala';
import {
  MAX_RETAINED_DELEGATIONS,
  countRetainedDelegations,
  pruneDelegationSessions,
} from './delegations.js';
import { type CliModelBindings, createModelBinding } from './model-bindings.js';
import type { UserSettings } from './settings.js';
import { type SessionApprovalHub, createSubagentApprovalChannel } from './subagent-approval.js';
import { registerBuiltinTools } from './tool-registration.js';
import type { ExecutionRootCoordinator } from './worktree/index.js';

const restrictedLineageByCoordinator = new WeakMap<object, Set<string>>();

function getRestrictedAgentSet(key: object): Set<string> {
  let set = restrictedLineageByCoordinator.get(key);
  if (!set) {
    set = new Set<string>();
    restrictedLineageByCoordinator.set(key, set);
  }
  return set;
}

/**
 * 子代理执行器配置选项。
 */
export interface CliSubagentRunnerOptions {
  /** 会话管理器，用于创建独立的子会话历史文件与锁。 */
  manager: SessionManager;
  /** 显式用户目录贯穿每个子会话；未传时保留既有 CLI/SDK 行为。 */
  homeDirectory?: string;
  /** 模型绑定管理器，用于解析各角色对应的实际模型与 Provider。 */
  models: CliModelBindings;
  /** 用户设置。 */
  settings: UserSettings;
  /** 终端 Shell 偏好。 */
  preference?: string;
  /** 项目是否受信任。 */
  isTrusted?: boolean;
  /** 本地宿主显式传入审批与租约；不因子代理隔离绕过父宿主权限。 */
  approvalChannel?: ApprovalChannel;
  /** 父会话树常驻审批中枢；提供后启用跨兄弟子代理 `allow_session` 缓存共享与排队重判。 */
  approvalHub?: SessionApprovalHub;
  /** 可选注入的子代理运行时实例，用于嵌套子代理工具挂载及委派淘汰时查询活跃任务。 */
  runtime?: AgentRuntime;
  /** 可选诊断回调（如自动淘汰过期委派会话时记录说明）。 */
  onDiagnostic?: (message: string) => void;
  /** 同一宿主所有会话共享的工作区写互斥，不使用新的隐式单例。 */
  leaseCoordinator: WorkspaceLeaseCoordinator;
  /** 可选跨子系统物理执行根协调器；传入后在子代理生命周期内校验移除门闩并登记活动运行。 */
  executionCoordinator?: ExecutionRootCoordinator;
}

/** 委派子会话续聊执行器配置选项；与首次派发共享同一安全与协调边界。 */
export type CliSubagentResumerOptions = CliSubagentRunnerOptions;

/** 单轮委派执行的公共入参；runner 与 resumer 只在会话获取方式上不同。 */
interface DelegationTurnRequest {
  /** 已持有单写者句柄的子会话。 */
  handle: ManagedSession;
  /** 任务快照；提供角色、策略、执行目录与限额。 */
  task: AgentTaskRecord;
  /** 本轮用户输入。 */
  prompt: string;
  /** 取消/超时信号。 */
  signal: AbortSignal;
  /** 运行时上下文（提供人工审批期间暂停墙钟超时的句柄）。 */
  context?: SubagentRunnerContext;
  /** 宿主装配选项。 */
  options: CliSubagentRunnerOptions;
}

/**
 * 执行一轮子代理对话并返回终端摘要。
 *
 * 保证：
 * - AgentSession 在返回前必定 destroy，避免工具事务与摘要清理泄漏；
 * - 工具注册只取 effectivePolicy.allowedTools 的交集，advisor 不注册任何工具；
 * - 模型选择沿用 modelOverride → 默认绑定，角色路由不得扩大父级权限。
 */
async function runDelegationTurn(request: DelegationTurnRequest): Promise<{
  summary: string;
  modelId?: string;
}> {
  const { handle, task, prompt, signal, options } = request;
  // 与 AgentSession 内部同源的项目哈希与结果桶：子代理的大输出也落全局受管目录，
  // 沙箱只对该桶开放只读豁免；未注入 homeDirectory 时退回系统临时目录且无豁免。
  const toolResultsRoot = options.homeDirectory
    ? path.join(options.homeDirectory, '.kapibala', 'tool-results')
    : undefined;
  const subagentProjectRoot = toNativePhysicalPath(
    task.worktree?.projectRoot ?? options.manager.project.projectRoot,
  );
  const subagentResultsDir = toolResultsRoot
    ? sessionToolResultsDirectory({
        resultsRoot: toolResultsRoot,
        projectKey: computeProjectKey(subagentProjectRoot),
        sessionId: handle.conversationId,
      })
    : undefined;
  const sandbox = new PathSandbox({
    workspaceRoot: task.workspaceRoot,
    ...(subagentResultsDir ? { readOnlyExemptions: () => [subagentResultsDir] } : {}),
  });

  const defaultBinding = options.models.defaultBinding;
  let selectedProfile = defaultBinding.profile;
  let selectedProvider = defaultBinding.provider;

  if (task.modelOverride) {
    const found = options.settings.profiles.find((p) => p.id === task.modelOverride);
    if (!found) {
      throw new Error(`未找到指定的覆盖模型配置: '${task.modelOverride}'`);
    }
    const overrideBinding = createModelBinding(found, options.settings);
    selectedProfile = overrideBinding.profile;
    selectedProvider = overrideBinding.provider;
  }

  const derivedPolicy = task.effectivePolicy as
    | {
        mode?: SessionMode;
        rules?: readonly PermissionRule[];
        allowedTools?: readonly string[];
        hasExplicitAllowedTools?: boolean;
        restrictedAllowedTools?: boolean;
      }
    | undefined;
  const effectiveMode: SessionMode = derivedPolicy?.mode ?? 'Approval';
  const derivedRules = derivedPolicy?.rules;

  const tempRegistry = new ToolRegistry();
  if (task.role !== 'advisor') {
    registerBuiltinTools(tempRegistry, {
      cwd: task.executionCwd,
      shell: options.preference ?? 'auto',
      disableShell: task.role === 'explore' || task.role === 'planner',
      ...(options.runtime ? { runtime: options.runtime } : {}),
    });
  }

  const effectiveAllowed = derivedPolicy?.allowedTools;
  const allowedToolSet = new Set(effectiveAllowed ?? task.allowedTools ?? []);

  // 判断当前子代理或其任意祖先是否收紧过 allowedTools（含 A 缩权后派生未显式传 allowedTools 的子级 B）。
  const restrictedAgents = getRestrictedAgentSet(options.approvalHub ?? options.leaseCoordinator);
  let hasLineageToolRestriction =
    Boolean(task.allowedTools && task.allowedTools.length > 0) ||
    task.role === 'custom' ||
    Boolean(derivedPolicy?.hasExplicitAllowedTools) ||
    Boolean(derivedPolicy?.restrictedAllowedTools);

  if (!hasLineageToolRestriction && task.origin.parentAgentId) {
    if (restrictedAgents.has(task.origin.parentAgentId)) {
      hasLineageToolRestriction = true;
    } else if (options.runtime) {
      const visited = new Set<string>([task.agentId]);
      let cursorId: string | undefined = task.origin.parentAgentId;
      while (cursorId && !visited.has(cursorId)) {
        visited.add(cursorId);
        if (restrictedAgents.has(cursorId)) {
          hasLineageToolRestriction = true;
          break;
        }
        const ancestor = options.runtime.getTask(cursorId);
        if (!ancestor) break;
        if (
          (ancestor.allowedTools && ancestor.allowedTools.length > 0) ||
          ancestor.role === 'custom'
        ) {
          hasLineageToolRestriction = true;
          break;
        }
        cursorId = ancestor.origin.parentAgentId;
      }
    }
  }

  if (!hasLineageToolRestriction && effectiveAllowed && task.role !== 'advisor') {
    try {
      const unrestrictedBaseline = deriveChildPolicy(
        {
          mode: effectiveMode,
          rules: derivedRules ?? [],
          availableTools: tempRegistry.list(),
          workspaceRoot: task.workspaceRoot,
          executionCwd: task.executionCwd,
          currentDepth: Math.max(0, task.origin.depth - 1),
        },
        { role: task.role },
      );
      if (unrestrictedBaseline.allowedTools.some((name) => !allowedToolSet.has(name))) {
        hasLineageToolRestriction = true;
      }
    } catch {
      hasLineageToolRestriction = true;
    }
  }

  if (hasLineageToolRestriction) {
    restrictedAgents.add(task.agentId);
  }

  const subagentApprovalChannel = createSubagentApprovalChannel({
    parentChannel: options.approvalChannel,
    hub: options.approvalHub,
    origin: {
      agentId: task.agentId,
      role: task.role,
      description: task.description,
      ...(task.mode === 'detached' ? { childSessionId: handle.conversationId } : {}),
      parentSessionId: task.origin.parentSessionId,
    },
    // 自身或任意祖先显式收紧过 allowedTools 的子代理仅只读命中父树缓存、禁止回写，防缩权分支污染根会话缓存。
    canWriteTreeCache: !hasLineageToolRestriction,
    pauseTimeout: () => request.context?.pauseTimeout?.() ?? (() => {}),
  });

  const subSession = new AgentSession({
    userInstructionsPath: options.homeDirectory
      ? path.join(options.homeDirectory, '.kapibala/AGENTS.md')
      : undefined,
    loggingDirectory: options.homeDirectory
      ? path.join(options.homeDirectory, '.kapibala')
      : undefined,
    auditRecoveryDirectory: options.homeDirectory
      ? path.join(options.homeDirectory, '.kapibala/audit')
      : undefined,
    approvalChannel: subagentApprovalChannel,
    leaseCoordinator: options.leaseCoordinator,
    workspaceRoot: task.workspaceRoot,
    executionCwd: task.executionCwd,
    projectRoot: subagentProjectRoot,
    sandbox,
    ...(toolResultsRoot ? { toolResultsDirectory: toolResultsRoot } : {}),
    store: handle.store,
    conversationId: handle.conversationId,
    defaultProfile: selectedProfile,
    defaultProvider: selectedProvider,
    rootTaskId: task.origin.rootTaskId,
    depth: task.origin.depth,
    agentId: task.agentId,
    maxSteps: task.limits.maxSteps,
    mode: effectiveMode,
    ...(derivedRules ? { permissionRules: [...derivedRules] } : {}),
  });

  try {
    if (task.role !== 'advisor') {
      // 仅注册 effectivePolicy.allowedTools 允许的工具，绝不上溢写/执行工具
      for (const tool of tempRegistry.list()) {
        if (allowedToolSet.has(tool.name)) {
          subSession.tools.register(tool);
        }
      }
    }

    const preferredRole: PrimaryModelRole =
      (task.effectivePolicy as { preferredRole?: PrimaryModelRole } | undefined)?.preferredRole ??
      'default';
    const targetRole: PrimaryModelRole =
      preferredRole !== 'default' && options.models.hasRole(preferredRole)
        ? preferredRole
        : 'default';
    options.models.attach(subSession, targetRole);
    await subSession.init();

    let summary = 'Task completed without text output';
    for await (const event of subSession.run(prompt, { signal })) {
      if (event.type === 'message_stop' && event.message.role === 'assistant') {
        for (const block of event.message.content) {
          if (block.type === 'text') {
            summary = block.text;
          }
        }
      }
    }

    return { summary, modelId: selectedProfile.id };
  } finally {
    await subSession.destroy();
  }
}

/**
 * 创建用于生产环境的真实子代理会话执行器（首次派发）。
 *
 * @param options 工厂配置选项
 * @returns 标准的 SubagentSessionRunner 异步执行函数
 */
export function createCliSubagentRunner(options: CliSubagentRunnerOptions): SubagentSessionRunner {
  if (!options.leaseCoordinator)
    throw new KapibalaError('Missing host lease coordinator', {
      code: 'CONFIG_INVALID',
      safeMessage: '缺少宿主写租约协调器',
    });
  return async (
    task: AgentTaskRecord,
    signal: AbortSignal,
    context: SubagentRunnerContext,
  ): Promise<{ summary: string; modelId?: string; sessionId?: string; title?: string }> => {
    if (context?.leaseCoordinator !== options.leaseCoordinator)
      throw new KapibalaError('Parent and host coordinators differ', {
        code: 'CONFIG_INVALID',
        safeMessage: '父会话与子代理宿主写租约身份不一致',
      });
    options.executionCoordinator?.assertNotFenced(task.workspaceRoot);
    const execRunHandle = options.executionCoordinator?.trackActiveRun({
      executionRoot: task.workspaceRoot,
      ownerId: `subagent:${task.agentId}`,
      kind: 'native',
    });
    try {
      // 1. 分配独立子会话存储文件与单写者句柄；detached 在创建时写入委派头部身份。
      const detached = task.mode === 'detached';
      // 保留预算在创建前检查：先尝试清理超期或超额的终态委派会话，仍达上限时直接拒绝，不先建文件再失败。
      if (detached) {
        const activeSessionIds = new Set(
          (options.runtime?.listTasks({ status: 'active' }) ?? []).flatMap((item) =>
            item.sessionId ? [item.sessionId] : [],
          ),
        );
        const pruned = await pruneDelegationSessions(options.manager, {
          activeSessionIds,
          onDiagnostic: options.onDiagnostic,
        });
        for (const prunedId of pruned) {
          options.runtime?.forgetDelegationSession(prunedId);
        }
        const retained = await countRetainedDelegations(options.manager);
        if (retained >= MAX_RETAINED_DELEGATIONS) {
          throw createDelegationError(
            'DELEGATION_LIMIT_EXCEEDED',
            `Retained delegation limit reached (${MAX_RETAINED_DELEGATIONS}); delete one via /delegations delete`,
          );
        }
      }
      const handle = await options.manager.create(
        detached
          ? {
              delegation: {
                kind: 'delegation',
                parentSessionId: task.origin.parentSessionId,
                ...(context.parentTitle ? { parentTitle: context.parentTitle } : {}),
                taskName: task.description,
                createdAt: Date.now(),
                ...(task.requestId ? { requestId: task.requestId } : {}),
                ...(task.requestSignature ? { requestSignature: task.requestSignature } : {}),
                // 回执快照里的 sessionId 由 header.conversationId 唯一确定，这里不重复写入。
                ...(task.requestReceipt ? { requestReceipt: { ...task.requestReceipt } } : {}),
              },
              ...(task.worktree ? { worktree: task.worktree } : {}),
            }
          : task.worktree
            ? { worktree: task.worktree }
            : undefined,
      );
      if (detached) context.onSessionCreated?.(handle.conversationId);

      let result:
        | { summary: string; modelId?: string; sessionId?: string; title?: string }
        | undefined;
      let failure: unknown;
      let succeeded = false;
      try {
        const turn = await runDelegationTurn({
          handle,
          task,
          prompt: task.prompt,
          signal,
          context,
          options,
        });
        result = {
          summary: turn.summary,
          modelId: turn.modelId,
          ...(detached
            ? {
                sessionId: handle.conversationId,
                title: formatDelegationTitle(task.description, context.parentTitle),
              }
            : {}),
        };
        succeeded = true;
      } catch (error) {
        failure = error;
      }
      // 终态命名：detached 会话在销毁前写一次 title 记录；失败也写，保证续聊入口可辨认。
      // 名称只取创建时快照，后续父会话改名不联动。
      const failures: unknown[] = [];
      if (detached) {
        try {
          await handle.store.appendRecord('title', {
            title: formatDelegationTitle(task.description, context.parentTitle),
          });
        } catch (error) {
          failures.push(error);
        }
      }
      // 存储句柄必须无论成功或标题追加失败都尝试释放；
      // 清理错误不覆盖主流程异常：主流程失败时抛出原错误，否则抛出首个清理错误。
      try {
        await handle.release();
      } catch (error) {
        failures.push(error);
      }
      if (!succeeded) throw failure;
      if (failures.length) throw failures[0];
      return result!;
    } finally {
      execRunHandle?.release();
    }
  };
}

/**
 * 创建委派会话续聊执行器（send_agent）。
 *
 * 约束：
 * - 目标必须是 detached 且已有 sessionId；ephemeral 或已清理的会话明确失败；
 * - 每次续聊重新 open 取单写者锁，与用户同时打开同一会话时按 SESSION_LOCKED 拒绝，不抢锁；
 * - 失败不删除会话文件：失败轮次仍可再次续聊，只有用户显式 cancel/delete 才清理。
 *
 * @param options 与首次派发共享的宿主装配选项
 * @returns 标准的 SubagentSessionResumer 异步执行函数
 */
export function createCliSubagentResumer(
  options: CliSubagentResumerOptions,
): SubagentSessionResumer {
  if (!options.leaseCoordinator)
    throw new KapibalaError('Missing host lease coordinator', {
      code: 'CONFIG_INVALID',
      safeMessage: '缺少宿主写租约协调器',
    });
  return async (
    task: AgentTaskRecord,
    prompt: string,
    signal: AbortSignal,
    context: SubagentRunnerContext,
  ): Promise<{ summary: string; modelId?: string }> => {
    if (context?.leaseCoordinator !== options.leaseCoordinator)
      throw new KapibalaError('Parent and host coordinators differ', {
        code: 'CONFIG_INVALID',
        safeMessage: '父会话与子代理宿主写租约身份不一致',
      });
    if (!task.sessionId) {
      throw createDelegationError(
        'DELEGATION_NOT_RETAINED',
        `Task ${task.agentId} has no retained session to resume`,
      );
    }

    options.executionCoordinator?.assertNotFenced(task.workspaceRoot);
    const execRunHandle = options.executionCoordinator?.trackActiveRun({
      executionRoot: task.workspaceRoot,
      ownerId: task.sessionId,
      kind: 'native',
    });
    try {
      const handle = await options.manager.open(task.sessionId);
      let result: { summary: string; modelId?: string } | undefined;
      let failure: unknown;
      let succeeded = false;
      try {
        result = await runDelegationTurn({ handle, task, prompt, signal, context, options });
        succeeded = true;
      } catch (error) {
        failure = error;
      }
      const releaseError = await handle.release().catch((error: unknown) => error);
      if (!succeeded) throw failure;
      if (releaseError) throw releaseError;
      return result!;
    } finally {
      execRunHandle?.release();
    }
  };
}
