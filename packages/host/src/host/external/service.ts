import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ViewExternalApproval,
  ViewExternalConfigCategory,
  ViewExternalConfigOption,
  ViewExternalHarness,
  ViewExternalHarnessProbe,
  ViewExternalSession,
  ViewExternalSnapshot,
  ViewExternalTemplate,
  ViewNotice,
  ViewOperation,
} from '../../view-model/index.js';
import { loadCredentialSecrets } from '../managed-session.js';
import { redactViewMessage } from '../public-projection.js';
import { redactText, sanitizeDisplayText } from '../redaction.js';
import { normalizeProjectRoot } from '../resource/mcp-approval.js';
import { isProjectTrusted, loadSettings } from '../settings.js';
import {
  deleteHarnessConfigCache,
  readHarnessConfigCache,
  saveHarnessConfigCache,
} from './config-cache.js';
import {
  type BuiltinHarnessOverride,
  type CustomExternalHarnessInput,
  computeHarnessConfigDigest,
  getExternalStateDirPath,
  listResolvedExternalHarnesses,
  removeCustomExternalHarness,
  resetBuiltinHarnessOverride,
  saveBuiltinHarnessOverride,
  toggleExternalHarness,
  upsertCustomExternalHarness,
} from './config.js';
import { AcpStdioDriver } from './drivers/acp/acp-driver.js';
import { ExternalTranscriptProjector } from './drivers/acp/projector.js';
import { ClaudeCliDriver } from './drivers/claude-cli.js';
import { CodexAppServerDriver } from './drivers/codex-app-server.js';
import { PiRpcDriver } from './drivers/pi-rpc.js';
import { resolveForwardedEnvSecrets } from './env.js';
import { ACP_REGISTRY_TEMPLATES } from './presets.js';
import { type ExternalSessionRecord, ExternalSessionRegistry } from './registry.js';
import {
  type ExternalApprovalDecision,
  type ExternalConfigSelection,
  type ExternalDriverSessionHandle,
  type ExternalEvent,
  type ExternalHarnessDefinition,
  type ExternalHarnessDriver,
  ExternalHarnessError,
  type ExternalTransportKind,
  isReservedObjectPropertyName,
} from './types.js';

/** 宿主全局并发活跃外部子进程硬上限。 */
export const MAX_ACTIVE_EXTERNAL_PROCESSES = 4;
/** 流式文本/思考 chunk 合并推送窗口（50ms），避免高频单字符增量淹没 IPC。 */
const STREAM_COALESCE_MS = 50;
/** 外部审批请求默认到期时间（120 秒；到期自动按取消拒绝，绝不自动放行）。 */
const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
/** 空闲外部子进程自动回收时间（30 分钟；回收后保留会话记录与只读展示快照）。 */
const DEFAULT_IDLE_REAP_MS = 30 * 60_000;
/** 运行期单会话保留的诊断通知条数上限，防高频异常告警无限增长突破单帧预算。 */
const MAX_LIVE_NOTICES = 32;

interface LiveApprovalEntry {
  readonly requestId: string;
  readonly view: ViewExternalApproval;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly respond: (decision: ExternalApprovalDecision) => void;
}

interface OpeningReservation {
  readonly workspaceRoot: string;
  readonly title: string;
  readonly abort: AbortController;
  readonly settled: Promise<void>;
  readonly slot: LiveSessionSlot;
}

interface LiveSessionSlot {
  record: ExternalSessionRecord;
  handle: ExternalDriverSessionHandle;
  readonly projector: ExternalTranscriptProjector;
  readonly approvals: Map<string, LiveApprovalEntry>;
  readonly notices: ViewNotice[];
  configOptions?: readonly ViewExternalConfigOption[];
  operation?: ViewOperation;
  sequence: number;
  coalesceTimer?: ReturnType<typeof setTimeout>;
  idleTimer?: ReturnType<typeof setTimeout>;
  closing?: Promise<void>;
  truncatedArchive: boolean;
  readonly secrets: readonly string[];
}

/**
 * `ExternalSessionService` 构造参数。
 *
 * 所有目录与环境注入均保持可显式覆写，供桌面主进程、本地守护进程与隔离单测共享同一套编排状态机。
 */
export interface ExternalSessionServiceOptions {
  /** 用户状态根目录（缺省取 `os.homedir()`，外部配置与快照落于其下 `.kapibala/external`）。 */
  readonly homeDir?: string;
  /** 注入给可执行文件查找与 `envFrom` 转发的宿主环境变量快照（缺省读 `process.env`）。 */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  /** 可选自定义传输驱动覆盖表（未指定的传输类型默认挂载四套内置驱动）。 */
  readonly drivers?: Partial<Record<ExternalTransportKind, ExternalHarnessDriver>>;
  /** 自定义工作区物理路径信任判定钩子；缺省读取用户级 `settings.json` 中的信任列表。 */
  readonly isWorkspaceTrusted?: (workspaceRoot: string) => boolean;
  /** 人工审批卡片超时毫秒数（默认 120 秒，到期自动按取消拒绝）。 */
  readonly approvalTimeoutMs?: number;
  /** 空闲外部子进程保活毫秒数（默认 30 分钟，`<= 0` 时禁用自动空闲回收）。 */
  readonly idleTimeoutMs?: number;
  /** 全局并发外部子进程上限（默认 4 个）。 */
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
 * 2. 强制执行 `isProjectTrusted`、全局 4 进程容量预占与同工作区单运行态外部会话互斥；
 * 3. 50ms 流式文本合并、120s 审批到期自动取消、30 分钟空闲子进程回收；
 * 4. 解耦「有界只读展示快照归档」与「`resumable` + `configDigest` 连续性恢复门禁」。
 */
export class ExternalSessionService {
  private readonly homeDir: string;
  private readonly registry: ExternalSessionRegistry;
  private readonly drivers: Partial<Record<ExternalTransportKind, ExternalHarnessDriver>>;
  private readonly probeCache = new Map<string, ViewExternalHarnessProbe>();
  private readonly liveSlots = new Map<string, LiveSessionSlot>();
  private readonly openingSessions = new Map<string, OpeningReservation>();
  private readonly activeProbes = new Set<{
    readonly abort: AbortController;
    readonly promise: Promise<unknown>;
  }>();
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
      'claude-cli': new ClaudeCliDriver({
        homeDir: this.homeDir,
        hostEnv: options.hostEnv,
      }),
      'codex-app-server': new CodexAppServerDriver({
        homeDir: this.homeDir,
        hostEnv: options.hostEnv,
      }),
      'pi-rpc': new PiRpcDriver({
        homeDir: this.homeDir,
        hostEnv: options.hostEnv,
      }),
      ...options.drivers,
    };
  }

  /** 返回当前所有存活外部会话子进程的 PID 列表（供诊断与零孤儿进程校验）。 */
  getActiveSessionPids(): number[] {
    const pids: number[] = [];
    for (const slot of this.liveSlots.values()) {
      if (typeof slot.handle.pid === 'number' && slot.handle.pid > 0) {
        pids.push(slot.handle.pid);
      }
    }
    return pids;
  }

  /** 注册或替换指定传输类型的驱动（供注入自定义驱动或单测替身）。 */
  registerDriver(driver: ExternalHarnessDriver): void {
    this.drivers[driver.transport] = driver;
  }

  /** 列出合并后的全部外部代理定义（按宿主环境自动评估未覆写内置预设的本机安装默认启用态）及官方 ACP Registry 模板。 */
  listHarnesses(): {
    readonly harnesses: ViewExternalHarness[];
    readonly templates: readonly ViewExternalTemplate[];
  } {
    const resolved = listResolvedExternalHarnesses({
      homeDir: this.homeDir,
      hostEnv: this.options.hostEnv,
    });
    const configCache = readHarnessConfigCache(this.homeDir);
    const harnesses: ViewExternalHarness[] = resolved.map(({ definition, hasOverride }) => {
      const probe = this.probeCache.get(definition.id);
      const digest = computeHarnessConfigDigest(definition);
      const cachedEntry = Object.hasOwn(configCache, definition.id)
        ? configCache[definition.id]
        : undefined;
      const cachedConfigOptions =
        cachedEntry && cachedEntry.configDigest === digest && cachedEntry.configOptions.length > 0
          ? cachedEntry.configOptions
          : undefined;
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
        ...(cachedConfigOptions ? { cachedConfigOptions } : {}),
      };
    });
    return {
      harnesses,
      templates: ACP_REGISTRY_TEMPLATES,
    };
  }

  /** 保存内置代理的增量覆写并使旧探测缓存失效；配置指纹变更后自动回收不匹配的存量会话并降级为只读归档。 */
  saveBuiltinOverride(id: string, override: BuiltinHarnessOverride): ViewExternalHarness[] {
    saveBuiltinHarnessOverride(id, override, { homeDir: this.homeDir });
    this.probeCache.delete(id);
    deleteHarnessConfigCache(this.homeDir, id);
    this.reconcileLiveSlotsForHarness(id);
    this.notifyListChanged();
    return this.listHarnesses().harnesses;
  }

  /** 移除指定内置代理的全部磁盘增量覆写，恢复内置命令参数并回到按本机安装态决定默认启停。 */
  resetBuiltinOverride(id: string): ViewExternalHarness[] {
    resetBuiltinHarnessOverride(id, { homeDir: this.homeDir });
    this.probeCache.delete(id);
    deleteHarnessConfigCache(this.homeDir, id);
    this.reconcileLiveSlotsForHarness(id);
    this.notifyListChanged();
    return this.listHarnesses().harnesses;
  }

  /** 显式持久化内置或自定义外部代理的启用状态；停用后同步关闭存活会话并拒绝新建或继续发送。 */
  toggleHarness(id: string, enabled: boolean): ViewExternalHarness[] {
    toggleExternalHarness(id, enabled, { homeDir: this.homeDir });
    this.reconcileLiveSlotsForHarness(id);
    this.notifyListChanged();
    return this.listHarnesses().harnesses;
  }

  /** 新增或覆盖自定义 `Local ACP Command` 代理（校验阻断原型保留键、内置 ID 碰撞与敏感凭据误填）。 */
  saveCustomHarness(entry: CustomExternalHarnessInput): ViewExternalHarness[] {
    const trimmedId = entry.id.trim();
    upsertCustomExternalHarness(entry, { homeDir: this.homeDir });
    this.probeCache.delete(trimmedId);
    deleteHarnessConfigCache(this.homeDir, trimmedId);
    this.reconcileLiveSlotsForHarness(trimmedId);
    this.notifyListChanged();
    return this.listHarnesses().harnesses;
  }

  /** 从磁盘配置移除指定自定义外部代理并回收其存活进程（历史归档仍保留只读可查）。 */
  deleteCustomHarness(id: string): ViewExternalHarness[] {
    removeCustomExternalHarness(id, { homeDir: this.homeDir });
    this.probeCache.delete(id);
    deleteHarnessConfigCache(this.homeDir, id);
    this.reconcileLiveSlotsForHarness(id);
    this.notifyListChanged();
    return this.listHarnesses().harnesses;
  }

  /**
   * 对已保存代理或草稿配置执行真实非破坏性握手探测（按驱动默认 15s–20s 超时）。
   *
   * 信任门禁：当指定具体 `workspaceRoot` 时强制核验 `isProjectTrusted`；未指定时在受管 `probe-cwd` 空目录安全执行握手探测。
   */
  async testHarness(
    target: string | ExternalHarnessDefinition,
    workspaceRoot?: string,
    signal?: AbortSignal,
  ): Promise<ViewExternalHarnessProbe> {
    if (this.disposed) {
      throw new ExternalHarnessError('EXTERNAL_ABORTED', '外部会话服务已关闭');
    }
    let probeCwd: string;
    if (workspaceRoot) {
      probeCwd = this.requireTrustedWorkspace(workspaceRoot);
    } else {
      // 未指定工作区时使用受管空目录而非系统根临时目录，防外部代理全盘扫描海量临时文件拖慢探测。
      probeCwd = path.join(getExternalStateDirPath(this.homeDir), 'probe-cwd');
      fs.mkdirSync(probeCwd, { recursive: true, mode: 0o700 });
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

    const probeAbort = new AbortController();
    const onParentAbort = (): void => {
      probeAbort.abort();
    };
    if (signal?.aborted) {
      probeAbort.abort();
    } else {
      signal?.addEventListener('abort', onParentAbort, { once: true });
    }

    const secrets = this.collectSecrets(probeCwd, def);
    const runPromise = driver.inspect(def, probeCwd, probeAbort.signal);
    const tracker = { abort: probeAbort, promise: runPromise };
    this.activeProbes.add(tracker);
    try {
      const result = await runPromise;
      const safeReason = result.reason ? redactText(result.reason, secrets) : undefined;
      const probe: ViewExternalHarnessProbe = {
        available: result.available,
        status: result.status,
        loadSupported: result.loadSupported,
        ...(result.agentName ? { agentName: result.agentName } : {}),
        ...(result.version ? { version: result.version } : {}),
        ...(safeReason ? { reason: safeReason } : {}),
        ...(result.loginHint ? { loginHint: result.loginHint } : {}),
        ...(result.installHint ? { installHint: result.installHint } : {}),
        ...(result.configOptions && result.configOptions.length > 0
          ? { configOptions: result.configOptions }
          : {}),
      };
      if (typeof target === 'string' && !this.disposed) {
        this.probeCache.set(def.id, probe);
        if (result.configOptions && result.configOptions.length > 0) {
          saveHarnessConfigCache(
            this.homeDir,
            def.id,
            computeHarnessConfigDigest(def),
            result.configOptions,
          );
        }
      }
      return probe;
    } finally {
      signal?.removeEventListener('abort', onParentAbort);
      this.activeProbes.delete(tracker);
    }
  }

  /** 列出指定已信任工作区（或全部已信任工作区）下的外部会话摘要。 */
  listSessions(workspaceRoot?: string): ViewExternalSession[] {
    const harnessMap = this.buildResolvedHarnessMap();
    if (workspaceRoot) {
      const nativeRoot = this.requireTrustedWorkspace(workspaceRoot);
      const records = this.registry.listRecords(nativeRoot);
      return records.map((rec) => this.toViewSession(rec, harnessMap));
    }
    const records = this.registry.listRecords();
    return records
      .filter((rec) => {
        try {
          this.requireTrustedWorkspace(rec.workspaceRoot);
          return true;
        } catch {
          return false;
        }
      })
      .map((rec) => this.toViewSession(rec, harnessMap));
  }

  /** 支持精确会话 ID 或唯一前缀解析（方便 CLI `/external show <前缀>` 交互）。 */
  resolveSessionId(idOrPrefix: string, workspaceRoot?: string): string {
    const trimmed = idOrPrefix.trim();
    if (!trimmed || isReservedObjectPropertyName(trimmed)) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', '外部会话 ID 非法');
    }
    const exact = this.registry.getRecord(trimmed);
    if (exact) {
      this.verifyExpectedWorkspace(exact.workspaceRoot, workspaceRoot);
      return trimmed;
    }
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
  getSnapshot(sessionId: string, expectedWorkspaceRoot?: string): ViewExternalSnapshot {
    const resolvedId = this.resolveSessionId(sessionId, expectedWorkspaceRoot);
    const live = this.liveSlots.get(resolvedId);
    if (live) {
      this.requireTrustedWorkspace(live.record.workspaceRoot);
      this.verifyExpectedWorkspace(live.record.workspaceRoot, expectedWorkspaceRoot);
      return this.buildLiveSnapshot(live);
    }
    const record = this.registry.getRecord(resolvedId);
    if (!record) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `未找到外部会话 '${sessionId}'`);
    }
    const nativeRoot = this.requireTrustedWorkspace(record.workspaceRoot);
    this.verifyExpectedWorkspace(record.workspaceRoot, expectedWorkspaceRoot);
    const archive = this.registry.readArchive(resolvedId);
    const currentDef = listResolvedExternalHarnesses({
      homeDir: this.homeDir,
      hostEnv: this.options.hostEnv,
    }).find((item) => item.definition.id === record.harnessId)?.definition;
    const secrets = this.collectSecrets(nativeRoot, currentDef);
    const redactFn = (text: string): string => redactText(text, secrets);
    const viewSession = this.toViewSession(record);
    const configCache = viewSession.canContinue ? readHarnessConfigCache(this.homeDir) : undefined;
    const cachedEntry =
      configCache && Object.hasOwn(configCache, record.harnessId)
        ? configCache[record.harnessId]
        : undefined;
    const cachedOptions =
      cachedEntry &&
      cachedEntry.configDigest === record.configDigest &&
      cachedEntry.configOptions.length > 0
        ? cachedEntry.configOptions
        : undefined;
    return {
      session: viewSession,
      sequence: 0,
      ...(archive?.truncated ? { truncatedArchive: true } : {}),
      messages: archive?.messages
        ? archive.messages.map((m) => redactViewMessage(m, redactFn))
        : [],
      approvals: [],
      ...(archive?.plan
        ? {
            plan: {
              ...archive.plan,
              items: archive.plan.items.map((item) => ({
                ...item,
                title: redactFn(item.title),
              })),
            },
          }
        : {}),
      notices: archive?.notices
        ? archive.notices.map((n) => ({ ...n, text: redactFn(n.text) }))
        : [],
      ...(cachedOptions ? { configOptions: cachedOptions } : {}),
    };
  }

  /** 在已信任工作区创建并握手打开一个新的外部代理会话（尚未发首轮 Prompt，处于 `'idle'` 态）。 */
  async openSession(
    input: {
      readonly workspaceRoot: string;
      readonly harnessId: string;
      readonly title?: string;
      readonly customTitle?: boolean;
      readonly requireIdleWorkspace?: boolean;
      /** 可选的新建会话初始模型 ID（缺省走代理自身默认）。 */
      readonly modelId?: string;
      /** 可选的新建会话初始模式 ID（缺省走代理自身默认）。 */
      readonly modeId?: string;
      /** 可选的新建会话初始推理档位（缺省走代理自身默认）。 */
      readonly thoughtLevel?: string;
    },
    signal?: AbortSignal,
  ): Promise<ViewExternalSnapshot> {
    if (this.disposed) {
      throw new ExternalHarnessError('EXTERNAL_ABORTED', '外部会话服务已关闭');
    }
    const nativeRoot = this.requireTrustedWorkspace(input.workspaceRoot);
    if (input.requireIdleWorkspace) {
      this.ensureWorkspaceNotRunning(nativeRoot, '');
    }
    const def = this.requireEnabledHarnessDefinition(input.harnessId);
    this.ensureProcessCapacity();

    const driver = this.requireDriver(def.transport);
    const id = `ext_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const now = Date.now();
    const configDigest = computeHarnessConfigDigest(def);
    const secrets = this.collectSecrets(nativeRoot, def);
    const hasExplicitTitle = Boolean(input.title?.trim());
    const customTitle = input.customTitle ?? hasExplicitTitle;
    const rawTitle = hasExplicitTitle ? input.title! : `${def.name} 任务`;
    const initialTitle =
      sanitizeDisplayText(redactText(rawTitle, secrets), 120) ?? `${def.name} 任务`;

    const initialConfig: ExternalConfigSelection[] = [];
    if (input.modelId?.trim()) {
      initialConfig.push({ category: 'model', value: input.modelId.trim() });
    }
    if (input.thoughtLevel?.trim()) {
      initialConfig.push({ category: 'thought_level', value: input.thoughtLevel.trim() });
    }
    if (input.modeId?.trim()) {
      initialConfig.push({ category: 'mode', value: input.modeId.trim() });
    }

    const initialRecord: ExternalSessionRecord = {
      id,
      harnessId: def.id,
      harnessName: def.name,
      transport: def.transport,
      workspaceRoot: nativeRoot,
      configDigest,
      title: initialTitle,
      ...(customTitle ? { customTitle: true } : {}),
      status: 'starting',
      resumable: false,
      createdAt: now,
      updatedAt: now,
    };
    const slot = await this.spawnAndBindSlot({
      record: initialRecord,
      def,
      driver,
      secrets,
      ...(initialConfig.length > 0 ? { initialConfig } : {}),
      signal,
    });
    if (!slot.closing) this.armIdleTimer(slot);
    this.flushSlotImmediate(slot);
    return this.buildLiveSnapshot(slot);
  }

  /**
   * 在空闲态切换外部会话的模型、模式或推理档位。
   *
   * 边界与恢复语义：
   * - 运行中或待审批状态下拒绝切换（`EXTERNAL_SESSION_BUSY`），避免打乱在途请求；
   * - 若子进程已空闲回收且仍满足可恢复门禁，自动先恢复会话再下发切换命令；
   * - 切换成功后同步更新展示标签与本地配置目录缓存，并广播给所有订阅方。
   */
  async setSessionConfig(
    input: {
      readonly sessionId: string;
      readonly configId: string;
      readonly category: ViewExternalConfigCategory;
      readonly value: string;
      readonly expectedWorkspaceRoot?: string;
    },
    signal?: AbortSignal,
  ): Promise<ViewExternalSnapshot> {
    if (this.disposed) {
      throw new ExternalHarnessError('EXTERNAL_ABORTED', '外部会话服务已关闭');
    }
    const resolvedId = this.resolveSessionId(input.sessionId, input.expectedWorkspaceRoot);
    let slot = this.liveSlots.get(resolvedId);
    if (slot) {
      const currentDef = this.requireEnabledHarnessDefinition(slot.record.harnessId);
      if (computeHarnessConfigDigest(currentDef) !== slot.record.configDigest) {
        await this.closeSession(resolvedId).catch(() => {});
        slot = undefined;
      }
    }
    if (!slot) {
      if (this.openingSessions.has(resolvedId)) {
        throw new ExternalHarnessError(
          'EXTERNAL_SESSION_BUSY',
          '当前外部会话正在握手恢复，请稍候再试',
        );
      }
      const record = this.registry.getRecord(resolvedId);
      if (!record) {
        throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `未找到外部会话 '${resolvedId}'`);
      }
      const nativeResumeRoot = this.requireTrustedWorkspace(record.workspaceRoot);
      if (normalizeProjectRoot(nativeResumeRoot) !== normalizeProjectRoot(record.workspaceRoot)) {
        throw new ExternalHarnessError(
          'EXTERNAL_UNTRUSTED_WORKSPACE',
          `工作区目录物理身份已变更，拒绝恢复外部会话 '${resolvedId}'`,
        );
      }
      this.verifyExpectedWorkspace(record.workspaceRoot, input.expectedWorkspaceRoot);
      if (record.owner) {
        throw new ExternalHarnessError('EXTERNAL_SESSION_BUSY', '外部会话由另一个宿主持有');
      }
      const def = this.requireEnabledHarnessDefinition(record.harnessId);
      if (!this.canContinueRecord(record)) {
        throw new ExternalHarnessError(
          'EXTERNAL_PROTOCOL_ERROR',
          '当前为外部代理只读历史归档，无法切换配置',
        );
      }
      this.ensureProcessCapacity();
      const driver = this.requireDriver(def.transport);
      slot = await this.spawnAndBindSlot({
        record,
        def,
        driver,
        resume: true,
        signal,
      });
    } else {
      this.requireTrustedWorkspace(slot.record.workspaceRoot);
      this.verifyExpectedWorkspace(slot.record.workspaceRoot, input.expectedWorkspaceRoot);
    }

    if (
      slot.closing ||
      slot.record.status === 'running' ||
      slot.record.status === 'waiting_approval' ||
      slot.record.status === 'cancelling' ||
      slot.record.status === 'starting'
    ) {
      throw new ExternalHarnessError(
        'EXTERNAL_SESSION_BUSY',
        '当前外部代理正在运行，请等待本轮结束后再切换配置',
      );
    }
    if (!slot.handle.setConfigOption) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `外部代理 '${slot.record.harnessName}' 暂不支持会话内动态切换配置`,
      );
    }

    this.clearSlotTimers(slot);
    const updated = await slot.handle.setConfigOption(
      {
        configId: input.configId,
        category: input.category,
        value: input.value,
      },
      signal,
    );
    if (updated.configOptions && updated.configOptions.length > 0) {
      slot.configOptions = updated.configOptions;
      saveHarnessConfigCache(
        this.homeDir,
        slot.record.harnessId,
        slot.record.configDigest,
        updated.configOptions,
      );
    }
    this.updateSlotRecordSafe(slot, {
      ...(updated.modelLabel !== undefined ? { modelLabel: updated.modelLabel } : {}),
      ...(updated.modeLabel !== undefined ? { modeLabel: updated.modeLabel } : {}),
      ...(updated.thoughtLevelLabel !== undefined
        ? { thoughtLevelLabel: updated.thoughtLevelLabel }
        : {}),
    });
    if (!slot.closing) this.armIdleTimer(slot);
    this.flushSlotImmediate(slot);
    return this.buildLiveSnapshot(slot);
  }

  /** 一步式创建外部代理会话并立即发送首轮任务文本；同工作区忙时前置拦截，避免泄漏空闲子进程。 */
  async startSession(
    input: {
      readonly workspaceRoot: string;
      readonly harnessId: string;
      readonly prompt: string;
    },
    signal?: AbortSignal,
  ): Promise<ViewExternalSnapshot> {
    if (!input.prompt.trim()) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', '发送给外部代理的任务内容不能为空');
    }
    const opened = await this.openSession(
      {
        workspaceRoot: input.workspaceRoot,
        harnessId: input.harnessId,
        title: input.prompt,
        customTitle: false,
        requireIdleWorkspace: true,
      },
      signal,
    );
    try {
      return await this.promptSession(
        {
          sessionId: opened.session.id,
          text: input.prompt,
        },
        signal,
      );
    } catch (err) {
      const live = this.liveSlots.get(opened.session.id);
      if (
        live &&
        live.projector.getMessages().length === 0 &&
        !this.registry.hasArchive(opened.session.id)
      ) {
        await this.deleteSession(opened.session.id).catch(() => {});
      }
      throw err;
    }
  }

  /**
   * 同步完成信任/并发校验、离线恢复握手与用户消息入列，立即返回 `'running'` 快照并在后台推进该轮执行。
   *
   * 供桌面端非阻塞 RPC 使用，避免长耗时外部轮次或待审批挂起触发桌面 30s RPC 请求超时。
   */
  async dispatchPrompt(
    input: {
      readonly sessionId: string;
      readonly text: string;
      readonly expectedWorkspaceRoot?: string;
    },
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
    input: {
      readonly sessionId: string;
      readonly text: string;
      readonly expectedWorkspaceRoot?: string;
    },
    signal?: AbortSignal,
  ): Promise<ViewExternalSnapshot> {
    const { completion } = await this.prepareAndLaunchPrompt(input, signal);
    return completion;
  }

  private async prepareAndLaunchPrompt(
    input: {
      readonly sessionId: string;
      readonly text: string;
      readonly expectedWorkspaceRoot?: string;
    },
    signal?: AbortSignal,
  ): Promise<{
    readonly initialSnapshot: ViewExternalSnapshot;
    readonly completion: Promise<ViewExternalSnapshot>;
  }> {
    if (this.disposed) {
      throw new ExternalHarnessError('EXTERNAL_ABORTED', '外部会话服务已关闭');
    }
    const resolvedId = this.resolveSessionId(input.sessionId, input.expectedWorkspaceRoot);
    const promptText = input.text.trim();
    if (!promptText) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', '发送给外部代理的任务内容不能为空');
    }

    let slot = this.liveSlots.get(resolvedId);
    if (slot) {
      const currentDef = this.requireEnabledHarnessDefinition(slot.record.harnessId);
      if (computeHarnessConfigDigest(currentDef) !== slot.record.configDigest) {
        await this.closeSession(resolvedId).catch(() => {});
        slot = undefined;
      }
    }
    if (!slot) {
      if (this.openingSessions.has(resolvedId)) {
        throw new ExternalHarnessError(
          'EXTERNAL_SESSION_BUSY',
          '当前外部会话正在握手恢复，请稍候再试',
        );
      }
      const record = this.registry.getRecord(resolvedId);
      if (!record) {
        throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `未找到外部会话 '${resolvedId}'`);
      }
      const nativeResumeRoot = this.requireTrustedWorkspace(record.workspaceRoot);
      if (normalizeProjectRoot(nativeResumeRoot) !== normalizeProjectRoot(record.workspaceRoot)) {
        throw new ExternalHarnessError(
          'EXTERNAL_UNTRUSTED_WORKSPACE',
          `工作区目录物理身份已变更，拒绝恢复外部会话 '${resolvedId}'`,
        );
      }
      this.verifyExpectedWorkspace(record.workspaceRoot, input.expectedWorkspaceRoot);
      if (record.owner) {
        throw new ExternalHarnessError('EXTERNAL_SESSION_BUSY', '外部会话由另一个宿主持有');
      }
      const def = this.requireEnabledHarnessDefinition(record.harnessId);
      if (!this.canContinueRecord(record)) {
        throw new ExternalHarnessError(
          'EXTERNAL_PROTOCOL_ERROR',
          '当前为外部代理只读历史归档（代理不支持恢复或启动配置已变更），如需继续请新建外部会话',
        );
      }
      this.ensureProcessCapacity();
      this.ensureWorkspaceNotRunning(record.workspaceRoot, resolvedId);

      const driver = this.requireDriver(def.transport);
      slot = await this.spawnAndBindSlot({ record, def, driver, resume: true, signal });
    }

    if (this.disposed) {
      throw new ExternalHarnessError('EXTERNAL_ABORTED', '外部会话服务已关闭');
    }
    this.requireTrustedWorkspace(slot.record.workspaceRoot);
    this.verifyExpectedWorkspace(slot.record.workspaceRoot, input.expectedWorkspaceRoot);
    if (slot.closing || slot.record.status !== 'idle') {
      throw new ExternalHarnessError(
        'EXTERNAL_SESSION_BUSY',
        '当前外部会话正在执行或等待审批，不能并发发送新轮次',
      );
    }
    this.ensureWorkspaceNotRunning(slot.record.workspaceRoot, resolvedId);

    const activeSlot = slot;
    if (activeSlot.closing || this.liveSlots.get(resolvedId) !== activeSlot) {
      throw new ExternalHarnessError('EXTERNAL_ABORTED', '外部会话已关闭');
    }
    this.clearIdleTimer(activeSlot);

    // 仅在未设置自定义标题且首轮尚无历史消息时，以脱敏后的首轮用户输入更新标题
    const updatedTitle =
      !activeSlot.record.customTitle && activeSlot.projector.getMessages().length === 0
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
        if (activeSlot.closing) {
          await activeSlot.closing;
          return this.buildLiveSnapshot(activeSlot);
        }
        if (this.liveSlots.get(resolvedId) !== activeSlot)
          return this.buildLiveSnapshot(activeSlot);
        this.cancelAllSlotApprovals(activeSlot);
        if (turnRes.stopReason === 'cancelled') {
          activeSlot.projector.interruptTurn();
          activeSlot.operation = { id: opId, phase: 'idle', result: 'aborted' };
        } else {
          activeSlot.projector.completeTurn(turnRes.usage);
          activeSlot.operation = { id: opId, phase: 'idle', result: 'completed' };
        }

        if (turnRes.processTerminated) {
          this.finishSlot(activeSlot, { status: 'ended' });
        } else {
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
        if (activeSlot.closing) {
          await activeSlot.closing;
          return this.buildLiveSnapshot(activeSlot);
        }
        const sanitizedErr = this.redactErrorInstance(err, activeSlot.secrets);
        if (this.liveSlots.get(resolvedId) !== activeSlot) throw sanitizedErr;
        this.cancelAllSlotApprovals(activeSlot);
        activeSlot.projector.interruptTurn();
        const safeErr =
          sanitizeDisplayText(
            redactText(err instanceof Error ? err.message : String(err), activeSlot.secrets),
            300,
          ) ?? '执行失败';
        activeSlot.operation = { id: opId, phase: 'idle', result: 'failed' };
        this.pushSlotNotice(activeSlot, {
          id: `notice-${randomUUID().slice(0, 8)}`,
          level: 'error',
          text: safeErr,
        });
        if (err instanceof ExternalHarnessError && err.processTerminated) {
          this.finishSlot(activeSlot, { status: 'failed', lastError: safeErr });
        } else {
          this.updateSlotRecord(activeSlot, { status: 'idle', lastError: safeErr });
          this.persistSlotArchive(activeSlot);
          this.armIdleTimer(activeSlot);
          this.flushSlotImmediate(activeSlot);
        }
        this.options.onAttentionEvent?.({
          kind: 'turn_failed',
          session: this.toViewSession(activeSlot.record),
        });
        throw sanitizedErr;
      }
    })();

    return { initialSnapshot, completion };
  }

  /** 回复指定外部会话中的挂起人工审批请求；未知选项抛错且不销毁原挂起审批单。 */
  async approveSession(input: {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly optionId?: string;
    readonly cancel?: boolean;
    readonly expectedWorkspaceRoot?: string;
  }): Promise<void> {
    const resolvedId = this.resolveSessionId(input.sessionId, input.expectedWorkspaceRoot);
    const slot = this.liveSlots.get(resolvedId);
    if (!slot || slot.closing) {
      throw new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', '外部会话已关闭，审批单已失效');
    }
    this.requireTrustedWorkspace(slot.record.workspaceRoot);
    this.verifyExpectedWorkspace(slot.record.workspaceRoot, input.expectedWorkspaceRoot);

    const entry = slot.approvals.get(input.approvalId);
    if (!entry) {
      throw new ExternalHarnessError(
        'EXTERNAL_APPROVAL_EXPIRED',
        '该外部审批请求已处理或已超时过期',
      );
    }

    if (!input.cancel && input.optionId) {
      const validOpt = entry.view.options.some((o) => o.optionId === input.optionId);
      if (!validOpt) {
        throw new ExternalHarnessError(
          'EXTERNAL_CONFIG_INVALID',
          `未知的审批选项 '${input.optionId}'`,
        );
      }
    }

    clearTimeout(entry.timer);
    slot.approvals.delete(input.approvalId);

    if (input.cancel || !input.optionId) {
      entry.respond({ outcome: 'cancelled' });
    } else {
      entry.respond({ outcome: 'selected', optionId: input.optionId });
    }

    if (slot.approvals.size === 0 && slot.record.status === 'waiting_approval') {
      const nextStatus = slot.operation?.phase === 'running' ? 'running' : 'idle';
      this.updateSlotRecord(slot, { status: nextStatus });
      if (nextStatus === 'idle') {
        this.armIdleTimer(slot);
      }
    }
    this.flushSlotImmediate(slot);
  }

  /** 取消当前外部会话正在执行的轮次或握手启动。 */
  async cancelSession(sessionId: string, expectedWorkspaceRoot?: string): Promise<void> {
    const resolvedId = this.resolveSessionId(sessionId, expectedWorkspaceRoot);
    const opening = this.openingSessions.get(resolvedId);
    if (opening) {
      this.verifyExpectedWorkspace(opening.workspaceRoot, expectedWorkspaceRoot);
      opening.abort.abort();
      return;
    }
    const slot = this.liveSlots.get(resolvedId);
    if (!slot) return;
    this.verifyExpectedWorkspace(slot.record.workspaceRoot, expectedWorkspaceRoot);
    if (slot.closing) return;
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
  async closeSession(sessionId: string, expectedWorkspaceRoot?: string): Promise<void> {
    const resolvedId = this.resolveSessionId(sessionId, expectedWorkspaceRoot);
    const opening = this.openingSessions.get(resolvedId);
    if (opening) {
      this.verifyExpectedWorkspace(opening.workspaceRoot, expectedWorkspaceRoot);
      opening.abort.abort();
      await opening.settled;
      return;
    }
    const slot = this.liveSlots.get(resolvedId);
    if (!slot) {
      const rec = this.registry.getRecord(resolvedId);
      if (rec) {
        this.verifyExpectedWorkspace(rec.workspaceRoot, expectedWorkspaceRoot);
        if (rec.owner) {
          throw new ExternalHarnessError('EXTERNAL_SESSION_BUSY', '外部会话由另一个宿主持有');
        }
      }
      return;
    }
    this.verifyExpectedWorkspace(slot.record.workspaceRoot, expectedWorkspaceRoot);

    slot.closing ??= Promise.resolve()
      .then(async () => {
        this.clearSlotTimers(slot);
        this.cancelAllSlotApprovals(slot);
        await slot.handle.close();
        slot.projector.interruptTurn();
        slot.operation = undefined;
        this.finishSlot(slot, { status: 'ended', lastError: undefined });
      })
      .catch((err) => {
        slot.closing = undefined;
        throw err;
      });
    await slot.closing;
  }

  /** 删除外部会话记录及其只读快照文件（若仍在运行先自动关闭子进程再删除）。 */
  async deleteSession(sessionId: string, expectedWorkspaceRoot?: string): Promise<boolean> {
    const resolvedId = this.resolveSessionId(sessionId, expectedWorkspaceRoot);
    const rec = this.registry.getRecord(resolvedId);
    if (rec) {
      this.verifyExpectedWorkspace(rec.workspaceRoot, expectedWorkspaceRoot);
    }
    if (this.liveSlots.has(resolvedId) || this.openingSessions.has(resolvedId)) {
      await this.closeSession(resolvedId, expectedWorkspaceRoot);
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

  /** 宿主停机清理：中止在途探测与握手、保存所有活动会话快照并两段式回收全部外部子进程树，确保零孤儿残留。 */
  async dispose(): Promise<void> {
    this.disposed = true;
    const probes = [...this.activeProbes];
    for (const p of probes) {
      p.abort.abort();
    }
    const opening = [...this.openingSessions.values()];
    for (const entry of opening) {
      entry.abort.abort();
    }
    const activeIds = [...this.liveSlots.keys()];
    await Promise.allSettled([
      ...probes.map((p) => p.promise),
      ...opening.map((entry) => entry.settled),
      ...activeIds.map((id) => this.closeSession(id)),
    ]);
    this.listSubscribers.clear();
    this.sessionSubscribers.clear();
  }

  private redactErrorInstance(err: unknown, secrets: readonly string[]): Error {
    if (err instanceof ExternalHarnessError) {
      const safeMsg = redactText(err.message, secrets);
      const safePublic = redactText(err.safeMessage, secrets);
      if (safeMsg === err.message && safePublic === err.safeMessage) {
        return err;
      }
      return new ExternalHarnessError(err.code, safeMsg, {
        retryPolicy: err.retryPolicy,
        safeMessage: safePublic,
        loginHint: err.loginHint,
        installHint: err.installHint,
        processTerminated: err.processTerminated,
      });
    }
    const rawMsg = err instanceof Error ? err.message : String(err);
    return new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', redactText(rawMsg, secrets));
  }

  private collectSecrets(workspaceRoot: string, def?: ExternalHarnessDefinition): string[] {
    const base = loadCredentialSecrets(workspaceRoot, this.homeDir);
    const forwarded = resolveForwardedEnvSecrets(
      def?.envFrom,
      this.options.hostEnv,
      process.platform,
    );
    return forwarded.length > 0 ? [...new Set([...base, ...forwarded])] : base;
  }

  private async spawnAndBindSlot(params: {
    readonly record: ExternalSessionRecord;
    readonly def: ExternalHarnessDefinition;
    readonly driver: ExternalHarnessDriver;
    readonly secrets?: readonly string[];
    readonly resume?: boolean;
    readonly initialConfig?: readonly ExternalConfigSelection[];
    readonly signal?: AbortSignal;
  }): Promise<LiveSessionSlot> {
    if (this.liveSlots.has(params.record.id) || this.openingSessions.has(params.record.id)) {
      throw new ExternalHarnessError(
        'EXTERNAL_SESSION_BUSY',
        '当前外部会话已在启动或已存在活跃进程',
      );
    }

    const secrets = params.secrets ?? this.collectSecrets(params.record.workspaceRoot, params.def);
    const projector = new ExternalTranscriptProjector(params.record.id, secrets);
    const claimed = this.registry.upsertRecord(
      { ...params.record, status: 'starting', updatedAt: Date.now() },
      params.resume,
    );
    const existingArchive = params.resume ? this.registry.readArchive(claimed.id) : undefined;
    if (existingArchive?.messages.length) {
      projector.replaceMessages(existingArchive.messages, existingArchive.truncated);
    }
    if (existingArchive?.plan?.items.length) {
      projector.applyEvent({ type: 'plan_updated', items: existingArchive.plan.items });
    }

    const slot: LiveSessionSlot = {
      record: claimed,
      handle: undefined as unknown as ExternalDriverSessionHandle,
      projector,
      approvals: new Map(),
      notices: existingArchive?.notices ? [...existingArchive.notices] : [],
      sequence: 0,
      truncatedArchive: Boolean(existingArchive?.truncated),
      secrets,
    };

    const openingAbort = new AbortController();
    const onParentAbort = (): void => {
      openingAbort.abort();
    };
    if (params.signal?.aborted) {
      openingAbort.abort();
    } else {
      params.signal?.addEventListener('abort', onParentAbort, { once: true });
    }

    let settleOpening!: () => void;
    const settled = new Promise<void>((resolve) => {
      settleOpening = resolve;
    });
    this.openingSessions.set(params.record.id, {
      workspaceRoot: params.record.workspaceRoot,
      title: params.record.title,
      abort: openingAbort,
      settled,
      slot,
    });
    this.notifyListChanged(claimed.workspaceRoot);

    try {
      const opened = await params.driver.open({
        def: params.def,
        workspaceRoot: params.record.workspaceRoot,
        ...(params.resume && claimed.nativeSessionId
          ? { nativeSessionId: claimed.nativeSessionId }
          : {}),
        ...(!params.resume && params.initialConfig?.length
          ? { initialConfig: params.initialConfig }
          : {}),
        signal: openingAbort.signal,
        onEvent: (event) => this.handleDriverEvent(slot, event),
      });
      slot.handle = opened.handle;

      if (this.disposed || openingAbort.signal.aborted) {
        throw new ExternalHarnessError('EXTERNAL_ABORTED', '外部会话启动已取消');
      }

      if (
        !existingArchive?.messages.length &&
        opened.replayedMessages &&
        opened.replayedMessages.length > 0
      ) {
        slot.projector.replaceMessages(opened.replayedMessages);
      }
      if (opened.configOptions && opened.configOptions.length > 0) {
        slot.configOptions = opened.configOptions;
        saveHarnessConfigCache(
          this.homeDir,
          params.def.id,
          params.record.configDigest,
          opened.configOptions,
        );
      }

      const updatedRecord: ExternalSessionRecord = {
        ...slot.record,
        status: 'idle',
        ...(opened.nativeSessionId
          ? { nativeSessionId: opened.nativeSessionId }
          : slot.record.nativeSessionId
            ? { nativeSessionId: slot.record.nativeSessionId }
            : {}),
        resumable: Boolean(opened.resumable || slot.record.resumable),
        ...(opened.modelLabel
          ? { modelLabel: opened.modelLabel }
          : slot.record.modelLabel
            ? { modelLabel: slot.record.modelLabel }
            : {}),
        ...(opened.modeLabel
          ? { modeLabel: opened.modeLabel }
          : slot.record.modeLabel
            ? { modeLabel: slot.record.modeLabel }
            : {}),
        ...(opened.thoughtLevelLabel
          ? { thoughtLevelLabel: opened.thoughtLevelLabel }
          : slot.record.thoughtLevelLabel
            ? { thoughtLevelLabel: slot.record.thoughtLevelLabel }
            : {}),
        updatedAt: Date.now(),
      };
      slot.record = this.registry.upsertRecord(updatedRecord);
      this.liveSlots.set(updatedRecord.id, slot);
      return slot;
    } catch (err) {
      await slot.handle?.close().catch(() => {});
      this.clearSlotTimers(slot);
      this.cancelAllSlotApprovals(slot);
      const aborted = openingAbort.signal.aborted;
      const rawErr = err instanceof Error ? err.message : String(err);
      if (
        !params.resume &&
        slot.projector.getMessages().length === 0 &&
        !this.registry.hasArchive(claimed.id)
      ) {
        try {
          this.registry.deleteRecord(claimed.id);
        } catch {
          /* ignore cleanup failure */
        }
      } else {
        this.updateSlotRecordSafe(slot, {
          status: aborted ? 'ended' : 'failed',
          lastError: aborted ? undefined : sanitizeDisplayText(redactText(rawErr, secrets), 300),
        });
      }
      this.notifyListChanged(claimed.workspaceRoot);
      throw this.redactErrorInstance(err, secrets);
    } finally {
      params.signal?.removeEventListener('abort', onParentAbort);
      this.openingSessions.delete(params.record.id);
      settleOpening();
    }
  }

  private handleDriverEvent(slot: LiveSessionSlot, event: ExternalEvent): void {
    if (
      slot.closing ||
      (this.liveSlots.get(slot.record.id) !== slot &&
        this.openingSessions.get(slot.record.id)?.slot !== slot)
    ) {
      if (event.type === 'approval_requested') event.respond({ outcome: 'cancelled' });
      return;
    }
    switch (event.type) {
      case 'text_delta':
      case 'thought_delta':
      case 'user_delta': {
        slot.projector.applyEvent(event);
        if (slot.projector.wasTruncated()) {
          slot.truncatedArchive = true;
        }
        this.scheduleCoalescedFlush(slot);
        return;
      }
      case 'tool_upsert':
      case 'plan_updated': {
        slot.projector.applyEvent(event);
        if (slot.projector.wasTruncated()) {
          slot.truncatedArchive = true;
        }
        this.emitSnapshotImmediate(slot);
        return;
      }
      case 'config_updated': {
        if (event.configOptions && event.configOptions.length > 0) {
          slot.configOptions = event.configOptions;
          saveHarnessConfigCache(
            this.homeDir,
            slot.record.harnessId,
            slot.record.configDigest,
            event.configOptions,
          );
        }
        this.updateSlotRecordSafe(slot, {
          ...(event.nativeSessionId ? { nativeSessionId: event.nativeSessionId } : {}),
          ...(event.resumable !== undefined ? { resumable: event.resumable } : {}),
          ...(event.modelLabel ? { modelLabel: event.modelLabel } : {}),
          ...(event.modeLabel ? { modeLabel: event.modeLabel } : {}),
          ...(event.thoughtLevelLabel ? { thoughtLevelLabel: event.thoughtLevelLabel } : {}),
        });
        this.flushSlotImmediate(slot);
        return;
      }
      case 'approval_cancelled': {
        let removed = false;
        for (const [aprId, entry] of slot.approvals) {
          if (entry.requestId === event.requestId) {
            clearTimeout(entry.timer);
            slot.approvals.delete(aprId);
            removed = true;
          }
        }
        if (removed) {
          if (slot.approvals.size === 0 && slot.record.status === 'waiting_approval') {
            const nextStatus = slot.operation?.phase === 'running' ? 'running' : 'idle';
            this.updateSlotRecordSafe(slot, { status: nextStatus });
            if (nextStatus === 'idle') {
              this.armIdleTimer(slot);
            }
          }
          this.flushSlotImmediate(slot);
        }
        return;
      }
      case 'approval_requested': {
        if (
          slot.closing ||
          slot.record.status === 'cancelling' ||
          slot.operation?.phase !== 'running'
        ) {
          event.respond({ outcome: 'cancelled' });
          return;
        }
        const approvalId = `extapr_${randomUUID().slice(0, 12)}`;
        const expiresAt = Date.now() + this.approvalTimeoutMs;
        const view: ViewExternalApproval = {
          approvalId,
          sessionId: slot.record.id,
          toolCallId: event.toolCallId.slice(0, 256) || 'tool',
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
          this.pushSlotNotice(slot, {
            id: `notice-${randomUUID().slice(0, 8)}`,
            level: 'warning',
            text: `外部审批「${view.toolTitle}」已超时（${Math.round(this.approvalTimeoutMs / 1000)}s），已自动按取消拒绝`,
          });
          if (slot.approvals.size === 0 && slot.record.status === 'waiting_approval') {
            const nextStatus = slot.operation?.phase === 'running' ? 'running' : 'idle';
            this.updateSlotRecordSafe(slot, { status: nextStatus });
            if (nextStatus === 'idle') {
              this.armIdleTimer(slot);
            }
          }
          this.flushSlotImmediate(slot);
        }, this.approvalTimeoutMs);
        timer.unref?.();

        slot.approvals.set(approvalId, {
          requestId: event.requestId,
          view,
          timer,
          respond: event.respond,
        });
        this.updateSlotRecordSafe(slot, { status: 'waiting_approval' });
        this.flushSlotImmediate(slot);
        this.options.onAttentionEvent?.({
          kind: 'approval_requested',
          session: this.toViewSession(slot.record),
        });
        return;
      }
      case 'diagnostic': {
        if (event.level === 'warning' || event.level === 'error') {
          this.pushSlotNotice(slot, {
            id: `notice-${randomUUID().slice(0, 8)}`,
            level: event.level,
            text: redactText(event.text, slot.secrets),
          });
          this.emitSnapshotImmediate(slot);
        }
        return;
      }
      case 'closed': {
        if (this.liveSlots.get(slot.record.id) !== slot) return;
        const running = slot.operation?.phase === 'running';
        slot.projector.interruptTurn();
        slot.operation = undefined;
        const crashed =
          running || event.signal !== null || (event.code !== 0 && event.code !== null);
        const errTail = event.stderrTail
          ? sanitizeDisplayText(redactText(event.stderrTail, slot.secrets), 240)
          : undefined;
        const fallbackCrashMsg = event.signal
          ? `外部代理进程因信号 ${event.signal} 终止`
          : '外部代理进程已异常退出';
        this.finishSlot(slot, {
          status: crashed ? 'failed' : 'ended',
          lastError: crashed ? (errTail ?? fallbackCrashMsg) : undefined,
        });
        if (running)
          this.options.onAttentionEvent?.({
            kind: 'turn_failed',
            session: this.toViewSession(slot.record),
          });
        return;
      }
    }
  }

  private pushSlotNotice(slot: LiveSessionSlot, notice: ViewNotice): void {
    slot.notices.push(notice);
    if (slot.notices.length > MAX_LIVE_NOTICES) {
      slot.notices.splice(0, slot.notices.length - MAX_LIVE_NOTICES);
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

  private emitSnapshotImmediate(slot: LiveSessionSlot): void {
    if (slot.coalesceTimer !== undefined) {
      clearTimeout(slot.coalesceTimer);
      slot.coalesceTimer = undefined;
    }
    this.emitSnapshot(slot);
  }

  private flushSlotImmediate(slot: LiveSessionSlot): void {
    this.emitSnapshotImmediate(slot);
    this.notifyListChanged(slot.record.workspaceRoot);
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
      const alreadyTruncated = slot.truncatedArchive || slot.projector.wasTruncated();
      this.registry.saveArchive(
        slot.record.id,
        {
          messages: slot.projector.getMessages(),
          plan: slot.projector.getPlan(),
          notices: slot.notices,
          alreadyTruncated,
        },
        slot.secrets,
      );
      const persisted = this.registry.readArchive(slot.record.id);
      if (persisted?.truncated) {
        slot.truncatedArchive = true;
      }
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
    slot.record = this.registry.upsertRecord(next);
  }

  private updateSlotRecordSafe(
    slot: LiveSessionSlot,
    patch: Partial<Omit<ExternalSessionRecord, 'id' | 'createdAt'>>,
  ): void {
    try {
      this.updateSlotRecord(slot, patch);
    } catch {
      slot.record = {
        ...slot.record,
        ...patch,
        updatedAt: Date.now(),
      };
    }
  }

  /** 子进程已收口后先归档，再释放持久归属；`finally` 保证即便磁盘短暂忙也不将死槽滞留在 `liveSlots`。 */
  private finishSlot(
    slot: LiveSessionSlot,
    patch: { readonly status: 'ended' | 'failed'; readonly lastError?: string },
  ): void {
    this.clearSlotTimers(slot);
    this.cancelAllSlotApprovals(slot);
    this.persistSlotArchive(slot);
    try {
      this.updateSlotRecordSafe(slot, patch);
    } finally {
      this.liveSlots.delete(slot.record.id);
      this.flushSlotImmediate(slot);
    }
  }

  private buildLiveSnapshot(slot: LiveSessionSlot): ViewExternalSnapshot {
    const truncated = slot.truncatedArchive || slot.projector.wasTruncated();
    return {
      session: this.toViewSession(slot.record),
      sequence: slot.sequence,
      ...(truncated ? { truncatedArchive: true } : {}),
      messages: slot.projector.getMessages(),
      ...(slot.operation ? { operation: slot.operation } : {}),
      approvals: [...slot.approvals.values()].map((a) => a.view),
      ...(slot.projector.getPlan() ? { plan: slot.projector.getPlan() } : {}),
      notices: [...slot.notices],
      ...(slot.configOptions && slot.configOptions.length > 0
        ? { configOptions: slot.configOptions }
        : {}),
    };
  }

  private buildResolvedHarnessMap(): Map<string, ExternalHarnessDefinition> {
    const map = new Map<string, ExternalHarnessDefinition>();
    for (const item of listResolvedExternalHarnesses({
      homeDir: this.homeDir,
      hostEnv: this.options.hostEnv,
    })) {
      map.set(item.definition.id, item.definition);
    }
    return map;
  }

  private reconcileLiveSlotsForHarness(harnessId: string): void {
    const currentDef = this.buildResolvedHarnessMap().get(harnessId);
    const nextDigest = currentDef?.enabled ? computeHarnessConfigDigest(currentDef) : undefined;
    for (const [sid, opening] of this.openingSessions) {
      if (opening.slot.record.harnessId === harnessId) {
        if (!nextDigest || opening.slot.record.configDigest !== nextDigest) {
          opening.abort.abort();
        }
      }
      void sid;
    }
    for (const [sid, slot] of this.liveSlots) {
      if (slot.record.harnessId === harnessId) {
        if (!nextDigest || slot.record.configDigest !== nextDigest) {
          void this.closeSession(sid).catch(() => {});
        }
      }
    }
  }

  private canContinueRecord(
    record: ExternalSessionRecord,
    harnessMap?: ReadonlyMap<string, ExternalHarnessDefinition>,
  ): boolean {
    const def = harnessMap
      ? harnessMap.get(record.harnessId)
      : this.buildResolvedHarnessMap().get(record.harnessId);
    if (!def || !def.enabled) return false;
    if (!this.drivers[def.transport]) return false;
    if (computeHarnessConfigDigest(def) !== record.configDigest) return false;

    const live = this.liveSlots.get(record.id);
    if (live) return !live.closing;
    if (record.owner) return false;
    return Boolean(record.resumable && record.nativeSessionId);
  }

  private toViewSession(
    record: ExternalSessionRecord,
    harnessMap?: ReadonlyMap<string, ExternalHarnessDefinition>,
  ): ViewExternalSession {
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
      canContinue: this.canContinueRecord(effective, harnessMap),
      hasArchive: Boolean(
        (live && live.projector.getMessages().length > 0) || this.registry.hasArchive(effective.id),
      ),
      pendingApprovalCount: live ? live.approvals.size : 0,
      ...(effective.modelLabel ? { modelLabel: effective.modelLabel } : {}),
      ...(effective.modeLabel ? { modeLabel: effective.modeLabel } : {}),
      ...(effective.thoughtLevelLabel ? { thoughtLevelLabel: effective.thoughtLevelLabel } : {}),
      createdAt: effective.createdAt,
      updatedAt: effective.updatedAt,
      ...(effective.lastError ? { lastError: effective.lastError } : {}),
    };
  }

  private verifyExpectedWorkspace(
    recordWorkspaceRoot: string,
    expectedWorkspaceRoot?: string,
  ): void {
    if (!expectedWorkspaceRoot) return;
    const expectedNative = this.requireTrustedWorkspace(expectedWorkspaceRoot);
    if (normalizeProjectRoot(recordWorkspaceRoot) !== normalizeProjectRoot(expectedNative)) {
      throw new ExternalHarnessError(
        'EXTERNAL_CONFIG_INVALID',
        `外部会话不属于当前工作区 '${expectedNative}'`,
      );
    }
  }

  private requireTrustedWorkspace(workspaceRoot: string): string {
    if (!workspaceRoot || !path.isAbsolute(workspaceRoot)) {
      throw new ExternalHarnessError(
        'EXTERNAL_UNTRUSTED_WORKSPACE',
        '必须提供绝对路径的工作区根目录',
      );
    }
    let nativeRoot: string;
    try {
      nativeRoot = fs.realpathSync.native(workspaceRoot);
      if (!fs.statSync(nativeRoot).isDirectory()) {
        throw new Error('NOT_DIRECTORY');
      }
    } catch {
      throw new ExternalHarnessError(
        'EXTERNAL_UNTRUSTED_WORKSPACE',
        `工作区目录不存在或无法解析物理身份: '${workspaceRoot}'`,
      );
    }
    const trusted = this.options.isWorkspaceTrusted
      ? this.options.isWorkspaceTrusted(nativeRoot)
      : isProjectTrusted(
          loadSettings({ cwd: nativeRoot, homeDir: this.homeDir, includeProject: false }).settings,
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
    const hit = listResolvedExternalHarnesses({
      homeDir: this.homeDir,
      hostEnv: this.options.hostEnv,
    }).find((item) => item.definition.id === id);
    if (!hit) {
      throw new ExternalHarnessError('EXTERNAL_CONFIG_INVALID', `未找到外部代理 '${id}'`);
    }
    return hit.definition;
  }

  private requireEnabledHarnessDefinition(id: string): ExternalHarnessDefinition {
    const def = this.requireHarnessDefinition(id);
    if (!def.enabled) {
      throw new ExternalHarnessError(
        'EXTERNAL_HARNESS_DISABLED',
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
    if (this.liveSlots.size + this.openingSessions.size >= this.maxActiveProcesses) {
      throw new ExternalHarnessError(
        'EXTERNAL_CAPACITY',
        `并发活跃外部代理进程数已达上限（${this.maxActiveProcesses} 个），请先关闭空闲外部会话`,
      );
    }
  }

  private ensureWorkspaceNotRunning(workspaceRoot: string, currentSessionId: string): void {
    const targetNorm = normalizeProjectRoot(workspaceRoot);
    for (const [id, opening] of this.openingSessions) {
      if (id === currentSessionId) continue;
      if (normalizeProjectRoot(opening.workspaceRoot) !== targetNorm) continue;
      throw new ExternalHarnessError(
        'EXTERNAL_WORKSPACE_BUSY',
        `同一工作区已有正在启动的外部代理会话（${opening.title}），请等待其完成或取消后再试`,
      );
    }
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
