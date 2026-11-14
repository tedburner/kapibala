import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentRuntime,
  AgentSession,
  type ApprovalChannel,
  type CanonicalMessage,
  type ManagedSession,
  type PrimaryModelRole,
  type SessionEvent,
  SessionManager,
  type SessionMode,
  type WorkspaceLeaseCoordinator,
  sanitizeSessionTitle,
} from '@kiturone/kapibala';
import { type McpPluginInstance, createMcpPlugin } from '@kiturone/kapibala-mcp';
import { toWireErrorCode } from '../protocol/index.js';
import type { JsonValue } from '../protocol/index.js';
import { resolveCliMcpOptions } from './mcp.js';
import { CliModelBindings, ROUTABLE_MODEL_ROLES } from './model-bindings.js';
import { StreamingRedactor, redactText } from './redaction.js';
import {
  BUILTIN_PROFILES,
  type UserSettings,
  isProjectTrusted,
  loadSettings,
  resolveApiKeyDetailed,
} from './settings.js';
import { getCliSkillOptions, hasProjectSkills } from './skills.js';
import { createCliSubagentRunner } from './subagent-runner.js';
import { registerBuiltinTools } from './tool-registration.js';
import { formatToolDetail } from './ui/tool-presentation.js';

import type { PresentationEvent, PresentationState } from '../view-model/index.js';
import type { StatusFacts } from '../view-model/status.js';
import { projectHistory } from './history-projection.js';
import { type ManagedInspection, projectInspection } from './inspection.js';
import { PresentationStore } from './presentation-store.js';
import { redactPresentationState } from './public-projection.js';
import { SessionPresentation, presentationScope } from './session-presentation.js';
import { projectStatusFacts } from './status-facts.js';
import { TaskObservation } from './task-observation.js';
/** 收集可解析的模型凭证；忽略无密钥占位与过短值，避免把常见词整体替换。 */
function credentialsFromSettings(settings: Pick<UserSettings, 'profiles'>): string[] {
  return settings.profiles.flatMap((profile) => {
    const resolved = resolveApiKeyDetailed(profile, settings);
    return resolved && resolved.source !== 'none' && resolved.key.length >= 4 ? [resolved.key] : [];
  });
}

/** 只读加载工作区生效的凭证供标题等非会话出口脱敏；配置不可读时退化为空集。 */
export function loadCredentialSecrets(workspaceRoot: string, homeDir?: string): string[] {
  try {
    return credentialsFromSettings(loadSettings({ cwd: workspaceRoot, homeDir }).settings);
  } catch {
    return [];
  }
}

function publicHistory(history: CanonicalMessage[], redact: (text: string) => string): JsonValue[] {
  return history.map((message, index) => ({
    id: message.id ?? `legacy:${index}`,
    role: message.role,
    state: message.state ?? 'completed',
    blocks: message.content.flatMap((block) => {
      if (block.type === 'text') return [{ kind: 'text', text: redact(block.text) }];
      if (block.type === 'thinking') return [{ kind: 'thinking', text: redact(block.thinking) }];
      if (block.type === 'tool_result')
        return [{ kind: 'tool_result', text: redact(formatToolDetail(block.content)) }];
      if (block.type === 'tool_use') return [{ kind: 'tool_use', text: block.name }];
      return [];
    }),
  }));
}

/** Node 宿主显式身份；不改变进程 cwd/HOME，不替调用方提升工作区根。 */
export interface ManagedSessionOptions {
  workspaceRoot: string;
  homeDirectory: string;
  conversationId?: string;
  /** 新会话的临时默认模型；仅影响此会话，不写回用户配置。 */
  initialProfileId?: string;
  approvalChannel: ApprovalChannel;
  leaseCoordinator: WorkspaceLeaseCoordinator;
  /** 未传时保持 SDK 读取行为；桌面调用方应显式设置读取预算。 */
  maxReadBytes?: number;
}

/** 本次会话选择；仅空闲时应用，不持久化全局默认或自动提升权限。 */
export interface ManagedSessionConfiguration {
  profileId?: string;
  role?: PrimaryModelRole;
  mode?: SessionMode;
}

/**
 * 公共受管会话：快照与事件投影脱敏，wire 适配不得传输任何原始句柄。
 * `session` 是唯一的例外面——仅供同进程宿主构造命令上下文；跨进程只允许
 * 传递 snapshot/事件投影，`runSkill` 与 `run` 共用同一收据管线。
 */
export interface ManagedHostSession {
  readonly conversationId: string;
  /**
   * 同进程宿主（桌面命令适配器等）所需的会话对象。
   * 仅供宿主侧在进程内构造命令上下文使用；不得跨进程传输或序列化。
   */
  readonly session: AgentSession;
  /** 完整驱动一次运行；并发请求拒绝，外部中止也等待工具事务收口。 */
  run(input: string, signal?: AbortSignal): Promise<void>;
  /**
   * 显式技能直发：与 run 共用同一投影、审批与工具事务管线，事件流语义一致。
   * task 为空或技能名非法时由底层 Session 以 SKILL_INVALID_INPUT 拒绝。
   */
  runSkill(skillName: string, task: string, signal?: AbortSignal): Promise<void>;
  /** 中止当前父子任务并等待清理；不因退订展示而自动触发。 */
  cancel(): Promise<void>;
  /** 清理失败保留写锁，可重试；成功后禁止再运行或配置。 */
  dispose(): Promise<void>;
  /** 清理中的句柄仍忙碌，只有终态且清理结束才能复用。 */
  isBusy(): boolean;
  /** 只更新空闲会话，保持全局设置不变；失效 Profile 明确拒绝。 */
  configure(configuration: ManagedSessionConfiguration): void;
  /** 就地重命名：追加 title 控制记录，运行中也可改，不打断当前任务。 */
  rename(title: string): Promise<void>;
  /** 就地切换置顶：追加 pin_state 控制记录，只影响列表次序，不改活动时间。 */
  setPinned(pinned: boolean): Promise<void>;
  /** 返回脱敏后的公共展示快照，不提供原始历史或资源句柄。 */
  snapshot(): PresentationState;
  /** 交付已接受的有序展示事件；退订不取消执行。 */
  subscribeEvents(listener: (event: PresentationEvent) => void): () => void;
  /** 当前生效选择的白名单事实，不含 Profile 对象、端点或凭证。 */
  configuration(): { profileId: string; role: PrimaryModelRole; mode: SessionMode };
  /** 仅读取当前状态；缺失的 Provider usage 不以默认零补齐。 */
  status(): StatusFacts;
  /** 只读取已知状态，不启动探测或收集；诊断与任务摘要有界脱敏。 */
  inspection(): ManagedInspection;
  /** 观察变更不依赖页面正文订阅，退订不影响执行。 */
  subscribeInspection(listener: () => void): () => void;
}

/** 只在调用时装配资源；导入不探测环境、不读终端、不启动 Agent 或工具进程。 */
export async function createManagedSession(
  options: ManagedSessionOptions,
): Promise<ManagedHostSession> {
  return (await createManagedSessionResources(options)).managed;
}

/** 内部业务错误只暴露固定 code；cause 不属于公共展示或跨进程 DTO。 */
class ManagedHostError extends Error {
  constructor(
    readonly code: string,
    cause?: unknown,
  ) {
    super(code, { cause });
  }
}

/** 本地 wire 适配器专用资源；/host 公共入口仅导出上面的窄门面。 */
export async function createManagedSessionResources(options: ManagedSessionOptions) {
  if (!path.isAbsolute(options.workspaceRoot) || !path.isAbsolute(options.homeDirectory))
    throw new ManagedHostError('ABSOLUTE_PATH_REQUIRED');
  if (!options.leaseCoordinator) throw new ManagedHostError('LEASE_COORDINATOR_REQUIRED');
  const homeDirectory = fs.realpathSync.native(options.homeDirectory);
  if (!fs.statSync(homeDirectory).isDirectory()) throw new ManagedHostError('HOME_UNAVAILABLE');
  const workspaceRoot = options.workspaceRoot;
  const conversationId = options.conversationId;
  const approval = options.approvalChannel;
  const leases = options.leaseCoordinator;
  const root = fs.realpathSync.native(workspaceRoot);
  if (!fs.statSync(root).isDirectory()) throw new ManagedHostError('WORKSPACE_UNAVAILABLE');
  const loaded = loadSettings({ cwd: root, homeDir: homeDirectory });
  const settings = options.initialProfileId
    ? { ...loaded.settings, defaultModel: options.initialProfileId }
    : loaded.settings;
  const trusted = isProjectTrusted(settings, root);
  if (
    loaded.pendingProject ||
    (!trusted && (hasProjectSkills(root) || fs.existsSync(path.join(root, '.kapibala/mcp.json'))))
  )
    throw new ManagedHostError('TRUST_REQUIRED');
  const profile =
    settings.profiles.find((item) => item.id === settings.defaultModel) ??
    BUILTIN_PROFILES.find((item) => item.id === settings.defaultModel);
  if (!profile) throw new ManagedHostError('CONFIG_REQUIRED');
  let models: CliModelBindings;
  try {
    models = new CliModelBindings(settings, profile);
  } catch {
    throw new ManagedHostError('CONFIG_REQUIRED');
  }
  const manager = new SessionManager({
    workspaceRoot: root,
    homeDirectory,
    projectRootMode: 'exact',
    maxReadBytes: options.maxReadBytes,
  });
  let handle: ManagedSession | undefined;
  let session: AgentSession | undefined;
  let runtime: AgentRuntime | undefined;
  try {
    try {
      handle = conversationId
        ? await manager.open(conversationId, { autoUpgradeLegacy: true })
        : await manager.create();
    } catch (error) {
      const code = toWireErrorCode(error);
      if (code === 'SESSION_BUSY' || code === 'SESSION_NOT_FOUND')
        throw new ManagedHostError(code, error);
      throw error;
    }
    const preference = settings.shell?.preference ?? 'auto';
    runtime = new AgentRuntime({
      runner: (...args) =>
        createCliSubagentRunner({
          homeDirectory,
          manager,
          models,
          settings,
          preference,
          isTrusted: trusted,
          approvalChannel: approval,
          leaseCoordinator: leases,
        })(...args),
      validateModelOverride: (id) => settings.profiles.some((item) => item.id === id),
      outboxPath: path.join(root, '.kapibala/outbox.jsonl'),
    });
    session = new AgentSession({
      userInstructionsPath: path.join(homeDirectory, '.kapibala/AGENTS.md'),
      loggingDirectory: path.join(homeDirectory, '.kapibala'),
      auditRecoveryDirectory: path.join(homeDirectory, '.kapibala/audit'),
      workspaceRoot: root,
      executionCwd: root,
      projectRoot: root,
      store: handle.store,
      conversationId: handle.conversationId,
      defaultProfile: models.defaultBinding.profile,
      defaultProvider: models.defaultBinding.provider,
      approvalChannel: approval,
      leaseCoordinator: leases,
      permissionRules: settings.permissionRules,
      mode:
        settings.permissionMode === 'FullAccess'
          ? 'Approval'
          : (settings.permissionMode ?? 'Approval'),
      skills: getCliSkillOptions(settings, {
        cwd: root,
        projectRoot: root,
        homeDir: homeDirectory,
      }),
    });
    registerBuiltinTools(session.tools, {
      cwd: root,
      shell: preference,
      disableShell: settings.shell?.enabled === false,
      runtime,
    });
    models.attach(session);
    const mcp = resolveCliMcpOptions({
      projectRoot: root,
      homeDir: homeDirectory,
      isProjectTrusted: trusted,
    });
    if (mcp.diagnostics.some((item) => item.severity === 'error'))
      throw new Error('MCP_CONFIG_INVALID');
    let mcpPlugin: McpPluginInstance | undefined;
    // 累计仅使用 Provider 明确提供的 usage；任一请求缺失时保持未知，避免把默认零当账单。
    let runUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let hasUsage = false;
    let usageComplete = true;
    let awaitingUsage = false;
    const inspectionListeners = new Set<() => void>();
    const inspectionChanged = () => {
      for (const listener of inspectionListeners) {
        try {
          listener();
        } catch {
          /* 观察者不影响执行。 */
        }
      }
    };
    let mountMcp: ((signal: AbortSignal) => Promise<void>) | undefined;
    if (mcp.enabled && mcp.servers.size) {
      const servers = Object.fromEntries(
        [...mcp.servers].map(([name, entry]) => [name, entry.config]),
      );
      const mcpSession = session;
      mountMcp = async (runSignal) => {
        mcpPlugin = createMcpPlugin(servers, {
          authorizer: async (descriptor, signal) => {
            inspectionChanged();
            const choice = await approval.requestApproval(
              {
                toolName: 'mcp_start',
                rootDir: root,
                capabilities: descriptor.type === 'stdio' ? ['exec'] : ['net:outbound'],
                input: { ...descriptor },
                sessionAllowed: true,
              },
              signal ? AbortSignal.any([signal, runSignal]) : runSignal,
            );
            return choice === 'cancel' ? 'deny_once' : choice;
          },
        });
        try {
          await mcpSession.use(mcpPlugin);
        } finally {
          inspectionChanged();
        }
      };
    }
    await session.init();
    const current = session;
    const ownedHandle = handle;
    const ownedRuntime = runtime;
    const credentials = credentialsFromSettings(settings);
    const redact = (text: string) => redactText(text, credentials);
    const identity = {
      conversationId: handle.conversationId,
      branchId: handle.store.getActiveBranchId(),
      viewEpoch: 1,
    };
    const presentation = new PresentationStore(
      identity,
      projectHistory(current.getHistory(), presentationScope(identity), redact),
    );
    const tasks = new TaskObservation(
      ownedRuntime,
      {
        parentSessionId: handle.conversationId,
        branchId: identity.branchId,
      },
      inspectionChanged,
    );
    const stopInspectionEvents = presentation.subscribeEvents((event) => {
      if (event.change.type !== 'append') inspectionChanged();
    });
    let selectedDefaultId = profile.id;
    let selectedProfileId = profile.id;
    let selectedRole: PrimaryModelRole = 'default';
    let activeProjection: SessionPresentation | undefined;
    let activeController: AbortController | undefined;
    let activeDone: Promise<void> | undefined;
    let disposed = false;
    let closing = false;
    const assertIdle = () => {
      if (disposed || closing) throw new ManagedHostError('SESSION_CLOSED');
      if (activeController || current.isBusy()) throw new ManagedHostError('SESSION_BUSY');
    };
    const refresh = (configuration: ManagedSessionConfiguration = {}) => {
      assertIdle();
      const latest = loadSettings({ cwd: root, homeDir: homeDirectory });
      if (
        latest.pendingProject ||
        (!isProjectTrusted(latest.settings, root) &&
          (hasProjectSkills(root) || fs.existsSync(path.join(root, '.kapibala/mcp.json'))))
      )
        throw new ManagedHostError('TRUST_REQUIRED');
      const role = configuration.role ?? selectedRole;
      const defaultId =
        configuration.profileId && role === 'default' ? configuration.profileId : selectedDefaultId;
      const id =
        configuration.profileId ??
        (configuration.role && role !== selectedRole
          ? role === 'default'
            ? defaultId
            : latest.settings.modelRouting?.[role]
          : selectedProfileId);
      const selected = latest.settings.profiles.find((item) => item.id === id);
      const defaultProfile = latest.settings.profiles.find((item) => item.id === defaultId);
      if (!selected || !defaultProfile) throw new ManagedHostError('PROFILE_UNAVAILABLE');
      const nextSettings = {
        ...latest.settings,
        modelRouting: {
          ...latest.settings.modelRouting,
          ...(role === 'default' ? {} : { [role]: selected.id }),
        },
      };
      const nextModels = new CliModelBindings(nextSettings, defaultProfile);
      if (!nextModels.hasRole(role)) throw new ManagedHostError('PROFILE_UNAVAILABLE');
      // 所有目标先完成校验；未配置的角色明确回到本次 default，不能留住旧凭证绑定。
      for (const route of ROUTABLE_MODEL_ROLES)
        if (nextSettings.modelRouting?.[route] && !nextModels.hasRole(route))
          throw new ManagedHostError('PROFILE_UNAVAILABLE');
      current.switchModel(
        nextModels.defaultBinding.profile,
        'default',
        nextModels.defaultBinding.provider,
      );
      for (const route of ROUTABLE_MODEL_ROLES)
        if (!nextModels.hasRole(route))
          current.switchModel(
            nextModels.defaultBinding.profile,
            route,
            nextModels.defaultBinding.provider,
          );
      nextModels.attach(current, role);
      if (configuration.mode !== undefined) current.switchMode(configuration.mode);
      // 旧值在会话生存期保留，仅供公共输出打码；不把旧凭证带回模型配置。
      for (const secret of credentialsFromSettings(nextSettings))
        if (!credentials.includes(secret)) credentials.push(secret);
      Object.assign(settings, nextSettings);
      models = nextModels;
      selectedDefaultId = defaultId;
      selectedProfileId = selected.id;
      selectedRole = role;
      inspectionChanged();
    };
    // 独立记录运行时与会话的清理状态；全部成功后才释放存储锁，失败重试补做未完成步骤。
    let runtimeClosed = false;
    let sessionDestroyed = false;
    let handleReleased = false;
    let disposal: Promise<void> | undefined;
    const dispose = (): Promise<void> => {
      if (disposal) return disposal;
      closing = true;
      disposal = (async () => {
        activeController?.abort();
        const failures: unknown[] = [];
        try {
          await cancelChildren();
        } catch (error) {
          failures.push(error);
        }
        await activeDone;
        if (!runtimeClosed) {
          try {
            await ownedRuntime.close();
            runtimeClosed = true;
          } catch (error) {
            failures.push(error);
          }
        }
        if (!sessionDestroyed) {
          try {
            await current.destroy();
            sessionDestroyed = true;
          } catch (error) {
            failures.push(error);
          }
        }
        if (runtimeClosed && sessionDestroyed && !handleReleased) {
          try {
            await ownedHandle.release();
            handleReleased = true;
          } catch (error) {
            failures.push(error);
          }
        }
        if (handleReleased) {
          disposed = true;
          tasks.close();
          stopInspectionEvents();
          inspectionListeners.clear();
          presentation.close();
        }
        if (failures.length) throw new ManagedHostError('SESSION_CLEANUP_FAILED', failures[0]);
      })().catch((error) => {
        disposal = undefined;
        throw error;
      });
      return disposal;
    };
    const cancelChildren = async () => {
      await Promise.all(
        ownedRuntime
          .listTasks({ status: 'active' })
          .map((task) => ownedRuntime.cancelTask(task.agentId, 'Host cancelled')),
      );
    };
    const run = async function* (
      input: string,
      signal?: AbortSignal,
      skillName?: string,
    ): AsyncGenerator<SessionEvent> {
      refresh();
      const controller = new AbortController();
      activeController = controller;
      let complete!: () => void;
      activeDone = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const combinedSignal = signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal;
      const projected = new SessionPresentation(
        presentation,
        randomUUID(),
        () => current.getHistory(),
        redact,
      );
      activeProjection = projected;
      runUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      hasUsage = false;
      usageComplete = true;
      awaitingUsage = false;
      let failure: unknown;
      try {
        const stream = async function* (): AsyncGenerator<SessionEvent> {
          if (mountMcp) {
            const mount = mountMcp;
            await mount(combinedSignal);
            mountMcp = undefined;
          }
          const textRedactor = new StreamingRedactor(credentials);
          const thinkingRedactor = new StreamingRedactor(credentials);
          for await (const event of skillName
            ? current.runSkill(skillName, input, { signal: combinedSignal })
            : current.run(input, { signal: combinedSignal })) {
            if (event.type === 'text_delta')
              yield { ...event, text: textRedactor.push(event.text) };
            else if (event.type === 'thinking_delta')
              yield { ...event, thinking: thinkingRedactor.push(event.thinking) };
            else {
              const text = textRedactor.flush();
              const thinking = thinkingRedactor.flush();
              if (text) yield { type: 'text_delta' as const, text };
              if (thinking) yield { type: 'thinking_delta' as const, thinking };
              yield event;
            }
          }
          const text = textRedactor.flush();
          const thinking = thinkingRedactor.flush();
          if (text) yield { type: 'text_delta' as const, text };
          if (thinking) yield { type: 'thinking_delta' as const, thinking };
        };
        for await (const event of stream()) {
          if (event.type === 'turn_start') awaitingUsage = true;
          if (event.type === 'error') usageComplete = false;
          if (event.type === 'turn_finish') {
            awaitingUsage = false;
            if (!event.usage) usageComplete = false;
            else {
              hasUsage = true;
              runUsage = {
                promptTokens: runUsage.promptTokens + event.usage.promptTokens,
                completionTokens: runUsage.completionTokens + event.usage.completionTokens,
                totalTokens: runUsage.totalTokens + event.usage.totalTokens,
              };
            }
          }
          projected.consume(event);
          yield event;
        }
      } catch (error) {
        failure = error;
        throw error;
      } finally {
        // 提前结束迭代也会等待 Core 的 return/finally，随后才宣告展示空闲。
        try {
          if (!current.isBusy())
            projected.settle(combinedSignal.aborted ? 'aborted' : undefined, failure);
        } finally {
          activeProjection = undefined;
          activeController = undefined;
          complete();
          activeDone = undefined;
        }
      }
    };
    const managed: ManagedHostSession = {
      conversationId: ownedHandle.conversationId,
      session: current,
      async run(input, signal) {
        for await (const _ of run(input, signal)) {
          /* 投影已在内部完成。 */
        }
      },
      async runSkill(skillName, task, signal) {
        for await (const _ of run(task, signal, skillName)) {
          /* 投影已在内部完成。 */
        }
      },
      async cancel() {
        activeProjection?.cancelling();
        activeController?.abort();
        let failure: unknown;
        try {
          await cancelChildren();
        } catch (error) {
          failure = error;
        }
        await activeDone;
        if (failure || current.isBusy())
          throw new ManagedHostError('SESSION_CLEANUP_FAILED', failure);
      },
      dispose,
      isBusy: () => Boolean(activeController) || current.isBusy() || closing,
      configure: refresh,
      // 标题与置顶都是全局控制记录：走已打开的 Store 追加，既不必重新取锁，
      // 也不会打断在途运行；运行中的会话同样允许改名与置顶。
      async rename(title) {
        if (disposed || closing) throw new ManagedHostError('SESSION_CLOSED');
        const value = title.trim();
        if (!value) throw new ManagedHostError('SESSION_TITLE_REQUIRED');
        await ownedHandle.store.appendRecord('title', { title: sanitizeSessionTitle(value) });
      },
      async setPinned(pinned) {
        if (disposed || closing) throw new ManagedHostError('SESSION_CLOSED');
        await ownedHandle.store.setPinnedState(pinned);
      },
      configuration: () => ({
        profileId: selectedProfileId,
        role: selectedRole,
        mode: current.getMode(),
      }),
      snapshot: () => redactPresentationState(presentation.snapshot(), redact),
      subscribeEvents: (listener) => presentation.subscribeEvents(listener),
      inspection: () =>
        projectInspection(
          {
            status: managed.status(),
            branchDrift: ownedHandle.branchDrift,
            skills: current.getSkills(),
            skillsEnabled: settings.skills?.enabled !== false,
            mcpEnabled: mcp.enabled,
            servers: [...mcp.servers].map(([name, entry]) => {
              const status = mcpPlugin?.manager.getAllStatuses().find((item) => item.name === name);
              return status
                ? {
                    ...status,
                    toolCount: mcpPlugin?.manager.getServerTools(name).length,
                    promptCount: mcpPlugin?.promptRegistry.getPromptsByServer(name).length,
                  }
                : {
                    name,
                    connectionState: entry.config.enabled === false ? 'disabled' : 'deferred',
                    toolsState: 'pending' as const,
                    promptsState: 'pending' as const,
                  };
            }),
            mcpDiagnostics: mcp.diagnostics,
          },
          redact,
        ),
      subscribeInspection: (listener) => {
        inspectionListeners.add(listener);
        return () => {
          inspectionListeners.delete(listener);
        };
      },
      status: () =>
        projectStatusFacts(
          {
            phase:
              closing || (!activeController && current.isBusy())
                ? 'settling'
                : (presentation.snapshot().operation?.phase ?? 'idle'),
            model: current.getActiveProfile().name,
            permissionMode: current.getMode(),
            gitBranch: manager.project.gitBranch,
            contextUsage: current.getStats().contextUsage,
            runUsage: hasUsage && usageComplete && !awaitingUsage ? runUsage : undefined,
            tasks: tasks.snapshot(),
          },
          redact,
        ),
    };
    return {
      managed,
      conversationId: ownedHandle.conversationId,
      history: () => publicHistory(current.getHistory(), redact),
      redact,
      isBusy: managed.isBusy,
      cancelChildren,
      run,
      dispose,
    };
  } catch (error) {
    // 创建失败时也按依赖顺序清理；上游未清理完不能释放存储锁，原始错误优先上报。
    try {
      await runtime?.close();
      await session?.destroy();
      await handle?.release();
    } catch {
      /* 保留未完成清理的句柄及单写者锁，不允许其它会话重叠写入。 */
    }
    throw error;
  }
}
