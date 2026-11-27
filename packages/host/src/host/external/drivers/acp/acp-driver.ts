import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type {
  ViewExternalConfigCategory,
  ViewExternalConfigChoice,
  ViewExternalConfigOption,
  ViewTool,
} from '../../../../view-model/index.js';
import { buildExternalLaunchEnv } from '../../env.js';
import { NdjsonChannel } from '../../ndjson-channel.js';
import { ExternalProcessSupervisor, resolveExternalCommand } from '../../process.js';
import { formatThoughtLevelLabel, orderThoughtLevels } from '../../thought-levels.js';
import {
  type ExternalApprovalDecision,
  type ExternalConfigSelection,
  type ExternalDriverOpenResult,
  type ExternalDriverSessionHandle,
  type ExternalEvent,
  type ExternalHarnessDefinition,
  type ExternalHarnessDriver,
  ExternalHarnessError,
  type ExternalInspectResult,
  type ExternalSetConfigResult,
  type ExternalTurnResult,
  isValidNativeSessionId,
} from '../../types.js';
import { type AcpHarnessFlavor, isAcpAuthRequiredError, resolveAcpFlavor } from './flavors.js';
import { ExternalTranscriptProjector } from './projector.js';
import {
  LEGACY_ACP_MODEL_CONFIG_ID,
  LEGACY_ACP_MODE_CONFIG_ID,
  extractAcpChunkText,
  normalizeAcpConfigOptions,
  normalizeAcpConfigSummary,
  normalizeAcpInitializeResult,
  normalizeAcpPermissionRequest,
  normalizeAcpPlanUpdate,
  normalizeAcpToolUpdate,
  normalizeAcpUsage,
  patchAcpConfigOptions,
  summarizeAcpConfigOptions,
} from './tolerance.js';

/** 设置页「检测连接」默认超时（20 秒；兼容 Oh My Pi 等首次初始化模型/扩展耗时约 12 秒的代理）。 */
const DEFAULT_INSPECT_TIMEOUT_MS = 20_000;
/** 设置页非破坏性探测阶段的 `authenticate` 子步骤超时上限（3.5 秒），避免未登录 OAuth 回调长时间阻塞探测按钮。 */
const INSPECT_AUTH_PROBE_TIMEOUT_MS = 3_500;
/** 会话启动握手默认超时（60 秒）。 */
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000;
/** 轮次无进展静默看门狗上限（10 分钟；有实质输出即顺延，审批挂起期间暂停）。 */
const DEFAULT_TURN_WATCHDOG_MS = 10 * 60_000;
/** 发送 `session/cancel` 后等待外部代理收口响应的宽限时间（5 秒）。 */
const CANCEL_SETTLE_GRACE_MS = 5_000;
/** 操作系统休眠唤醒时钟跳变容忍阈值（10 秒）。 */
const SLEEP_JUMP_TOLERANCE_MS = 10_000;

/** `AcpStdioDriver` 可调参数（支持单测缩短超时与注入宿主环境）。 */
export interface AcpStdioDriverOptions {
  readonly clientVersion?: string;
  readonly inspectTimeoutMs?: number;
  readonly handshakeTimeoutMs?: number;
  readonly turnWatchdogMs?: number;
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  readonly homeDir?: string;
  readonly platform?: NodeJS.Platform;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pickAuthMethodId(
  flavor: AcpHarnessFlavor,
  methods: readonly { readonly id: string; readonly name: string }[],
): string | undefined {
  if (!flavor.preferredAuthMethodIds || flavor.preferredAuthMethodIds.length === 0) {
    return undefined;
  }
  for (const preferred of flavor.preferredAuthMethodIds) {
    const hit = methods.find((m) => m.id === preferred);
    if (hit) return hit.id;
  }
  return undefined;
}

function waitAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ExternalHarnessError('EXTERNAL_ABORTED', '操作已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new ExternalHarnessError('EXTERNAL_ABORTED', '操作已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 调用 ACP `session/set_config_option`，并兼容部分代理（如 OpenCode 2.4.2）内部异步事件总线尚未落位导致首次回包仍带旧 `currentValue` 的竞态：
 * 若回包携带 `configOptions` 且对应配置项 `currentValue` 仍未切至目标值，等待 35ms 后补发一次确认落位，确保联动的 `effort` 等衍生选项完整返回。
 */
async function setAcpConfigOptionWithSettle(
  channel: NdjsonChannel,
  params: {
    readonly sessionId: string;
    readonly configId: string;
    readonly value: string;
  },
  options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
): Promise<unknown> {
  const firstRaw = await channel.request('session/set_config_option', params, options);
  const firstOpts = normalizeAcpConfigOptions(firstRaw);
  const matched = firstOpts.find((item) => item.id === params.configId);
  if (matched?.currentValue && matched.currentValue !== params.value) {
    await waitAbortable(35, options.signal);
    return await channel.request('session/set_config_option', params, options);
  }
  return firstRaw;
}

/** 探测阶段采集每个模型候选各自支持的推理强度（如 OpenCode 仅部分推理模型暴露 `effort` 变体）。 */
async function enrichAcpModelThoughtLevels(params: {
  readonly channel: NdjsonChannel;
  readonly sessionId: string;
  readonly baseOptions: readonly ViewExternalConfigOption[];
  readonly preferredOverrides?: readonly {
    readonly category: 'model' | 'thought_level';
    readonly value: string;
  }[];
  readonly budgetMs: number;
  readonly signal?: AbortSignal;
}): Promise<ViewExternalConfigOption[]> {
  const { channel, sessionId, baseOptions, preferredOverrides, budgetMs, signal } = params;
  const modelOpt = baseOptions.find((opt) => opt.category === 'model');
  if (
    !modelOpt ||
    modelOpt.id === LEGACY_ACP_MODEL_CONFIG_ID ||
    modelOpt.options.length === 0 ||
    modelOpt.options.length > 40 ||
    budgetMs < 400
  ) {
    return [...baseOptions];
  }

  const deadline = Date.now() + Math.min(budgetMs, 4_500);
  const perModel = new Map<
    string,
    { readonly levels: readonly string[]; readonly defaultLevel?: string }
  >();
  const discoveredChoices = new Map<string, ViewExternalConfigChoice>();
  let discoveredThoughtId =
    baseOptions.find((opt) => opt.category === 'thought_level')?.id ?? 'effort';
  let discoveredThoughtName =
    baseOptions.find((opt) => opt.category === 'thought_level')?.name ?? '推理强度';

  const recordThoughtOption = (
    modelValue: string,
    thoughtOpt: ViewExternalConfigOption | undefined,
  ): void => {
    if (!thoughtOpt || thoughtOpt.options.length === 0) {
      perModel.set(modelValue, { levels: [] });
      return;
    }
    discoveredThoughtId = thoughtOpt.id;
    discoveredThoughtName = thoughtOpt.name;
    const vals: string[] = [];
    for (const c of thoughtOpt.options) {
      vals.push(c.value);
      if (!discoveredChoices.has(c.value)) {
        discoveredChoices.set(c.value, {
          value: c.value,
          name: formatThoughtLevelLabel(c.value),
          ...(c.description ? { description: c.description } : {}),
        });
      }
    }
    const orderedVals = orderThoughtLevels(vals);
    const defaultLevel =
      thoughtOpt.currentValue && orderedVals.includes(thoughtOpt.currentValue)
        ? thoughtOpt.currentValue
        : orderedVals[0];
    perModel.set(modelValue, {
      levels: orderedVals,
      ...(defaultLevel ? { defaultLevel } : {}),
    });
  };

  if (modelOpt.currentValue) {
    recordThoughtOption(
      modelOpt.currentValue,
      baseOptions.find((opt) => opt.category === 'thought_level'),
    );
  }

  for (const choice of modelOpt.options) {
    if (perModel.has(choice.value)) continue;
    const leftMs = deadline - Date.now();
    if (leftMs < 150 || signal?.aborted) break;
    try {
      const stepRaw = await setAcpConfigOptionWithSettle(
        channel,
        { sessionId, configId: modelOpt.id, value: choice.value },
        { timeoutMs: Math.min(1_500, leftMs), signal },
      );
      const stepOpts = normalizeAcpConfigOptions(stepRaw);
      const stepModel = stepOpts.find((opt) => opt.category === 'model');
      if (stepModel?.currentValue && stepModel.currentValue !== choice.value) {
        continue;
      }
      recordThoughtOption(
        choice.value,
        stepOpts.find((opt) => opt.category === 'thought_level'),
      );
    } catch {
      /* 单个模型探测超时或不支持切换时跳过，保留已探明结果 */
      break;
    }
  }

  const preferredModel = preferredOverrides?.find((o) => o.category === 'model')?.value;
  const preferredThought = preferredOverrides?.find((o) => o.category === 'thought_level')?.value;
  const effectiveCurrentModel =
    preferredModel && modelOpt.options.some((c) => c.value === preferredModel)
      ? preferredModel
      : modelOpt.currentValue;

  const enrichedModelChoices: ViewExternalConfigChoice[] = modelOpt.options.map((choice) => {
    const meta = perModel.get(choice.value);
    if (!meta) return choice;
    return {
      ...choice,
      supportedThoughtLevels: meta.levels,
      ...(meta.defaultLevel ? { defaultThoughtLevel: meta.defaultLevel } : {}),
    };
  });

  const enrichedModelOpt: ViewExternalConfigOption = {
    ...modelOpt,
    ...(effectiveCurrentModel ? { currentValue: effectiveCurrentModel } : {}),
    options: enrichedModelChoices,
  };

  const out: ViewExternalConfigOption[] = [enrichedModelOpt];

  if (discoveredChoices.size > 0) {
    const orderedThoughtChoices = orderThoughtLevels(discoveredChoices.keys()).map(
      (v) => discoveredChoices.get(v)!,
    );
    const activeModelMeta = effectiveCurrentModel ? perModel.get(effectiveCurrentModel) : undefined;
    const effectiveCurrentThought =
      preferredThought && orderedThoughtChoices.some((c) => c.value === preferredThought)
        ? preferredThought
        : (activeModelMeta?.defaultLevel ?? orderedThoughtChoices[0]?.value);
    out.push({
      id: discoveredThoughtId,
      name: discoveredThoughtName,
      category: 'thought_level',
      ...(effectiveCurrentThought ? { currentValue: effectiveCurrentThought } : {}),
      options: orderedThoughtChoices,
    });
  } else {
    const existingThought = baseOptions.find((opt) => opt.category === 'thought_level');
    if (existingThought) out.push(existingThought);
  }

  for (const other of baseOptions) {
    if (other.category !== 'model' && other.category !== 'thought_level') {
      out.push(other);
    }
  }
  return out;
}

/**
 * 标准 ACP（Agent Client Protocol）JSON-RPC 2.0 over NDJSON stdio 传输驱动。
 *
 * 承载范围：Antigravity（`agy acp`）、OpenCode（`opencode acp`）、DeepSeek Harness（`dsh --profile acp`）、
 * Gemini CLI、Qwen Code、Oh My Pi（`omp acp`）、Qoder / Qoder CN（`qodercli --acp` / `qoderclicn --acp`）、
 * TRAE / TRAE CN（`traecli acp serve`）、官方 ACP Registry 模板与任意第三方 `Local ACP Command`。
 */
export class AcpStdioDriver implements ExternalHarnessDriver {
  readonly transport = 'acp' as const;

  constructor(private readonly options: AcpStdioDriverOptions = {}) {}

  /**
   * 非破坏性握手探测：校验可执行文件解析、完成 `initialize` 能力交换并惰性探明登录态，探测结束后立即回收临时进程。
   */
  async inspect(
    def: ExternalHarnessDefinition,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ExternalInspectResult> {
    if (signal?.aborted) {
      throw new ExternalHarnessError('EXTERNAL_ABORTED', '探测已取消');
    }
    let flavor = resolveAcpFlavor({ flavor: def.flavor, command: def.command, args: def.args });

    let resolvedCmd: ReturnType<typeof resolveExternalCommand>;
    try {
      resolvedCmd = resolveExternalCommand({
        command: def.command,
        args: def.args,
        platform: this.options.platform,
        homeDir: this.options.homeDir,
        hostEnv: this.options.hostEnv,
      });
    } catch (err) {
      if (err instanceof ExternalHarnessError) {
        if (err.code === 'EXTERNAL_COMMAND_NOT_FOUND') {
          return {
            available: false,
            loadSupported: false,
            status: 'not_installed',
            reason: err.message,
            ...(flavor.installHint ? { installHint: flavor.installHint } : {}),
          };
        }
        if (err.code === 'EXTERNAL_UNSUPPORTED_SHIM' || err.code === 'EXTERNAL_NODE_NOT_FOUND') {
          return {
            available: false,
            loadSupported: false,
            status: 'invalid_shim',
            reason: err.message,
            ...(flavor.installHint ? { installHint: flavor.installHint } : {}),
          };
        }
      }
      return {
        available: false,
        loadSupported: false,
        status: 'handshake_failed',
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    let proc: ExternalProcessSupervisor | undefined;
    let channel: NdjsonChannel | undefined;
    const timeoutMs = this.options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const remainingBudgetMs = (): number => Math.max(1_000, deadline - Date.now());

    try {
      const launchEnv = buildExternalLaunchEnv({
        hostEnv: this.options.hostEnv,
        env: def.env,
        envFrom: def.envFrom,
        extraPathDirs: resolvedCmd.extraPathDirs,
        platform: this.options.platform,
      });

      proc = ExternalProcessSupervisor.spawn({
        executable: resolvedCmd.executable,
        args: resolvedCmd.args,
        cwd,
        env: launchEnv.env,
      });

      channel = new NdjsonChannel(proc.stdout, proc.stdin);
      const initRaw = await channel.request(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: {
            name: 'Kapibala',
            version: this.options.clientVersion ?? '0.1.5',
          },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        { timeoutMs, signal },
      );
      channel.markHandshakeCompleted();

      const init = normalizeAcpInitializeResult(initRaw);
      flavor = resolveAcpFlavor({
        flavor: def.flavor,
        command: def.command,
        args: def.args,
        agentInfoName: init.agentName,
      });

      const authMethodId = pickAuthMethodId(flavor, init.authMethods);
      let probeNewRes: unknown;
      if (authMethodId || init.authMethods.length > 0) {
        // 惰性认证探测：对声明了 authMethods 的代理（如 Antigravity / Gemini / TRAE / OMP）先试调 session/new 核验既有登录态，
        // 避免盲目触发交互式浏览器 OAuth 弹窗；仅当报未鉴权且存在首选静默认证方法时才降级尝试 authenticate。
        try {
          probeNewRes = await channel.request(
            'session/new',
            { cwd, mcpServers: [] },
            { timeoutMs: remainingBudgetMs(), signal },
          );
        } catch (probeErr) {
          const probeRpcCode =
            probeErr &&
            typeof probeErr === 'object' &&
            typeof (probeErr as { rpcCode?: unknown }).rpcCode === 'number'
              ? (probeErr as { rpcCode: number }).rpcCode
              : undefined;
          const probeMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
          if (!isAcpAuthRequiredError(`${probeMsg} ${proc.getStderrTail()}`, probeRpcCode)) {
            throw probeErr;
          }
          if (!authMethodId) {
            return {
              available: false,
              ...(init.agentName ? { agentName: init.agentName } : {}),
              ...(init.version ? { version: init.version } : {}),
              loadSupported: Boolean(init.loadMethod),
              status: 'needs_login',
              reason: '已完成协议握手，但尚未完成登录鉴权',
              ...(flavor.loginHint ? { loginHint: flavor.loginHint } : {}),
            };
          }
          try {
            await channel.request(
              'authenticate',
              { methodId: authMethodId },
              { timeoutMs: Math.min(remainingBudgetMs(), INSPECT_AUTH_PROBE_TIMEOUT_MS), signal },
            );
            probeNewRes = await channel.request(
              'session/new',
              { cwd, mcpServers: [] },
              { timeoutMs: remainingBudgetMs(), signal },
            );
          } catch (authErr) {
            const authMsg = authErr instanceof Error ? authErr.message : String(authErr);
            return {
              available: false,
              ...(init.agentName ? { agentName: init.agentName } : {}),
              ...(init.version ? { version: init.version } : {}),
              loadSupported: Boolean(init.loadMethod),
              status: 'needs_login',
              reason: `已完成协议握手，但认证未通过（${authMsg}）`,
              ...(flavor.loginHint ? { loginHint: flavor.loginHint } : {}),
            };
          }
        }
        if (flavor.id === 'omp' && !normalizeAcpConfigSummary(probeNewRes).modelLabel) {
          return {
            available: false,
            ...(init.agentName ? { agentName: init.agentName } : {}),
            ...(init.version ? { version: init.version } : {}),
            loadSupported: Boolean(init.loadMethod),
            status: 'needs_login',
            reason: 'Oh My Pi 尚未配置默认模型或登录凭据（请在终端运行 omp 执行 /login 与 /model）',
            ...(flavor.loginHint ? { loginHint: flavor.loginHint } : {}),
          };
        }
      } else if (flavor.id !== 'dsh') {
        // 对未声明 authMethods 的 ACP 代理也尝试一次非破坏性 session/new 以顺带采集可用模型与模式目录；
        // 仅在命中未鉴权错误时标 needs_login，其余失败静默忽略不影响握手就绪判定。
        try {
          probeNewRes = await channel.request(
            'session/new',
            { cwd, mcpServers: [] },
            { timeoutMs: Math.min(remainingBudgetMs(), 8_000), signal },
          );
        } catch (probeErr) {
          const probeRpcCode =
            probeErr &&
            typeof probeErr === 'object' &&
            typeof (probeErr as { rpcCode?: unknown }).rpcCode === 'number'
              ? (probeErr as { rpcCode: number }).rpcCode
              : undefined;
          const probeMsg = probeErr instanceof Error ? probeErr.message : String(probeErr);
          if (isAcpAuthRequiredError(`${probeMsg} ${proc.getStderrTail()}`, probeRpcCode)) {
            return {
              available: false,
              ...(init.agentName ? { agentName: init.agentName } : {}),
              ...(init.version ? { version: init.version } : {}),
              loadSupported: Boolean(init.loadMethod),
              status: 'needs_login',
              reason: '已完成协议握手，但尚未完成登录鉴权',
              ...(flavor.loginHint ? { loginHint: flavor.loginHint } : {}),
            };
          }
        }
      }

      if (flavor.id === 'dsh' && !authMethodId) {
        return {
          available: false,
          ...(init.agentName ? { agentName: init.agentName } : {}),
          ...(init.version ? { version: init.version } : {}),
          loadSupported: Boolean(init.loadMethod),
          status: 'auth_unverified',
          reason: 'ACP 握手成功。DeepSeek Harness 会在首轮调用时检查模型凭据。',
          ...(flavor.loginHint ? { loginHint: flavor.loginHint } : {}),
        };
      }

      const baseConfigOptions = probeNewRes ? normalizeAcpConfigOptions(probeNewRes) : [];
      const probeSessionId =
        typeof asRecord(probeNewRes)?.sessionId === 'string'
          ? String(asRecord(probeNewRes)!.sessionId).trim()
          : '';
      const preferredOverrides = flavor.resolveInitialConfigOverrides?.({
        workspaceRoot: cwd,
        homeDir: this.options.homeDir ?? os.homedir(),
        env: launchEnv.env,
        platform: this.options.platform ?? process.platform,
      });
      const configOptions =
        probeSessionId && baseConfigOptions.length > 0
          ? await enrichAcpModelThoughtLevels({
              channel,
              sessionId: probeSessionId,
              baseOptions: baseConfigOptions,
              preferredOverrides,
              budgetMs: remainingBudgetMs() - 300,
              signal,
            })
          : baseConfigOptions;

      if (probeSessionId && init.canDeleteSession) {
        await channel
          .request('session/delete', { sessionId: probeSessionId }, { timeoutMs: 800, signal })
          .catch(() => {});
      }

      return {
        available: true,
        ...(init.agentName ? { agentName: init.agentName } : {}),
        ...(init.version ? { version: init.version } : {}),
        loadSupported: Boolean(init.loadMethod),
        status: 'ready',
        ...(configOptions.length > 0 ? { configOptions } : {}),
      };
    } catch (err) {
      if (err instanceof ExternalHarnessError) {
        if (err.code === 'EXTERNAL_COMMAND_NOT_FOUND') {
          return {
            available: false,
            loadSupported: false,
            status: 'not_installed',
            reason: err.message,
            ...(flavor.installHint ? { installHint: flavor.installHint } : {}),
          };
        }
        if (err.code === 'EXTERNAL_UNSUPPORTED_SHIM' || err.code === 'EXTERNAL_NODE_NOT_FOUND') {
          return {
            available: false,
            loadSupported: false,
            status: 'invalid_shim',
            reason: err.message,
            ...(flavor.installHint ? { installHint: flavor.installHint } : {}),
          };
        }
      }
      const rpcCode =
        err && typeof err === 'object' && typeof (err as { rpcCode?: unknown }).rpcCode === 'number'
          ? (err as { rpcCode: number }).rpcCode
          : undefined;
      const errMsg = err instanceof Error ? err.message : String(err);
      const stderrTail = proc?.getStderrTail() ?? '';
      const combinedDiag = [errMsg, stderrTail].filter(Boolean).join(' | ');

      if (isAcpAuthRequiredError(combinedDiag, rpcCode)) {
        return {
          available: false,
          loadSupported: false,
          status: 'needs_login',
          reason: '外部代理尚未登录或缺少认证凭据',
          ...(flavor.loginHint ? { loginHint: flavor.loginHint } : {}),
        };
      }

      const misconfigHint = flavor.misconfiguredCommandHint?.(def.command, def.args);
      return {
        available: false,
        loadSupported: false,
        status: 'handshake_failed',
        reason: misconfigHint ? `${errMsg}（提示：${misconfigHint}）` : errMsg,
        ...(flavor.loginHint ? { loginHint: flavor.loginHint } : {}),
      };
    } finally {
      channel?.close();
      await proc?.close();
    }
  }

  /**
   * 在已信任工作区启动 ACP 子进程并完成新建或 `session/load` 恢复握手；惰性按需调用 `authenticate`，失败时确保回收子进程。
   */
  async open(input: {
    def: ExternalHarnessDefinition;
    workspaceRoot: string;
    nativeSessionId?: string;
    initialConfig?: readonly ExternalConfigSelection[];
    onEvent: (event: ExternalEvent) => void;
    signal?: AbortSignal;
  }): Promise<ExternalDriverOpenResult> {
    const { def, onEvent, signal } = input;
    if (signal?.aborted) {
      throw new ExternalHarnessError('EXTERNAL_ABORTED', '外部会话启动已取消');
    }
    if (input.nativeSessionId !== undefined && !isValidNativeSessionId(input.nativeSessionId)) {
      throw new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', '外部会话恢复标识格式非法');
    }
    const nativeWorkspaceRoot = (() => {
      try {
        return fs.realpathSync.native(input.workspaceRoot);
      } catch {
        return path.resolve(input.workspaceRoot);
      }
    })();

    let flavor = resolveAcpFlavor({ flavor: def.flavor, command: def.command, args: def.args });
    const resolvedCmd = resolveExternalCommand({
      command: def.command,
      args: def.args,
      platform: this.options.platform,
      homeDir: this.options.homeDir,
      hostEnv: this.options.hostEnv,
    });
    const launchEnv = buildExternalLaunchEnv({
      hostEnv: this.options.hostEnv,
      env: def.env,
      envFrom: def.envFrom,
      extraPathDirs: resolvedCmd.extraPathDirs,
      platform: this.options.platform,
    });

    const knownTools = new Map<string, ViewTool>();
    const pendingApprovalResolvers = new Map<
      string,
      (decision: ExternalApprovalDecision) => void
    >();
    let boundSessionId: string | undefined = input.nativeSessionId?.trim();
    let replayingLoad = false;
    let replayProjector: ExternalTranscriptProjector | undefined;
    let notifiedConfig: { modelLabel?: string; modeLabel?: string; thoughtLevelLabel?: string } =
      {};
    let currentConfigOptions: ViewExternalConfigOption[] = [];
    let activeTurnState:
      | {
          cancelled: boolean;
          cancel: () => Promise<void>;
        }
      | undefined;
    let lastActivityAt = Date.now();
    let userClosed = false;
    let fatalChannelError: ExternalHarnessError | undefined;

    const settlePendingApprovalsAsCancelled = (): void => {
      for (const [reqId, resolveDecision] of pendingApprovalResolvers) {
        pendingApprovalResolvers.delete(reqId);
        resolveDecision({ outcome: 'cancelled' });
      }
    };

    const proc = ExternalProcessSupervisor.spawn({
      executable: resolvedCmd.executable,
      args: resolvedCmd.args,
      cwd: nativeWorkspaceRoot,
      env: launchEnv.env,
      onClose: (closeRes) => {
        void channel.drainAndClose().finally(() => {
          settlePendingApprovalsAsCancelled();
          if (!userClosed) {
            onEvent({
              type: 'closed',
              code: closeRes.code,
              signal: closeRes.signal,
              ...(closeRes.stderrTail ? { stderrTail: closeRes.stderrTail } : {}),
            });
          }
        });
      },
    });

    const emitOrCapture = (event: ExternalEvent): void => {
      lastActivityAt = Date.now();
      if (replayingLoad && replayProjector) {
        replayProjector.applyEvent(event);
        if (event.type === 'plan_updated' || event.type === 'config_updated') {
          onEvent(event);
        }
        return;
      }
      onEvent(event);
    };

    const channel = new NdjsonChannel(proc.stdout, proc.stdin, {
      onNonJsonLine: (line) => {
        onEvent({ type: 'diagnostic', level: 'info', text: line });
      },
      onFatalError: (err) => {
        fatalChannelError = err;
        settlePendingApprovalsAsCancelled();
        onEvent({ type: 'diagnostic', level: 'error', text: err.message });
        void proc.close();
      },
      onNotification: (method, rawParams) => {
        if (method !== 'session/update') return;
        const params = asRecord(rawParams);
        if (!params) return;
        if (
          boundSessionId &&
          typeof params.sessionId === 'string' &&
          params.sessionId !== boundSessionId
        ) {
          return;
        }
        const update = asRecord(params.update);
        if (!update || typeof update.sessionUpdate !== 'string') return;

        switch (update.sessionUpdate) {
          case 'agent_message_chunk': {
            const text = extractAcpChunkText(update);
            if (text) emitOrCapture({ type: 'text_delta', text, replay: replayingLoad });
            break;
          }
          case 'agent_thought_chunk': {
            const text = extractAcpChunkText(update);
            if (text) emitOrCapture({ type: 'thought_delta', text, replay: replayingLoad });
            break;
          }
          case 'user_message_chunk': {
            const text = extractAcpChunkText(update);
            if (text) emitOrCapture({ type: 'user_delta', text, replay: replayingLoad });
            break;
          }
          case 'tool_call':
          case 'tool_call_update': {
            const existingId = (
              typeof update.toolCallId === 'string'
                ? update.toolCallId
                : typeof update.id === 'string'
                  ? update.id
                  : typeof update.callId === 'string'
                    ? update.callId
                    : ''
            )
              .trim()
              .slice(0, 256);
            const prev = existingId ? knownTools.get(existingId) : undefined;
            const merged = normalizeAcpToolUpdate(update, prev);
            if (merged) {
              knownTools.set(merged.callId, merged);
              emitOrCapture({ type: 'tool_upsert', tool: merged, replay: replayingLoad });
            }
            break;
          }
          case 'plan': {
            const items = normalizeAcpPlanUpdate(update);
            emitOrCapture({ type: 'plan_updated', items });
            break;
          }
          case 'config_option_update':
          case 'config_options_update':
          case 'current_mode_update':
          case 'current_model_update': {
            if (currentConfigOptions.length > 0 || Array.isArray(update.configOptions)) {
              currentConfigOptions = patchAcpConfigOptions(currentConfigOptions, update);
            }
            const cfgFromOpts = summarizeAcpConfigOptions(currentConfigOptions);
            const cfgRaw = normalizeAcpConfigSummary(update);
            const mergedCfg = {
              ...(cfgRaw.modelLabel
                ? { modelLabel: cfgRaw.modelLabel }
                : cfgFromOpts.modelLabel
                  ? { modelLabel: cfgFromOpts.modelLabel }
                  : {}),
              ...(cfgRaw.modeLabel
                ? { modeLabel: cfgRaw.modeLabel }
                : cfgFromOpts.modeLabel
                  ? { modeLabel: cfgFromOpts.modeLabel }
                  : {}),
              ...(cfgRaw.thoughtLevelLabel
                ? { thoughtLevelLabel: cfgRaw.thoughtLevelLabel }
                : cfgFromOpts.thoughtLevelLabel
                  ? { thoughtLevelLabel: cfgFromOpts.thoughtLevelLabel }
                  : {}),
            };
            if (
              mergedCfg.modelLabel ||
              mergedCfg.modeLabel ||
              mergedCfg.thoughtLevelLabel ||
              currentConfigOptions.length > 0
            ) {
              notifiedConfig = {
                ...notifiedConfig,
                ...mergedCfg,
              };
              emitOrCapture({
                type: 'config_updated',
                ...mergedCfg,
                ...(currentConfigOptions.length > 0 ? { configOptions: currentConfigOptions } : {}),
              });
            }
            break;
          }
          default:
            break;
        }
      },
      onRequest: async (id, method, params) => {
        if (method !== 'session/request_permission') {
          throw Object.assign(new Error(`Unsupported client method: ${method}`), {
            rpcCode: -32601,
          });
        }
        const reqObj = asRecord(params);
        if (
          boundSessionId &&
          typeof reqObj?.sessionId === 'string' &&
          reqObj.sessionId !== boundSessionId
        ) {
          return { outcome: { outcome: 'cancelled' } };
        }
        // 握手重放期、无活跃轮次或当前轮次已发起取消时自动按取消回绝，防在途帧将状态倒退回 waiting_approval。
        if (replayingLoad || !activeTurnState || activeTurnState.cancelled) {
          return { outcome: { outcome: 'cancelled' } };
        }
        const requestKey = String(id).slice(0, 256);
        const fallbackCallId = `perm-${requestKey}`.slice(0, 256);
        const rawToolCall = asRecord(reqObj?.toolCall);
        const rawCallId = (
          typeof rawToolCall?.toolCallId === 'string'
            ? rawToolCall.toolCallId
            : typeof rawToolCall?.id === 'string'
              ? rawToolCall.id
              : typeof rawToolCall?.callId === 'string'
                ? rawToolCall.callId
                : typeof reqObj?.toolCallId === 'string'
                  ? reqObj.toolCallId
                  : fallbackCallId
        )
          .trim()
          .slice(0, 256);
        const normalized = normalizeAcpPermissionRequest(
          params,
          knownTools.get(rawCallId),
          fallbackCallId,
        );

        knownTools.set(normalized.tool.callId, normalized.tool);
        onEvent({ type: 'tool_upsert', tool: normalized.tool });

        const decision = await new Promise<ExternalApprovalDecision>((resolve) => {
          let settled = false;
          const finish = (res: ExternalApprovalDecision): void => {
            if (settled) return;
            settled = true;
            pendingApprovalResolvers.delete(requestKey);
            lastActivityAt = Date.now();
            resolve(res);
          };
          pendingApprovalResolvers.set(requestKey, finish);
          onEvent({
            type: 'approval_requested',
            requestId: requestKey,
            toolCallId: normalized.tool.callId,
            toolTitle: normalized.toolTitle,
            ...(normalized.target ? { target: normalized.target } : {}),
            ...(normalized.warning ? { warning: normalized.warning } : {}),
            options: normalized.options,
            respond: finish,
          });
        });

        if (decision.outcome === 'selected') {
          const pickedOpt = normalized.options.find((o) => o.optionId === decision.optionId);
          if (pickedOpt?.kind.startsWith('reject')) {
            const currentTool = knownTools.get(normalized.tool.callId);
            if (currentTool?.status === 'running') {
              const rejectedTool: ViewTool = { ...currentTool, status: 'failed' };
              knownTools.set(rejectedTool.callId, rejectedTool);
              onEvent({ type: 'tool_upsert', tool: rejectedTool });
            }
          }
          return {
            outcome: {
              outcome: 'selected',
              optionId: decision.optionId,
            },
          };
        }
        const cancelledTool = knownTools.get(normalized.tool.callId);
        if (cancelledTool?.status === 'running') {
          const interruptedTool: ViewTool = { ...cancelledTool, status: 'interrupted' };
          knownTools.set(interruptedTool.callId, interruptedTool);
          onEvent({ type: 'tool_upsert', tool: interruptedTool });
        }
        return {
          outcome: {
            outcome: 'cancelled',
          },
        };
      },
    });

    const handshakeTimeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;

    try {
      const initRaw = await channel.request(
        'initialize',
        {
          protocolVersion: 1,
          clientInfo: {
            name: 'Kapibala',
            version: this.options.clientVersion ?? '0.1.5',
          },
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
          },
        },
        { timeoutMs: handshakeTimeoutMs, signal },
      );
      channel.markHandshakeCompleted();

      const init = normalizeAcpInitializeResult(initRaw);
      flavor = resolveAcpFlavor({
        flavor: def.flavor,
        command: def.command,
        args: def.args,
        agentInfoName: init.agentName,
      });

      const authMethodId = pickAuthMethodId(flavor, init.authMethods);
      const openOrLoadSession = async (): Promise<unknown> => {
        if (boundSessionId) {
          if (!init.loadMethod) {
            throw new ExternalHarnessError(
              'EXTERNAL_PROTOCOL_ERROR',
              `外部代理 '${def.name}' 不支持加载已有会话`,
            );
          }
          replayProjector = new ExternalTranscriptProjector(`replay:${boundSessionId}`);
          replayingLoad = true;
          let loadedRaw: unknown;
          try {
            loadedRaw = await channel.request(
              init.loadMethod,
              {
                sessionId: boundSessionId,
                cwd: nativeWorkspaceRoot,
                mcpServers: [],
              },
              { timeoutMs: handshakeTimeoutMs, signal },
            );
          } finally {
            replayingLoad = false;
          }
          replayProjector.completeTurn();
          const returnedId = asRecord(loadedRaw)?.sessionId;
          if (isValidNativeSessionId(returnedId)) {
            boundSessionId = returnedId.trim();
          }
          return loadedRaw;
        }
        const createdRaw = await channel.request(
          'session/new',
          {
            cwd: nativeWorkspaceRoot,
            mcpServers: [],
          },
          { timeoutMs: handshakeTimeoutMs, signal },
        );
        const createdId = asRecord(createdRaw)?.sessionId;
        if (typeof createdId !== 'string' || !createdId.trim()) {
          throw new ExternalHarnessError(
            'EXTERNAL_PROTOCOL_ERROR',
            `外部代理 '${def.name}' session/new 未返回有效的 sessionId`,
          );
        }
        boundSessionId = createdId.trim();
        return createdRaw;
      };

      let sessionResultRaw: unknown;
      try {
        sessionResultRaw = await openOrLoadSession();
      } catch (sessionErr) {
        const rpcCode =
          sessionErr &&
          typeof sessionErr === 'object' &&
          typeof (sessionErr as { rpcCode?: unknown }).rpcCode === 'number'
            ? (sessionErr as { rpcCode: number }).rpcCode
            : undefined;
        const msg = sessionErr instanceof Error ? sessionErr.message : String(sessionErr);
        if (!authMethodId || !isAcpAuthRequiredError(`${msg} ${proc.getStderrTail()}`, rpcCode)) {
          throw sessionErr;
        }
        // 仅当直接新建/加载会话报未鉴权时才按需发起 authenticate，避免对已登录 CLI 误触交互式浏览器 OAuth。
        replayProjector = undefined;
        await channel.request(
          'authenticate',
          { methodId: authMethodId },
          { timeoutMs: handshakeTimeoutMs, signal },
        );
        sessionResultRaw = await openOrLoadSession();
      }

      currentConfigOptions = normalizeAcpConfigOptions(sessionResultRaw);

      /** 统一向对端提交单项配置切换（优先标准 `session/set_config_option`，旧式回退 `session/set_model` / `session/set_mode`）。 */
      const applyConfigChange = async (
        change: {
          readonly configId?: string;
          readonly category: ViewExternalConfigCategory;
          readonly value: string;
        },
        reqSignal?: AbortSignal,
      ): Promise<ExternalSetConfigResult> => {
        if (!boundSessionId) {
          throw new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', '外部会话尚未绑定 sessionId');
        }
        const opt =
          (change.configId
            ? currentConfigOptions.find((item) => item.id === change.configId)
            : undefined) ?? currentConfigOptions.find((item) => item.category === change.category);
        if (!opt) {
          throw new ExternalHarnessError(
            'EXTERNAL_CONFIG_INVALID',
            `外部代理 '${def.name}' 不支持切换该配置项`,
          );
        }
        const trimmedVal = change.value.trim();
        if (!opt.options.some((choice) => choice.value === trimmedVal)) {
          throw new ExternalHarnessError(
            'EXTERNAL_CONFIG_INVALID',
            `外部代理 '${def.name}' 当前无可用选项 '${trimmedVal}'，请刷新模型列表后重试`,
          );
        }
        const reqTimeout = Math.min(handshakeTimeoutMs, 10_000);
        let updatedRaw: unknown;
        if (opt.id === LEGACY_ACP_MODEL_CONFIG_ID) {
          updatedRaw = await channel.request(
            'session/set_model',
            { sessionId: boundSessionId, modelId: trimmedVal },
            { timeoutMs: reqTimeout, signal: reqSignal },
          );
        } else if (opt.id === LEGACY_ACP_MODE_CONFIG_ID) {
          updatedRaw = await channel.request(
            'session/set_mode',
            { sessionId: boundSessionId, modeId: trimmedVal },
            { timeoutMs: reqTimeout, signal: reqSignal },
          );
        } else {
          updatedRaw = await setAcpConfigOptionWithSettle(
            channel,
            { sessionId: boundSessionId, configId: opt.id, value: trimmedVal },
            { timeoutMs: reqTimeout, signal: reqSignal },
          );
        }

        if (Array.isArray(asRecord(updatedRaw)?.configOptions)) {
          const prevObj = asRecord(sessionResultRaw);
          sessionResultRaw = prevObj ? { ...prevObj, ...(asRecord(updatedRaw) ?? {}) } : updatedRaw;
          currentConfigOptions = normalizeAcpConfigOptions(sessionResultRaw);
        } else {
          currentConfigOptions = currentConfigOptions.map((item) =>
            item.id === opt.id ? { ...item, currentValue: trimmedVal } : item,
          );
        }
        const nextSummary = summarizeAcpConfigOptions(currentConfigOptions);
        return {
          ...nextSummary,
          ...(currentConfigOptions.length > 0 ? { configOptions: currentConfigOptions } : {}),
        };
      };

      // 仅在新建会话（非 session/load 恢复）时套用初始配置：
      // 1) 用户在选择器显式指定的模型/模式/推理档位优先，覆盖方言默认同步（例如 OpenCode model.json）；
      // 2) 未显式指定时保持方言默认同步，失败静默回退；显式指定失败时报错提示，避免静默跑错模型。
      if (!input.nativeSessionId && boundSessionId) {
        const explicitItems = input.initialConfig ?? [];
        const hasExplicitModel = explicitItems.some((item) => item.category === 'model');
        const flavorDefaults =
          flavor.resolveInitialConfigOverrides?.({
            workspaceRoot: nativeWorkspaceRoot,
            homeDir: this.options.homeDir ?? os.homedir(),
            env: launchEnv.env,
            platform: this.options.platform ?? process.platform,
          }) ?? [];

        const planned = new Map<
          ViewExternalConfigCategory,
          { readonly value: string; readonly explicit: boolean }
        >();
        for (const defItem of flavorDefaults) {
          if (
            hasExplicitModel &&
            (defItem.category === 'model' || defItem.category === 'thought_level')
          ) {
            continue;
          }
          planned.set(defItem.category, { value: defItem.value, explicit: false });
        }
        for (const expItem of explicitItems) {
          if (expItem.value.trim()) {
            planned.set(expItem.category, { value: expItem.value.trim(), explicit: true });
          }
        }

        const applyOrder: readonly ViewExternalConfigCategory[] = [
          'model',
          'thought_level',
          'mode',
        ];
        for (const category of applyOrder) {
          const target = planned.get(category);
          if (!target) continue;
          const opt = currentConfigOptions.find((item) => item.category === category);
          if (!opt) {
            if (target.explicit) {
              throw new ExternalHarnessError(
                'EXTERNAL_CONFIG_INVALID',
                `外部代理 '${def.name}' 不支持在建会话时指定该配置项`,
              );
            }
            continue;
          }
          if (opt.currentValue === target.value) continue;
          if (!opt.options.some((choice) => choice.value === target.value)) {
            if (target.explicit) {
              throw new ExternalHarnessError(
                'EXTERNAL_CONFIG_INVALID',
                `外部代理 '${def.name}' 当前无可用选项 '${target.value}'，请刷新模型列表后重试`,
              );
            }
            continue;
          }
          try {
            await applyConfigChange({ configId: opt.id, category, value: target.value }, signal);
          } catch (cfgErr) {
            if (target.explicit) throw cfgErr;
            /* 方言默认同步失败时保留 session/new 默认配置，不阻断启动 */
          }
        }
      }

      const rpcConfigSummary = normalizeAcpConfigSummary(sessionResultRaw);
      const optConfigSummary = summarizeAcpConfigOptions(currentConfigOptions);
      const configSummary = {
        ...(optConfigSummary.modelLabel
          ? { modelLabel: optConfigSummary.modelLabel }
          : rpcConfigSummary.modelLabel
            ? { modelLabel: rpcConfigSummary.modelLabel }
            : notifiedConfig.modelLabel
              ? { modelLabel: notifiedConfig.modelLabel }
              : {}),
        ...(optConfigSummary.modeLabel
          ? { modeLabel: optConfigSummary.modeLabel }
          : rpcConfigSummary.modeLabel
            ? { modeLabel: rpcConfigSummary.modeLabel }
            : notifiedConfig.modeLabel
              ? { modeLabel: notifiedConfig.modeLabel }
              : {}),
        ...(optConfigSummary.thoughtLevelLabel
          ? { thoughtLevelLabel: optConfigSummary.thoughtLevelLabel }
          : rpcConfigSummary.thoughtLevelLabel
            ? { thoughtLevelLabel: rpcConfigSummary.thoughtLevelLabel }
            : notifiedConfig.thoughtLevelLabel
              ? { thoughtLevelLabel: notifiedConfig.thoughtLevelLabel }
              : {}),
      };
      const validBoundId = isValidNativeSessionId(boundSessionId) ? boundSessionId : undefined;
      const resumable = Boolean(validBoundId && init.loadMethod && flavor.verifiedResumable);

      const watchdogLimitMs = this.options.turnWatchdogMs ?? DEFAULT_TURN_WATCHDOG_MS;
      const checkIntervalMs = Math.max(25, Math.min(1_000, Math.floor(watchdogLimitMs / 4)));

      const handle: ExternalDriverSessionHandle = {
        pid: proc.pid,
        prompt: async (text: string, turnSignal?: AbortSignal): Promise<ExternalTurnResult> => {
          if (activeTurnState) {
            throw new ExternalHarnessError(
              'EXTERNAL_SESSION_BUSY',
              '当前外部代理会话已有运行中的轮次，禁止并发发送 Prompt',
            );
          }
          if (!boundSessionId) {
            throw new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', '外部会话尚未绑定 sessionId');
          }

          lastActivityAt = Date.now();
          let cancelRequested = false;
          let timedOutByWatchdog = false;
          let graceTimer: ReturnType<typeof setTimeout> | undefined;
          const turnAbortController = new AbortController();

          const sendCancelAndSettle = async (): Promise<void> => {
            if (cancelRequested || timedOutByWatchdog) return;
            cancelRequested = true;
            if (activeTurnState) activeTurnState.cancelled = true;
            settlePendingApprovalsAsCancelled();
            try {
              channel.notify('session/cancel', { sessionId: boundSessionId });
            } catch {
              /* ignore closed pipe */
            }
            graceTimer = setTimeout(() => {
              turnAbortController.abort();
            }, CANCEL_SETTLE_GRACE_MS);
            graceTimer.unref?.();
          };

          activeTurnState = { cancelled: false, cancel: sendCancelAndSettle };
          const onExternalAbort = (): void => {
            void sendCancelAndSettle();
          };
          turnSignal?.addEventListener('abort', onExternalAbort, { once: true });

          let lastTickAt = Date.now();
          const watchdogInterval = setInterval(() => {
            const now = Date.now();
            const tickDelta = now - lastTickAt;
            lastTickAt = now;
            if (tickDelta > SLEEP_JUMP_TOLERANCE_MS) {
              lastActivityAt += tickDelta;
              return;
            }
            if (pendingApprovalResolvers.size > 0) {
              lastActivityAt = now;
              return;
            }
            if (!timedOutByWatchdog && !cancelRequested && now - lastActivityAt > watchdogLimitMs) {
              timedOutByWatchdog = true;
              settlePendingApprovalsAsCancelled();
              try {
                channel.notify('session/cancel', { sessionId: boundSessionId });
              } catch {
                /* ignore */
              }
              turnAbortController.abort();
            }
          }, checkIntervalMs);
          watchdogInterval.unref?.();

          try {
            const promptRes = await channel.request(
              'session/prompt',
              {
                sessionId: boundSessionId,
                prompt: [{ type: 'text', text }],
              },
              { signal: turnAbortController.signal },
            );
            const resObj = asRecord(promptRes);
            const stopReason =
              cancelRequested || resObj?.stopReason === 'cancelled' ? 'cancelled' : 'completed';
            const usage = normalizeAcpUsage(promptRes);
            return {
              stopReason,
              ...(usage ? { usage } : {}),
            };
          } catch (err) {
            if (fatalChannelError) {
              userClosed = true;
              channel.close(fatalChannelError);
              await proc.close();
              throw new ExternalHarnessError(fatalChannelError.code, fatalChannelError.message, {
                processTerminated: true,
                cause: fatalChannelError,
              });
            }
            if (timedOutByWatchdog) {
              userClosed = true;
              channel.close();
              await proc.close();
              throw new ExternalHarnessError(
                'EXTERNAL_TIMEOUT',
                `外部代理 '${def.name}' 超过 ${Math.round(watchdogLimitMs / 1000)} 秒无响应，已自动终止`,
                { processTerminated: true },
              );
            }
            if (cancelRequested) {
              // 仅当 5s 优雅取消宽限期届满或子进程已退出时才强杀回收；若对端在宽限期内正常以取消错误回复，保留存活进程供下轮复用。
              if (turnAbortController.signal.aborted || proc.isClosed) {
                userClosed = true;
                channel.close();
                await proc.close();
                return { stopReason: 'cancelled', processTerminated: true };
              }
              return { stopReason: 'cancelled' };
            }
            if (err instanceof Error && isAcpAuthRequiredError(err.message)) {
              throw new ExternalHarnessError(
                'EXTERNAL_AUTH_REQUIRED',
                '外部代理缺少有效的模型凭据',
                {
                  loginHint: flavor.loginHint,
                },
              );
            }
            if (!proc.isClosed) {
              await Promise.race([
                proc.waitForClose(),
                new Promise<void>((resolve) => setTimeout(resolve, 60)),
              ]);
            }
            if (proc.isClosed) {
              userClosed = true;
              channel.close();
              const closed = await proc.close();
              const detail = closed.stderrTail
                ? `外部代理进程异常退出：${closed.stderrTail}`
                : `外部代理进程异常退出（code=${closed.code ?? 'null'}${closed.signal ? `, signal=${closed.signal}` : ''}）`;
              throw new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', detail, {
                processTerminated: true,
                cause: err,
              });
            }
            throw err;
          } finally {
            if (graceTimer !== undefined) clearTimeout(graceTimer);
            clearInterval(watchdogInterval);
            turnSignal?.removeEventListener('abort', onExternalAbort);
            activeTurnState = undefined;
          }
        },
        setConfigOption: async (req, reqSignal): Promise<ExternalSetConfigResult> => {
          if (activeTurnState) {
            throw new ExternalHarnessError(
              'EXTERNAL_SESSION_BUSY',
              '当前外部代理正在运行，请等待本轮结束后再切换配置',
            );
          }
          if (proc.isClosed) {
            throw new ExternalHarnessError(
              'EXTERNAL_PROTOCOL_ERROR',
              '外部代理子进程已结束，无法切换配置',
              { processTerminated: true },
            );
          }
          return await applyConfigChange(req, reqSignal);
        },
        cancel: async (): Promise<void> => {
          if (activeTurnState) {
            await activeTurnState.cancel();
          }
        },
        close: async (): Promise<void> => {
          userClosed = true;
          settlePendingApprovalsAsCancelled();
          channel.close();
          await proc.close();
        },
      };

      const replayedMessages = replayProjector?.getMessages();
      return {
        handle,
        ...(validBoundId ? { nativeSessionId: validBoundId } : {}),
        resumable,
        ...(configSummary.modelLabel ? { modelLabel: configSummary.modelLabel } : {}),
        ...(configSummary.modeLabel ? { modeLabel: configSummary.modeLabel } : {}),
        ...(configSummary.thoughtLevelLabel
          ? { thoughtLevelLabel: configSummary.thoughtLevelLabel }
          : {}),
        ...(currentConfigOptions.length > 0 ? { configOptions: currentConfigOptions } : {}),
        ...(replayedMessages && replayedMessages.length > 0 ? { replayedMessages } : {}),
      };
    } catch (err) {
      userClosed = true;
      settlePendingApprovalsAsCancelled();
      channel.close();
      await proc.close();

      const rpcCode =
        err && typeof err === 'object' && typeof (err as { rpcCode?: unknown }).rpcCode === 'number'
          ? (err as { rpcCode: number }).rpcCode
          : undefined;
      const msg = err instanceof Error ? err.message : String(err);
      if (isAcpAuthRequiredError(`${msg} ${proc.getStderrTail()}`, rpcCode)) {
        throw new ExternalHarnessError(
          'EXTERNAL_AUTH_REQUIRED',
          `外部代理 '${def.name}' 需要先完成登录鉴权`,
          {
            retryPolicy: 'after_user_action',
            ...(flavor.loginHint ? { loginHint: flavor.loginHint } : {}),
            cause: err,
          },
        );
      }
      if (err instanceof ExternalHarnessError) throw err;
      throw new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', msg, { cause: err });
    }
  }
}
