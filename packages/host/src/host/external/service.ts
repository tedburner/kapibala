import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ViewExternalApproval,
  ViewExternalHarness,
  ViewExternalHarnessProbe,
  ViewExternalSession,
  ViewExternalSessionStatus,
  ViewExternalSnapshot,
  ViewExternalTemplate,
  ViewNotice,
  ViewOperation,
} from '../../view-model/index.js';
import { loadCredentialSecrets } from '../managed-session.js';
import { redactText, sanitizeDisplayText } from '../redaction.js';
import { normalizeProjectRoot } from '../resource/mcp-approval.js';
import { isProjectTrusted, loadSettings } from '../settings.js';
import {
  type BuiltinHarnessOverride,
  type CustomExternalHarnessInput,
  computeHarnessConfigDigest,
  listResolvedExternalHarnesses,
  removeCustomExternalHarness,
  resetBuiltinHarnessOverride,
  saveBuiltinHarnessOverride,
  toggleExternalHarness,
  upsertCustomExternalHarness,
} from './config.js';
import { AcpStdioDriver } from './drivers/acp/acp-driver.js';
import { ExternalTranscriptProjector } from './drivers/acp/projector.js';
import { ACP_REGISTRY_TEMPLATES } from './presets.js';
import { type ExternalSessionRecord, ExternalSessionRegistry } from './registry.js';
import {
  type ExternalApprovalDecision,
  type ExternalDriverSessionHandle,
  type ExternalEvent,
  type ExternalHarnessDefinition,
  type ExternalHarnessDriver,
  ExternalHarnessError,
  type ExternalTransportKind,
} from './types.js';

/** 宿主全局并发活跃外部子进程硬上限。 */
export const MAX_ACTIVE_EXTERNAL_PROCESSES = 4;
/** 流式文本/思考 chunk 合并推送窗口（50ms），避免高频单字符增量淹没 IPC。 */
const STREAM_COALESCE_MS = 50;
/** 外部审批请求默认到期时间（120 秒；到期自动按取消拒绝，绝不自动放行）。 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
/** 空闲外部子进程自动回收时间（30 分钟；回收后保留会话记录与只读展示快照）。 */
const DEFAULT_IDLE_REAP_MS = 30 * 60_000;

interface LiveApprovalEntry {
  readonly view: ViewExternalApproval;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly respond: (decision: ExternalApprovalDecision) => void;
}

interface LiveSessionSlot {
  record: ExternalSessionRecord;
  handle: ExternalDriverSessionHandle;
  readonly projector: ExternalTranscriptProjector;
  readonly approvals: Map<string, LiveApprovalEntry>;
  readonly notices: ViewNotice[];
  operation?: ViewOperation;
  sequence: number;
  coalesceTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  truncatedArchive: boolean;
  readonly secrets: readonly string[];
}

/** `ExternalSessionService` 构造参数。 */
export interface ExternalSessionServiceOptions {
  readonly homeDir?: string;
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  readonly drivers?: Partial<Record<ExternalTransportKind, ExternalHarnessDriver>>;
  readonly isWorkspaceTrusted?: (workspaceRoot: string) => boolean;
  readonly approvalTimeoutMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxActiveProcesses?: number;
  /** 后台外部任务完成、失败或待审批时的事件钩子（供桌面宿主触发失焦通知或 Toast）。 */
  readonly onAttentionEvent?: (event: {
    readonly kind: 'approval_requested' | 'turn_completed' | 'turn_failed';
    readonly session: ViewExternalSession;
  }) => void;
}

/**
 * 外部代理工作台核心编排服务（CLI、本地 Daemon 与桌面 `DesktopHost` 共用真源）。
 *
 * 承担职责：
 * 1. 管理内置预设覆写、官方模板查询、自定义 `Local ACP Command` CRUD 与连接探测缓存；
 * 2. 强制执行 `isProjectTrusted`、全局 4 进程容量上限与同工作区单运行态外部会话互斥；
 * 3. 50ms 流式文本合并、120s 审批到期自动取消、30 分钟空闲子进程回收；
 * 4. 解耦「有界只读展示快照归档」与「`resumable` + `configDigest` 连续性恢复门禁」。
 */
export class ExternalSessionService {
  private readonly homeDir: string;
  private readonly registry: ExternalSessionRegistry;
  private readonly drivers: Partial<Record<ExternalTransportKind, ExternalHarnessDriver>>;
  private readonly probeCache = new Map<string, ViewExternalHarnessProbe>();
  private readonly liveSlots = new Map<string, LiveSessionSlot>();
  private readonly listSubscribers = new Set<(workspaceRoot?: string) => void>();
  private readonly sessionSubscribers = new Map<
    string,
    Set<(snapshot: ViewExternalSnapshot) => void>
  >();
  private readonly approvalTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly maxActiveProcesses: number;
  private disposed = false;

  constructor(private readonly options: ExternalSessionServiceOptions = {}) {
    this.homeDir = options.homeDir ?? os.homedir();
    this.registry = new ExternalSessionRegistry({ homeDir: this.homeDir });
    this.approvalTimeoutMs = options.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_REAP_MS;
    this.maxActiveProcesses = options.maxActiveProcesses ?? MAX_ACTIVE_EXTERNAL_PROCESSES;
    this.drivers = {
      acp: new AcpStdioDriver({
        homeDir: this.homeDir,
        hostEnv: options.hostEnv,
      }),
      ...options.drivers,
    };
  }

  /** 注册或替换指定传输类型的驱动（供 M3 注入 `claude-cli` / `codex-app-server` 或单测替身）。 */
  registerDriver(driver: ExternalHarnessDriver): void {
    this.drivers[driver.transport] = driver;
  }

  /** 列出合并后的全部外部代理定义（附最近一次探测快照）及官方 ACP Registry 模板。 */
  listHarnesses(): {
    readonly harnesses: ViewExternalHarness[];
    readonly templates: readonly ViewExternalTemplate[];
  } {
    const resolved = listResolvedExternalHarnesses({ homeDir: this.homeDir });
    const harnesses: ViewExternalHarness[] = resolved.map(({ definition, hasOverride }) => {
      const probe = this.probeCache.get(definition.id);
      return {
        id: definition.id,
        name: definition.name,
        transport: definition.transport,
        command: definition.command,
        args: definition.args,
        envFrom: definition.envFrom ?? [],
        builtin: Boolean(definition.builtin),
        ...(definition.registryId ? { registryId: definition.registryId } : {}),
        hasOverride,
        enabled: definition.enabled,
        ...(probe ? { probe } : {}),
      };
    });
    return {
      harnesses,
      templates: ACP_REGISTRY_TEMPLATES,
    };
  }

  /** 保存内置代理的增量覆写并使旧探测缓存失效。 */
  saveBuiltinOverride(id: string, override: BuiltinHarnessOverride): ViewExternalHarness[] {
    saveBuiltinHarnessOverride(id, override, { homeDir: this.homeDir });
    this.probeCache.delete(id);
    this.notifyListChanged();
    return this.listHarnesses().harnesses;
  }

  /** 恢复指定内置代理的默认配置。 */
  resetBuiltinOverride(id: string): ViewExternalHarness[] {
    resetBuiltinHarnessOverride(id, { homeDir: this.homeDir });
    this.probeCache.delete(id);
    this.notifyListChanged();
    return this.listHarnesses().harnesses;
  }

  /** 启用或停用内置/自定义外部代理。 */
  toggleHarness(id: string, enabled: boolean): ViewExternalHarness[] {
    toggleExternalHarness(id, enabled, { homeDir: this.homeDir });
    this.notifyListChanged();
    return this.listHarnesses().harnesses;
  }

  /** 新增或编辑自定义 `Local ACP Command` 代理。 */
  saveCustomHarness(entry: CustomExternalHarnessInput): ViewExternalHarness[] {
    upsertCustomExternalHarness(entry, { homeDir: this.homeDir });
    this.probeCache.delete(entry.id.trim());
    this.notifyListChanged();
    return this.listHarnesses().harnesses;
  }

  /** 删除用户自定义外部代理。 */
  deleteCustomHarness(id: string): ViewExternalHarness[] {
    removeCustomExternalHarness(id, { homeDir: this.homeDir });
    this.probeCache.delete(id);
    this.notifyListChanged();
    return this.listHarnesses().harnesses;
  }

  /**
   * 对已保存代理或草稿配置执行真实非破坏性握手探测（默认 15s 超时）。
   *
   * 信任门禁：当指定具体 `workspaceRoot` 时强制核验 `isProjectTrusted`；未指定时在系统临时目录安全执行版本与协议握手探测。
   */
  async testHarness(
    target: string | ExternalHarnessDefinition,
    workspaceRoot?: string,
    signal?: AbortSignal,
  ): Promise<ViewExternalHarnessProbe> {
    let probeCwd = os.tmpdir();
    if (workspaceRoot) {
      probeCwd = this.requireTrustedWorkspace(workspaceRoot);
    }

    const def = typeof target === 'string' ? this.requireHarnessDefinition(target) : target;
    const driver = this.drivers[def.transport];
    if (!driver) {
      const unsupported: ViewExternalHarnessProbe = {
        available: false,
        status: 'handshake_failed',
        loadSupported: false,
        reason: `传输驱动 '${def.transport}' 尚未在当前宿主实例注册`,
      };
      if (typeof target === 'string') this.probeCache.set(def.id, unsupported);
      return unsupported;
    }

    const result = await driver.inspect(def, probeCwd, signal);
    const probe: ViewExternalHarnessProbe = {
      available: result.available,
      status: result.status,
      loadSupported: result.loadSupported,
      ...(result.agentName ? { agentName: result.agentName } : {}),
      ...(result.version ? { version: result.version } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      ...(result.loginHint ? { loginHint: result.loginHint } : {}),
      ...(result.installHint ? { installHint: result.installHint } : {}),
    };
    if (typeof target === 'string') {
      this.probeCache.set(def.id, probe);
    }
    return probe;
  }

  /** 列出指定已信任工作区（或全部工作区）下的外部会话摘要。 */
  listSessions(workspaceRoot?: string): ViewExternalSession[] {
    if (workspaceRoot) {
      this.requireTrustedWorkspace(workspaceRoot);
    }
    const records = this.registry.listRecords(workspaceRoot);
    return records.map((rec) => this.toViewSession(rec));
  }

  /** 支持精确会话 ID 或唯一前缀解析（方便 CLI `/external show <前缀>` 交互）。 */
  resolveSessionId(idOrPrefix: string, workspaceRoot?: string): string {
    const trimmed = idOrPrefix.trim();
    if (!trimmed) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', '外部会话 ID 不能为空');
    }
    if (this.registry.getRecord(trimmed)) return trimmed;
    const candidates = this.registry
      .listRecords(workspaceRoot)
      .filter((r) => r.id.startsWith(trimmed));
    if (candidates.length === 1) return candidates[0]!.id;
    if (candidates.length > 1) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `外部会话前缀 '${trimmed}' 匹配到多个会话，请提供更长前缀`,
      );
    }
    throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `未找到外部会话 '${trimmed}'`);
  }

  /** 读取外部会话实时或历史归档只读快照（已回收或已结束会话直接读 `snapshots/`，绝不白屏）。 */
  getSnapshot(sessionId: string): ViewExternalSnapshot {
    const resolvedId = this.resolveSessionId(sessionId);
    const live = this.liveSlots.get(resolvedId);
    if (live) {
      return this.buildLiveSnapshot(live);
    }
    const record = this.registry.getRecord(resolvedId);
    if (!record) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `未找到外部会话 '${sessionId}'`);
    }
    const archive = this.registry.readArchive(resolvedId);
    return {
      session: this.toViewSession(record),
      sequence: 0,
      ...(archive?.truncated ? { truncatedArchive: true } : {}),
      messages: archive?.messages ?? [],
      approvals: [],
      ...(archive?.plan ? { plan: archive.plan } : {}),
      notices: archive?.notices ?? [],
    };
  }

  /** 在已信任工作区创建并握手打开一个新的外部代理会话（尚未发首轮 Prompt，处于 `'idle'` 态）。 */
  async openSession(
    input: {
      readonly workspaceRoot: string;
      readonly harnessId: string;
      readonly title?: string;
    },
    signal?: AbortSignal,
  ): Promise<ViewExternalSnapshot> {
    if (this.disposed) {
      throw new ExternalHarnessError('EXTERNAL_ABORTED', '外部会话服务已关闭');
    }
    const nativeRoot = this.requireTrustedWorkspace(input.workspaceRoot);
    const def = this.requireEnabledHarnessDefinition(input.harnessId);
    this.ensureProcessCapacity();

    const driver = this.requireDriver(def.transport);
    const id = `ext_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = Date.now();
    const configDigest = computeHarnessConfigDigest(def);
    const initialTitle =
      sanitizeDisplayText(input.title ?? `${def.name} 任务`, 120) ?? `${def.name} 任务`;

    const initialRecord: ExternalSessionRecord = {
      id,
      harnessId: def.id,
      harnessName: def.name,
      transport: def.transport,
      workspaceRoot: nativeRoot,
      configDigest,
      title: initialTitle,
      status: 'starting',
      resumable: false,
      createdAt: now,
      updatedAt: now,
    };
    this.registry.upsertRecord(initialRecord);
    this.notifyListChanged(nativeRoot);

    try {
      const slot = await this.spawnAndBindSlot({
        record: initialRecord,
        def,
        driver,
        signal,
      });
      this.armIdleTimer(slot);
      const snap = this.buildLiveSnapshot(slot);
      this.notifyListChanged(nativeRoot);
      this.emitSnapshot(slot);
      return snap;
    } catch (err) {
      const errText =
        sanitizeDisplayText(err instanceof Error ? err.message : String(err), 300) ?? '启动失败';
      this.registry.upsertRecord({
        ...initialRecord,
        status: 'failed',
        updatedAt: Date.now(),
        lastError: errText,
      });
      this.notifyListChanged(nativeRoot);
      throw err;
    }
  }

  /** 一步式创建外部代理会话并立即发送首轮任务文本。 */
  async startSession(
    input: {
      readonly workspaceRoot: string;
      readonly harnessId: string;
      readonly prompt: string;
    },
    signal?: AbortSignal,
  ): Promise<ViewExternalSnapshot> {
    const title = sanitizeDisplayText(input.prompt, 80) ?? '外部任务';
    const opened = await this.openSession(
      {
        workspaceRoot: input.workspaceRoot,
        harnessId: input.harnessId,
        title,
      },
      signal,
    );
    return this.promptSession(
      {
        sessionId: opened.session.id,
        text: input.prompt,
      },
      signal,
    );
  }

  /**
   * 同步完成信任/并发校验、离线恢复握手与用户消息入列，立即返回 `'running'` 快照并在后台推进该轮执行。
   *
   * 供桌面端非阻塞 RPC 使用，避免长耗时外部轮次或待审批挂起触发桌面 30s RPC 请求超时。
   */
  async dispatchPrompt(
    input: { readonly sessionId: string; readonly text: string },
    signal?: AbortSignal,
  ): Promise<ViewExternalSnapshot> {
    const { initialSnapshot, completion } = await this.prepareAndLaunchPrompt(input, signal);
    void completion.catch(() => {});
    return initialSnapshot;
  }

  /**
   * 向外部会话发送一轮输入并等待该轮结算完成。
   *
   * 双轨恢复语义：
   * - 若子进程仍在场且为 `'idle'`，直接发送；
   * - 若会话已结束/空闲回收，仅当 `canContinue === true`（`resumable` 为真且 `configDigest` 未漂移）时自动拉起子进程恢复续聊，
   *   否则拒绝并明确提示当前为只读历史归档。
   */
  async promptSession(
    input: { readonly sessionId: string; readonly text: string },
    signal?: AbortSignal,
  ): Promise<ViewExternalSnapshot> {
    const { completion } = await this.prepareAndLaunchPrompt(input, signal);
    return completion;
  }

  private async prepareAndLaunchPrompt(
    input: { readonly sessionId: string; readonly text: string },
    signal?: AbortSignal,
  ): Promise<{
    readonly initialSnapshot: ViewExternalSnapshot;
    readonly completion: Promise<ViewExternalSnapshot>;
  }> {
    const resolvedId = this.resolveSessionId(input.sessionId);
    const promptText = input.text.trim();
    if (!promptText) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', '发送给外部代理的任务内容不能为空');
    }

    let slot = this.liveSlots.get(resolvedId);
    if (!slot) {
      const record = this.registry.getRecord(resolvedId);
      if (!record) {
        throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `未找到外部会话 '${resolvedId}'`);
      }
      this.requireTrustedWorkspace(record.workspaceRoot);
      if (!this.canContinueRecord(record)) {
        throw new ExternalHarnessError(
          'EXTERNAL_PROTOCOL_ERROR',
          '当前为外部代理只读历史归档（代理不支持恢复或启动配置已变更），如需继续请新建外部会话',
        );
      }
      this.ensureProcessCapacity();
      this.ensureWorkspaceNotRunning(record.workspaceRoot, resolvedId);

      const def = this.requireEnabledHarnessDefinition(record.harnessId);
      const driver = this.requireDriver(def.transport);
      const existingArchive = this.registry.readArchive(resolvedId);

      slot = await this.spawnAndBindSlot({
        record,
        def,
        driver,
        nativeSessionId: record.nativeSessionId,
        existingArchiveMessages: existingArchive?.messages,
        truncatedArchive: Boolean(existingArchive?.truncated),
        signal,
      });
    } else {
      this.requireTrustedWorkspace(slot.record.workspaceRoot);
      if (slot.record.status !== 'idle') {
        throw new ExternalHarnessError(
          'EXTERNAL_SESSION_BUSY',
          '当前外部会话正在执行或等待审批，不能并发发送新轮次',
        );
      }
      this.ensureWorkspaceNotRunning(slot.record.workspaceRoot, resolvedId);
    }

    const activeSlot = slot;
    this.clearIdleTimer(activeSlot);

    // 若标题仍是默认占位名，以首轮用户输入更新会话标题
    const updatedTitle =
      activeSlot.projector.getMessages().length === 0
        ? (sanitizeDisplayText(redactText(promptText, activeSlot.secrets), 80) ??
          activeSlot.record.title)
        : activeSlot.record.title;

    activeSlot.projector.beginUserTurn(promptText);
    const opId = `extop_${randomUUID().slice(0, 8)}`;
    activeSlot.operation = { id: opId, phase: 'running' };
    this.updateSlotRecord(activeSlot, {
      title: updatedTitle,
      status: 'running',
      lastError: undefined,
    });
    this.flushSlotImmediate(activeSlot);
    const initialSnapshot = this.buildLiveSnapshot(activeSlot);

    const completion = (async (): Promise<ViewExternalSnapshot> => {
      try {
        const turnRes = await activeSlot.handle.prompt(promptText, signal);
        if (turnRes.stopReason === 'cancelled') {
          activeSlot.projector.interruptTurn();
          activeSlot.operation = { id: opId, phase: 'idle', result: 'aborted' };
        } else {
          activeSlot.projector.completeTurn(turnRes.usage);
          activeSlot.operation = { id: opId, phase: 'idle', result: 'completed' };
        }

        if (this.liveSlots.has(activeSlot.record.id)) {
          this.updateSlotRecord(activeSlot, { status: 'idle' });
          this.persistSlotArchive(activeSlot);
          this.armIdleTimer(activeSlot);
          this.flushSlotImmediate(activeSlot);
          if (turnRes.stopReason === 'completed') {
            this.options.onAttentionEvent?.({
              kind: 'turn_completed',
              session: this.toViewSession(activeSlot.record),
            });
          }
        }
        return this.getSnapshot(activeSlot.record.id);
      } catch (err) {
        activeSlot.projector.interruptTurn();
        const safeErr =
          sanitizeDisplayText(
            redactText(err instanceof Error ? err.message : String(err), activeSlot.secrets),
            300,
          ) ?? '执行失败';
        activeSlot.operation = { id: opId, phase: 'idle', result: 'failed' };
        activeSlot.notices.push({
          id: `notice-${randomUUID().slice(0, 8)}`,
          level: 'error',
          text: safeErr,
        });
        const stillAlive = this.liveSlots.has(activeSlot.record.id);
        this.updateSlotRecord(activeSlot, {
          status: stillAlive ? 'idle' : 'failed',
          lastError: safeErr,
        });
        this.persistSlotArchive(activeSlot);
        if (stillAlive) this.armIdleTimer(activeSlot);
        this.flushSlotImmediate(activeSlot);
        this.options.onAttentionEvent?.({
          kind: 'turn_failed',
          session: this.toViewSession(activeSlot.record),
        });
        throw err;
      }
    })();

    return { initialSnapshot, completion };
  }

  /** 回复指定外部会话中的挂起人工审批请求。 */
  async approveSession(input: {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly optionId?: string;
    readonly cancel?: boolean;
  }): Promise<void> {
    const resolvedId = this.resolveSessionId(input.sessionId);
    const slot = this.liveSlots.get(resolvedId);
    if (!slot) {
      throw new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', '外部会话已关闭，审批单已失效');
    }
    const entry = slot.approvals.get(input.approvalId);
    if (!entry) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', '该外部审批请求已处理或已过期');
    }

    clearTimeout(entry.timer);
    slot.approvals.delete(input.approvalId);

    if (input.cancel || !input.optionId) {
      entry.respond({ outcome: 'cancelled' });
    } else {
      const validOpt = entry.view.options.some((o) => o.optionId === input.optionId);
      if (!validOpt) {
        entry.respond({ outcome: 'cancelled' });
        throw new ExternalHarnessError(
          'EXTERNAL_CONFIG_INVALID',
          `未知的审批选项 '${input.optionId}'`,
        );
      }
      entry.respond({ outcome: 'selected', optionId: input.optionId });
    }

    if (slot.approvals.size === 0 && slot.record.status === 'waiting_approval') {
      this.updateSlotRecord(slot, { status: 'running' });
    }
    this.flushSlotImmediate(slot);
  }

  /** 取消当前外部会话正在执行的轮次。 */
  async cancelSession(sessionId: string): Promise<void> {
    const resolvedId = this.resolveSessionId(sessionId);
    const slot = this.liveSlots.get(resolvedId);
    if (!slot) return;
    if (
      slot.record.status !== 'running' &&
      slot.record.status !== 'waiting_approval' &&
      slot.record.status !== 'starting'
    ) {
      return;
    }
    this.cancelAllSlotApprovals(slot);
    if (slot.operation) {
      slot.operation = { ...slot.operation, phase: 'cancelling' };
    }
    this.updateSlotRecord(slot, { status: 'cancelling' });
    this.flushSlotImmediate(slot);
    await slot.handle.cancel();
  }

  /** 主动关闭外部会话子进程，保留会话登记与只读展示快照归档。 */
  async closeSession(sessionId: string): Promise<void> {
    const resolvedId = this.resolveSessionId(sessionId);
    const slot = this.liveSlots.get(resolvedId);
    if (!slot) {
      const rec = this.registry.getRecord(resolvedId);
      if (rec && rec.status !== 'ended' && rec.status !== 'failed') {
        this.registry.upsertRecord({ ...rec, status: 'ended', updatedAt: Date.now() });
        this.notifyListChanged(rec.workspaceRoot);
      }
      return;
    }

    this.liveSlots.delete(resolvedId);
    this.clearSlotTimers(slot);
    this.cancelAllSlotApprovals(slot);
    slot.projector.interruptTurn();
    slot.operation = undefined;
    this.updateSlotRecord(slot, { status: 'ended' });
    this.persistSlotArchive(slot);
    await slot.handle.close();
    this.flushSlotImmediate(slot);
  }

  /** 删除已结束的外部会话记录及其只读快照文件（若仍在运行先自动关闭子进程再删除）。 */
  async deleteSession(sessionId: string): Promise<boolean> {
    const resolvedId = this.resolveSessionId(sessionId);
    const rec = this.registry.getRecord(resolvedId);
    if (this.liveSlots.has(resolvedId)) {
      await this.closeSession(resolvedId);
    }
    this.sessionSubscribers.delete(resolvedId);
    const deleted = this.registry.deleteRecord(resolvedId);
    this.notifyListChanged(rec?.workspaceRoot);
    return deleted;
  }

  /** 订阅外部会话列表或代理配置变更通知。 */
  subscribeList(listener: (workspaceRoot?: string) => void): () => void {
    this.listSubscribers.add(listener);
    return () => {
      this.listSubscribers.delete(listener);
    };
  }

  /** 订阅指定外部会话的展示快照流更新。 */
  subscribeSession(
    sessionId: string,
    listener: (snapshot: ViewExternalSnapshot) => void,
  ): () => void {
    const resolvedId = this.resolveSessionId(sessionId);
    let set = this.sessionSubscribers.get(resolvedId);
    if (!set) {
      set = new Set();
      this.sessionSubscribers.set(resolvedId, set);
    }
    set.add(listener);
    return () => {
      const current = this.sessionSubscribers.get(resolvedId);
      if (!current) return;
      current.delete(listener);
      if (current.size === 0) {
        this.sessionSubscribers.delete(resolvedId);
      }
    };
  }

  /** 宿主停机清理：保存所有活动会话快照并两段式回收全部外部子进程树，确保零孤儿残留。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const activeIds = [...this.liveSlots.keys()];
    await Promise.allSettled(activeIds.map((id) => this.closeSession(id)));
    this.listSubscribers.clear();
    this.sessionSubscribers.clear();
  }

  private async spawnAndBindSlot(params: {
    readonly record: ExternalSessionRecord;
    readonly def: ExternalHarnessDefinition;
    readonly driver: ExternalHarnessDriver;
    readonly nativeSessionId?: string;
    readonly existingArchiveMessages?: readonly import('../../view-model/index.js').ViewMessage[];
    readonly truncatedArchive?: boolean;
    readonly signal?: AbortSignal;
  }): Promise<LiveSessionSlot> {
    const secrets = loadCredentialSecrets(params.record.workspaceRoot, this.homeDir);
    const projector = new ExternalTranscriptProjector(params.record.id, secrets);
    if (params.existingArchiveMessages && params.existingArchiveMessages.length > 0) {
      projector.replaceMessages(params.existingArchiveMessages);
    }

    // 预先构造槽引用，确保 open 握手刚结束或中途推送的通知都能准确落入同一槽位。
    const slot: LiveSessionSlot = {
      record: params.record,
      handle: undefined as unknown as ExternalDriverSessionHandle,
      projector,
      approvals: new Map(),
      notices: [],
      sequence: 0,
      truncatedArchive: Boolean(params.truncatedArchive),
      secrets,
    };

    const opened = await params.driver.open({
      def: params.def,
      workspaceRoot: params.record.workspaceRoot,
      ...(params.nativeSessionId ? { nativeSessionId: params.nativeSessionId } : {}),
      signal: params.signal,
      onEvent: (event) => this.handleDriverEvent(slot, event),
    });

    slot.handle = opened.handle;
    if (
      (!params.existingArchiveMessages || params.existingArchiveMessages.length === 0) &&
      opened.replayedMessages &&
      opened.replayedMessages.length > 0
    ) {
      slot.projector.replaceMessages(opened.replayedMessages);
    }

    const updatedRecord: ExternalSessionRecord = {
      ...params.record,
      status: 'idle',
      ...(opened.nativeSessionId ? { nativeSessionId: opened.nativeSessionId } : {}),
      resumable: opened.resumable,
      ...(opened.modelLabel ? { modelLabel: opened.modelLabel } : {}),
      ...(opened.modeLabel ? { modeLabel: opened.modeLabel } : {}),
      updatedAt: Date.now(),
    };
    slot.record = updatedRecord;
    this.registry.upsertRecord(updatedRecord);
    this.liveSlots.set(updatedRecord.id, slot);
    return slot;
  }

  private handleDriverEvent(slot: LiveSessionSlot, event: ExternalEvent): void {
    switch (event.type) {
      case 'text_delta':
      case 'thought_delta':
      case 'user_delta': {
        slot.projector.applyEvent(event);
        this.scheduleCoalescedFlush(slot);
        return;
      }
      case 'tool_upsert':
      case 'plan_updated': {
        slot.projector.applyEvent(event);
        this.flushSlotImmediate(slot);
        return;
      }
      case 'config_updated': {
        this.updateSlotRecord(slot, {
          ...(event.modelLabel ? { modelLabel: event.modelLabel } : {}),
          ...(event.modeLabel ? { modeLabel: event.modeLabel } : {}),
        });
        this.flushSlotImmediate(slot);
        return;
      }
      case 'approval_requested': {
        const approvalId = `extapr_${randomUUID().slice(0, 12)}`;
        const expiresAt = Date.now() + this.approvalTimeoutMs;
        const view: ViewExternalApproval = {
          approvalId,
          sessionId: slot.record.id,
          toolCallId: event.toolCallId,
          toolTitle: redactText(event.toolTitle, slot.secrets),
          ...(event.target ? { target: redactText(event.target, slot.secrets) } : {}),
          ...(event.warning ? { warning: redactText(event.warning, slot.secrets) } : {}),
          options: event.options.map((o) => ({
            optionId: o.optionId,
            label: redactText(o.label, slot.secrets),
            kind: o.kind,
          })),
          expiresAt,
        };

        const timer = setTimeout(() => {
          if (!slot.approvals.has(approvalId)) return;
          slot.approvals.delete(approvalId);
          event.respond({ outcome: 'cancelled' });
          slot.notices.push({
            id: `notice-${randomUUID().slice(0, 8)}`,
            level: 'warning',
            text: `外部审批「${view.toolTitle}」已超时（${Math.round(this.approvalTimeoutMs / 1000)}s），已自动按取消拒绝`,
          });
          if (slot.approvals.size === 0 && slot.record.status === 'waiting_approval') {
            this.updateSlotRecord(slot, { status: 'running' });
          }
          this.flushSlotImmediate(slot);
        }, this.approvalTimeoutMs);
        timer.unref?.();

        slot.approvals.set(approvalId, {
          view,
          timer,
          respond: event.respond,
        });
        this.updateSlotRecord(slot, { status: 'waiting_approval' });
        this.flushSlotImmediate(slot);
        this.options.onAttentionEvent?.({
          kind: 'approval_requested',
          session: this.toViewSession(slot.record),
        });
        return;
      }
      case 'diagnostic': {
        if (event.level === 'warning' || event.level === 'error') {
          slot.notices.push({
            id: `notice-${randomUUID().slice(0, 8)}`,
            level: event.level,
            text: redactText(event.text, slot.secrets),
          });
          this.flushSlotImmediate(slot);
        }
        return;
      }
      case 'closed': {
        if (!this.liveSlots.has(slot.record.id)) return;
        this.liveSlots.delete(slot.record.id);
        this.clearSlotTimers(slot);
        this.cancelAllSlotApprovals(slot);
        slot.projector.interruptTurn();
        slot.operation = undefined;
        const crashed = event.code !== 0 && event.code !== null;
        const errTail = event.stderrTail
          ? sanitizeDisplayText(redactText(event.stderrTail, slot.secrets), 240)
          : undefined;
        this.updateSlotRecord(slot, {
          status: crashed ? 'failed' : 'ended',
          ...(crashed && errTail ? { lastError: errTail } : {}),
        });
        this.persistSlotArchive(slot);
        this.flushSlotImmediate(slot);
        return;
      }
    }
  }

  private scheduleCoalescedFlush(slot: LiveSessionSlot): void {
    if (slot.coalesceTimer !== undefined) return;
    slot.coalesceTimer = setTimeout(() => {
      slot.coalesceTimer = undefined;
      this.emitSnapshot(slot);
    }, STREAM_COALESCE_MS);
    slot.coalesceTimer.unref?.();
  }

  private flushSlotImmediate(slot: LiveSessionSlot): void {
    if (slot.coalesceTimer !== undefined) {
      clearTimeout(slot.coalesceTimer);
      slot.coalesceTimer = undefined;
    }
    this.notifyListChanged(slot.record.workspaceRoot);
    this.emitSnapshot(slot);
  }

  private emitSnapshot(slot: LiveSessionSlot): void {
    slot.sequence += 1;
    const listeners = this.sessionSubscribers.get(slot.record.id);
    if (!listeners || listeners.size === 0) return;
    const snap = this.buildLiveSnapshot(slot);
    for (const listener of listeners) {
      try {
        listener(snap);
      } catch {
        /* 隔离订阅者异常 */
      }
    }
  }

  private notifyListChanged(workspaceRoot?: string): void {
    for (const listener of this.listSubscribers) {
      try {
        listener(workspaceRoot);
      } catch {
        /* ignore */
      }
    }
  }

  private armIdleTimer(slot: LiveSessionSlot): void {
    this.clearIdleTimer(slot);
    if (this.idleTimeoutMs <= 0) return;
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = undefined;
      if (slot.record.status === 'idle' && slot.approvals.size === 0) {
        void this.closeSession(slot.record.id).catch(() => {});
      }
    }, this.idleTimeoutMs);
    slot.idleTimer.unref?.();
  }

  private clearIdleTimer(slot: LiveSessionSlot): void {
    if (slot.idleTimer !== undefined) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = undefined;
    }
  }

  private clearSlotTimers(slot: LiveSessionSlot): void {
    this.clearIdleTimer(slot);
    if (slot.coalesceTimer !== undefined) {
      clearTimeout(slot.coalesceTimer);
      slot.coalesceTimer = undefined;
    }
  }

  private cancelAllSlotApprovals(slot: LiveSessionSlot): void {
    for (const [id, entry] of slot.approvals) {
      slot.approvals.delete(id);
      clearTimeout(entry.timer);
      entry.respond({ outcome: 'cancelled' });
    }
  }

  private persistSlotArchive(slot: LiveSessionSlot): void {
    try {
      this.registry.saveArchive(
        slot.record.id,
        {
          messages: slot.projector.getMessages(),
          plan: slot.projector.getPlan(),
          notices: slot.notices,
        },
        slot.secrets,
      );
    } catch {
      /* 快照写盘失败不阻断会话收口 */
    }
  }

  private updateSlotRecord(
    slot: LiveSessionSlot,
    patch: Partial<Omit<ExternalSessionRecord, 'id' | 'createdAt'>>,
  ): void {
    const next: ExternalSessionRecord = {
      ...slot.record,
      ...patch,
      updatedAt: Date.now(),
    };
    slot.record = next;
    this.registry.upsertRecord(next);
  }

  private buildLiveSnapshot(slot: LiveSessionSlot): ViewExternalSnapshot {
    return {
      session: this.toViewSession(slot.record),
      sequence: slot.sequence,
      ...(slot.truncatedArchive ? { truncatedArchive: true } : {}),
      messages: slot.projector.getMessages(),
      ...(slot.operation ? { operation: slot.operation } : {}),
      approvals: [...slot.approvals.values()].map((a) => a.view),
      ...(slot.projector.getPlan() ? { plan: slot.projector.getPlan() } : {}),
      notices: [...slot.notices],
    };
  }

  private canContinueRecord(record: ExternalSessionRecord): boolean {
    if (this.liveSlots.has(record.id)) return true;
    if (!record.resumable || !record.nativeSessionId) return false;
    const entry = listResolvedExternalHarnesses({ homeDir: this.homeDir }).find(
      (i) => i.definition.id === record.harnessId,
    );
    if (!entry || !entry.definition.enabled) return false;
    if (!this.drivers[entry.definition.transport]) return false;
    return computeHarnessConfigDigest(entry.definition) === record.configDigest;
  }

  private toViewSession(record: ExternalSessionRecord): ViewExternalSession {
    const live = this.liveSlots.get(record.id);
    const effective = live ? live.record : record;
    return {
      id: effective.id,
      harnessId: effective.harnessId,
      harnessName: effective.harnessName,
      transport: effective.transport,
      workspaceRoot: effective.workspaceRoot,
      title: effective.title,
      status: effective.status,
      resumable: effective.resumable,
      canContinue: this.canContinueRecord(effective),
      hasArchive: Boolean(
        (live && live.projector.getMessages().length > 0) || this.registry.hasArchive(effective.id),
      ),
      pendingApprovalCount: live ? live.approvals.size : 0,
      ...(effective.modelLabel ? { modelLabel: effective.modelLabel } : {}),
      ...(effective.modeLabel ? { modeLabel: effective.modeLabel } : {}),
      createdAt: effective.createdAt,
      updatedAt: effective.updatedAt,
      ...(effective.lastError ? { lastError: effective.lastError } : {}),
    };
  }

  private requireTrustedWorkspace(workspaceRoot: string): string {
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
      throw new ExternalHarnessError(
        'EXTERNAL_UNTRUSTED_WORKSPACE',
        '必须提供绝对路径的工作区根目录',
      );
    }
    let nativeRoot = path.resolve(workspaceRoot);
    try {
      nativeRoot = fs.realpathSync.native(workspaceRoot);
    } catch {
      /* keep resolved */
    }
    const trusted = this.options.isWorkspaceTrusted
      ? this.options.isWorkspaceTrusted(nativeRoot)
      : isProjectTrusted(
          loadSettings({ cwd: nativeRoot, homeDir: this.homeDir }).settings,
          nativeRoot,
        );
    if (!trusted) {
      throw new ExternalHarnessError(
        'EXTERNAL_UNTRUSTED_WORKSPACE',
        `工作区 '${nativeRoot}' 尚未被信任，拒绝执行外部代理`,
      );
    }
    return nativeRoot;
  }

  private requireHarnessDefinition(id: string): ExternalHarnessDefinition {
    const hit = listResolvedExternalHarnesses({ homeDir: this.homeDir }).find(
      (item) => item.definition.id === id,
    );
    if (!hit) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `未找到外部代理 '${id}'`);
    }
    return hit.definition;
  }

  private requireEnabledHarnessDefinition(id: string): ExternalHarnessDefinition {
    const def = this.requireHarnessDefinition(id);
    if (!def.enabled) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `外部代理 '${def.name}' 当前已停用，请先在设置中启用`,
      );
    }
    return def;
  }

  private requireDriver(transport: ExternalTransportKind): ExternalHarnessDriver {
    const driver = this.drivers[transport];
    if (!driver) {
      throw new ExternalHarnessError(
        'EXTERNAL_PROTOCOL_ERROR',
        `外部代理传输驱动 '${transport}' 暂不可用`,
      );
    }
    return driver;
  }

  private ensureProcessCapacity(): void {
    if (this.liveSlots.size >= this.maxActiveProcesses) {
      throw new ExternalHarnessError(
        'EXTERNAL_CAPACITY',
        `并发活跃外部代理进程数已达上限（${this.maxActiveProcesses} 个），请先关闭空闲外部会话`,
      );
    }
  }

  private ensureWorkspaceNotRunning(workspaceRoot: string, currentSessionId: string): void {
    const targetNorm = normalizeProjectRoot(workspaceRoot);
    for (const [id, slot] of this.liveSlots) {
      if (id === currentSessionId) continue;
      if (normalizeProjectRoot(slot.record.workspaceRoot) !== targetNorm) continue;
      if (
        slot.record.status === 'starting' ||
        slot.record.status === 'running' ||
        slot.record.status === 'waiting_approval' ||
        slot.record.status === 'cancelling'
      ) {
        throw new ExternalHarnessError(
          'EXTERNAL_WORKSPACE_BUSY',
          `同一工作区已有运行中的外部代理会话（${slot.record.title}），请等待其完成或取消后再试`,
        );
      }
    }
  }
}
