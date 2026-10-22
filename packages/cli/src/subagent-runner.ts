/**
 * @fileoverview CLI 生产环境真实子代理会话执行器（SubagentSessionRunner）工厂。
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
 * 4. 结果与模型追溯：
 *    完整驱动 AgentSession.run 消费所有事件，提取真实的 Assistant 文本作为终态 summary，
 *    记录实际响应的 modelId，用于可靠发件箱通知与父会话对账。
 */

import {
  AgentSession,
  type AgentTaskRecord,
  type ApprovalChannel,
  KapibalaError,
  PathSandbox,
  type PrimaryModelRole,
  type SessionManager,
  type SessionMode,
  type SubagentRunnerContext,
  type SubagentSessionRunner,
  ToolRegistry,
  type WorkspaceLeaseCoordinator,
} from '@kiturone/kapibala';
import { type CliModelBindings, createModelBinding } from './model-bindings.js';
import type { UserSettings } from './settings.js';
import { registerBuiltinTools } from './tool-registration.js';

/**
 * 子代理执行器配置选项。
 */
export interface CliSubagentRunnerOptions {
  /** 会话管理器，用于创建独立的子会话历史文件与锁。 */
  manager: SessionManager;
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
  /** 同一宿主所有会话共享的工作区写互斥，不使用新的隐式单例。 */
  leaseCoordinator: WorkspaceLeaseCoordinator;
}

/**
 * 创建用于生产环境的真实子代理会话执行器。
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
  ): Promise<{ summary: string; modelId?: string }> => {
    if (context?.leaseCoordinator !== options.leaseCoordinator)
      throw new KapibalaError('Parent and host coordinators differ', {
        code: 'CONFIG_INVALID',
        safeMessage: '父会话与子代理宿主写租约身份不一致',
      });
    // 1. 分配独立子会话存储文件与单写者句柄
    const handle = await options.manager.create();

    let subSession: AgentSession | undefined;
    let result: { summary: string; modelId?: string } | undefined;
    let failure: unknown;
    let succeeded = false;
    try {
      // 2. 构建独立沙箱
      const sandbox = new PathSandbox({ workspaceRoot: task.workspaceRoot });

      // 3. 解析目标模型与 Provider 绑定
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

      // 4. 构建并启动子 AgentSession（严格绑定 effectivePolicy 派生的安全模式）
      const effectiveMode: SessionMode =
        (task.effectivePolicy as { mode?: SessionMode } | undefined)?.mode ?? 'Approval';

      subSession = new AgentSession({
        approvalChannel: options.approvalChannel,
        leaseCoordinator: options.leaseCoordinator,
        workspaceRoot: task.workspaceRoot,
        executionCwd: task.executionCwd,
        rootDir: task.workspaceRoot,
        sandbox,
        store: handle.store,
        conversationId: handle.conversationId,
        defaultProfile: selectedProfile,
        defaultProvider: selectedProvider,
        rootTaskId: task.origin.rootTaskId,
        depth: task.origin.depth,
        agentId: task.agentId,
        maxSteps: task.limits.maxSteps,
        mode: effectiveMode,
      });

      // 5. 构建子代理受限工具注册表并直接挂载至 subSession.tools
      const effectiveAllowed = (
        task.effectivePolicy as { allowedTools?: readonly string[] } | undefined
      )?.allowedTools;
      const allowedToolSet = new Set(effectiveAllowed ?? task.allowedTools ?? []);

      if (task.role !== 'advisor') {
        const tempRegistry = new ToolRegistry();
        registerBuiltinTools(tempRegistry, {
          cwd: task.executionCwd,
          shell: options.preference ?? 'auto',
          disableShell: task.role === 'explore' || task.role === 'planner',
        });

        // 仅注册 effectivePolicy.allowedTools 允许的工具，绝不上溢写/执行工具
        for (const tool of tempRegistry.list()) {
          if (allowedToolSet.has(tool.name)) {
            subSession.tools.register(tool);
          }
        }
      }

      // 6. 注册多角色路由并激活场景模型角色
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
      const modelId: string | undefined = selectedProfile.id;

      // 6. 执行 prompt 驱动智能体循环
      for await (const event of subSession.run(task.prompt, { signal })) {
        if (event.type === 'message_stop' && event.message.role === 'assistant') {
          for (const block of event.message.content) {
            if (block.type === 'text') {
              summary = block.text;
            }
          }
        }
      }

      result = { summary, modelId };
      succeeded = true;
    } catch (error) {
      failure = error;
    }
    // 子会话销毁成功后才能释放存储句柄；失败时保留单写者锁，防止重叠写入。
    // 清理错误不覆盖主流程异常：主流程失败时抛出原错误，否则抛出首个清理错误。
    const failures: unknown[] = [];
    try {
      await subSession?.destroy();
    } catch (error) {
      failures.push(error);
    }
    if (!failures.length) {
      try {
        await handle.release();
      } catch (error) {
        failures.push(error);
      }
    }
    if (!succeeded) throw failure;
    if (failures.length) throw failures[0];
    return result!;
  };
}
