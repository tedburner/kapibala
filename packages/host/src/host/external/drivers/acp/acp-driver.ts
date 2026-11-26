import fs from 'node:fs';
import path from 'node:path';
import type { ViewTool } from '../../../../view-model/index.js';
import { buildExternalLaunchEnv } from '../../env.js';
import { NdjsonChannel } from '../../ndjson-channel.js';
import { ExternalProcessSupervisor, resolveExternalCommand } from '../../process.js';
import {
  type ExternalApprovalDecision,
  type ExternalDriverOpenResult,
  type ExternalDriverSessionHandle,
  type ExternalEvent,
  type ExternalHarnessDefinition,
  type ExternalHarnessDriver,
  ExternalHarnessError,
  type ExternalInspectResult,
  type ExternalTurnResult,
  isValidNativeSessionId,
} from '../../types.js';
import { type AcpHarnessFlavor, isAcpAuthRequiredError, resolveAcpFlavor } from './flavors.js';
import { ExternalTranscriptProjector } from './projector.js';
import {
  extractAcpChunkText,
  normalizeAcpConfigSummary,
  normalizeAcpInitializeResult,
  normalizeAcpPermissionRequest,
  normalizeAcpPlanUpdate,
  normalizeAcpToolUpdate,
  normalizeAcpUsage,
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
      if (authMethodId || init.authMethods.length > 0) {
        // 惰性认证探测：对声明了 authMethods 的代理（如 Antigravity / Gemini / TRAE / OMP）先试调 session/new 核验既有登录态，
        // 避免盲目触发交互式浏览器 OAuth 弹窗；仅当报未鉴权且存在首选静默认证方法时才降级尝试 authenticate。
        let probeNewRes: unknown;
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

      return {
        available: true,
        ...(init.agentName ? { agentName: init.agentName } : {}),
        ...(init.version ? { version: init.version } : {}),
        loadSupported: Boolean(init.loadMethod),
        status: 'ready',
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
          case 'current_mode_update': {
            const cfg = normalizeAcpConfigSummary(update);
            if (cfg.modelLabel || cfg.modeLabel) {
              emitOrCapture({ type: 'config_updated', ...cfg });
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

      const configSummary = normalizeAcpConfigSummary(sessionResultRaw);
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
