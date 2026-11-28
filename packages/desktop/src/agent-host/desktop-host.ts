import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type ApprovalChannel,
  type ApprovalChoice,
  type ApprovalRequest,
  CrossProjectSessionCatalog,
  KapibalaError,
  SessionLock,
  type SessionManager,
  SessionReferenceReader,
  type SessionWorktreeBinding,
  WorkspaceLeaseCoordinator,
  computeProjectKey,
  isSamePath,
  toNativePhysicalPath,
} from '@kiturone/kapibala';
import {
  type CommandContext,
  type CommandOutput,
  type SelectConfig,
  createDefaultCommandDispatcher,
} from '@kiturone/kapibala-cli/commands';
import {
  type LoadedSettings,
  type ManagedHostSession,
  createManagedSession,
  loadSettings,
  redactText,
} from '@kiturone/kapibala-host/host';
// 启动任务文本与技能导入门面只在宿主内部约定里共享：投影与直发两处必须同一个常量。
import {
  CheckpointService,
  EXPLICIT_SKILL_KICKOFF,
  ExecutionRootCoordinator,
  ExternalSessionService,
  WorktreeError,
  WorktreeService,
  importSkills,
  sanitizeDisplayText,
  scanImportableSkills,
} from '@kiturone/kapibala-host/internal';
import type { PresentationEvent, ViewFileDiff } from '@kiturone/kapibala-host/view-model';
import {
  LIMITS,
  type Method,
  type Notification,
  type Output,
  PARAMS,
  PresentationEventSchema,
  RESULTS,
  type RunReceipt,
  encodedBytes,
} from '../shared/contracts.js';
import { type Inspection, InspectionSchema, type RuntimeSnapshot } from '../shared/observations.js';
import { safeError } from '../shared/rpc.js';
import { snapshotChunks } from '../shared/snapshots.js';
import type { Lane } from '../shared/transport.js';
import { LatestSnapshot } from './latest-snapshot.js';
import { ResourceService } from './resource-service.js';
import { SettingsService } from './settings-service.js';
import { TerminalService } from './terminal-service.js';
import { enumerateWorkspaceFiles, readWorkspaceFile } from './workspace-files.js';
import { Workspaces } from './workspaces.js';

/** 单帧 Diff 补丁总 UTF-8 字节预算（720 KiB），确保包裹 RPC 信封后恒低于 `LIMITS.frame`（1 MiB）。 */
const MAX_DESKTOP_DIFF_PATCH_BYTES = 720 * 1024;

function clampDesktopDiffFiles(files: readonly ViewFileDiff[]): {
  readonly files: ViewFileDiff[];
  readonly truncated: boolean;
} {
  let remaining = MAX_DESKTOP_DIFF_PATCH_BYTES;
  let anyTruncated = false;
  const clamped: ViewFileDiff[] = files.map((file) => {
    if (file.truncated) anyTruncated = true;
    if (!file.patch) return { ...file };
    const patchBytes = Buffer.byteLength(file.patch, 'utf8');
    if (patchBytes <= remaining) {
      remaining -= patchBytes;
      return { ...file };
    }
    anyTruncated = true;
    if (remaining <= 0) {
      return { ...file, patch: '', truncated: true };
    }
    const sliced = Buffer.from(file.patch, 'utf8').subarray(0, remaining).toString('utf8');
    remaining = 0;
    return { ...file, patch: sliced, truncated: true };
  });
  return { files: clamped, truncated: anyTruncated };
}

/**
 * 桌面端不承接的斜杠命令：这些命令把实际工作委托给 CLI 宿主回调（模型切换/退出）
 * 或需要运行收据管线适配（提示词任务），桌面首版未接入对应适配面。
 * 门禁在 dispatch 前拦截并给出明确反馈，`run.commandList` 同步过滤——
 * 绝不允许命令目录展示一个会假成功或静默空操作的条目。
 */
const DESKTOP_UNHANDLED_COMMANDS: ReadonlyMap<string, string> = new Map([
  ['model', '会话内模型切换依赖 CLI 宿主回调，桌面端请在设置面板管理模型。'],
  ['exit', '桌面端没有退出命令；请直接关闭窗口或会话标签。'],
  ['prompt', '提示词任务依赖运行收据管线适配，桌面端暂未开放；可改用该服务的 MCP 工具。'],
  ['external', '桌面端请在新对话输入框选择外部代理，或在设置面板「外部代理」中管理配置。'],
]);

type Scope = { workspaceId: string; sessionId: string };
interface View {
  id: string;
  unsubscribe(): void;
  snapshotId: string;
  sequence: number;
  posted: boolean;
  valid: boolean;
  installed: boolean;
  buffer: PresentationEvent[];
  bytes: number;
}
interface Slot {
  scope: Scope;
  handle: ManagedHostSession;
  run?: RunReceipt;
  running?: Promise<void>;
  cancellation?: Promise<void>;
  closing?: Promise<void>;
  view?: View;
  redact: (text: string) => string;
  inspectionRevision: number;
  inspectionScheduled?: boolean;
  inspectionStream?: LatestSnapshot<Inspection>;
  stopInspection?: () => void;
  /** 监视状态订阅；用于把徽标数量并入运行快照。 */
  stopWatches?: () => void;
  cleanupFailed?: boolean;
}
interface PendingApproval {
  slot: Slot;
  runId: string;
  sessionAllowed: boolean;
  /** reason 必须随裁决一并上报：超时自动拒绝与用户主动拒绝在渲染层需要不同的解释文案。 */
  finish(choice: ApprovalChoice, reason: 'resolved' | 'timeout' | 'aborted'): void;
}

/** 单 utility Host 的资源所有者；所有父子会话显式共享同一个工作区租约协调器。 */
export class DesktopHost {
  readonly workspaces: Workspaces;
  readonly settings: SettingsService;
  readonly resources: ResourceService;
  readonly checkpoints: CheckpointService;
  readonly worktrees: WorktreeService;
  readonly external: ExternalSessionService;
  readonly terminals: TerminalService;
  private readonly executionCoordinator: ExecutionRootCoordinator;
  private readonly externalStreams = new Map<
    string,
    {
      readonly sessionId: string;
      readonly stream: LatestSnapshot<Output<'external.snapshot'>>;
      readonly unsubscribe: () => void;
    }
  >();
  private readonly leases = new WorkspaceLeaseCoordinator();
  private readonly sessions = new Map<string, Slot>();
  private readonly operations = new Map<
    string,
    { digest: string; receipt: RunReceipt; pending?: Promise<RunReceipt> }
  >();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly openings = new Set<Promise<unknown>>();
  private dead = false;
  private runtimeRevision = 0;
  private readonly runtimeStream: LatestSnapshot<RuntimeSnapshot>;
  constructor(
    home: string,
    private readonly notify: (event: Notification, lane?: Lane) => Promise<void>,
    private readonly assemble = createManagedSession,
    externalHostEnv?: NodeJS.ProcessEnv,
  ) {
    this.runtimeStream = new LatestSnapshot(
      (subscriptionId, snapshot) =>
        this.notify({ type: 'session.runtimeChanged', subscriptionId, snapshot }, 'data'),
      (subscriptionId) => {
        if (!this.dead)
          void this.notify({ type: 'session.runtimeInvalidated', subscriptionId }, 'control').catch(
            () => {},
          );
      },
    );
    this.workspaces = new Workspaces(home);
    this.settings = new SettingsService(this.workspaces);
    this.resources = new ResourceService(this.workspaces);
    this.executionCoordinator = new ExecutionRootCoordinator();
    this.checkpoints = new CheckpointService({
      homeDir: this.workspaces.home,
      hostEnv: externalHostEnv,
    });
    this.worktrees = new WorktreeService({
      homeDir: this.workspaces.home,
      coordinator: this.executionCoordinator,
      hostEnv: externalHostEnv,
    });
    this.terminals = new TerminalService({
      hostEnv: externalHostEnv,
      onEvent: (evt) => {
        if (this.dead) return;
        if (evt.type === 'data') {
          void this.notify(
            {
              type: 'terminal.data',
              workspaceId: evt.workspaceId,
              sessionKey: evt.sessionKey,
              terminalId: evt.terminalId,
              data: evt.data,
            },
            'data',
          ).catch(() => {});
        } else {
          void this.notify(
            {
              type: 'terminal.exit',
              workspaceId: evt.workspaceId,
              sessionKey: evt.sessionKey,
              terminalId: evt.terminalId,
              exitCode: evt.exitCode,
            },
            'control',
          ).catch(() => {});
        }
      },
    });
    this.external = new ExternalSessionService({
      homeDir: this.workspaces.home,
      hostEnv: externalHostEnv,
      checkpoints: this.checkpoints,
      worktrees: this.worktrees,
      executionCoordinator: this.executionCoordinator,
      onAttentionEvent: (evt) => {
        if (this.dead) return;
        const ownerRoot = evt.session.worktree?.projectRoot ?? evt.session.workspaceRoot;
        const wsId = this.workspaces.findIdByRoot(ownerRoot);
        if (!wsId) return;
        void this.notify(
          {
            type: 'external.attention',
            kind: evt.kind,
            workspaceId: wsId,
            sessionId: evt.session.id,
            title: evt.session.title,
            harnessName: evt.session.harnessName,
          },
          'control',
        ).catch(() => {});
      },
    });
    this.external.subscribeList((workspaceRoot) => {
      if (this.dead) return;
      const wsId = workspaceRoot ? this.workspaces.findIdByRoot(workspaceRoot) : undefined;
      void this.notify(
        {
          type: 'external.listChanged',
          ...(wsId ? { workspaceId: wsId } : {}),
        },
        'control',
      ).catch(() => {});
    });
    // 启动清扫：进程异常退出遗留的死锁会让归档/恢复/删除以 SESSION_LOCKED 永久失败。
    // 只清「持有者确认死亡」与超宽限期的损坏锁；存活的锁（含本进程与并行实例的）一律不动。
    void SessionLock.sweepStaleDead(path.join(home, '.kapibala', 'sessions')).catch(() => {});
  }

  /** 斜杠命令分发器（与 CLI 同一装配源）；首次使用时装配，进程内单例。 */
  private commandDispatcher?: ReturnType<typeof createDefaultCommandDispatcher>;
  /** 命令交互（question/select/secret）挂起表；requestId → 应答回调与会话归属。 */
  private readonly interactionPending = new Map<
    string,
    {
      sessionId: string;
      timer: ReturnType<typeof setTimeout>;
      resolve: (value: string | undefined) => void;
    }
  >();

  /** 仅接收 Main 复核过的业务请求；每个分支仍校验当前 Host 内的资源归属。 */
  async dispatch(method: Method, params: unknown, selection?: string): Promise<unknown> {
    if (this.dead) throw new Error('HOST_UNAVAILABLE');
    switch (method) {
      case 'workspace.openDefault':
        return this.workspaces.openDefault();
      case 'workspace.pick':
      case 'workspace.openRecent':
        if (!selection) throw new Error('FORBIDDEN');
        return this.workspaces.registerProject(selection);
      case 'workspace.addProject': {
        const p = PARAMS[method].parse(params);
        return this.workspaces.addProject(p.workspaceId, p.name, p.trustToken, p.acceptTrust);
      }
      case 'workspace.confirmTrust': {
        const p = PARAMS[method].parse(params);
        return this.workspaces.confirm(p.workspaceId, p.trustToken, p.accept);
      }
      case 'workspace.listFiles': {
        const p = PARAMS[method].parse(params);
        return this.listFiles(p.workspaceId, p.query, p.worktreeId);
      }
      case 'workspace.readFile': {
        const p = PARAMS[method].parse(params);
        return this.readFile(p.workspaceId, p.path, p.worktreeId);
      }
      case 'settings.read':
        return this.settings.read(PARAMS[method].parse(params).workspaceId);
      case 'settings.saveProfile': {
        const p = PARAMS[method].parse(params);
        return this.settings.saveProfile(p.profile, p.apiKey, p.editId);
      }
      case 'settings.listModels': {
        const p = PARAMS[method].parse(params);
        return {
          models: await this.settings.listModels(p.baseURL, p.apiKey, p.profileId, p.provider),
        };
      }
      case 'settings.setDefault':
        this.settings.setDefault(PARAMS[method].parse(params).profileId);
        return {};
      case 'settings.setPermissionMode':
        this.settings.setPermissionMode(PARAMS[method].parse(params).mode);
        return {};
      case 'settings.setEnabled': {
        const p = PARAMS[method].parse(params);
        this.settings.setEnabled(p.profileId, p.enabled);
        return {};
      }
      case 'settings.deleteProfile':
        this.settings.deleteProfile(PARAMS[method].parse(params).profileId);
        return {};
      case 'settings.testProfile':
        return this.settings.testProfile(PARAMS[method].parse(params).profileId);
      case 'settings.setRouting': {
        const p = PARAMS[method].parse(params);
        this.settings.setRouting(p.role, p.profileId);
        return {};
      }
      case 'resources.readMcp':
        return this.resources.readMcp(PARAMS[method].parse(params).workspaceId);
      case 'resources.saveMcpServer': {
        const p = PARAMS[method].parse(params);
        return this.resources.saveMcpServer(p);
      }
      case 'resources.deleteMcpServer': {
        const p = PARAMS[method].parse(params);
        return this.resources.deleteMcpServer(p);
      }
      case 'resources.toggleMcpServer': {
        const p = PARAMS[method].parse(params);
        return this.resources.toggleMcpServer(p);
      }
      case 'resources.approveMcpServer': {
        const p = PARAMS[method].parse(params);
        return this.resources.approveMcpServer(p);
      }
      case 'resources.revokeMcpServer': {
        const p = PARAMS[method].parse(params);
        return this.resources.revokeMcpServer(p);
      }
      case 'resources.inspectMcpImport': {
        const p = PARAMS[method].parse(params);
        return this.resources.inspectMcpImport(p);
      }
      case 'resources.importMcp': {
        const p = PARAMS[method].parse(params);
        return this.resources.importMcp(p);
      }
      case 'resources.readSkills': {
        const p = PARAMS[method].parse(params);
        return await this.resources.readSkills(p.workspaceId);
      }
      case 'resources.setSkillsEnabled': {
        const p = PARAMS[method].parse(params);
        return await this.resources.setSkillsEnabled(p);
      }
      case 'resources.setSkillDisabled': {
        const p = PARAMS[method].parse(params);
        return await this.resources.setSkillDisabled(p);
      }
      case 'resources.inspectSkills': {
        const p = PARAMS[method].parse(params);
        return await this.resources.inspectSkills(p);
      }
      case 'resources.importSkills': {
        const p = PARAMS[method].parse(params);
        return await this.resources.importSkills(p);
      }
      case 'run.command':
        return await this.command(PARAMS[method].parse(params));
      case 'run.commandList':
        return {
          commands: this.commands
            .getDefinitions()
            // 门禁外的命令不进补全目录：展示一个点了会假成功的条目比不展示更糟。
            .filter((definition) => !DESKTOP_UNHANDLED_COMMANDS.has(definition.name))
            .map((definition) => ({
              name: definition.name,
              usage: definition.usage,
              description: definition.description,
              interactionLevel: definition.interactionLevel ?? 'select',
            })),
        };
      case 'run.skillCatalog':
        return this.skillCatalog(PARAMS[method].parse(params));
      case 'interaction.reply': {
        const p = PARAMS[method].parse(params);
        const pending = this.interactionPending.get(p.requestId);
        if (!pending || pending.sessionId !== p.sessionId) throw new Error('INTERACTION_UNKNOWN');
        clearTimeout(pending.timer);
        this.interactionPending.delete(p.requestId);
        pending.resolve(p.value);
        this.notify(
          {
            ...p,
            type: 'interaction.closed',
            requestId: p.requestId,
            reason: 'resolved',
          },
          'data',
        ).catch(() => {});
        return {};
      }
      case 'session.runtimeSubscribe': {
        const p = PARAMS[method].parse(params);
        this.runtimeStream.subscribe(p.subscriptionId);
        return this.runtimeSnapshot();
      }
      case 'session.runtimeUnsubscribe':
        this.runtimeStream.unsubscribe(PARAMS[method].parse(params).subscriptionId);
        return {};
      case 'session.inspect': {
        const p = PARAMS[method].parse(params);
        const slot = this.slot(p);
        if (slot.view?.id !== p.subscriptionId) throw new Error('PRESENTATION_STALE');
        return this.inspect(slot);
      }
      case 'session.list': {
        const p = PARAMS[method].parse(params);
        const manager = this.workspaces.manager(p.workspaceId);
        const keyword = p.query?.toLowerCase();
        // 每次列表读取只捕获一次凭证集合，避免搜索每条标题都重新读取配置。
        const redact = this.settings.captureRedactor(p.workspaceId);
        const list = await manager.list(p.page, {
          pageSize: 50,
          // 先脱敏再匹配，避免通过搜索结果推断历史标题中的密钥。
          filter: keyword
            ? (item) => redact(item.title).toLowerCase().includes(keyword)
            : undefined,
        });
        return this.projectHistory(list, redact);
      }
      case 'session.archived': {
        const p = PARAMS[method].parse(params);
        const manager = this.workspaces.manager(p.workspaceId);
        const redact = this.settings.captureRedactor(p.workspaceId);
        // 过滤先于分页在 SessionManager 内完成，页码与总数只统计归档项。
        const list = await manager.list(p.page, {
          pageSize: 50,
          includeArchived: true,
          filter: (item) => item.archived === true,
        });
        return this.projectHistory(list, redact);
      }
      case 'session.readArchived': {
        const p = PARAMS[method].parse(params);
        return await this.readArchivedConversation(p.workspaceId, p.conversationId);
      }
      case 'session.create': {
        const p = PARAMS[method].parse(params);
        return this.open(p.workspaceId, undefined, p.profileId, p.worktree);
      }
      case 'session.open': {
        const p = PARAMS[method].parse(params);
        return this.open(p.workspaceId, p.conversationId);
      }
      case 'session.close':
        await this.close(this.slot(PARAMS[method].parse(params)));
        return {};
      case 'session.archive':
      case 'session.restore':
      case 'session.delete': {
        const p = PARAMS[method].parse(params);
        await this.mutateSession(p.workspaceId, p.conversationId, method);
        return {};
      }
      case 'session.rename': {
        const p = PARAMS[method].parse(params);
        await this.renameConversation(p.workspaceId, p.conversationId, p.title);
        return {};
      }
      case 'session.pin': {
        const p = PARAMS[method].parse(params);
        await this.pinConversation(p.workspaceId, p.conversationId, p.pinned);
        return {};
      }
      case 'session.evidence': {
        // 只读聚合：直接复用 managed 会话的同一口径，不在这里另写统计。
        const slot = this.slot(PARAMS[method].parse(params));
        return slot.handle.evidence();
      }
      case 'session.branchWithSummary': {
        const p = PARAMS[method].parse(params);
        return await this.branchConversationWithSummary(
          p.workspaceId,
          p.conversationId,
          p.branchName,
          p.baseRecordId,
        );
      }
      case 'session.configure': {
        const p = PARAMS[method].parse(params);
        const slot = this.slot(p);
        this.workspaces.get(p.workspaceId, true);
        if (slot.cleanupFailed) throw new Error('SESSION_CLEANUP_FAILED');
        if (slot.closing) throw new Error('SESSION_BUSY');
        if (p.mode === 'FullAccess' && p.confirmFullAccess !== true) throw new Error('FORBIDDEN');
        await slot.handle.configure({
          profileId: p.profileId,
          role: p.role,
          mode: p.mode,
        });
        return slot.handle.configuration();
      }
      case 'run.start':
        return await this.startWithOptionalRestore(PARAMS[method].parse(params));
      case 'run.regenerate':
        return await this.regenerate(PARAMS[method].parse(params));
      case 'run.cancel': {
        const p = PARAMS[method].parse(params);
        const slot = this.slot(p);
        if (!slot.run || slot.run.runId !== p.runId) throw new Error('OPERATION_UNKNOWN');
        if (slot.run.phase !== 'idle') {
          slot.run.phase = 'cancelling';
          this.emitRun(slot);
          slot.cancellation ??= slot.handle.cancel();
          void slot.cancellation.catch(() => {
            if (slot.run) {
              slot.run.phase = 'settling';
              slot.run.error = safeError(new Error('SESSION_CLEANUP_FAILED'));
              this.emitRun(slot);
            }
          });
        }
        return { ...slot.run };
      }
      case 'run.status': {
        const slot = this.slot(PARAMS[method].parse(params));
        this.settleIfDone(slot);
        return slot.run ?? null;
      }
      case 'approval.reply': {
        const p = PARAMS[method].parse(params);
        const slot = this.slot(p);
        const pending = this.approvals.get(p.approvalId);
        if (!pending || pending.slot !== slot || pending.runId !== p.runId)
          throw new Error('APPROVAL_EXPIRED');
        if (p.choice === 'allow_session' && !pending.sessionAllowed) throw new Error('FORBIDDEN');
        pending.finish(p.choice, 'resolved');
        return {};
      }
      case 'reference.candidates': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const redact = this.settings.captureRedactor(p.workspaceId);
        const reader = new SessionReferenceReader({
          homeDirectory: this.workspaces.home,
          maxReadBytes: LIMITS.history,
        });
        const items = await reader.listCandidates({
          projectRoot: ws.root,
          ...(p.limit !== undefined ? { limit: p.limit } : {}),
        });
        return {
          items: items.map((item) => ({
            sessionId: item.sessionId,
            title: sanitizeDisplayText(redact(item.title), 200) ?? '',
            lastActivityAt: item.lastActivityAt,
            messageCount: item.messageCount,
            ...(item.delegation ? { isDelegation: true } : {}),
          })),
        };
      }
      case 'reference.search': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const redact = this.settings.captureRedactor(p.workspaceId);
        const sanitizedQuery = p.query.trim().startsWith('re:')
          ? p.query
          : p.query.replace(/\bproject:\S+/gi, '').trim();
        if (!sanitizedQuery) return { hits: [] };
        const catalog = new CrossProjectSessionCatalog({ homeDirectory: this.workspaces.home });
        const bucketEntries = await catalog.scanSessions({
          projectKey: computeProjectKey(ws.root),
          projectRoot: ws.root,
        });
        const titleBySession = new Map(
          bucketEntries.map((entry) => [
            entry.conversationId,
            sanitizeDisplayText(redact(entry.title), 200) ?? entry.conversationId.slice(0, 8),
          ]),
        );
        const res = await catalog.search(sanitizedQuery, {
          project: ws.root,
          limit: p.limit ?? 20,
        });
        return {
          hits: res.hits
            .filter((hit) => isSamePath(hit.projectRoot, ws.root))
            .map((hit) => ({
              sessionId: hit.conversationId,
              title: titleBySession.get(hit.conversationId) ?? hit.conversationId.slice(0, 8),
              recordId: hit.recordId,
              branchId: hit.branchId,
              role: hit.role,
              snippet: sanitizeDisplayText(redact(hit.snippet), 400) ?? '',
              timestamp: hit.timestamp,
            })),
        };
      }
      case 'reference.read': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const redact = this.settings.captureRedactor(p.workspaceId);
        const reader = new SessionReferenceReader({
          homeDirectory: this.workspaces.home,
          maxReadBytes: LIMITS.history,
        });
        const readResult = await reader.read({
          projectRoot: ws.root,
          sessionId: p.sessionId,
          ...(p.recordIds ? { recordIds: p.recordIds } : {}),
          ...(p.branchId !== undefined ? { branchId: p.branchId } : {}),
          ...(p.limit !== undefined ? { limit: p.limit } : {}),
        });
        const title = readResult.title
          ? sanitizeDisplayText(redact(readResult.title), 200)
          : undefined;
        return {
          sessionId: readResult.sessionId,
          ...(title ? { title } : {}),
          branchId: readResult.branchId,
          records: readResult.records.map((rec) => ({
            recordId: rec.recordId,
            role: rec.role,
            branchId: rec.branchId,
            timestamp: rec.timestamp,
            text: redact(rec.text),
            truncated: rec.truncated,
          })),
          ...(readResult.partial ? { partial: readResult.partial } : {}),
        };
      }
      case 'checkpoint.list': {
        const p = PARAMS[method].parse(params);
        return await this.listCheckpointsRpc(p);
      }
      case 'checkpoint.diff': {
        const p = PARAMS[method].parse(params);
        return await this.diffCheckpointsRpc(p);
      }
      case 'checkpoint.restore': {
        const p = PARAMS[method].parse(params);
        return await this.restoreCheckpointRpc(p);
      }
      case 'worktree.list': {
        const p = PARAMS[method].parse(params);
        return await this.listWorktrees(p.workspaceId);
      }
      case 'worktree.create': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const created = await this.worktrees.create({
          projectRoot: ws.root,
          ...(p.name ? { name: p.name } : {}),
          ...(p.branch ? { branch: p.branch } : {}),
          ...(p.baseRef ? { baseRef: p.baseRef } : {}),
        });
        return {
          id: created.binding.id,
          projectRoot: created.binding.projectRoot,
          worktreePath: created.binding.worktreePath,
          branch: created.binding.branch,
          baseRef: created.binding.baseRef,
          baseCommit: created.binding.baseCommit,
          createdAt: created.binding.createdAt,
        };
      }
      case 'worktree.status': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        this.requireOwnedWorktree(p.id, ws.root);
        const st = await this.worktrees.status(p.id);
        return {
          id: st.id,
          projectRoot: st.projectRoot,
          worktreePath: st.worktreePath,
          branch: st.branch,
          baseRef: st.baseRef,
          baseCommit: st.baseCommit,
          ...(st.headCommit ? { headCommit: st.headCommit } : {}),
          exists: st.exists,
          linkVerified: st.linkVerified,
          dirty: st.dirty,
          untrackedCount: st.untrackedCount,
          aheadCount: st.aheadCount,
          behindCount: st.behindCount,
          additions: st.additions,
          deletions: st.deletions,
          changedFiles: st.changedFiles.map((f) => ({
            path: f.path,
            status: f.status,
            ...(f.oldPath ? { oldPath: f.oldPath } : {}),
            additions: f.additions,
            deletions: f.deletions,
            binary: f.binary,
          })),
        };
      }
      case 'worktree.diff': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        this.requireOwnedWorktree(p.id, ws.root);
        const redact = this.settings.captureRedactor(p.workspaceId);
        const diff = await this.worktrees.diff(p.id);
        const mapped: ViewFileDiff[] = diff.files.map((f) => ({
          path: redact(f.path),
          status: f.status,
          ...(f.oldPath ? { originalPath: redact(f.oldPath) } : {}),
          additions: f.additions,
          deletions: f.deletions,
          binary: f.binary,
          patch: redact(f.patch),
          truncated: f.truncated,
        }));
        const clamped = clampDesktopDiffFiles(mapped);
        return {
          id: diff.id,
          branch: diff.branch,
          baseCommit: diff.baseCommit,
          headCommit: diff.headCommit,
          additions: diff.additions,
          deletions: diff.deletions,
          truncated: diff.truncated || clamped.truncated,
          files: clamped.files,
        };
      }
      case 'worktree.previewMerge': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        this.requireOwnedWorktree(p.id, ws.root);
        const preview = await this.worktrees.previewMerge(p.id);
        return {
          worktreeId: preview.id,
          branch: preview.branch,
          baseRef: preview.targetBranch,
          aheadCount: preview.aheadCount,
          behindCount: preview.behindCount,
          worktreeDirty: preview.worktreeDirty,
          mainDirty: preview.mainDirty,
          canApply: preview.canApply,
          ...(preview.blockingReason ? { blockingReason: preview.blockingReason } : {}),
          additions: preview.additions,
          deletions: preview.deletions,
          previewToken: preview.previewToken,
          changedFiles: preview.changedFiles.map((f) => ({
            path: f.path,
            status: f.status,
            additions: f.additions,
            deletions: f.deletions,
          })),
        };
      }
      case 'worktree.applyMerge': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        this.requireOwnedWorktree(p.id, ws.root);
        const outcome = await this.worktrees.applyMerge({
          id: p.id,
          previewToken: p.previewToken,
          ...(p.commitMessage ? { commitMessage: p.commitMessage } : {}),
        });
        if (outcome.status === 'conflict') {
          return {
            status: 'conflict',
            conflictedFiles: [...outcome.conflictedFiles],
          };
        }
        return {
          status: 'merged',
          mergedCommit: outcome.mergedCommit,
          targetBranch: outcome.targetBranch,
          conflictedFiles: [],
        };
      }
      case 'worktree.remove': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        this.requireOwnedWorktree(p.id, ws.root);
        const outcome = await this.worktrees.remove({
          id: p.id,
          ...(p.force !== undefined ? { force: p.force } : {}),
          onBeforeRemove: async (rec) => {
            await this.closeIdleResourcesInWorktree(ws.id, ws.root, rec.worktreePath);
          },
        });
        if (!outcome.removed) {
          return {
            removed: false,
            reason: outcome.reason,
            details: [...outcome.details],
          };
        }
        return {
          removed: true,
          details: [],
        };
      }
      case 'terminal.listShells': {
        const p = PARAMS[method].parse(params);
        this.workspaces.get(p.workspaceId, true);
        return {
          shells: this.terminals.listShells(),
          activeTerminalsCount: this.terminals.liveCount(),
        };
      }
      case 'terminal.ensure': {
        const p = PARAMS[method].parse(params);
        const target = await this.resolveTerminalTarget(p.workspaceId, p.sessionKey);
        return await this.terminals.ensure({
          workspaceId: p.workspaceId,
          sessionKey: p.sessionKey,
          cwd: target.cwd,
          cwdLabel: target.cwdLabel,
          ...(p.shellId ? { shellId: p.shellId } : {}),
          ...(p.cols !== undefined ? { cols: p.cols } : {}),
          ...(p.rows !== undefined ? { rows: p.rows } : {}),
        });
      }
      case 'terminal.create': {
        const p = PARAMS[method].parse(params);
        const target = await this.resolveTerminalTarget(p.workspaceId, p.sessionKey);
        return await this.terminals.create({
          workspaceId: p.workspaceId,
          sessionKey: p.sessionKey,
          cwd: target.cwd,
          cwdLabel: target.cwdLabel,
          ...(p.shellId ? { shellId: p.shellId } : {}),
          ...(p.replaceTerminalId ? { replaceTerminalId: p.replaceTerminalId } : {}),
          ...(p.cols !== undefined ? { cols: p.cols } : {}),
          ...(p.rows !== undefined ? { rows: p.rows } : {}),
        });
      }
      case 'terminal.write': {
        const p = PARAMS[method].parse(params);
        this.workspaces.get(p.workspaceId, true);
        this.terminals.write(p);
        return {};
      }
      case 'terminal.resize': {
        const p = PARAMS[method].parse(params);
        this.workspaces.get(p.workspaceId, true);
        this.terminals.resize(p);
        return {};
      }
      case 'terminal.clear': {
        const p = PARAMS[method].parse(params);
        this.workspaces.get(p.workspaceId, true);
        this.terminals.clear(p);
        return {};
      }
      case 'terminal.close': {
        const p = PARAMS[method].parse(params);
        this.workspaces.get(p.workspaceId, true);
        return await this.terminals.close(p);
      }
      case 'presentation.subscribe':
      case 'presentation.resync': {
        const p = PARAMS[method].parse(params);
        this.subscribe(this.slot(p), p.subscriptionId);
        return {};
      }
      case 'presentation.unsubscribe': {
        const p = PARAMS[method].parse(params);
        const slot = this.slot(p);
        if (slot.view?.id === p.subscriptionId) {
          slot.view.unsubscribe();
          slot.view = undefined;
          slot.inspectionStream?.unsubscribe(p.subscriptionId);
        }
        return {};
      }
      case 'presentation.installed': {
        const p = PARAMS[method].parse(params);
        const slot = this.slot(p);
        const view = slot.view;
        if (
          !view ||
          p.subscriptionId !== view.id ||
          p.snapshotId !== view.snapshotId ||
          p.sequence !== view.sequence ||
          !view.posted ||
          !view.valid
        )
          throw new Error('PRESENTATION_STALE');
        view.installed = true;
        const buffered = view.buffer.splice(0);
        view.bytes = 0;
        for (const event of buffered) this.publish(slot, view, event);
        return {};
      }
      case 'external.harnesses': {
        const p = PARAMS[method].parse(params);
        if (p.workspaceId) this.workspaces.get(p.workspaceId);
        return this.external.listHarnesses();
      }
      case 'external.saveHarness': {
        const p = PARAMS[method].parse(params);
        const harnesses = p.builtin
          ? this.external.saveBuiltinOverride(p.id, {
              ...(p.command !== undefined ? { command: p.command } : {}),
              ...(p.args !== undefined ? { args: p.args } : {}),
              ...(p.envFrom !== undefined ? { envFrom: p.envFrom } : {}),
              ...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
            })
          : this.external.saveCustomHarness({
              id: p.id,
              name: p.name ?? p.id,
              command: p.command ?? '',
              args: p.args ?? [],
              ...(p.registryId ? { registryId: p.registryId } : {}),
              ...(p.envFrom ? { envFrom: p.envFrom } : {}),
              enabled: p.enabled ?? true,
            });
        return { harnesses };
      }
      case 'external.resetHarness': {
        const p = PARAMS[method].parse(params);
        return { harnesses: this.external.resetBuiltinOverride(p.id) };
      }
      case 'external.toggleHarness': {
        const p = PARAMS[method].parse(params);
        return { harnesses: this.external.toggleHarness(p.id, p.enabled) };
      }
      case 'external.deleteHarness': {
        const p = PARAMS[method].parse(params);
        return { harnesses: this.external.deleteCustomHarness(p.id) };
      }
      case 'external.testHarness': {
        const p = PARAMS[method].parse(params);
        const wsRoot = p.workspaceId ? this.workspaces.get(p.workspaceId, true).root : undefined;
        if (p.draft) {
          return await this.external.testHarness(
            {
              id: p.id ?? 'draft-probe',
              name: p.draft.name,
              transport: 'acp',
              command: p.draft.command,
              args: p.draft.args,
              ...(p.draft.envFrom ? { envFrom: p.draft.envFrom } : {}),
              enabled: true,
            },
            wsRoot,
          );
        }
        if (!p.id) throw new Error('INVALID_REQUEST');
        return await this.external.testHarness(p.id, wsRoot);
      }
      case 'external.list': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        return { items: this.external.listSessions(ws.root) };
      }
      case 'external.open': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const initialPrompt = p.prompt?.trim();
        let allocatedWorktree: Awaited<ReturnType<WorktreeService['create']>> | undefined;
        if (p.worktree?.enabled) {
          allocatedWorktree = await this.worktrees.create({
            projectRoot: ws.root,
            ...(p.title || initialPrompt ? { name: p.title || initialPrompt } : {}),
            ...(p.worktree.branch ? { branch: p.worktree.branch } : {}),
            ...(p.worktree.baseRef ? { baseRef: p.worktree.baseRef } : {}),
          });
        }
        let opened: Awaited<ReturnType<ExternalSessionService['openSession']>>;
        try {
          opened = await this.external.openSession({
            workspaceRoot: allocatedWorktree ? allocatedWorktree.binding.worktreePath : ws.root,
            ...(allocatedWorktree
              ? { projectRoot: ws.root, worktree: allocatedWorktree.binding }
              : {}),
            harnessId: p.harnessId,
            ...(p.title ? { title: p.title } : {}),
            ...(p.modelId ? { modelId: p.modelId } : {}),
            ...(p.modeId ? { modeId: p.modeId } : {}),
            ...(p.thoughtLevel ? { thoughtLevel: p.thoughtLevel } : {}),
            ...(initialPrompt ? { requireIdleWorkspace: true } : {}),
          });
        } catch (openErr) {
          if (allocatedWorktree) {
            await this.worktrees
              .remove({ id: allocatedWorktree.record.id, force: true })
              .catch(() => {});
          }
          throw openErr;
        }
        if (initialPrompt) {
          try {
            return await this.external.dispatchPrompt({
              sessionId: opened.session.id,
              text: initialPrompt,
              expectedWorkspaceRoot: ws.root,
              ...(p.handoff ? { handoff: p.handoff } : {}),
            });
          } catch (err) {
            await this.external.deleteSession(opened.session.id, ws.root).catch(() => {});
            if (allocatedWorktree) {
              await this.worktrees
                .remove({ id: allocatedWorktree.record.id, force: true })
                .catch(() => {});
            }
            throw err;
          }
        }
        return opened;
      }
      case 'external.snapshot': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const snap = this.external.getSnapshot(p.sessionId, ws.root);
        if (this.externalOwnerWorkspaceId(snap.session) !== ws.id) {
          throw new Error('FORBIDDEN');
        }
        return snap;
      }
      case 'external.subscribe': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const snap = this.external.getSnapshot(p.sessionId, ws.root);
        if (this.externalOwnerWorkspaceId(snap.session) !== ws.id) {
          throw new Error('FORBIDDEN');
        }
        const existing = this.externalStreams.get(p.subscriptionId);
        if (existing) {
          existing.unsubscribe();
          existing.stream.close();
          this.externalStreams.delete(p.subscriptionId);
        }
        const stream = new LatestSnapshot<Output<'external.snapshot'>>(
          (subscriptionId, snapshot) =>
            this.notify(
              {
                type: 'external.snapshotChanged',
                subscriptionId,
                sessionId: snap.session.id,
                snapshot,
              },
              'data',
            ),
          (subscriptionId) => {
            const staleSub = this.externalStreams.get(subscriptionId);
            if (staleSub) {
              staleSub.unsubscribe();
              this.externalStreams.delete(subscriptionId);
            }
            if (!this.dead) {
              void this.notify(
                {
                  type: 'external.snapshotInvalidated',
                  subscriptionId,
                  sessionId: snap.session.id,
                },
                'control',
              ).catch(() => {});
            }
          },
        );
        stream.subscribe(p.subscriptionId);
        const unsubscribe = this.external.subscribeSession(snap.session.id, (nextSnap) => {
          stream.push(RESULTS['external.snapshot'].parse(nextSnap));
        });
        this.externalStreams.set(p.subscriptionId, {
          sessionId: snap.session.id,
          stream,
          unsubscribe,
        });
        return snap;
      }
      case 'external.unsubscribe': {
        const p = PARAMS[method].parse(params);
        const sub = this.externalStreams.get(p.subscriptionId);
        if (sub) {
          sub.unsubscribe();
          sub.stream.unsubscribe(p.subscriptionId);
          this.externalStreams.delete(p.subscriptionId);
        }
        return {};
      }
      case 'external.prompt': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const current = this.external.getSnapshot(p.sessionId, ws.root);
        if (this.externalOwnerWorkspaceId(current.session) !== ws.id) {
          throw new Error('FORBIDDEN');
        }
        return await this.external.dispatchPrompt({
          sessionId: current.session.id,
          text: p.text,
          expectedWorkspaceRoot: ws.root,
          ...(p.configOverrides ? { configOverrides: p.configOverrides } : {}),
          ...(p.handoff ? { handoff: p.handoff } : {}),
        });
      }
      case 'external.setConfig': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const current = this.external.getSnapshot(p.sessionId, ws.root);
        if (this.externalOwnerWorkspaceId(current.session) !== ws.id) {
          throw new Error('FORBIDDEN');
        }
        return await this.external.setSessionConfig({
          sessionId: current.session.id,
          configId: p.configId,
          category: p.category,
          value: p.value,
          expectedWorkspaceRoot: ws.root,
        });
      }
      case 'external.approve': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const current = this.external.getSnapshot(p.sessionId, ws.root);
        if (this.externalOwnerWorkspaceId(current.session) !== ws.id) {
          throw new Error('FORBIDDEN');
        }
        await this.external.approveSession({
          sessionId: current.session.id,
          approvalId: p.approvalId,
          ...(p.optionId ? { optionId: p.optionId } : {}),
          ...(p.cancel !== undefined ? { cancel: p.cancel } : {}),
          expectedWorkspaceRoot: ws.root,
        });
        return {};
      }
      case 'external.cancel': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const current = this.external.getSnapshot(p.sessionId, ws.root);
        if (this.externalOwnerWorkspaceId(current.session) !== ws.id) {
          throw new Error('FORBIDDEN');
        }
        await this.external.cancelSession(current.session.id, ws.root);
        return {};
      }
      case 'external.close': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const current = this.external.getSnapshot(p.sessionId, ws.root);
        if (this.externalOwnerWorkspaceId(current.session) !== ws.id) {
          throw new Error('FORBIDDEN');
        }
        await this.terminals.closeBySession(`external:${current.session.id}`);
        await this.external.closeSession(current.session.id, ws.root);
        return {};
      }
      case 'external.delete': {
        const p = PARAMS[method].parse(params);
        const ws = this.workspaces.get(p.workspaceId, true);
        const current = this.external.getSnapshot(p.sessionId, ws.root);
        if (this.externalOwnerWorkspaceId(current.session) !== ws.id) {
          throw new Error('FORBIDDEN');
        }
        const ownedWorktreeId = current.worktree?.id ?? current.session.worktree?.id;
        await this.terminals.closeBySession(`external:${current.session.id}`);
        for (const [subId, sub] of this.externalStreams) {
          if (sub.sessionId === current.session.id) {
            sub.unsubscribe();
            sub.stream.close();
            this.externalStreams.delete(subId);
          }
        }
        const deleted = await this.external.deleteSession(current.session.id, ws.root);
        if (deleted && ownedWorktreeId) {
          await this.cleanupOrphanedWorktreeAfterSessionDelete(ws.id, ownedWorktreeId);
        }
        return { deleted };
      }
      default:
        throw new Error('FORBIDDEN');
    }
  }

  /** 控制失联先撤销审批再清理全部句柄；任何失败均阻断新控制连接。 */
  async disconnect(): Promise<void> {
    this.dead = true;
    this.runtimeStream.close();
    for (const sub of this.externalStreams.values()) {
      sub.unsubscribe();
      sub.stream.close();
    }
    this.externalStreams.clear();
    for (const pending of [...this.approvals.values()]) pending.finish('deny_once', 'aborted');
    for (const [reqId, pending] of [...this.interactionPending.entries()]) {
      this.interactionPending.delete(reqId);
      clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
    const openings = await Promise.allSettled([...this.openings]);
    const [results, externalRes] = await Promise.all([
      Promise.allSettled([...this.sessions.values()].map((slot) => this.close(slot))),
      Promise.allSettled([this.external.dispose(), this.terminals.dispose()]),
    ]);
    if (
      openings.some(
        (item) =>
          item.status === 'rejected' &&
          (!(item.reason instanceof Error) || item.reason.message !== 'HOST_UNAVAILABLE'),
      )
    )
      throw new Error('SESSION_CLEANUP_FAILED');
    if (
      results.some((item) => item.status === 'rejected') ||
      externalRes.some((item) => item.status === 'rejected')
    )
      throw new Error('SESSION_CLEANUP_FAILED');
  }
  /** 只供测试和监督读取的数字事实，不暴露会话、Provider、原历史或密钥。 */
  counts(): {
    sessions: number;
    runs: number;
    approvals: number;
    operations: number;
  } {
    return {
      sessions: this.sessions.size,
      runs: [...this.sessions.values()].filter((slot) => slot.run && slot.run.phase !== 'idle')
        .length,
      approvals: this.approvals.size,
      operations: this.operations.size,
    };
  }

  private open(
    workspaceId: string,
    conversationId?: string,
    initialProfileId?: string,
    worktree?: { readonly enabled?: boolean; readonly branch?: string; readonly baseRef?: string },
  ) {
    const task = this.openSession(workspaceId, conversationId, initialProfileId, worktree);
    this.openings.add(task);
    void task.finally(() => this.openings.delete(task)).catch(() => {});
    return task;
  }
  private async openSession(
    workspaceId: string,
    conversationId?: string,
    initialProfileId?: string,
    worktreeOption?: {
      readonly enabled?: boolean;
      readonly branch?: string;
      readonly baseRef?: string;
    },
  ) {
    const workspace = this.workspaces.get(workspaceId, true);
    const known =
      conversationId !== undefined
        ? [...this.sessions.values()].find(
            (slot) =>
              slot.scope.workspaceId === workspaceId &&
              slot.handle.conversationId === conversationId,
          )
        : undefined;
    if (known?.cleanupFailed) throw new Error('SESSION_CLEANUP_FAILED');
    if (known?.closing) throw new Error('SESSION_BUSY');
    if (known) {
      const knownWt = known.handle.worktree();
      return {
        ...known.scope,
        conversationId: known.handle.conversationId,
        configuration: known.handle.configuration(),
        ...(knownWt ? { worktree: knownWt } : {}),
      };
    }
    if (this.sessions.size + this.openings.size >= LIMITS.sessions)
      throw new Error('SESSION_LIMIT');
    const scope = { workspaceId, sessionId: randomUUID() };
    const slotRef: { current?: Slot } = {};
    const approvalChannel: ApprovalChannel = {
      requestApproval: (request, signal) =>
        slotRef.current
          ? this.approve(slotRef.current, request, signal)
          : Promise.resolve('deny_once'),
    };
    let allocatedWorktree: Awaited<ReturnType<WorktreeService['create']>> | undefined;
    if (!conversationId && worktreeOption?.enabled) {
      allocatedWorktree = await this.worktrees.create({
        projectRoot: workspace.root,
        ...(worktreeOption.branch ? { branch: worktreeOption.branch } : {}),
        ...(worktreeOption.baseRef ? { baseRef: worktreeOption.baseRef } : {}),
      });
    }
    let handle: ManagedHostSession;
    try {
      handle = await this.assemble({
        projectRoot: workspace.root,
        workspaceRoot: allocatedWorktree ? allocatedWorktree.binding.worktreePath : workspace.root,
        ...(allocatedWorktree ? { worktree: allocatedWorktree.binding } : {}),
        checkpoints: this.checkpoints,
        worktrees: this.worktrees,
        executionCoordinator: this.executionCoordinator,
        homeDirectory: this.workspaces.home,
        conversationId,
        initialProfileId,
        approvalChannel,
        leaseCoordinator: this.leases,
        maxReadBytes: LIMITS.history,
        // 监视终态通知只携带身份与状态：窗口在后台时由主进程转成系统通知。
        onWatchEvent: (notification) => {
          if (this.dead) return;
          void this.notify(
            {
              type: 'watch.triggered',
              sessionId: scope.sessionId,
              watchId: notification.watchId,
              kind: notification.kind,
              state: notification.state,
            },
            'control',
          ).catch(() => {});
        },
        isHostIdle: () => {
          const current = slotRef.current;
          if (!current || this.dead || current.cleanupFailed || current.closing) return false;
          this.settleIfDone(current);
          if (current.run && current.run.phase !== 'idle') return false;
          if (this.counts().runs >= LIMITS.runs) return false;
          // 若当前标签已建立视图订阅但尚未完成初始快照安装，暂缓一拍避免运行在半安装视图上启动。
          if (current.view && (!current.view.installed || !current.view.valid)) return false;
          return true;
        },
        onAutoResume: (input, signal) =>
          slotRef.current ? this.autoResume(slotRef.current, input, signal) : Promise.resolve(),
      });
    } catch (assembleErr) {
      if (allocatedWorktree) {
        await this.worktrees
          .remove({ id: allocatedWorktree.record.id, force: true })
          .catch(() => {});
      }
      throw assembleErr;
    }
    if (this.dead) {
      await handle.dispose();
      if (allocatedWorktree) {
        await this.worktrees
          .remove({ id: allocatedWorktree.record.id, force: true })
          .catch(() => {});
      }
      throw new Error('HOST_UNAVAILABLE');
    }
    const slot: Slot = {
      scope,
      handle,
      redact: this.settings.captureRedactor(workspaceId),
      inspectionRevision: 0,
    };
    slotRef.current = slot;
    const owned = slot;
    slot.inspectionStream = new LatestSnapshot(
      (subscriptionId, snapshot) =>
        this.notify(
          {
            type: 'session.inspectionChanged',
            ...scope,
            subscriptionId,
            snapshot,
          },
          'data',
        ),
      (subscriptionId) => {
        if (!this.dead)
          void this.notify(
            {
              type: 'session.inspectionInvalidated',
              ...scope,
              subscriptionId,
            },
            'control',
          ).catch(() => {});
      },
    );
    slot.stopInspection = handle.subscribeInspection(() => this.inspectionChanged(owned));
    slot.stopWatches = handle.subscribeWatches(() => this.runtimeChanged());
    this.sessions.set(scope.sessionId, slot);
    this.runtimeChanged();
    const openedWt = handle.worktree();
    return {
      ...scope,
      conversationId: handle.conversationId,
      configuration: handle.configuration(),
      ...(openedWt ? { worktree: openedWt } : {}),
    };
  }
  private runtimeSnapshot(): RuntimeSnapshot {
    return {
      revision: this.runtimeRevision,
      items: [...this.sessions.values()].map((slot) => ({
        ...slot.scope,
        conversationId: slot.handle.conversationId,
        runId: slot.run?.runId,
        phase: slot.run?.phase ?? 'idle',
        result: slot.run?.result,
        approvals: [...this.approvals.values()].filter((pending) => pending.slot === slot).length,
        cleanup: slot.closing ? 'closing' : slot.cleanupFailed ? 'failed' : 'none',
        // 只统计仍在监视中的条目：终态不再需要徽标，历史可从观察面查看。
        watches: slot.handle.watches().filter((item) => item.state === 'armed').length,
        startedAt: slot.run?.startedAt,
        settledAt: slot.run?.settledAt,
      })),
    };
  }
  private runtimeChanged(): void {
    this.runtimeRevision++;
    if (!this.dead) this.runtimeStream.push(this.runtimeSnapshot());
  }
  private inspect(slot: Slot): Inspection {
    return InspectionSchema.parse({
      ...slot.handle.inspection(),
      revision: ++slot.inspectionRevision,
    });
  }
  private inspectionChanged(slot: Slot): void {
    if (this.dead || !slot.view || slot.inspectionScheduled) return;
    slot.inspectionScheduled = true;
    queueMicrotask(() => {
      slot.inspectionScheduled = false;
      if (this.dead || !slot.view) return;
      try {
        slot.inspectionStream?.push(this.inspect(slot));
      } catch {
        const subscriptionId = slot.view?.id;
        slot.inspectionStream?.close();
        if (subscriptionId)
          void this.notify(
            {
              type: 'session.inspectionInvalidated',
              ...slot.scope,
              subscriptionId,
            },
            'control',
          ).catch(() => {});
      }
    });
  }
  private slot(scope: Scope): Slot {
    const slot = this.sessions.get(scope.sessionId);
    if (!slot || slot.scope.workspaceId !== scope.workspaceId) throw new Error('SESSION_NOT_FOUND');
    return slot;
  }
  /** 历史页只投影白名单字段并统一脱敏；归档页与活跃页共用同一投影，避免两处字段漂移。 */
  private projectHistory(
    list: Awaited<ReturnType<SessionManager['list']>>,
    redact: (text: string) => string,
  ): Output<'session.list'> {
    return {
      ...list,
      items: list.items.map((item) => ({
        conversationId: item.conversationId,
        title: redact(item.title),
        messageCount: item.messageCount,
        lastActivityAt: item.lastActivityAt,
        pinned: item.pinned === true,
        unavailableReason: item.unavailableReason,
        ...(item.delegation
          ? {
              delegation: {
                parentSessionId: item.delegation.parentSessionId,
                ...(item.delegation.parentTitle
                  ? { parentTitle: redact(item.delegation.parentTitle) }
                  : {}),
                taskName: redact(item.delegation.taskName),
              },
            }
          : {}),
      })),
    };
  }
  /**
   * 只读读取单条归档（或历史）会话的消息与工具调用摘要：
   * - 全程不修改 `archive_state`，读取完毕立即在 `finally` 释放句柄与管理器，绝不残留写锁；
   * - 将同一轮内的连续助手步骤（`tool_use` + `tool_result` + 回复正文）折叠为单条助手记录并脱敏裁剪至安全帧预算内。
   */
  private async readArchivedConversation(
    workspaceId: string,
    conversationId: string,
  ): Promise<Output<'session.readArchived'>> {
    this.workspaces.get(workspaceId, true);
    const redact = this.settings.captureRedactor(workspaceId);
    const manager = this.workspaces.manager(workspaceId);
    try {
      const openedHandle = await manager.open(conversationId, { autoUpgradeLegacy: false });
      try {
        const meta = openedHandle.metadata;
        const canonical = await openedHandle.store.load();
        const toolErrors = new Map<string, boolean>();
        for (const msg of canonical) {
          if (msg.role !== 'tool') continue;
          for (const block of msg.content) {
            if (block.type === 'tool_result') {
              toolErrors.set(block.toolUseId, Boolean(block.isError));
            }
          }
        }

        type PreviewTurn = Output<'session.readArchived'>['items'][number];
        const merged: Array<{
          id: string;
          role: 'user' | 'assistant';
          timestamp: number;
          texts: string[];
          tools: Array<{ name: string; summary: string; isError?: boolean }>;
        }> = [];

        const summarizeToolInput = (rawInput: unknown): string => {
          if (rawInput && typeof rawInput === 'object') {
            const obj = rawInput as Record<string, unknown>;
            const candidate =
              obj.path ??
              obj.filePath ??
              obj.command ??
              obj.CommandLine ??
              obj.url ??
              obj.query ??
              obj.pattern ??
              obj.description;
            if (typeof candidate === 'string' && candidate.trim()) {
              return sanitizeDisplayText(redact(candidate.trim()), 120) ?? '';
            }
          }
          return '';
        };

        for (const msg of canonical) {
          if (msg.role === 'user') {
            const userTexts: string[] = [];
            for (const block of msg.content) {
              if (block.type === 'text' && block.text.trim()) {
                userTexts.push(redact(block.text.trim()));
              }
            }
            if (userTexts.length > 0) {
              merged.push({
                id: msg.id ?? randomUUID(),
                role: 'user',
                timestamp: msg.timestamp ?? meta?.lastActivityAt ?? 0,
                texts: userTexts,
                tools: [],
              });
            }
          } else if (msg.role === 'assistant') {
            const assistantTexts: string[] = [];
            const stepTools: Array<{ name: string; summary: string; isError?: boolean }> = [];
            for (const block of msg.content) {
              if (block.type === 'text' && block.text.trim()) {
                assistantTexts.push(redact(block.text.trim()));
              } else if (block.type === 'tool_use') {
                stepTools.push({
                  name: redact(block.name),
                  summary: summarizeToolInput(block.input),
                  isError: toolErrors.get(block.id) ?? false,
                });
              }
            }
            if (assistantTexts.length === 0 && stepTools.length === 0) continue;
            const prev = merged.at(-1);
            if (prev && prev.role === 'assistant') {
              prev.texts.push(...assistantTexts);
              prev.tools.push(...stepTools);
              if (msg.timestamp && msg.timestamp > prev.timestamp) {
                prev.timestamp = msg.timestamp;
              }
            } else {
              merged.push({
                id: msg.id ?? randomUUID(),
                role: 'assistant',
                timestamp: msg.timestamp ?? meta?.lastActivityAt ?? 0,
                texts: assistantTexts,
                tools: stepTools,
              });
            }
          }
        }

        let truncated = merged.length > 200;
        const tailSlice = truncated ? merged.slice(-200) : merged;
        let remainingBytes = 512 * 1024;
        const items: PreviewTurn[] = [];

        for (let i = tailSlice.length - 1; i >= 0; i -= 1) {
          const entry = tailSlice[i]!;
          let joinedText = entry.texts.join('\n\n');
          if (joinedText.length > 16_000) {
            joinedText = `${joinedText.slice(0, 16_000)}\n…`;
            truncated = true;
          }
          const byteLen = Buffer.byteLength(joinedText, 'utf8') + 256;
          if (byteLen > remainingBytes && items.length > 0) {
            truncated = true;
            break;
          }
          remainingBytes = Math.max(0, remainingBytes - byteLen);
          items.push({
            id: entry.id,
            role: entry.role,
            timestamp: Math.max(0, Math.trunc(entry.timestamp)),
            text: joinedText,
            toolSummaries: entry.tools.slice(0, 64),
          });
        }
        items.reverse();

        const rawTitle = meta?.customTitle ?? meta?.title ?? '';
        return {
          conversationId: openedHandle.conversationId,
          title: sanitizeDisplayText(redact(rawTitle), 200) || '未命名对话',
          archived: meta?.archived ?? true,
          ...(meta?.gitBranch
            ? { gitBranch: sanitizeDisplayText(redact(meta.gitBranch), 120) }
            : {}),
          lastActivityAt: Math.max(0, Math.trunc(meta?.lastActivityAt ?? 0)),
          messageCount: Math.max(0, Math.trunc(meta?.messageCount ?? canonical.length)),
          truncated,
          items,
        };
      } finally {
        await openedHandle.release();
      }
    } finally {
      await manager.close();
    }
  }

  /**
   * 归档/恢复/删除都以「会话文件不被本进程持有」为前提。
   *
   * - 运行中的会话直接拒绝（SESSION_IN_USE）：归档或删除会中断用户任务，不静默代做；
   * - 仅持有空闲句柄时先关闭再交给 SessionManager，否则同进程内的写锁会让操作以 SESSION_LOCKED 失败；
   * - 会话身份只在对应空间的桶内解析，跨空间同名 ID 不会命中别处历史。
   */
  private async mutateSession(
    workspaceId: string,
    conversationId: string,
    method: 'session.archive' | 'session.restore' | 'session.delete',
  ): Promise<void> {
    const slot = this.findSlot(workspaceId, conversationId);
    let deletedWorktreeId = method === 'session.delete' ? slot?.handle.worktree()?.id : undefined;
    if (slot) {
      if (slot.closing) throw new Error('SESSION_BUSY');
      if (slot.run && slot.run.phase !== 'idle') throw new Error('SESSION_IN_USE');
      await this.close(slot);
    }
    if (method === 'session.archive' || method === 'session.delete') {
      await this.terminals.closeBySession(`native:${workspaceId}:${conversationId}`);
    }
    const manager = this.workspaces.manager(workspaceId);
    try {
      if (method === 'session.archive') await manager.archiveSession(conversationId);
      else if (method === 'session.restore') await manager.restoreSession(conversationId);
      else {
        if (!deletedWorktreeId) {
          const matched = await manager
            .list(1, {
              pageSize: 1,
              includeArchived: true,
              filter: (item) => item.conversationId === conversationId,
            })
            .catch(() => undefined);
          deletedWorktreeId = matched?.items[0]?.worktree?.id;
        }
        await manager.deleteSession(conversationId);
        for (const openSlot of this.sessions.values()) {
          if (openSlot.scope.workspaceId === workspaceId) {
            openSlot.handle.forgetDelegation(conversationId);
          }
        }
      }
    } finally {
      await manager.close();
    }
    if (method === 'session.delete' && deletedWorktreeId) {
      await this.cleanupOrphanedWorktreeAfterSessionDelete(workspaceId, deletedWorktreeId);
    }
  }
  /** 同一空间内按会话 ID 找本进程持有的句柄；跨空间同名 ID 不会命中。 */
  private findSlot(workspaceId: string, conversationId: string): Slot | undefined {
    return [...this.sessions.values()].find(
      (item) =>
        item.scope.workspaceId === workspaceId && item.handle.conversationId === conversationId,
    );
  }
  /**
   * 重命名已打开或未打开的会话。
   *
   * - 句柄在本进程时走打开的 Store：不必抢写锁，运行中也能改名而不打断任务；
   * - 未打开时交给 SessionManager 自己取锁、追加 title 记录并释放；
   * - 两条路径都只写控制记录，不搬动文件、不改正文历史。
   */
  private async renameConversation(
    workspaceId: string,
    conversationId: string,
    title: string,
  ): Promise<void> {
    const slot = this.findSlot(workspaceId, conversationId);
    if (slot) {
      if (slot.closing) throw new Error('SESSION_BUSY');
      await slot.handle.rename(title);
      return;
    }
    const manager = this.workspaces.manager(workspaceId);
    try {
      await manager.renameSession(conversationId, title);
    } finally {
      await manager.close();
    }
  }
  /** 置顶只改列表次序；与重命名同样优先复用已打开的句柄，不要求先停止任务。 */
  private async pinConversation(
    workspaceId: string,
    conversationId: string,
    pinned: boolean,
  ): Promise<void> {
    const slot = this.findSlot(workspaceId, conversationId);
    if (slot) {
      if (slot.closing) throw new Error('SESSION_BUSY');
      await slot.handle.setPinned(pinned);
      return;
    }
    const manager = this.workspaces.manager(workspaceId);
    try {
      await manager.pinSession(conversationId, pinned);
    } finally {
      await manager.close();
    }
  }
  private async close(slot: Slot): Promise<void> {
    if (slot.closing) return slot.closing;
    slot.cleanupFailed = false;
    slot.closing = (async () => {
      for (const pending of [...this.approvals.values()])
        if (pending.slot === slot) pending.finish('deny_once', 'aborted');
      for (const [reqId, pending] of [...this.interactionPending.entries()]) {
        if (pending.sessionId === slot.scope.sessionId) {
          this.interactionPending.delete(reqId);
          clearTimeout(pending.timer);
          pending.resolve(undefined);
        }
      }
      await slot.handle.dispose();
      await slot.running;
      slot.view?.unsubscribe();
      slot.inspectionStream?.close();
      slot.stopInspection?.();
      slot.stopWatches?.();
      await this.terminals.closeBySession(
        `native:${slot.scope.workspaceId}:${slot.handle.conversationId}`,
      );
      this.sessions.delete(slot.scope.sessionId);
      this.runtimeChanged();
    })().catch((error) => {
      slot.closing = undefined;
      slot.cleanupFailed = true;
      this.runtimeChanged();
      throw error;
    });
    this.runtimeChanged();
    return slot.closing;
  }
  /**
   * 工作区或受管 Git Worktree 文件路径枚举（相对路径清单），供 composer `@` 文件补全与右侧工作台 `Files` 树使用。
   * 当传入 `worktreeId` 时强制核验该工作树归属当前工作区且通过四步 `.git` 双向回链校验。
   */
  private listFiles(
    workspaceId: string,
    query?: string,
    worktreeId?: string,
  ): Output<'workspace.listFiles'> {
    const root = this.resolveVerifiedExecutionRoot(workspaceId, worktreeId);
    return enumerateWorkspaceFiles(root, {
      maxFiles: 5000,
      maxDepth: 16,
      ...(query !== undefined ? { query } : {}),
    });
  }

  /**
   * 只读读取工作区或已验真受管工作树内的单个文件（硬禁区拒绝 `.kapibala` 与敏感 `.env*`，512 KiB UTF-8 截断并脱敏）。
   */
  private readFile(
    workspaceId: string,
    targetPath: string,
    worktreeId?: string,
  ): Output<'workspace.readFile'> {
    const root = this.resolveVerifiedExecutionRoot(workspaceId, worktreeId);
    const redact = this.settings.captureRedactor(workspaceId);
    const read = readWorkspaceFile({ root, targetPath });
    return {
      ...read,
      content: read.binary ? '' : redact(read.content),
    };
  }

  private resolveVerifiedExecutionRoot(workspaceId: string, worktreeId?: string): string {
    const workspace = this.workspaces.get(workspaceId, true);
    if (!worktreeId) return workspace.root;
    const rec = this.requireOwnedWorktree(worktreeId, workspace.root);
    if (!fs.existsSync(rec.worktreePath)) {
      throw new WorktreeError(
        'WORKTREE_NOT_FOUND',
        `Worktree directory missing: '${rec.worktreePath}'`,
      );
    }
    if (!this.worktrees.verifyLink(workspace.root, rec.worktreePath)) {
      throw new WorktreeError(
        'WORKTREE_LINK_INVALID',
        `Worktree link verification failed: '${rec.worktreePath}'`,
      );
    }
    return toNativePhysicalPath(rec.worktreePath);
  }

  /**
   * 列出指定工作区下的受管 Git Worktree，并结合当前空间内未归档本地会话、已打开槽位与外部会话计算占用状态（`inUse` / `prunable`）。
   */
  async listWorktrees(workspaceId: string): Promise<Output<'worktree.list'>> {
    const ws = this.workspaces.get(workspaceId, true);
    const boundIds = await this.collectBoundWorktreeIds(ws.id, ws.root, {
      includeArchived: false,
    });
    return {
      items: this.worktrees.list(ws.root).map((rec) => {
        const inUse = boundIds.has(rec.id);
        return {
          id: rec.id,
          projectRoot: rec.projectRoot,
          worktreePath: rec.worktreePath,
          branch: rec.branch,
          baseRef: rec.baseRef,
          baseCommit: rec.baseCommit,
          createdAt: rec.createdAt,
          inUse,
          prunable: !inUse,
        };
      }),
    };
  }

  private async collectBoundWorktreeIds(
    workspaceId: string,
    workspaceRoot: string,
    options?: { readonly includeArchived?: boolean },
  ): Promise<Set<string>> {
    const bound = new Set<string>();
    for (const slot of this.sessions.values()) {
      if (slot.scope.workspaceId !== workspaceId) continue;
      const wtId = slot.handle.worktree()?.id;
      if (wtId) bound.add(wtId);
    }
    const manager = this.workspaces.manager(workspaceId);
    try {
      let page = 1;
      for (;;) {
        const listed = await manager.list(page, {
          pageSize: 100,
          ...(options?.includeArchived ? { includeArchived: true } : {}),
        });
        for (const item of listed.items) {
          if (item.worktree?.id) bound.add(item.worktree.id);
        }
        if (page >= listed.pages) break;
        page += 1;
      }
    } finally {
      await manager.close();
    }
    try {
      for (const ext of this.external.listSessions(workspaceRoot)) {
        if (ext.worktree?.id) bound.add(ext.worktree.id);
      }
    } catch {
      // 外部会话目录不可读时不阻塞工作树列举。
    }
    return bound;
  }

  private async cleanupOrphanedWorktreeAfterSessionDelete(
    workspaceId: string,
    worktreeId: string,
  ): Promise<void> {
    try {
      const ws = this.workspaces.get(workspaceId, true);
      const rec = this.worktrees.get(worktreeId);
      if (!rec || !isSamePath(rec.projectRoot, ws.root)) return;
      const remainingRefs = await this.collectBoundWorktreeIds(ws.id, ws.root, {
        includeArchived: true,
      });
      if (remainingRefs.has(worktreeId)) return;
      await this.worktrees
        .remove({
          id: worktreeId,
          force: false,
          onBeforeRemove: async (targetRec) => {
            await this.closeIdleResourcesInWorktree(ws.id, ws.root, targetRec.worktreePath);
          },
        })
        .catch(() => {});
    } catch {
      // 会话删除已完成，工作树非强制回收失败（如存在未提交改动或未合并提交）静默保留目录。
    }
  }

  private requireOwnedWorktree(id: string, projectRoot: string) {
    const rec = this.worktrees.get(id);
    if (!rec || !isSamePath(rec.projectRoot, projectRoot)) {
      throw new WorktreeError(
        'WORKTREE_NOT_FOUND',
        `Worktree '${id}' does not belong to workspace`,
      );
    }
    return rec;
  }

  private externalOwnerWorkspaceId(session: {
    readonly workspaceRoot: string;
    readonly worktree?: { readonly projectRoot: string };
  }): string | undefined {
    return this.workspaces.findIdByRoot(session.worktree?.projectRoot ?? session.workspaceRoot);
  }

  private async closeIdleResourcesInWorktree(
    workspaceId: string,
    workspaceRoot: string,
    worktreePath: string,
  ): Promise<void> {
    const idleSlots = [...this.sessions.values()].filter((slot) => {
      if (slot.scope.workspaceId !== workspaceId || slot.closing) return false;
      this.settleIfDone(slot);
      if (slot.run && slot.run.phase !== 'idle') return false;
      const wt = slot.handle.worktree();
      return Boolean(wt && isSamePath(wt.worktreePath, worktreePath));
    });
    for (const slot of idleSlots) {
      await this.close(slot);
    }
    const idleExternals = this.external
      .listSessions(workspaceRoot)
      .filter(
        (ext) =>
          ext.status === 'idle' &&
          ext.worktree &&
          isSamePath(ext.worktree.worktreePath, worktreePath),
      );
    for (const ext of idleExternals) {
      await this.terminals.closeBySession(`external:${ext.id}`);
      await this.external.closeSession(ext.id, workspaceRoot).catch(() => {});
    }
    await this.terminals.closeByCwd(worktreePath);
  }

  /**
   * 严格在宿主侧校验 `sessionKey` 归属并反解受信任终端工作目录（`worktreePath ?? workspace.root`），
   * 杜绝渲染进程传入任意文件系统路径越界启动交互式 Shell。
   */
  private async resolveTerminalTarget(
    workspaceId: string,
    sessionKey: string,
  ): Promise<{ readonly cwd: string; readonly cwdLabel: string }> {
    const ws = this.workspaces.get(workspaceId, true);
    if (sessionKey.startsWith('native:')) {
      const rest = sessionKey.slice('native:'.length);
      const colonIdx = rest.indexOf(':');
      if (colonIdx <= 0) throw new Error('FORBIDDEN');
      const keyWsId = rest.slice(0, colonIdx);
      const convId = rest.slice(colonIdx + 1);
      if (keyWsId !== workspaceId || !convId) throw new Error('FORBIDDEN');
      const openSlot = this.findSlot(workspaceId, convId);
      if (openSlot) {
        const wt = openSlot.handle.worktree();
        if (
          wt &&
          fs.existsSync(wt.worktreePath) &&
          this.worktrees.verifyLink(ws.root, wt.worktreePath)
        ) {
          return {
            cwd: toNativePhysicalPath(wt.worktreePath),
            cwdLabel: wt.branch || path.basename(wt.worktreePath),
          };
        }
        return { cwd: ws.root, cwdLabel: path.basename(ws.root) || ws.name };
      }
      const { executionRoot } = await this.resolveClosedConversationTarget(
        workspaceId,
        ws.root,
        convId,
        'fallback_root',
      );
      return { cwd: executionRoot, cwdLabel: path.basename(executionRoot) || ws.name };
    }
    if (sessionKey.startsWith('external:')) {
      const extId = sessionKey.slice('external:'.length);
      if (!extId) throw new Error('FORBIDDEN');
      const snap = this.external.getSnapshot(extId, ws.root);
      if (this.externalOwnerWorkspaceId(snap.session) !== ws.id) {
        throw new Error('FORBIDDEN');
      }
      const wt = snap.worktree;
      if (
        wt &&
        fs.existsSync(wt.worktreePath) &&
        this.worktrees.verifyLink(ws.root, wt.worktreePath)
      ) {
        return {
          cwd: toNativePhysicalPath(wt.worktreePath),
          cwdLabel: wt.branch || path.basename(wt.worktreePath),
        };
      }
      return {
        cwd: snap.session.workspaceRoot,
        cwdLabel: path.basename(snap.session.workspaceRoot) || ws.name,
      };
    }
    throw new Error('FORBIDDEN');
  }

  private async resolveClosedConversationTarget(
    workspaceId: string,
    workspaceRoot: string,
    conversationId: string,
    mode: 'strict_link' | 'fallback_root' = 'strict_link',
  ): Promise<{ readonly executionRoot: string }> {
    const manager = this.workspaces.manager(workspaceId);
    try {
      const openedHandle = await manager.open(conversationId, { autoUpgradeLegacy: false });
      try {
        const persistedWt: SessionWorktreeBinding | undefined = openedHandle.header?.worktree;
        if (!persistedWt) {
          return { executionRoot: workspaceRoot };
        }
        if (fs.existsSync(persistedWt.worktreePath)) {
          if (this.worktrees.verifyLink(workspaceRoot, persistedWt.worktreePath)) {
            return { executionRoot: toNativePhysicalPath(persistedWt.worktreePath) };
          }
          if (mode === 'fallback_root') {
            return { executionRoot: workspaceRoot };
          }
          throw new WorktreeError(
            'WORKTREE_LINK_INVALID',
            `Managed worktree link verification failed: ${persistedWt.worktreePath}`,
          );
        }
        return {
          executionRoot: mode === 'fallback_root' ? workspaceRoot : persistedWt.worktreePath,
        };
      } finally {
        await openedHandle.release();
      }
    } finally {
      await manager.close();
    }
  }

  private resolveExternalIdIfMatch(
    workspaceRoot: string,
    p: {
      readonly sessionId?: string;
      readonly conversationId?: string;
      readonly externalSessionId?: string;
    },
  ): string | undefined {
    if (p.externalSessionId) {
      return this.external.resolveSessionId(p.externalSessionId, workspaceRoot);
    }
    if (!p.conversationId && p.sessionId && !this.sessions.has(p.sessionId)) {
      try {
        return this.external.resolveSessionId(p.sessionId, workspaceRoot);
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private async listCheckpointsRpc(
    p: Output<'checkpoint.list'> extends never
      ? never
      : import('../shared/contracts.js').Params<'checkpoint.list'>,
  ): Promise<Output<'checkpoint.list'>> {
    const ws = this.workspaces.get(p.workspaceId, true);
    const extId = this.resolveExternalIdIfMatch(ws.root, p);
    if (extId) {
      return { items: await this.external.listSessionCheckpoints(extId, ws.root) };
    }
    const openSlot = p.sessionId
      ? this.slot({ workspaceId: p.workspaceId, sessionId: p.sessionId })
      : p.conversationId
        ? this.findSlot(p.workspaceId, p.conversationId)
        : undefined;
    if (openSlot) {
      return { items: await openSlot.handle.checkpoints() };
    }
    if (!p.conversationId) throw new Error('INVALID_REQUEST');
    const { executionRoot } = await this.resolveClosedConversationTarget(
      p.workspaceId,
      ws.root,
      p.conversationId,
    );
    if (!fs.existsSync(executionRoot)) return { items: [] };
    const redact = this.settings.captureRedactor(p.workspaceId);
    const records = await this.checkpoints.listCheckpoints({
      projectRoot: ws.root,
      executionRoot,
      sessionId: p.conversationId,
    });
    return {
      items: records.map((rec) => ({
        ordinal: rec.ordinal,
        createdAt: rec.createdAt,
        startTree: rec.startTree,
        endTree: rec.endTree,
        additions: rec.additions,
        deletions: rec.deletions,
        changedFilesCount: rec.changedFiles.length,
        ...(rec.label ? { label: sanitizeDisplayText(redact(rec.label), 120) } : {}),
      })),
    };
  }

  private async diffCheckpointsRpc(
    p: import('../shared/contracts.js').Params<'checkpoint.diff'>,
  ): Promise<Output<'checkpoint.diff'>> {
    const ws = this.workspaces.get(p.workspaceId, true);
    const extId = this.resolveExternalIdIfMatch(ws.root, p);
    if (extId) {
      const diff = await this.external.diffSessionCheckpoints({
        sessionId: extId,
        expectedWorkspaceRoot: ws.root,
        ...(p.ordinal !== undefined ? { ordinal: p.ordinal } : {}),
        ...(p.fromOrdinal !== undefined ? { fromOrdinal: p.fromOrdinal } : {}),
        ...(p.toOrdinal !== undefined ? { toOrdinal: p.toOrdinal } : {}),
        ...(p.includeLiveWorktree !== undefined
          ? { includeLiveWorktree: p.includeLiveWorktree }
          : {}),
      });
      const clamped = clampDesktopDiffFiles(diff.files);
      return {
        available: diff.available,
        additions: diff.additions,
        deletions: diff.deletions,
        truncated: diff.truncated || clamped.truncated,
        files: clamped.files,
      };
    }
    const openSlot = p.sessionId
      ? this.slot({ workspaceId: p.workspaceId, sessionId: p.sessionId })
      : p.conversationId
        ? this.findSlot(p.workspaceId, p.conversationId)
        : undefined;
    if (openSlot) {
      const diff = await openSlot.handle.checkpointDiff({
        ...(p.ordinal !== undefined ? { ordinal: p.ordinal } : {}),
        ...(p.fromOrdinal !== undefined ? { fromOrdinal: p.fromOrdinal } : {}),
        ...(p.toOrdinal !== undefined ? { toOrdinal: p.toOrdinal } : {}),
        ...(p.includeLiveWorktree !== undefined
          ? { includeLiveWorktree: p.includeLiveWorktree }
          : {}),
      });
      const clamped = clampDesktopDiffFiles(diff.files);
      return {
        available: diff.available,
        additions: diff.additions,
        deletions: diff.deletions,
        truncated: diff.truncated || clamped.truncated,
        files: clamped.files,
      };
    }
    if (!p.conversationId) throw new Error('INVALID_REQUEST');
    const { executionRoot } = await this.resolveClosedConversationTarget(
      p.workspaceId,
      ws.root,
      p.conversationId,
    );
    if (!fs.existsSync(executionRoot)) {
      return { available: false, additions: 0, deletions: 0, truncated: false, files: [] };
    }
    const redact = this.settings.captureRedactor(p.workspaceId);
    const diff = await this.checkpoints.diff({
      projectRoot: ws.root,
      executionRoot,
      sessionId: p.conversationId,
      ...(p.ordinal !== undefined ? { ordinal: p.ordinal } : {}),
      ...(p.fromOrdinal !== undefined ? { fromOrdinal: p.fromOrdinal } : {}),
      ...(p.toOrdinal !== undefined ? { toOrdinal: p.toOrdinal } : {}),
      ...(p.includeLiveWorktree !== undefined
        ? { includeLiveWorktree: p.includeLiveWorktree }
        : {}),
    });
    const mapped: ViewFileDiff[] = diff.files.map((f) => ({
      path: redact(f.path),
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      binary: f.binary,
      patch: redact(f.patch),
      truncated: f.truncated,
    }));
    const clamped = clampDesktopDiffFiles(mapped);
    return {
      available: diff.available,
      additions: diff.additions,
      deletions: diff.deletions,
      truncated: diff.truncated || clamped.truncated,
      files: clamped.files,
    };
  }

  private async restoreCheckpointRpc(
    p: import('../shared/contracts.js').Params<'checkpoint.restore'>,
  ): Promise<Output<'checkpoint.restore'>> {
    const ws = this.workspaces.get(p.workspaceId, true);
    const extId = this.resolveExternalIdIfMatch(ws.root, p);
    if (extId) {
      const outcome = await this.external.restoreSessionCheckpoint({
        sessionId: extId,
        targetOrdinal: p.targetOrdinal,
        ...(p.force !== undefined ? { force: p.force } : {}),
        expectedWorkspaceRoot: ws.root,
      });
      if (outcome.status === 'conflict') {
        return {
          status: 'conflict',
          restoredFiles: [],
          deletedFiles: [],
          conflicts: [...outcome.conflicts],
        };
      }
      return {
        status: outcome.status,
        restoredFiles: [...outcome.restoredFiles],
        deletedFiles: [...outcome.deletedFiles],
        conflicts: [],
      };
    }
    const openSlot = p.sessionId
      ? this.slot({ workspaceId: p.workspaceId, sessionId: p.sessionId })
      : p.conversationId
        ? this.findSlot(p.workspaceId, p.conversationId)
        : undefined;
    if (openSlot) {
      this.settleIfDone(openSlot);
      if (
        openSlot.cleanupFailed ||
        openSlot.closing ||
        openSlot.handle.isBusy() ||
        (openSlot.run && openSlot.run.phase !== 'idle')
      ) {
        throw new Error('SESSION_BUSY');
      }
      const outcome = await openSlot.handle.restoreCheckpoint(p.targetOrdinal, p.force);
      if (outcome.status === 'conflict') {
        return {
          status: 'conflict',
          restoredFiles: [],
          deletedFiles: [],
          conflicts: [...outcome.conflicts],
        };
      }
      return {
        status: outcome.status,
        restoredFiles: [...outcome.restoredFiles],
        deletedFiles: [...outcome.deletedFiles],
        conflicts: [],
      };
    }
    if (!p.conversationId) throw new Error('INVALID_REQUEST');
    const { executionRoot } = await this.resolveClosedConversationTarget(
      p.workspaceId,
      ws.root,
      p.conversationId,
    );
    if (!fs.existsSync(executionRoot)) {
      throw new WorktreeError(
        'WORKTREE_NOT_FOUND',
        `Execution root does not exist: '${executionRoot}'`,
      );
    }
    if (!isSamePath(executionRoot, ws.root) && !this.worktrees.verifyLink(ws.root, executionRoot)) {
      throw new WorktreeError(
        'WORKTREE_LINK_INVALID',
        `Execution root link invalid: '${executionRoot}'`,
      );
    }
    this.executionCoordinator.assertNotFenced(executionRoot);
    const outcome = await this.checkpoints.restore({
      projectRoot: ws.root,
      executionRoot,
      sessionId: p.conversationId,
      targetOrdinal: p.targetOrdinal,
      ...(p.force !== undefined ? { force: p.force } : {}),
    });
    if (outcome.status === 'conflict') {
      return {
        status: 'conflict',
        restoredFiles: [],
        deletedFiles: [],
        conflicts: [...outcome.conflicts],
      };
    }
    return {
      status: outcome.status,
      restoredFiles: [...outcome.restoredFiles],
      deletedFiles: [...outcome.deletedFiles],
      conflicts: [],
    };
  }

  private async branchConversationWithSummary(
    workspaceId: string,
    conversationId: string,
    branchName?: string,
    baseRecordId?: string,
  ): Promise<Output<'session.branchWithSummary'>> {
    const ws = this.workspaces.get(workspaceId, true);
    const targetBranchId =
      branchName && /^[a-zA-Z0-9_-]+$/.test(branchName)
        ? branchName
        : `branch-${Date.now().toString(36)}`;
    const openSlot = this.findSlot(workspaceId, conversationId);
    if (openSlot) {
      this.settleIfDone(openSlot);
      if (openSlot.cleanupFailed) throw new Error('SESSION_CLEANUP_FAILED');
      if (
        openSlot.closing ||
        openSlot.handle.isBusy() ||
        (openSlot.run && openSlot.run.phase !== 'idle')
      ) {
        throw new Error('SESSION_BUSY');
      }
      return await openSlot.handle.createBranchWithSummary(targetBranchId, {
        ...(baseRecordId ? { baseRecordId } : {}),
      });
    }
    const tempHandle = await this.assemble({
      projectRoot: ws.root,
      workspaceRoot: ws.root,
      checkpoints: this.checkpoints,
      worktrees: this.worktrees,
      executionCoordinator: this.executionCoordinator,
      homeDirectory: this.workspaces.home,
      conversationId,
      approvalChannel: { requestApproval: async () => 'deny_once' },
      leaseCoordinator: this.leases,
      maxReadBytes: LIMITS.history,
    });
    try {
      return await tempHandle.createBranchWithSummary(targetBranchId, {
        ...(baseRecordId ? { baseRecordId } : {}),
      });
    } finally {
      await tempHandle.dispose();
    }
  }

  /** 斜杠命令执行：与 CLI 同一分发器；输出收集为 feedback，交互经对话框往返。 */
  private async command(p: {
    workspaceId: string;
    sessionId: string;
    input: string;
  }): Promise<Output<'run.command'>> {
    this.workspaces.get(p.workspaceId, true);
    const slot = this.slot(p);
    const workspace = this.workspaces.get(p.workspaceId);
    const loaded: LoadedSettings = loadSettings({
      homeDir: this.workspaces.home,
      cwd: workspace.root,
      includeProject: workspace.trusted,
    });
    const feedback: string[] = [];
    // 斜杠命令取首个 token，裸退出别名（exit/quit）只匹配单词条：'exit now' 这类
    // 带空格的自然语言输入不是命令，必须继续交给模型处理。
    const trimmed = p.input.trim();
    const isCommand = trimmed.startsWith('/') || /^\S+$/.test(trimmed);
    const commandToken = isCommand
      ? trimmed.replace(/^\//, '').split(/\s+/)[0]?.toLowerCase()
      : undefined;
    const definition = commandToken ? this.commands.getDefinition(commandToken) : undefined;
    // getDefinition 已把别名归一到主名（quit → exit），未注册的输入交给 dispatcher 报未知命令。
    const unhandled = definition ? DESKTOP_UNHANDLED_COMMANDS.get(definition.name) : undefined;
    if (unhandled) {
      // 明确反馈而不是静默空操作：占位回调式的假成功会直接损害对命令系统的信任。
      feedback.push(unhandled);
      return { handled: true, feedback };
    }
    // /skill <名称> 无任务直发：与 CLI 同样使用宿主合成启动任务满足 core 的非空 userInput 约束，
    // 在此提前进入 start 收据管线，确保忙碌门禁与同步拒绝直接呈现为命令反馈。
    const skillOnly = /^\/skill\s+(\S+)\s*$/.exec(trimmed);
    if (skillOnly) {
      const kickoff = EXPLICIT_SKILL_KICKOFF;
      try {
        await this.start(
          {
            workspaceId: p.workspaceId,
            sessionId: p.sessionId,
            operationId: randomUUID(),
            input: kickoff,
          },
          (handle) => handle.runSkill(skillOnly[1], kickoff),
        );
      } catch (error) {
        feedback.push(`技能执行失败: ${(error as Error).message}`);
      }
      return { handled: true, feedback };
    }
    const handled = await this.commands.dispatch(
      p.input,
      this.commandContext(slot, feedback, loaded),
    );
    return { handled, feedback };
  }

  private get commands() {
    if (!this.commandDispatcher) this.commandDispatcher = createDefaultCommandDispatcher();
    return this.commandDispatcher;
  }

  /**
   * 会话技能目录的有界投影，供 `/` 补全面板的技能组。
   * 过滤口径与 CLI 的 `/skill ` 名字补全一致（userInvocable 且 available 且未禁用）：
   * 面板据此承诺「当前会话现在就能跑」——运行时 registry 不含会话启动后新增或
   * 改变信任状态的技能，不会虚列。诊断、激活态与目录预算不进此面（仍走
   * session.inspect），description 截 256 字符并给 truncated 标志，防止超大
   * 技能目录撑爆 wire 载荷。
   */
  private skillCatalog(p: { workspaceId: string; sessionId: string }): Output<'run.skillCatalog'> {
    const slot = this.slot(p);
    const catalog = slot.handle.session.getSkills();
    const limit = 500;
    const filtered = catalog.skills.filter(
      (skill) => skill.userInvocable && skill.available && !skill.disabled,
    );
    const skills = filtered.slice(0, limit).map((skill) => ({
      name: skill.name,
      description:
        skill.description.length > 256 ? `${skill.description.slice(0, 256)}…` : skill.description,
      scope: skill.scope,
    }));
    return {
      installed: catalog.skills.length > 0,
      skills,
      truncated: filtered.length > limit,
    };
  }

  /**
   * 构造桌面侧 CommandContext：会话来自托管槽位，交互经对话框往返，输出进命令反馈。
   * question/select/readSecret 三个交互端口由对话框真实承接；依赖 CLI 宿主回调的
   * 命令（model/exit）已被 dispatch 前的门禁拦截，回调在此仅作兜底——若被绕过
   * 必须显式抛错，绝不静默空操作制造假成功。
   */
  private commandContext(slot: Slot, feedback: string[], loaded: LoadedSettings): CommandContext {
    const requestInteraction = async (
      kind: 'question' | 'secret' | 'select',
      prompt: string,
      options?: { value: string; label: string }[],
    ): Promise<string | undefined> => {
      if (this.interactionPending.size >= LIMITS.approvals) throw new Error('INTERACTION_LIMIT');
      const requestId = randomUUID();
      const promise = new Promise<string | undefined>((resolve) => {
        const timer = setTimeout(() => {
          const pending = this.interactionPending.get(requestId);
          if (pending) {
            this.interactionPending.delete(requestId);
            pending.resolve(undefined);
            this.notify(
              {
                ...slot.scope,
                type: 'interaction.closed',
                requestId,
                reason: 'timeout',
              },
              'data',
            ).catch(() => {});
          }
        }, LIMITS.approvalTimeout);
        this.interactionPending.set(requestId, {
          sessionId: slot.scope.sessionId,
          timer,
          resolve,
        });
      });
      this.notify(
        {
          ...slot.scope,
          type: 'interaction.requested',
          requestId,
          kind,
          prompt,
          ...(options ? { options } : {}),
        },
        'data',
      ).catch(() => {});
      return await promise;
    };
    const output: CommandOutput = {
      log: (message) => feedback.push(message),
      error: (message) => feedback.push(message),
      write: (text) => feedback.push(text),
    };
    const workspace = this.workspaces.get(slot.scope.workspaceId);
    return {
      session: slot.handle.session,
      settings: loaded.settings,
      output,
      // 透传隔离 HOME、实际配置路径与项目根：命令介导的全局/项目写入（默认模型/路由/密钥/MCP/技能导入）
      // 必须落在当前工作区与 workspaces.home，settings 读取也要如实报告来源而不是「使用内置默认」。
      homeDir: this.workspaces.home,
      settingsPath: loaded.sourcePath,
      projectRoot: workspace.root,
      watches: {
        list: () => slot.handle.watches(),
        cancel: (watchId) => slot.handle.cancelWatch(watchId),
      },
      scanImportableSkills: (scope) =>
        scanImportableSkills({
          homeDir: this.workspaces.home,
          projectRoot: workspace.root,
          projectTrusted: workspace.trusted,
          settings: loadSettings({
            homeDir: this.workspaces.home,
            cwd: workspace.root,
            includeProject: workspace.trusted,
          }).settings,
          scope,
        }),
      importSkills: (request) =>
        importSkills({
          homeDir: this.workspaces.home,
          projectRoot: workspace.root,
          projectTrusted: workspace.trusted,
          settings: loadSettings({
            homeDir: this.workspaces.home,
            cwd: workspace.root,
            includeProject: workspace.trusted,
          }).settings,
          scope: request.scope,
          items: request.items,
          overwrite: request.overwrite,
        }),
      // 门禁外的兜底：正常路径不会到达（model/exit 已在 dispatch 前拦截）。
      onModelSwitched: () => {
        throw new Error('桌面端不支持会话内模型切换；请使用设置面板管理模型。');
      },
      onExit: async () => {
        throw new Error('桌面端没有退出命令；请直接关闭窗口或会话标签。');
      },
      isInputBusy: () => false,
      question: (prompt) => requestInteraction('question', prompt),
      readSecret: async (prompt) => (await requestInteraction('secret', prompt)) ?? '',
      select: async <T>(config: SelectConfig<T>) => {
        const reply = await requestInteraction(
          'select',
          config.message,
          config.options.map((option) => ({
            value: String(option.value),
            label: option.label,
          })),
        );
        if (reply === undefined) return null;
        const match = config.options.find((option) => String(option.value) === reply);
        return match ? match.value : null;
      },
      dispatcher: this.commands,
      external: this.external,
      checkpoints: this.checkpoints,
      worktrees: this.worktrees,
      executionRoot: (() => {
        const slotWt = slot.handle.worktree();
        return slotWt &&
          fs.existsSync(slotWt.worktreePath) &&
          this.worktrees.verifyLink(workspace.root, slotWt.worktreePath)
          ? toNativePhysicalPath(slotWt.worktreePath)
          : workspace.root;
      })(),
      onCheckpointRestored: () => {
        this.inspectionChanged(slot);
      },
      onBeforeRemoveWorktree: async (rec) => {
        await this.closeIdleResourcesInWorktree(workspace.id, workspace.root, rec.worktreePath);
      },
      runSkill: async (name, task) => {
        // 显式技能走与 run.start 相同的收据管线：忙碌反映、事件流、取消语义保持一致。
        // 必须 await：start 的同步门禁（忙碌/展示未就绪/限额）拒绝时要把失败
        // 交回 dispatcher 输出为命令反馈——fire-and-forget 会让失败静默消失，
        // 用户只会看到「什么都没发生」。
        await this.start(
          {
            workspaceId: slot.scope.workspaceId,
            sessionId: slot.scope.sessionId,
            operationId: randomUUID(),
            input: task,
          },
          (handle) => handle.runSkill(name, task),
        );
      },
    };
  }

  private async startWithOptionalRestore(
    p: import('../shared/contracts.js').Params<'run.start'>,
  ): Promise<RunReceipt> {
    return this.start(p);
  }

  private async regenerate(
    p: import('../shared/contracts.js').Params<'run.regenerate'>,
  ): Promise<RunReceipt> {
    return this.start({
      workspaceId: p.workspaceId,
      sessionId: p.sessionId,
      operationId: p.operationId ?? randomUUID(),
      input: p.input?.trim() || '<regenerate>',
      regenerate: true,
      ...(p.restoreFiles !== undefined ? { restoreFiles: p.restoreFiles } : {}),
      ...(p.force !== undefined ? { force: p.force } : {}),
      ...(p.targetMessageId !== undefined ? { targetMessageId: p.targetMessageId } : {}),
    });
  }

  private async start(
    p: {
      workspaceId: string;
      sessionId: string;
      operationId: string;
      input: string;
      /** 重试：托管层在持有写租约后按目标轮次身份对齐检查点并回退重跑。 */
      regenerate?: boolean;
      restoreFiles?: boolean;
      force?: boolean;
      /** 可选目标历史用户消息 ID；缺省重试最后一轮。 */
      targetMessageId?: string;
      /** 跨代理接力上下文。 */
      handoff?: { readonly fromTitle: string; readonly context: string };
      /** 跨会话引用身份选择。 */
      references?: readonly {
        readonly sessionId: string;
        readonly recordId?: string;
        readonly branchId?: string;
      }[];
    },
    execute?: (handle: ManagedHostSession) => Promise<void>,
  ): Promise<RunReceipt> {
    this.workspaces.get(p.workspaceId, true);
    const slot = this.slot(p);
    this.settleIfDone(slot);
    const digest = createHash('sha256').update(JSON.stringify(p)).digest('hex');
    const known = this.operations.get(p.operationId);
    if (known) {
      if (known.digest !== digest) throw new Error('OPERATION_CONFLICT');
      return known.pending ? await known.pending : { ...known.receipt };
    }
    if (slot.cleanupFailed) throw new Error('SESSION_CLEANUP_FAILED');
    if (slot.closing || slot.handle.isBusy() || (slot.run && slot.run.phase !== 'idle'))
      throw new Error('SESSION_BUSY');
    if (!slot.view?.installed || !slot.view.valid) throw new Error('PRESENTATION_STALE');
    if (this.operations.size >= LIMITS.operations) {
      this.evictSettledOperations();
      if (this.operations.size >= LIMITS.operations) throw new Error('OPERATION_LIMIT');
    }
    if (this.counts().runs >= LIMITS.runs) throw new Error('RUN_LIMIT');
    slot.redact = this.settings.captureRedactor(p.workspaceId);
    slot.cancellation = undefined;
    const receipt: RunReceipt = {
      ...slot.scope,
      runId: randomUUID(),
      operationId: p.operationId,
      phase: 'running',
      startedAt: Date.now(),
    };
    const awaitPreFlight = !execute && Boolean(p.regenerate && p.restoreFiles);
    let resolvePreFlight: (() => void) | undefined;
    let rejectPreFlight: ((err: unknown) => void) | undefined;
    let preFlightSettled = !awaitPreFlight;
    const preFlightPromise = awaitPreFlight
      ? new Promise<void>((resolve, reject) => {
          resolvePreFlight = () => {
            if (preFlightSettled) return;
            preFlightSettled = true;
            resolve();
          };
          rejectPreFlight = (err: unknown) => {
            if (preFlightSettled) return;
            preFlightSettled = true;
            reject(err);
          };
        })
      : undefined;

    slot.run = receipt;
    const operationEntry: { digest: string; receipt: RunReceipt; pending?: Promise<RunReceipt> } = {
      digest,
      receipt,
    };
    this.operations.set(p.operationId, operationEntry);
    this.emitRun(slot);
    slot.running = (
      execute
        ? execute(slot.handle)
        : p.references && p.references.length > 0 && !p.regenerate
          ? slot.handle.runWithReferences(
              p.input,
              p.references.map((ref) => ({
                sessionId: ref.sessionId,
                ...(ref.recordId !== undefined ? { recordIds: [ref.recordId] } : {}),
                ...(ref.branchId !== undefined ? { branchId: ref.branchId } : {}),
              })),
            )
          : slot.handle.run(p.input, undefined, {
              regenerate: p.regenerate,
              restoreFiles: p.restoreFiles,
              forceRestore: p.force,
              ...(p.targetMessageId ? { targetMessageId: p.targetMessageId } : {}),
              ...(awaitPreFlight ? { onBeforeModelStart: resolvePreFlight } : {}),
              ...(p.handoff ? { handoff: p.handoff } : {}),
            })
    )
      .then(
        () => {
          resolvePreFlight?.();
          receipt.result = slot.handle.snapshot().operation?.result ?? 'completed';
        },
        (error) => {
          rejectPreFlight?.(error);
          receipt.result = 'failed';
          receipt.error = safeError(error);
        },
      )
      .then(async () => {
        try {
          await slot.cancellation;
        } catch {
          receipt.error = safeError(new Error('SESSION_CLEANUP_FAILED'));
        }
        receipt.phase = slot.handle.isBusy() ? 'settling' : 'idle';
        if (receipt.phase === 'idle') receipt.settledAt = Date.now();
        this.emitRun(slot);
      });

    if (preFlightPromise) {
      const pendingReceipt = preFlightPromise
        .then(() => {
          operationEntry.pending = undefined;
          return { ...receipt };
        })
        .catch(async (err) => {
          await slot.running;
          // 前置还原冲突或目标失效在模型启动前即中止，释放 operationId 便于用户确认覆盖后重试。
          if (this.operations.get(p.operationId) === operationEntry) {
            this.operations.delete(p.operationId);
          }
          throw err;
        });
      operationEntry.pending = pendingReceipt;
      return await pendingReceipt;
    }

    return { ...receipt };
  }

  /**
   * 监视自动续跑：与前台 `start` 共用同一份 `slot.run` 收据、审批准入与 `run.cancel` 停止能力，
   * 同时允许后台会话标签（`slot.view === undefined`）在不要求前台视图订阅的前提下安全推进。
   */
  private async autoResume(slot: Slot, input: string, signal: AbortSignal): Promise<void> {
    if (this.dead || signal.aborted || slot.cleanupFailed || slot.closing) return;
    this.settleIfDone(slot);
    if (slot.handle.isBusy() || (slot.run && slot.run.phase !== 'idle')) return;
    if (this.counts().runs >= LIMITS.runs) return;
    if (slot.view && (!slot.view.installed || !slot.view.valid)) return;
    slot.redact = this.settings.captureRedactor(slot.scope.workspaceId);
    slot.cancellation = undefined;
    const operationId = randomUUID();
    const receipt: RunReceipt = {
      ...slot.scope,
      runId: randomUUID(),
      operationId,
      phase: 'running',
      startedAt: Date.now(),
    };
    slot.run = receipt;
    this.emitRun(slot);
    slot.running = slot.handle
      .run(input, signal)
      .then(
        () => {
          receipt.result = slot.handle.snapshot().operation?.result ?? 'completed';
        },
        (error) => {
          receipt.result = 'failed';
          receipt.error = safeError(error);
        },
      )
      .then(async () => {
        try {
          await slot.cancellation;
        } catch {
          receipt.error = safeError(new Error('SESSION_CLEANUP_FAILED'));
        }
        receipt.phase = slot.handle.isBusy() ? 'settling' : 'idle';
        if (receipt.phase === 'idle') receipt.settledAt = Date.now();
        this.emitRun(slot);
      });
    await slot.running;
  }
  /** settling 只是「清理尚未确认」的过渡态；清理完成后没有任何事件会再推进它，
   *  这里在读取与新建运行两个入口复查，避免收据永久卡在 settling 导致会话无法再次运行。 */
  private settleIfDone(slot: Slot): void {
    if (slot.run?.phase === 'settling' && !slot.handle.isBusy()) {
      slot.run.phase = 'idle';
      slot.run.settledAt = Date.now();
      this.emitRun(slot);
    }
  }
  /** 幂等记录只为拦截在途或结果未明的重放；已收口的终态收据按容量淘汰，
   *  防止长期使用把记录累积到硬上限后所有新发送永久失败。被淘汰的旧 ID 重放等同新发送。 */
  private evictSettledOperations(): void {
    for (const [operationId, entry] of this.operations)
      if (entry.receipt.phase === 'idle' && entry.receipt.settledAt !== undefined)
        this.operations.delete(operationId);
  }
  private emitRun(slot: Slot): void {
    this.runtimeChanged();
    this.inspectionChanged(slot);
    if (slot.run && !this.dead)
      void this.notify({ type: 'run.changed', receipt: { ...slot.run } }, 'control').catch(
        () => {},
      );
  }
  private approve(
    slot: Slot,
    request: ApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalChoice> {
    this.settleIfDone(slot);
    if (
      this.dead ||
      slot.closing ||
      !this.sessions.has(slot.scope.sessionId) ||
      signal?.aborted ||
      this.approvals.size >= LIMITS.approvals
    )
      return Promise.resolve('deny_once');
    const approvalId = randomUUID();
    const runId =
      slot.run && slot.run.phase !== 'idle'
        ? slot.run.runId
        : request.subagentOrigin
          ? `subagent:${request.subagentOrigin.agentId}`
          : 'background';
    const subagentOrigin = request.subagentOrigin
      ? {
          agentId: request.subagentOrigin.agentId,
          role: request.subagentOrigin.role,
          description:
            sanitizeDisplayText(slot.redact(request.subagentOrigin.description), 400) ||
            request.subagentOrigin.role,
          ...(request.subagentOrigin.childSessionId
            ? { childSessionId: request.subagentOrigin.childSessionId }
            : {}),
          parentSessionId: request.subagentOrigin.parentSessionId,
        }
      : undefined;
    return new Promise((resolve) => {
      const finish = (choice: ApprovalChoice, reason: 'resolved' | 'timeout' | 'aborted') => {
        if (!this.approvals.delete(approvalId)) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.runtimeChanged();
        if (!this.dead)
          void this.notify({ type: 'approval.closed', approvalId, reason }, 'control').catch(
            () => {},
          );
        resolve(choice);
      };
      const abort = () => finish('deny_once', 'aborted');
      // 超时按拒绝收尾并显式广播 reason，让渲染层能解释「没有审批入口却出现 PERMISSION_DENIED」。
      const timer = setTimeout(() => finish('deny_once', 'timeout'), LIMITS.approvalTimeout);
      this.approvals.set(approvalId, {
        slot,
        runId,
        sessionAllowed: request.sessionAllowed === true,
        finish,
      });
      this.runtimeChanged();
      signal?.addEventListener('abort', abort, { once: true });
      void this.notify(
        {
          type: 'approval.requested',
          workspaceName: this.workspaces.get(slot.scope.workspaceId).name,
          workspaceRoot: this.workspaces.get(slot.scope.workspaceId).root,
          conversationId: slot.handle.conversationId,
          ...slot.scope,
          runId,
          approvalId,
          toolName: slot.redact(request.toolName),
          capabilities: [...(request.capabilities ?? [])],
          description: slot.redact(JSON.stringify(request.input ?? {})).slice(0, 10_000),
          sessionAllowed: request.sessionAllowed === true,
          expiresAt: Date.now() + LIMITS.approvalTimeout,
          ...(subagentOrigin ? { subagentOrigin } : {}),
        },
        'control',
      ).catch(abort);
    });
  }
  private subscribe(slot: Slot, subscriptionId: string): void {
    slot.view?.unsubscribe();
    const view: View = {
      id: subscriptionId,
      unsubscribe: () => {},
      snapshotId: randomUUID(),
      sequence: 0,
      posted: false,
      valid: true,
      installed: false,
      buffer: [],
      bytes: 0,
    };
    slot.view = view;
    slot.inspectionStream?.subscribe(subscriptionId);
    view.unsubscribe = slot.handle.subscribeEvents((event) => {
      if (slot.view !== view || !view.valid) return;
      if (!view.installed) {
        const bytes = encodedBytes(event);
        if (view.bytes + bytes > LIMITS.dataWindow) {
          this.invalidate(slot, view, 'OUTPUT_CONGESTED');
          return;
        }
        view.buffer.push(event);
        view.bytes += bytes;
      } else this.publish(slot, view, event);
    });
    const state = slot.handle.snapshot();
    view.sequence = state.sequence;
    // 订阅与快照捕获同处同步边界；只缓存水位之后的增量，不从合并通知反推 delta。
    void (async () => {
      try {
        const chunks = [
          ...snapshotChunks({ ...slot.scope, subscriptionId: view.id }, view.snapshotId, state),
        ];
        for (const chunk of chunks) {
          if (slot.view !== view || !view.valid || this.dead) return;
          if (chunk.index === chunk.count - 1) view.posted = true;
          await this.notify({ ...chunk, subscriptionId: view.id }, 'data');
        }
      } catch (error) {
        this.invalidate(
          slot,
          view,
          error instanceof Error && error.message === 'SNAPSHOT_TOO_LARGE'
            ? 'SNAPSHOT_TOO_LARGE'
            : 'OUTPUT_CONGESTED',
        );
      }
    })();
  }
  private publish(slot: Slot, view: View, event: PresentationEvent): void {
    if (slot.view !== view || !view.valid || event.sequence <= view.sequence) return;
    const notification: Notification = {
      type: 'presentation.event',
      ...slot.scope,
      subscriptionId: view.id,
      event: PresentationEventSchema.parse(event),
    };
    if (encodedBytes(notification) > LIMITS.frame - 1024) {
      this.invalidate(slot, view, 'PRESENTATION_STALE');
      // 超大提交要求页面显式换订阅重同步；不复用旧身份，避免迟到分块覆盖新快照。
      return;
    }
    void this.notify(notification, 'data').catch(() =>
      this.invalidate(slot, view, 'OUTPUT_CONGESTED'),
    );
  }
  private invalidate(slot: Slot, view: View, reason: string): void {
    if (slot.view !== view || !view.valid) return;
    view.valid = false;
    view.installed = false;
    view.buffer = [];
    view.bytes = 0;
    view.unsubscribe();
    if (!this.dead)
      void this.notify(
        {
          type: 'presentation.invalidated',
          ...slot.scope,
          subscriptionId: view.id,
          reason,
        },
        'control',
      ).catch(() => {});
  }
}
