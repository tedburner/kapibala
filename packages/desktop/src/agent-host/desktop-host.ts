import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  type ApprovalChannel,
  type ApprovalChoice,
  type ApprovalRequest,
  type SessionManager,
  WorkspaceLeaseCoordinator,
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
// 启动任务文本只在宿主内部约定里共享：它不进入公共导出面，投影与直发两处必须同一个常量。
import { EXPLICIT_SKILL_KICKOFF } from '@kiturone/kapibala-host/internal';
import type { PresentationEvent } from '@kiturone/kapibala-host/view-model';
import {
  LIMITS,
  type Method,
  type Notification,
  type Output,
  PARAMS,
  PresentationEventSchema,
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
import { Workspaces } from './workspaces.js';

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
  private readonly leases = new WorkspaceLeaseCoordinator();
  private readonly sessions = new Map<string, Slot>();
  private readonly operations = new Map<string, { digest: string; receipt: RunReceipt }>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly openings = new Set<Promise<unknown>>();
  private dead = false;
  private runtimeRevision = 0;
  private readonly runtimeStream: LatestSnapshot<RuntimeSnapshot>;
  constructor(
    home: string,
    private readonly notify: (event: Notification, lane?: Lane) => Promise<void>,
    private readonly assemble = createManagedSession,
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
      case 'workspace.listFiles':
        return this.listFiles(PARAMS[method].parse(params).workspaceId);
      case 'settings.read':
        return this.settings.read(PARAMS[method].parse(params).workspaceId);
      case 'settings.saveProfile': {
        const p = PARAMS[method].parse(params);
        return this.settings.saveProfile(p.profile, p.apiKey, p.editId);
      }
      case 'settings.listModels': {
        const p = PARAMS[method].parse(params);
        return {
          models: await this.settings.listModels(p.baseURL, p.apiKey, p.profileId),
        };
      }
      case 'settings.setDefault':
        this.settings.setDefault(PARAMS[method].parse(params).profileId);
        return {};
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
      case 'session.create': {
        const p = PARAMS[method].parse(params);
        return this.open(p.workspaceId, undefined, p.profileId);
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
      case 'session.configure': {
        const p = PARAMS[method].parse(params);
        const slot = this.slot(p);
        this.workspaces.get(p.workspaceId, true);
        if (slot.cleanupFailed) throw new Error('SESSION_CLEANUP_FAILED');
        if (slot.closing) throw new Error('SESSION_BUSY');
        if (p.mode === 'FullAccess' && p.confirmFullAccess !== true) throw new Error('FORBIDDEN');
        slot.handle.configure({
          profileId: p.profileId,
          role: p.role,
          mode: p.mode,
        });
        return slot.handle.configuration();
      }
      case 'run.start':
        return this.start(PARAMS[method].parse(params));
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
      default:
        throw new Error('FORBIDDEN');
    }
  }

  /** 控制失联先撤销审批再清理全部句柄；任何失败均阻断新控制连接。 */
  async disconnect(): Promise<void> {
    this.dead = true;
    this.runtimeStream.close();
    for (const pending of [...this.approvals.values()]) pending.finish('deny_once', 'aborted');
    const openings = await Promise.allSettled([...this.openings]);
    const results = await Promise.allSettled(
      [...this.sessions.values()].map((slot) => this.close(slot)),
    );
    if (
      openings.some(
        (item) =>
          item.status === 'rejected' &&
          (!(item.reason instanceof Error) || item.reason.message !== 'HOST_UNAVAILABLE'),
      )
    )
      throw new Error('SESSION_CLEANUP_FAILED');
    if (results.some((item) => item.status === 'rejected'))
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

  private open(workspaceId: string, conversationId?: string, initialProfileId?: string) {
    const task = this.openSession(workspaceId, conversationId, initialProfileId);
    this.openings.add(task);
    void task.finally(() => this.openings.delete(task)).catch(() => {});
    return task;
  }
  private async openSession(
    workspaceId: string,
    conversationId?: string,
    initialProfileId?: string,
  ) {
    const workspace = this.workspaces.get(workspaceId, true);
    const known = [...this.sessions.values()].find(
      (slot) =>
        slot.scope.workspaceId === workspaceId && slot.handle.conversationId === conversationId,
    );
    if (known?.cleanupFailed) throw new Error('SESSION_CLEANUP_FAILED');
    if (known?.closing) throw new Error('SESSION_BUSY');
    if (known)
      return {
        ...known.scope,
        conversationId: known.handle.conversationId,
        configuration: known.handle.configuration(),
      };
    if (this.sessions.size + this.openings.size >= LIMITS.sessions)
      throw new Error('SESSION_LIMIT');
    const scope = { workspaceId, sessionId: randomUUID() };
    let slot: Slot | undefined;
    const approvalChannel: ApprovalChannel = {
      requestApproval: (request, signal) =>
        slot ? this.approve(slot, request, signal) : Promise.resolve('deny_once'),
    };
    {
      const handle = await this.assemble({
        workspaceRoot: workspace.root,
        homeDirectory: this.workspaces.home,
        conversationId,
        initialProfileId,
        approvalChannel,
        leaseCoordinator: this.leases,
        maxReadBytes: LIMITS.history,
      });
      if (this.dead) {
        await handle.dispose();
        throw new Error('HOST_UNAVAILABLE');
      }
      slot = {
        scope,
        handle,
        redact: (text) => redactText(text, []),
        inspectionRevision: 0,
      };
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
      this.sessions.set(scope.sessionId, slot);
      this.runtimeChanged();
      return {
        ...scope,
        conversationId: handle.conversationId,
        configuration: handle.configuration(),
      };
    }
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
      })),
    };
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
    if (slot) {
      if (slot.closing) throw new Error('SESSION_BUSY');
      if (slot.run && slot.run.phase !== 'idle') throw new Error('SESSION_IN_USE');
      await this.close(slot);
    }
    const manager = this.workspaces.manager(workspaceId);
    try {
      if (method === 'session.archive') await manager.archiveSession(conversationId);
      else if (method === 'session.restore') await manager.restoreSession(conversationId);
      else await manager.deleteSession(conversationId);
    } finally {
      await manager.close();
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
      await slot.handle.dispose();
      await slot.running;
      slot.view?.unsubscribe();
      slot.inspectionStream?.close();
      slot.stopInspection?.();
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
  /** 工作区文件路径枚举（相对路径清单），供 composer @ 文件补全。
   * 保证：仅枚举受信任工作区（requireTrust），条目/深度双重预算，命中预算即截断明示；
   * 通用忽略目录（依赖、构建产物、版本库元数据）一律跳过；只返回路径，不读文件内容。 */
  private listFiles(workspaceId: string): Output<'workspace.listFiles'> {
    const workspace = this.workspaces.get(workspaceId, true);
    const root = workspace.root;
    const ignored = new Set([
      'node_modules',
      '.git',
      'dist',
      'out',
      'build',
      'coverage',
      'test-results',
      'playwright-report',
    ]);
    const maxFiles = 5000;
    const maxDepth = 16;
    const files: string[] = [];
    let truncated = false;
    const walk = (dir: string, depth: number): void => {
      if (files.length >= maxFiles || depth > maxDepth) {
        truncated = true;
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (files.length >= maxFiles || truncated) {
          truncated = true;
          return;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (ignored.has(entry.name) || entry.name.startsWith('.')) continue;
          walk(full, depth + 1);
        } else if (entry.isFile()) {
          files.push(path.relative(root, full));
        }
      }
    };
    walk(root, 0);
    return { files, truncated };
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
    // /skill <名称> 无任务直发：桌面把「选技能即运行」作为一等交互（CLI 仍要求显式
    // 任务并走 dispatcher 校验）。core 对显式技能要求非空 userInput（canonical 历史
    // 不变量），此处合成启动任务并走与 runSkill 相同的收据管线；start 的同步门禁
    // 拒绝必须以命令反馈可见，不能静默消失。
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
    return {
      session: slot.handle.session,
      settings: loaded.settings,
      output,
      // 透传隔离 HOME 与实际配置路径：命令介导的全局写入（默认模型/路由/密钥）必须
      // 落在 workspaces.home，settings 读取也要如实报告来源而不是「使用内置默认」。
      homeDir: this.workspaces.home,
      settingsPath: loaded.sourcePath,
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

  private start(
    p: {
      workspaceId: string;
      sessionId: string;
      operationId: string;
      input: string;
    },
    execute?: (handle: ManagedHostSession) => Promise<void>,
  ): RunReceipt {
    this.workspaces.get(p.workspaceId, true);
    const slot = this.slot(p);
    this.settleIfDone(slot);
    const digest = createHash('sha256').update(JSON.stringify(p)).digest('hex');
    const known = this.operations.get(p.operationId);
    if (known) {
      if (known.digest !== digest) throw new Error('OPERATION_CONFLICT');
      return { ...known.receipt };
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
    slot.run = receipt;
    this.operations.set(p.operationId, { digest, receipt });
    this.emitRun(slot);
    slot.running = (execute ? execute(slot.handle) : slot.handle.run(p.input))
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
    return { ...receipt };
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
    if (this.dead || !slot.run || signal?.aborted || this.approvals.size >= LIMITS.approvals)
      return Promise.resolve('deny_once');
    const approvalId = randomUUID();
    const runId = slot.run.runId;
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
