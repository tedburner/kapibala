import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentRuntime,
  AgentSession,
  type ApprovalChannel,
  type CanonicalMessage,
  type ManagedSession,
  type PreparedTaskResult,
  type PrimaryModelRole,
  type SessionEvent,
  SessionManager,
  type SessionMode,
  SessionReferenceReader,
  WatchInbox,
  type WorkspaceLeaseCoordinator,
  isSessionMode,
  sanitizeSessionTitle,
} from '@kiturone/kapibala';
import { type McpPluginInstance, createMcpPlugin } from '@kiturone/kapibala-mcp';
import { toWireErrorCode } from '../protocol/index.js';
import type { JsonValue } from '../protocol/index.js';
import { listDelegationSessions, readDelegationRequestEntries } from './delegations.js';
import { buildSessionEvidence } from './evidence.js';
import { resolveCliMcpOptions } from './mcp.js';
import { CliModelBindings, ROUTABLE_MODEL_ROLES } from './model-bindings.js';
import { StreamingRedactor, redactText } from './redaction.js';
import { McpServerApprovalStore, createApprovedStartAuthorizer } from './resource/mcp-approval.js';
import {
  BUILTIN_PROFILES,
  type UserSettings,
  isProjectTrusted,
  loadSettings,
  resolveApiKeyDetailed,
} from './settings.js';
import { getCliSkillOptions, hasProjectSkills } from './skills.js';
import { createCliSubagentResumer, createCliSubagentRunner } from './subagent-runner.js';
import { registerBuiltinTools } from './tool-registration.js';
import { formatToolDetail } from './ui/tool-presentation.js';

import type { PresentationEvent, PresentationState, ViewEvidence } from '../view-model/index.js';
import type { StatusFacts } from '../view-model/status.js';
import { buildTodoState, projectHistory } from './history-projection.js';
import { type ManagedInspection, projectInspection } from './inspection.js';
import { PresentationStore } from './presentation-store.js';
import { createArtifactPolicy } from './preview-policy.js';
import { redactPresentationState } from './public-projection.js';
import { type ReferenceSelection, readReferenceBlocks } from './reference-blocks.js';
import { SessionPresentation, presentationScope } from './session-presentation.js';
import { projectStatusFacts } from './status-facts.js';
import { TaskObservation } from './task-observation.js';
import { WatchService, type WatchView } from './watch/service.js';
import { createWatchTools } from './watch/tools.js';
/** 只在加载时用一次，避免把会话级记忆写回全局默认。 */
async function readPersistedMode(store: {
  loadState(): Promise<{ records: readonly { type: string; payload: Record<string, unknown> }[] }>;
}): Promise<SessionMode | undefined> {
  const state = await store.loadState();
  for (let index = state.records.length - 1; index >= 0; index--) {
    const record = state.records[index];
    // 最后一次写入生效；未知值忽略，退回全局默认而不是猜一个档位。
    if (record.type === 'mode_state' && isSessionMode(record.payload.mode))
      return record.payload.mode;
  }
  return undefined;
}

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
  /**
   * 监视终态回调：桌面等宿主用它发系统通知或状态增量。
   * 通知正文已由 `WatchInbox` 落盘，这里的载荷只含展示所需事实，不含文件内容。
   */
  onWatchEvent?(notification: import('@kiturone/kapibala').WatchNotification): void;
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
  run(
    input: string,
    signal?: AbortSignal,
    options?: { readonly regenerate?: boolean },
  ): Promise<void>;
  /**
   * 显式技能直发：与 run 共用同一投影、审批与工具事务管线，事件流语义一致。
   * task 为空或技能名非法时由底层 Session 以 SKILL_INVALID_INPUT 拒绝。
   */
  runSkill(skillName: string, task: string, signal?: AbortSignal): Promise<void>;
  /**
   * 带跨会话引用的运行：在运行锁内读取并冻结引用快照，装配成消息级溯源块。
   *
   * 边界：
   * - 调用方只传身份（`ReferenceSelection`），正文一律由宿主读取，不接受外部上传正文；
   * - 任一条引用读取失败、跨桶、已归档或合计超预算时抛稳定错误码并零追加；
   * - 引用块与普通正文共享同一条任务预算预检，不额外熔断。
   */
  runWithReferences(
    input: string,
    references: readonly ReferenceSelection[],
    signal?: AbortSignal,
  ): Promise<void>;
  /** 中止当前父子任务并等待清理；不因退订展示而自动触发。 */
  cancel(): Promise<void>;
  /** 清理失败保留写锁，可重试；成功后禁止再运行或配置。 */
  dispose(): Promise<void>;
  /** 清理中的句柄仍忙碌，只有终态且清理结束才能复用。 */
  isBusy(): boolean;
  /** 只更新空闲会话，保持全局设置不变；失效 Profile 明确拒绝。 */
  configure(configuration: ManagedSessionConfiguration): Promise<void>;
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
  /**
   * 会话看板只读聚合：变更行数 / 引用 / MCP / 委派四分区。
   * 从当前 canonical 历史实时重算，不落新记录；委派列表需要读取项目桶元数据，因此为异步。
   */
  evidence(): Promise<ViewEvidence>;
  /** 当前会话的监视视图（只读）；缺省没有监视时返回空数组。 */
  watches(): WatchView[];
  /** 取消一条仍在监视中的条目；终态条目明确拒绝而不是静默成功。 */
  cancelWatch(watchId: string): Promise<void>;
  /** 监视状态变化订阅；用于刷新徽标，退订不影响触发源。 */
  subscribeWatches(listener: () => void): () => void;
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
    // 受管结果根目录：删除会话时联动清理对应结果子树。
    toolResultsDirectory: path.join(homeDirectory, '.kapibala', 'tool-results'),
  });
  let handle: ManagedSession | undefined;
  let session: AgentSession | undefined;
  let runtime: AgentRuntime | undefined;
  // 监视服务先于装配完成进入 liveServices；创建失败时也要停掉它，避免泄漏进全局并发统计。
  let watches: WatchService | undefined;
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
    // 会话级记忆优先：同一会话重开后沿用上次显式切换的档位；
    // 没有记录时退回全局默认，且全局默认不允许是 FullAccess（配置不能默认提权）。
    const persistedMode = await readPersistedMode(handle.store);
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
      // 续聊与首次派发共享同一租约、审批与模型装配，避免独立入口绕过父宿主权限。
      resumer: createCliSubagentResumer({
        homeDirectory,
        manager,
        models,
        settings,
        preference,
        isTrusted: trusted,
        approvalChannel: approval,
        leaseCoordinator: leases,
      }),
      // 进程重启后从委派头重建幂等索引，同一 requestId 不重复派发。
      restoredRequests: readDelegationRequestEntries(manager),
      validateModelOverride: (id) => settings.profiles.some((item) => item.id === id),
      outboxPath: path.join(root, '.kapibala/outbox.jsonl'),
    });
    session = new AgentSession({
      userInstructionsPath: path.join(homeDirectory, '.kapibala/AGENTS.md'),
      loggingDirectory: path.join(homeDirectory, '.kapibala'),
      auditRecoveryDirectory: path.join(homeDirectory, '.kapibala/audit'),
      toolResultsDirectory: path.join(homeDirectory, '.kapibala', 'tool-results'),
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
        persistedMode ??
        (settings.permissionMode === 'FullAccess'
          ? 'Approval'
          : (settings.permissionMode ?? 'Approval')),
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
      const mcpApprovals = new McpServerApprovalStore({
        homeDir: homeDirectory,
        projectRoot: root,
      });
      mountMcp = async (runSignal) => {
        mcpPlugin = createMcpPlugin(servers, {
          authorizer: createApprovedStartAuthorizer({
            store: mcpApprovals,
            entries: new Map(
              [...mcp.servers].map(([name, entry]) => [
                name,
                { source: entry.source, config: entry.config },
              ]),
            ),
            fallback: async (descriptor, signal) => {
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
          }),
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
    // 引用读取器与会话同源（同一 home 下的 sessions 目录）；无状态、可跨运行复用。
    const referenceReader = new SessionReferenceReader({ homeDirectory });
    const identity = {
      conversationId: handle.conversationId,
      branchId: handle.store.getActiveBranchId(),
      viewEpoch: 1,
    };
    // 产物识别绑定本次会话的工作区与主目录：允许根与 `~/.kapibala` 排除都在这里固定，
    // 投影层只拿到纯函数，不接触全局状态或当前进程目录。
    const artifactPolicy = createArtifactPolicy({ workspaceRoot: root, homeDirectory });
    const presentation = new PresentationStore(
      identity,
      projectHistory(current.getHistory(), presentationScope(identity), redact, {
        artifacts: artifactPolicy,
        usageByMessageId: current.getMessageUsages(),
      }),
      buildTodoState(current.getHistory(), redact),
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
          watches?.dispose();
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
      prepare?: () => Promise<PreparedTaskResult>,
      /** 重试：先截断上一轮再按同一输入重跑；截断失败直接抛出，不产生任何 Core append。 */
      regenerate?: boolean,
    ): AsyncGenerator<SessionEvent> {
      refresh();
      let replaceHistory = false;
      if (regenerate) {
        const { branchId } = await current.rewindLastTurn();
        // 任务来源分支随活动分支切换；复用同一观察器，避免丢失已见过的投递事件。
        tasks.refresh({
          parentSessionId: ownedHandle.conversationId,
          branchId,
        });
        replaceHistory = true;
      }
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
        artifactPolicy,
        {
          getUsage: () => current.getMessageUsages(),
          ...(replaceHistory ? { replaceHistory: true } : {}),
        },
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
          // 引用经 runPreparedTask 在运行锁内读取与校验，准备失败时 Core 零 append。
          const source: AsyncIterable<SessionEvent> = prepare
            ? current.runPreparedTask(input, prepare, { signal: combinedSignal })
            : skillName
              ? current.runSkill(skillName, input, { signal: combinedSignal })
              : current.run(input, { signal: combinedSignal });
          for await (const event of source) {
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
    // 监视服务与运行共用同一空闲门：只有本会话没有在途运行时才投递并自动续跑，
    // 背景通知经 WatchInbox 落回登记分支，绝不与用户输入抢写。
    const watchInbox = new WatchInbox(ownedHandle.store);
    const watchService = new WatchService({
      workspaceRoot: root,
      store: ownedHandle.store,
      deliver: (notification, branchId) => watchInbox.consume(notification, branchId),
      isIdle: () => !activeController && !current.isBusy() && !closing && !disposed,
      resume: async (input, signal) => {
        for await (const _ of run(input, signal)) {
          /* 投影已在内部完成。 */
        }
      },
      onChange: inspectionChanged,
      ...(options.onWatchEvent ? { onNotify: options.onWatchEvent } : {}),
    });
    watches = watchService;
    for (const tool of createWatchTools(watchService)) current.tools.register(tool);
    // 等待持久化监视恢复完成再返回资源句柄，避免快速 dispose 与后台回读会话文件竞态。
    await watchService.start().catch((error: unknown) => {
      console.warn('[watch] failed to restore watch states for this session', error);
    });
    const managed: ManagedHostSession = {
      conversationId: ownedHandle.conversationId,
      session: current,
      async run(input, signal, options) {
        for await (const _ of run(input, signal, undefined, undefined, options?.regenerate)) {
          /* 投影已在内部完成。 */
        }
      },
      async runSkill(skillName, task, signal) {
        for await (const _ of run(task, signal, skillName)) {
          /* 投影已在内部完成。 */
        }
      },
      async runWithReferences(input, references, signal) {
        if (references.length === 0) {
          for await (const _ of run(input, signal)) {
            /* 无引用时与 run 完全同路径。 */
          }
          return;
        }
        // 冻结发生在这里：prepare 在运行锁内读取，失败或超预算时 Core 零 append。
        const prepare = async (): Promise<PreparedTaskResult> => ({
          content: await readReferenceBlocks(referenceReader, root, references, { redact }),
        });
        for await (const _ of run(input, signal, undefined, prepare)) {
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
      configure: (configuration) => {
        // 同步部分保持原语义：忙碌/信任校验直接抛出，不等一次磁盘写入。
        refresh(configuration);
        // v1 只读历史无法落盘，切换仅在本进程内生效；其余会话追加控制记录供下次打开恢复。
        return configuration.mode === undefined || ownedHandle.store.isReadOnly()
          ? Promise.resolve()
          : ownedHandle.store.setModeState(configuration.mode).then(() => undefined);
      },
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
      // 证据面板是只读聚合：每次按当前 canonical 历史重算，不缓存也不落新记录，
      // 因此历史重放与实时观察必然同一口径。
      evidence: async () => {
        const phase = presentation.snapshot().operation?.phase;
        return buildSessionEvidence(
          {
            conversationId: ownedHandle.conversationId,
            history: current.getHistory(),
            delegations: await listDelegationSessions(manager),
            tasks: runtime?.listTasks({ parentSessionId: ownedHandle.conversationId }) ?? [],
            parentActive: phase === 'running' || phase === 'cancelling',
          },
          redact,
        );
      },
      watches: () => watchService.list(),
      cancelWatch: (watchId) => watchService.cancel(watchId),
      subscribeWatches: (listener) => {
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
      // 本地 wire 适配器只读证据面；复用 managed 的同一聚合，避免两套口径。
      evidence: () => managed.evidence(),
      redact,
      isBusy: managed.isBusy,
      cancelChildren,
      run,
      dispose,
      watches: { list: () => managed.watches(), cancel: (id: string) => managed.cancelWatch(id) },
    };
  } catch (error) {
    // 创建失败时也按依赖顺序清理；上游未清理完不能释放存储锁，原始错误优先上报。
    try {
      watches?.dispose();
      await runtime?.close();
      await session?.destroy();
      await handle?.release();
    } catch {
      /* 保留未完成清理的句柄及单写者锁，不允许其它会话重叠写入。 */
    }
    throw error;
  }
}
