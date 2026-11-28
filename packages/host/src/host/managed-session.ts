import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AgentRuntime,
  AgentSession,
  type ApprovalChannel,
  type CanonicalMessage,
  type CreateBranchWithSummaryOptions,
  KapibalaError,
  type ManagedSession,
  type PreparedTaskResult,
  type PrimaryModelRole,
  SessionBusyError,
  type SessionEvent,
  SessionManager,
  type SessionMode,
  SessionReferenceReader,
  type SessionWorktreeBinding,
  WatchInbox,
  type WorkspaceLeaseCoordinator,
  isSessionMode,
  sanitizeSessionTitle,
} from '@kiturone/kapibala';
import { type McpPluginInstance, createMcpPlugin } from '@kiturone/kapibala-mcp';
import { toWireErrorCode } from '../protocol/index.js';
import type { JsonValue } from '../protocol/index.js';
import {
  type CapturePreTurnResult,
  CheckpointError,
  type CheckpointService,
  type RestoreCheckpointResult,
} from './checkpoint/index.js';
import { listDelegationSessions, readDelegationRequestEntries } from './delegations.js';
import { buildSessionEvidence } from './evidence.js';
import { resolveCliMcpOptions } from './mcp.js';
import { CliModelBindings, ROUTABLE_MODEL_ROLES } from './model-bindings.js';
import { StreamingRedactor, redactText, sanitizeDisplayText } from './redaction.js';
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

import type {
  PresentationEvent,
  PresentationState,
  ViewCheckpointItem,
  ViewDiffSummary,
  ViewEvidence,
  ViewFileDiff,
  ViewTurnMeta,
  ViewWorktreeSummary,
} from '../view-model/index.js';
import type { StatusFacts } from '../view-model/status.js';
import { buildTodoState, projectHistory } from './history-projection.js';
import { type ManagedInspection, projectInspection } from './inspection.js';
import { PresentationStore } from './presentation-store.js';
import { createArtifactPolicy } from './preview-policy.js';
import { redactPresentationChange, redactPresentationState } from './public-projection.js';
import { type ReferenceSelection, readReferenceBlocks } from './reference-blocks.js';
import { SessionPresentation, presentationScope } from './session-presentation.js';
import { projectStatusFacts } from './status-facts.js';
import { SessionApprovalHub } from './subagent-approval.js';
import { TaskObservation } from './task-observation.js';
import { WatchService, type WatchView } from './watch/service.js';
import { createWatchTools } from './watch/tools.js';
import {
  type ExecutionRootCoordinator,
  type ExecutionRunHandle,
  WorktreeError,
  type WorktreeService,
  verifyManagedWorktreeLink,
} from './worktree/index.js';

const NON_DEFAULT_ROLE_LABELS: Readonly<Record<string, string>> = {
  planning: '规划',
  execution: '执行',
  fast: '快速',
};

function resolveLocalTurnMeta(
  modelId: string,
  modelRole: string | undefined,
  settings: Pick<UserSettings, 'profiles'>,
): ViewTurnMeta {
  const matched =
    settings.profiles.find((item) => item.id === modelId) ??
    BUILTIN_PROFILES.find((item) => item.id === modelId);
  const roleLabel =
    modelRole && modelRole !== 'default' ? NON_DEFAULT_ROLE_LABELS[modelRole] : undefined;
  return {
    modelLabel: matched?.name ?? modelId,
    ...(matched?.supportsThinking ? { effortLabel: '深度思考' } : {}),
    ...(roleLabel ? { modeLabel: roleLabel } : {}),
  };
}

/** 只在加载时用一次，避免把会话级记忆写回全局默认。 */
async function readPersistedSessionRecords(store: {
  loadState(): Promise<{ records: readonly { type: string; payload: Record<string, unknown> }[] }>;
}): Promise<{
  readonly persistedMode?: SessionMode;
  readonly turnRecords: readonly { interactionId: string; modelId: string; modelRole?: string }[];
}> {
  const state = await store.loadState();
  let persistedMode: SessionMode | undefined;
  for (let index = state.records.length - 1; index >= 0; index--) {
    const record = state.records[index];
    if (record.type === 'mode_state' && isSessionMode(record.payload.mode)) {
      persistedMode = record.payload.mode;
      break;
    }
  }
  const turnRecords: { interactionId: string; modelId: string; modelRole?: string }[] = [];
  for (const record of state.records) {
    if (record.type !== 'run_started') continue;
    const interactionId = String(record.payload.interactionId ?? record.payload.runId ?? '').trim();
    const modelId = typeof record.payload.modelId === 'string' ? record.payload.modelId.trim() : '';
    const modelRole =
      typeof record.payload.modelRole === 'string' ? record.payload.modelRole : undefined;
    if (interactionId && modelId) {
      turnRecords.push({ interactionId, modelId, ...(modelRole ? { modelRole } : {}) });
    }
  }
  return { ...(persistedMode ? { persistedMode } : {}), turnRecords };
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
  /** 项目归属物理根（决定会话存储桶、信任根与跨会话引用桶）；缺省同 `workspaceRoot`。 */
  projectRoot?: string;
  /** 新建会话绑定的受管 Git Worktree 元数据；打开既有会话时优先读取已持久化的 `header.worktree`。 */
  worktree?: SessionWorktreeBinding;
  /** 宿主级 Shadow Git 检查点服务；注入后在每轮对话首尾自动采样并支持 `regenerate` 原子还原文件。 */
  checkpoints?: CheckpointService;
  /** 宿主级受管 Git Worktree 服务；注入后解锁 `spawn_agent(isolation: 'worktree')` 与工作树回链验真。 */
  worktrees?: WorktreeService;
  /** 横跨本地与外部代理会话的物理执行根互斥与移除门闩协调器；缺省复用 `worktrees?.coordinator`。 */
  executionCoordinator?: ExecutionRootCoordinator;
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
  /** 宿主外层忙碌门（如桌面在途 RunReceipt 或本地协议 active run）；缺省仅检查会话自身。 */
  isHostIdle?(): boolean;
  /**
   * 宿主接管监视自动续跑：桌面与本地协议宿主借此把续跑纳入各自的运行收据、事件推送、
   * 审批路由与取消管线；缺省直接走受管会话内部的 `run(input, signal)`。
   */
  onAutoResume?(input: string, signal: AbortSignal): Promise<void>;
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
    options?: {
      readonly regenerate?: boolean;
      /** `regenerate: true` 时是否同步还原上一轮归因磁盘文件；冲突时在分支回退前以 `CHECKPOINT_RESTORE_CONFLICT` 中止。 */
      readonly restoreFiles?: boolean;
      /** `restoreFiles: true` 时是否强制覆盖事后手动修改冲突文件（仍先生成 `pre-restore` 快照）。 */
      readonly forceRestore?: boolean;
      /** 跨代理或跨会话接力上下文：以 `promptSource` 受控块注入请求，不在用户气泡平铺历史原文。 */
      readonly handoff?: { readonly fromTitle: string; readonly context: string };
      /** 可选覆盖本轮模型断流自动回滚重试开关（默认开启 `true`）。 */
      readonly allowMidStreamRetry?: boolean;
    },
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
  /**
   * 在当前活动分支或指定记录切点分叉并生成附带背景摘要的新分支，随后原子同步展示投影与监视/任务范围。
   *
   * 前置约束与失败边界：
   * - 仅允许在会话空闲时调用（在途运行或正在关闭时以 `SESSION_BUSY` / `SESSION_CLOSED` 拒绝）；
   * - 底层存储不支持分支或只读时以 `BRANCH_UNAVAILABLE` 拒绝，切点处于半事务时拒绝且不改动原分支。
   */
  createBranchWithSummary(
    branchId: string,
    options?: CreateBranchWithSummaryOptions,
  ): Promise<{ branchId: string; summary: string }>;
  /**
   * 从当前已打开父会话的内存运行时中摘除已删除委派子会话的请求幂等索引，
   * 防止用户手动清理子会话后同一 `requestId` 仍命中已不存在的会话文件。
   */
  forgetDelegation(sessionId: string): void;
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
  /** 返回当前会话已记录的轮次级检查点列表（未注入检查点服务或不可用时返回空数组）。 */
  checkpoints(): Promise<ViewCheckpointItem[]>;
  /** 查询当前会话单轮或跨轮归因聚合文件 Diff 明细。 */
  checkpointDiff(options?: {
    readonly ordinal?: number;
    readonly fromOrdinal?: number;
    readonly toOrdinal?: number;
    readonly includeLiveWorktree?: boolean;
  }): Promise<{
    readonly available: boolean;
    readonly files: readonly ViewFileDiff[];
    readonly additions: number;
    readonly deletions: number;
    readonly truncated: boolean;
  }>;
  /** 在会话空闲且无执行门闩时按归因路径回滚磁盘文件至 `targetOrdinal` 结束态。 */
  restoreCheckpoint(targetOrdinal: number, force?: boolean): Promise<RestoreCheckpointResult>;
  /** 返回当前会话绑定的受管 Git Worktree 只读摘要（运行于主工作区时为 `undefined`）。 */
  worktree(): ViewWorktreeSummary | undefined;
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
  if (
    !path.isAbsolute(options.workspaceRoot) ||
    !path.isAbsolute(options.homeDirectory) ||
    (options.projectRoot !== undefined && !path.isAbsolute(options.projectRoot))
  )
    throw new ManagedHostError('ABSOLUTE_PATH_REQUIRED');
  if (!options.leaseCoordinator) throw new ManagedHostError('LEASE_COORDINATOR_REQUIRED');
  const homeDirectory = fs.realpathSync.native(options.homeDirectory);
  if (!fs.statSync(homeDirectory).isDirectory()) throw new ManagedHostError('HOME_UNAVAILABLE');
  const workspaceRoot = options.workspaceRoot;
  const conversationId = options.conversationId;
  const approval = options.approvalChannel;
  const leases = options.leaseCoordinator;
  const checkpoints = options.checkpoints;
  const worktrees = options.worktrees;
  const coordinator = options.executionCoordinator ?? worktrees?.coordinator;
  const worktreesRoot =
    worktrees?.worktreesRoot ?? path.join(homeDirectory, '.kapibala', 'worktrees');
  const projectRoot = fs.realpathSync.native(options.projectRoot ?? workspaceRoot);
  if (!fs.statSync(projectRoot).isDirectory()) throw new ManagedHostError('WORKSPACE_UNAVAILABLE');
  const loaded = loadSettings({ cwd: projectRoot, homeDir: homeDirectory });
  const settings = options.initialProfileId
    ? { ...loaded.settings, defaultModel: options.initialProfileId }
    : loaded.settings;
  const trusted = isProjectTrusted(settings, projectRoot);
  if (
    loaded.pendingProject ||
    (!trusted &&
      (hasProjectSkills(projectRoot) ||
        fs.existsSync(path.join(projectRoot, '.kapibala/mcp.json'))))
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
  if (!conversationId && options.worktree) {
    if (!fs.existsSync(options.worktree.worktreePath)) {
      throw new ManagedHostError('WORKSPACE_UNAVAILABLE');
    }
    if (
      !verifyManagedWorktreeLink({
        worktreesRoot,
        projectRoot,
        worktreePath: options.worktree.worktreePath,
      })
    ) {
      throw new WorktreeError(
        'WORKTREE_LINK_INVALID',
        `Managed worktree link verification failed for '${options.worktree.worktreePath}'`,
      );
    }
  }
  // 会话历史与跨会话引用桶始终锚定在 `projectRoot`，避免受管工作树会话分裂成孤立空间。
  const manager = new SessionManager({
    workspaceRoot: projectRoot,
    homeDirectory,
    projectRootMode: 'exact',
    maxReadBytes: options.maxReadBytes,
    // 受管结果根目录：删除会话时联动清理对应结果子树。
    toolResultsDirectory: path.join(homeDirectory, '.kapibala', 'tool-results'),
  });
  let handle: ManagedSession | undefined;
  let session: AgentSession | undefined;
  let runtime: AgentRuntime | undefined;
  const approvalHub = new SessionApprovalHub(approval);
  const rootApproval = approvalHub.createRootChannel();
  // 监视服务先于装配完成进入 liveServices；创建失败时也要停掉它，避免泄漏进全局并发统计。
  let watches: WatchService | undefined;
  try {
    try {
      handle = conversationId
        ? await manager.open(conversationId, { autoUpgradeLegacy: true })
        : await manager.create(options.worktree ? { worktree: options.worktree } : undefined);
    } catch (error) {
      const code = toWireErrorCode(error);
      if (code === 'SESSION_BUSY' || code === 'SESSION_NOT_FOUND')
        throw new ManagedHostError(code, error);
      throw error;
    }
    const sessionWorktree: SessionWorktreeBinding | undefined =
      handle.header.worktree ?? options.worktree;
    let executionRoot: string;
    if (sessionWorktree) {
      if (fs.existsSync(sessionWorktree.worktreePath)) {
        if (
          !verifyManagedWorktreeLink({
            worktreesRoot,
            projectRoot,
            worktreePath: sessionWorktree.worktreePath,
          })
        ) {
          throw new WorktreeError(
            'WORKTREE_LINK_INVALID',
            `Managed worktree link verification failed for '${sessionWorktree.worktreePath}'`,
          );
        }
        executionRoot = fs.realpathSync.native(sessionWorktree.worktreePath);
      } else if (!conversationId) {
        throw new ManagedHostError('WORKSPACE_UNAVAILABLE');
      } else {
        // 既有会话绑定的受管工作树已被移除时安全回退至 projectRoot，保持历史只读查看与清理可用。
        executionRoot = projectRoot;
      }
    } else {
      executionRoot = fs.realpathSync.native(workspaceRoot);
      if (!fs.statSync(executionRoot).isDirectory())
        throw new ManagedHostError('WORKSPACE_UNAVAILABLE');
    }
    const root = executionRoot;
    const viewWorktree: ViewWorktreeSummary | undefined = sessionWorktree
      ? {
          id: sessionWorktree.id,
          projectRoot: sessionWorktree.projectRoot,
          worktreePath: sessionWorktree.worktreePath,
          branch: sessionWorktree.branch,
          baseRef: sessionWorktree.baseRef,
          baseCommit: sessionWorktree.baseCommit,
          createdAt: sessionWorktree.createdAt,
        }
      : undefined;
    const preference = settings.shell?.preference ?? 'auto';
    // 会话级记忆优先：同一会话重开后沿用上次显式切换的档位；
    // 同时从历史 `run_started` 记录恢复每一轮实际使用的模型与角色，不被后续切换覆盖。
    const { persistedMode, turnRecords } = await readPersistedSessionRecords(handle.store);
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
          approvalHub,
          runtime,
          leaseCoordinator: leases,
          ...(coordinator ? { executionCoordinator: coordinator } : {}),
        })(...args),
      // 续聊与首次派发共享同一租约、审批中枢与模型装配，避免独立入口绕过父宿主权限。
      resumer: (...args) =>
        createCliSubagentResumer({
          homeDirectory,
          manager,
          models,
          settings,
          preference,
          isTrusted: trusted,
          approvalChannel: approval,
          approvalHub,
          runtime,
          leaseCoordinator: leases,
          ...(coordinator ? { executionCoordinator: coordinator } : {}),
        })(...args),
      ...(worktrees ? { worktreeProvider: worktrees.asSubagentWorktreeProvider() } : {}),
      // 进程重启后从委派头重建幂等索引，同一 requestId 不重复派发。
      restoredRequests: readDelegationRequestEntries(manager),
      validateModelOverride: (id) => settings.profiles.some((item) => item.id === id),
      outboxPath: path.join(projectRoot, '.kapibala/outbox.jsonl'),
    });
    session = new AgentSession({
      userInstructionsPath: path.join(homeDirectory, '.kapibala/AGENTS.md'),
      loggingDirectory: path.join(homeDirectory, '.kapibala'),
      auditRecoveryDirectory: path.join(homeDirectory, '.kapibala/audit'),
      toolResultsDirectory: path.join(homeDirectory, '.kapibala', 'tool-results'),
      workspaceRoot: root,
      executionCwd: root,
      projectRoot,
      store: handle.store,
      conversationId: handle.conversationId,
      defaultProfile: models.defaultBinding.profile,
      defaultProvider: models.defaultBinding.provider,
      approvalChannel: rootApproval,
      leaseCoordinator: leases,
      permissionRules: settings.permissionRules,
      retry: { maxRetries: 2, allowMidStreamRetry: true },
      mode:
        persistedMode ??
        (settings.permissionMode === 'FullAccess'
          ? 'Approval'
          : (settings.permissionMode ?? 'Approval')),
      skills: getCliSkillOptions(settings, {
        cwd: root,
        projectRoot,
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
      projectRoot,
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
        projectRoot,
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
              const choice = await rootApproval.requestApproval(
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
    const turnMetaByInteraction = new Map<string, ViewTurnMeta>();
    for (const entry of turnRecords) {
      turnMetaByInteraction.set(
        entry.interactionId,
        resolveLocalTurnMeta(entry.modelId, entry.modelRole, settings),
      );
    }
    const computeSessionDiffSummary = async (): Promise<ViewDiffSummary | undefined> => {
      if (!checkpoints) return undefined;
      try {
        const records = await checkpoints.listCheckpoints({
          projectRoot,
          executionRoot: root,
          sessionId: ownedHandle.conversationId,
        });
        if (records.length === 0) return undefined;
        const totalChanged = records.reduce((sum, item) => sum + item.changedFiles.length, 0);
        if (totalChanged === 0) return undefined;
        if (records.length === 1) {
          return { additions: records[0]!.additions, deletions: records[0]!.deletions };
        }
        const diffRes = await checkpoints.diff({
          projectRoot,
          executionRoot: root,
          sessionId: ownedHandle.conversationId,
        });
        if (!diffRes.available || diffRes.files.length === 0) return undefined;
        return { additions: diffRes.additions, deletions: diffRes.deletions };
      } catch {
        return undefined;
      }
    };
    const initialDiffSummary = conversationId ? await computeSessionDiffSummary() : undefined;
    const presentation = new PresentationStore(
      identity,
      projectHistory(current.getHistory(), presentationScope(identity), redact, {
        artifacts: artifactPolicy,
        usageByMessageId: current.getMessageUsages(),
        turnMetaByInteraction,
      }),
      buildTodoState(current.getHistory(), redact),
      {
        ...(viewWorktree ? { worktree: viewWorktree } : {}),
        ...(initialDiffSummary ? { diffSummary: initialDiffSummary } : {}),
      },
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
      const latest = loadSettings({ cwd: projectRoot, homeDir: homeDirectory });
      if (
        latest.pendingProject ||
        (!isProjectTrusted(latest.settings, projectRoot) &&
          (hasProjectSkills(projectRoot) ||
            fs.existsSync(path.join(projectRoot, '.kapibala/mcp.json'))))
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
        approvalHub.dispose();
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
    const syncExternalPresentation = () => {
      const snap = presentation.snapshot();
      if (snap.operation && snap.operation.phase !== 'idle') return;
      const activeBranch = ownedHandle.store.getActiveBranchId();
      if (snap.identity.branchId !== activeBranch) return;
      const scope = presentationScope(snap.identity);
      const knownIds = new Set(snap.messages.map((item) => item.id));
      const projected = projectHistory(current.getHistory(), scope, redact, {
        artifacts: artifactPolicy,
        usageByMessageId: current.getMessageUsages(),
        turnMetaByInteraction,
      });
      for (const message of projected) {
        if (knownIds.has(message.id)) continue;
        presentation.dispatch({
          ...snap.identity,
          sequence: presentation.snapshot().sequence + 1,
          change: { type: 'message_committed', message },
        });
      }
    };
    const emitDiffSummary = (diffSummary: ViewDiffSummary | undefined): void => {
      presentation.dispatch({
        ...presentation.snapshot().identity,
        sequence: presentation.snapshot().sequence + 1,
        change: { type: 'diff_summary_changed', diffSummary },
      });
    };
    const run = async function* (
      input: string,
      signal?: AbortSignal,
      skillName?: string,
      prepare?: () => Promise<PreparedTaskResult>,
      runOptions?: {
        /** 重试：先预检绑定、MCP 与可选文件冲突回滚，再截断上一轮并无损重跑。 */
        readonly regenerate?: boolean;
        readonly restoreFiles?: boolean;
        readonly forceRestore?: boolean;
        readonly allowMidStreamRetry?: boolean;
      },
    ): AsyncGenerator<SessionEvent> {
      const regenerate = runOptions?.regenerate;
      refresh();
      (
        current as AgentSession & {
          setRetryOptions?: (retry?: {
            maxRetries?: number;
            allowMidStreamRetry?: boolean;
          }) => void;
        }
      ).setRetryOptions?.({
        maxRetries: 2,
        allowMidStreamRetry: runOptions?.allowMidStreamRetry ?? true,
      });
      current.validatePrimaryBinding(selectedRole);
      coordinator?.assertNotFenced(root);
      const controller = new AbortController();
      activeController = controller;
      let complete!: () => void;
      activeDone = new Promise<void>((resolve) => {
        complete = resolve;
      });
      const combinedSignal = signal
        ? AbortSignal.any([controller.signal, signal])
        : controller.signal;
      let execRunHandle: ExecutionRunHandle | undefined;
      let projected: SessionPresentation | undefined;
      let rewoundState:
        | {
            branchId: string;
            previousBranchId: string;
            historyLengthAfterRewind: number;
          }
        | undefined;
      let effectiveInput = input;
      let effectiveSkillName = skillName;
      let effectivePrepare = prepare;
      let replaceHistory = false;
      let nextBranchId: string | undefined;
      let turnOrdinal = 0;
      let preTurnPromise: Promise<CapturePreTurnResult | undefined> | undefined;
      let preTurnResult: CapturePreTurnResult | undefined;
      let preTurnResolved = false;
      runUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      hasUsage = false;
      usageComplete = true;
      awaitingUsage = false;
      let failure: unknown;
      try {
        if (coordinator) {
          execRunHandle = await coordinator.acquireMutatingLease({
            executionRoot: root,
            ownerId: ownedHandle.conversationId,
            kind: 'native',
            signal: combinedSignal,
          });
        }
        if (regenerate && mountMcp) {
          const mount = mountMcp;
          await mount(combinedSignal);
          mountMcp = undefined;
        }
        if (regenerate) {
          // 强原子性保证：按会话回退前的用户轮次定位待撤销轮次序号（rewoundOrdinal = userTurnCountBeforeRewind - 1），
          // 仅当检查点实际覆盖了该轮（ordinal >= rewoundOrdinal）时才回滚至 rewoundOrdinal - 1，防止某轮因超时跳过检查点后误删前序轮次成果。
          if (runOptions?.restoreFiles && checkpoints) {
            const userTurnCountBeforeRewind = current
              .getHistory()
              .filter((m) => m.role === 'user').length;
            const rewoundOrdinal = userTurnCountBeforeRewind - 1;
            if (rewoundOrdinal >= 0) {
              const existingTurns = await checkpoints.listCheckpoints({
                projectRoot,
                executionRoot: root,
                sessionId: ownedHandle.conversationId,
              });
              if (existingTurns.some((t) => t.ordinal >= rewoundOrdinal)) {
                const restoreRes = await checkpoints.restore({
                  projectRoot,
                  executionRoot: root,
                  sessionId: ownedHandle.conversationId,
                  targetOrdinal: rewoundOrdinal - 1,
                  force: runOptions.forceRestore === true,
                  signal: combinedSignal,
                });
                if (restoreRes.status === 'conflict') {
                  const conflictErr = new KapibalaError(
                    `Checkpoint restore conflict on files: ${restoreRes.conflicts.join(', ')}`,
                    {
                      code: 'CHECKPOINT_RESTORE_CONFLICT',
                      retryPolicy: 'after_user_action',
                      safeMessage: `文件存在手动修改冲突，已中止回退：${restoreRes.conflicts.join(', ')}`,
                    },
                  );
                  (conflictErr as KapibalaError & { conflicts?: readonly string[] }).conflicts =
                    restoreRes.conflicts;
                  throw conflictErr;
                }
              }
            }
          }
          const rewound = await current.rewindLastTurn();
          rewoundState = {
            branchId: rewound.branchId,
            previousBranchId: rewound.previousBranchId,
            historyLengthAfterRewind: current.getHistory().length,
          };
          await watches?.onBranchRewound(
            rewound.previousBranchId,
            rewound.branchId,
            rewound.rewoundAt,
          );
          // 任务来源分支随活动分支切换；复用同一观察器，避免丢失已见过的投递事件。
          tasks.refresh({
            parentSessionId: ownedHandle.conversationId,
            branchId: rewound.branchId,
          });
          replaceHistory = true;
          nextBranchId = rewound.branchId;
          if (rewound.rewoundUserMessage) {
            const blocks = rewound.rewoundUserMessage.content;
            const primaryIndex = blocks.findIndex(
              (block) =>
                block.type === 'text' &&
                !block.skillSource &&
                !block.referenceSource &&
                !block.promptSource,
            );
            if (primaryIndex >= 0 && blocks[primaryIndex]?.type === 'text') {
              effectiveInput = blocks[primaryIndex].text;
            }
            const skillBlockIndex = blocks.findIndex(
              (block) => block.type === 'text' && block.skillSource !== undefined,
            );
            const candidateSkill =
              skillBlockIndex >= 0 && blocks[skillBlockIndex]?.type === 'text'
                ? blocks[skillBlockIndex].skillSource?.name
                : undefined;
            const skillAvailable =
              candidateSkill !== undefined &&
              current
                .getSkills()
                .skills.some(
                  (item) =>
                    item.name === candidateSkill &&
                    item.userInvocable &&
                    item.available &&
                    !item.disabled,
                );
            const extraBlocks = blocks.filter((_, index) => {
              if (index === primaryIndex) return false;
              if (index === skillBlockIndex && skillAvailable) return false;
              return true;
            });
            if (extraBlocks.length > 0) {
              const frozenBlocks = structuredClone(extraBlocks);
              effectivePrepare = async () => ({
                content: frozenBlocks,
                ...(skillAvailable && candidateSkill ? { skillName: candidateSkill } : {}),
              });
              effectiveSkillName = undefined;
            } else if (skillAvailable && candidateSkill) {
              effectiveSkillName = candidateSkill;
            }
          }
        }
        if (checkpoints) {
          const existingTurns = await checkpoints.listCheckpoints({
            projectRoot,
            executionRoot: root,
            sessionId: ownedHandle.conversationId,
          });
          const userTurnCount = current.getHistory().filter((m) => m.role === 'user').length;
          turnOrdinal = Math.max(
            userTurnCount,
            (existingTurns[existingTurns.length - 1]?.ordinal ?? -1) + 1,
          );
          preTurnPromise = checkpoints
            .capturePreTurn({
              projectRoot,
              executionRoot: root,
              sessionId: ownedHandle.conversationId,
              ordinal: turnOrdinal,
              signal: combinedSignal,
            })
            .catch(() => undefined);
        }
        const activeRunTurnMeta = resolveLocalTurnMeta(selectedProfileId, selectedRole, settings);
        const bindCurrentRunTurnMeta = (): void => {
          const hist = current.getHistory();
          for (let idx = hist.length - 1; idx >= Math.max(0, hist.length - 6); idx--) {
            const interactionId = hist[idx]?.interactionId;
            if (interactionId && !turnMetaByInteraction.has(interactionId)) {
              turnMetaByInteraction.set(interactionId, activeRunTurnMeta);
            }
          }
        };
        projected = new SessionPresentation(
          presentation,
          randomUUID(),
          () => current.getHistory(),
          redact,
          artifactPolicy,
          {
            getUsage: () => current.getMessageUsages(),
            getTurnMeta: () => {
              bindCurrentRunTurnMeta();
              return turnMetaByInteraction;
            },
            ...(replaceHistory ? { replaceHistory: true } : {}),
            ...(nextBranchId ? { nextBranchId } : {}),
          },
        );
        activeProjection = projected;
        const stream = async function* (): AsyncGenerator<SessionEvent> {
          if (mountMcp) {
            const mount = mountMcp;
            await mount(combinedSignal);
            mountMcp = undefined;
          }
          const textRedactor = new StreamingRedactor(credentials);
          const thinkingRedactor = new StreamingRedactor(credentials);
          // 引用经 runPreparedTask 在运行锁内读取与校验，准备失败时 Core 零 append。
          const source: AsyncIterable<SessionEvent> = effectivePrepare
            ? current.runPreparedTask(effectiveInput, effectivePrepare, { signal: combinedSignal })
            : effectiveSkillName
              ? current.runSkill(effectiveSkillName, effectiveInput, { signal: combinedSignal })
              : current.run(effectiveInput, { signal: combinedSignal });
          for await (const event of source) {
            // 在首个工具落地执行前确保并发前置检查点基线（含 5s 超时熔断预算）已完成就位。
            if (event.type === 'tool_start' && preTurnPromise && !preTurnResolved) {
              preTurnResult = await preTurnPromise;
              preTurnResolved = true;
            }
            if (event.type === 'text_delta')
              yield { ...event, text: textRedactor.push(event.text) };
            else if (event.type === 'thinking_delta')
              yield { ...event, thinking: thinkingRedactor.push(event.thinking) };
            else if (event.type === 'stream_reset') {
              // 半截流式输出将被丢弃：清空脱敏滑窗残留，不向下游补吐已作废的尾部碎片。
              textRedactor.flush();
              thinkingRedactor.flush();
              yield event;
            } else {
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
        if (
          rewoundState &&
          !current.isBusy() &&
          current.getHistory().length === rewoundState.historyLengthAfterRewind
        ) {
          try {
            await current.restoreBranch(rewoundState.previousBranchId);
            await watches?.onBranchRewound(rewoundState.branchId, rewoundState.previousBranchId);
            tasks.refresh({
              parentSessionId: ownedHandle.conversationId,
              branchId: rewoundState.previousBranchId,
            });
            projected?.revertBranchTransition();
          } catch {
            /* 回滚异常不覆盖原始运行错误。 */
          }
        }
        throw error;
      } finally {
        // 轮次终态（completed / failed / cancelled）统一结算检查点并刷新会话累计 diffSummary。
        if (checkpoints && preTurnPromise) {
          try {
            if (!preTurnResolved) {
              preTurnResult = await preTurnPromise;
              preTurnResolved = true;
            }
            if (preTurnResult?.captured) {
              const turnLabel = sanitizeDisplayText(redact(effectiveInput), 80);
              await checkpoints.capturePostTurn({
                projectRoot,
                executionRoot: root,
                sessionId: ownedHandle.conversationId,
                ordinal: turnOrdinal,
                startTree: preTurnResult.startTree,
                startCommitOid: preTurnResult.commitOid,
                ...(turnLabel ? { label: turnLabel } : {}),
              });
            }
            emitDiffSummary(await computeSessionDiffSummary());
          } catch {
            /* 检查点后置采样异常不覆盖主轮次终态与错误上报。 */
          }
        }
        // 提前结束迭代也会等待 Core 的 return/finally，随后才宣告展示空闲。
        try {
          if (!current.isBusy())
            projected?.settle(combinedSignal.aborted ? 'aborted' : undefined, failure);
        } finally {
          execRunHandle?.release();
          activeProjection = undefined;
          activeController = undefined;
          complete();
          activeDone = undefined;
        }
      }
    };
    // 监视服务与运行共用同一空闲门：只有本会话与外层宿主都没有在途运行时才投递并自动续跑，
    // 背景通知经 WatchInbox 落回登记分支并立即同步进内存历史与空闲视图，绝不与用户输入抢写。
    const watchInbox = new WatchInbox(ownedHandle.store);
    const watchService = new WatchService({
      workspaceRoot: root,
      store: ownedHandle.store,
      deliver: async (notification, branchId) => {
        const written = await watchInbox.consume(notification, branchId);
        if (written && branchId === ownedHandle.store.getActiveBranchId()) {
          await current.syncExternalHistory();
          syncExternalPresentation();
        }
        return written;
      },
      isIdle: () =>
        !activeController &&
        !current.isBusy() &&
        !closing &&
        !disposed &&
        (options.isHostIdle?.() ?? true),
      resume: async (input, signal) => {
        if (options.onAutoResume) {
          await options.onAutoResume(input, signal);
          return;
        }
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
      async run(input, signal, runOpts) {
        const handoffPrepare =
          runOpts?.handoff && !runOpts.regenerate
            ? async (): Promise<PreparedTaskResult> => ({
                content: [
                  {
                    type: 'text',
                    text: runOpts.handoff!.context,
                    promptSource: {
                      version: 1,
                      server: 'kapibala-handoff',
                      name: runOpts.handoff!.fromTitle || '历史会话',
                    },
                  },
                ],
              })
            : undefined;
        for await (const _ of run(input, signal, undefined, handoffPrepare, {
          regenerate: runOpts?.regenerate,
          restoreFiles: runOpts?.restoreFiles,
          forceRestore: runOpts?.forceRestore,
          allowMidStreamRetry: runOpts?.allowMidStreamRetry,
        })) {
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
        // 冻结发生在这里：prepare 在运行锁内按 `projectRoot` 同桶读取，失败或超预算时 Core 零 append。
        const prepare = async (): Promise<PreparedTaskResult> => ({
          content: await readReferenceBlocks(referenceReader, projectRoot, references, { redact }),
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
      async createBranchWithSummary(branchId, branchOptions) {
        assertIdle();
        const previousBranchId = ownedHandle.store.getActiveBranchId();
        const created = await current.createBranchWithSummary(branchId, branchOptions);
        await watches?.onBranchRewound(previousBranchId, created.branchId);
        tasks.refresh({
          parentSessionId: ownedHandle.conversationId,
          branchId: created.branchId,
        });
        const snap = presentation.snapshot();
        const nextIdentity = { ...snap.identity, branchId: created.branchId };
        const history = current.getHistory();
        const projectedMessages = projectHistory(history, presentationScope(nextIdentity), redact, {
          artifacts: artifactPolicy,
          usageByMessageId: current.getMessageUsages(),
          turnMetaByInteraction,
        });
        presentation.dispatch({
          ...snap.identity,
          sequence: presentation.snapshot().sequence + 1,
          change: {
            type: 'history_replaced',
            messages: projectedMessages,
            branchId: created.branchId,
          },
        });
        const todos = buildTodoState(history, redact);
        presentation.dispatch({
          ...presentation.snapshot().identity,
          sequence: presentation.snapshot().sequence + 1,
          change: todos ? { type: 'todos_changed', todos } : { type: 'todos_changed' },
        });
        inspectionChanged();
        return { branchId: created.branchId, summary: created.summary };
      },
      forgetDelegation(sessionId) {
        ownedRuntime.forgetDelegationSession(sessionId);
      },
      configuration: () => ({
        profileId: selectedProfileId,
        role: selectedRole,
        mode: current.getMode(),
      }),
      snapshot: () => redactPresentationState(presentation.snapshot(), redact),
      subscribeEvents: (listener) =>
        presentation.subscribeEvents((event) =>
          listener({ ...event, change: redactPresentationChange(event.change, redact) }),
        ),
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
        const checkpointRecords = checkpoints
          ? await checkpoints
              .listCheckpoints({
                projectRoot,
                executionRoot: root,
                sessionId: ownedHandle.conversationId,
              })
              .catch(() => undefined)
          : undefined;
        return buildSessionEvidence(
          {
            conversationId: ownedHandle.conversationId,
            history: current.getHistory(),
            delegations: await listDelegationSessions(manager),
            tasks: runtime?.listTasks({ parentSessionId: ownedHandle.conversationId }) ?? [],
            parentActive: phase === 'running' || phase === 'cancelling',
            ...(checkpointRecords && checkpointRecords.length > 0
              ? { checkpoints: checkpointRecords }
              : {}),
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
      checkpoints: async () => {
        if (!checkpoints) return [];
        const records = await checkpoints.listCheckpoints({
          projectRoot,
          executionRoot: root,
          sessionId: ownedHandle.conversationId,
        });
        return records.map((rec) => ({
          ordinal: rec.ordinal,
          createdAt: rec.createdAt,
          startTree: rec.startTree,
          endTree: rec.endTree,
          additions: rec.additions,
          deletions: rec.deletions,
          changedFilesCount: rec.changedFiles.length,
          ...(rec.label ? { label: sanitizeDisplayText(redact(rec.label), 120) } : {}),
        }));
      },
      checkpointDiff: async (diffOptions) => {
        if (!checkpoints) {
          return { available: false, files: [], additions: 0, deletions: 0, truncated: false };
        }
        const diffRes = await checkpoints.diff({
          projectRoot,
          executionRoot: root,
          sessionId: ownedHandle.conversationId,
          ...(diffOptions?.ordinal !== undefined ? { ordinal: diffOptions.ordinal } : {}),
          ...(diffOptions?.fromOrdinal !== undefined
            ? { fromOrdinal: diffOptions.fromOrdinal }
            : {}),
          ...(diffOptions?.toOrdinal !== undefined ? { toOrdinal: diffOptions.toOrdinal } : {}),
          ...(diffOptions?.includeLiveWorktree !== undefined
            ? { includeLiveWorktree: diffOptions.includeLiveWorktree }
            : {}),
        });
        return {
          available: diffRes.available,
          additions: diffRes.additions,
          deletions: diffRes.deletions,
          truncated: diffRes.truncated,
          files: diffRes.files.map((f) => ({
            path: redact(f.path),
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
            binary: f.binary,
            patch: redact(f.patch),
            truncated: f.truncated,
          })),
        };
      },
      restoreCheckpoint: async (targetOrdinal, force) => {
        assertIdle();
        if (!checkpoints) {
          throw new CheckpointError(
            'CHECKPOINT_GIT_UNAVAILABLE',
            'Checkpoint service is not configured for this session',
          );
        }
        coordinator?.assertNotFenced(root);
        if (coordinator?.hasActiveRuns(root)) {
          throw new SessionBusyError('restore checkpoint');
        }
        const execHandle = coordinator?.trackActiveRun({
          executionRoot: root,
          ownerId: ownedHandle.conversationId,
          kind: 'checkpoint',
        });
        try {
          const outcome = await checkpoints.restore({
            projectRoot,
            executionRoot: root,
            sessionId: ownedHandle.conversationId,
            targetOrdinal,
            force,
          });
          if (outcome.status === 'restored') {
            emitDiffSummary(await computeSessionDiffSummary());
            inspectionChanged();
          }
          return outcome;
        } finally {
          execHandle?.release();
        }
      },
      worktree: () => (viewWorktree ? { ...viewWorktree } : undefined),
      status: () =>
        projectStatusFacts(
          {
            phase:
              closing || (!activeController && current.isBusy())
                ? 'settling'
                : (presentation.snapshot().operation?.phase ?? 'idle'),
            model: current.getActiveProfile().name,
            permissionMode: current.getMode(),
            gitBranch: sessionWorktree?.branch ?? manager.project.gitBranch,
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
      run: async function* (
        input: string,
        signal?: AbortSignal,
        references?: readonly ReferenceSelection[],
        runResourceOptions?: { readonly allowMidStreamRetry?: boolean },
      ): AsyncGenerator<SessionEvent> {
        const prepare =
          references && references.length > 0
            ? async (): Promise<PreparedTaskResult> => ({
                content: await readReferenceBlocks(referenceReader, projectRoot, references, {
                  redact,
                }),
              })
            : undefined;
        yield* run(input, signal, undefined, prepare, {
          allowMidStreamRetry: runResourceOptions?.allowMidStreamRetry,
        });
      },
      dispose,
      watches: { list: () => managed.watches(), cancel: (id: string) => managed.cancelWatch(id) },
      checkpoints: () => managed.checkpoints(),
      checkpointDiff: (diffOpts?: {
        readonly ordinal?: number;
        readonly fromOrdinal?: number;
        readonly toOrdinal?: number;
        readonly includeLiveWorktree?: boolean;
      }) => managed.checkpointDiff(diffOpts),
      restoreCheckpoint: (targetOrdinal: number, force?: boolean) =>
        managed.restoreCheckpoint(targetOrdinal, force),
      worktree: () => managed.worktree(),
    };
  } catch (error) {
    // 创建失败时也按依赖顺序清理；上游未清理完不能释放存储锁，原始错误优先上报。
    try {
      approvalHub.dispose();
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
