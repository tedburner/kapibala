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

/** 设置页「检测连接」默认超时（15 秒）。 */
const DEFAULT_INSPECT_TIMEOUT_MS = 15_000;
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
 * 通用 `acp-stdio` 传输驱动（JSON-RPC 2.0 over NDJSON stdio）。
 *
 * 覆盖 Antigravity (`agy acp`)、OpenCode (`opencode acp`)、DeepSeek Harness (`dsh --profile acp`)、
 * Gemini CLI、Qwen Code、官方 ACP Registry 模板与任意本地 `Local ACP Command`：
 * - 显式声明客户端不提供 `fs/*` 与 `terminal/*`（任何越界反向请求一律回 `-32601`）；
 * - `session/load` 发请求前预先绑定 `nativeSessionId` 并开启重放收集，兼容 OpenCode 在响应前先推通知且省略响应 `sessionId` 的实现；
 * - 严格执行四项恢复门禁：仅经实测背书的 Flavor 且具备 `nativeSessionId` + 加载能力位时返回 `resumable: true`。
 */
export class AcpStdioDriver implements ExternalHarnessDriver {
  readonly transport = 'acp' as const;

  constructor(private readonly options: AcpStdioDriverOptions = {}) {}

  async inspect(
    def: ExternalHarnessDefinition,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ExternalInspectResult> {
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
      const code = err instanceof ExternalHarnessError ? err.code : 'EXTERNAL_COMMAND_NOT_FOUND';
      if (code === 'EXTERNAL_COMMAND_NOT_FOUND') {
        return {
          available: false,
          loadSupported: false,
          status: 'not_installed',
          reason: err instanceof Error ? err.message : '未找到可执行文件',
          ...(flavor.installHint ? { installHint: flavor.installHint } : {}),
        };
      }
      return {
        available: false,
        loadSupported: false,
        status: 'invalid_shim',
        reason: err instanceof Error ? err.message : '命令或垫片校验失败',
      };
    }

    const launchEnv = buildExternalLaunchEnv({
      hostEnv: this.options.hostEnv,
      env: def.env,
      envFrom: def.envFrom,
      extraPathDirs: resolvedCmd.extraPathDirs,
      platform: this.options.platform,
    });

    const proc = ExternalProcessSupervisor.spawn({
      executable: resolvedCmd.executable,
      args: resolvedCmd.args,
      cwd,
      env: launchEnv.env,
    });

    const channel = new NdjsonChannel(proc.stdout, proc.stdin);
    const timeoutMs = this.options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS;

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
      if (authMethodId) {
        await channel.request('authenticate', { methodId: authMethodId }, { timeoutMs, signal });
      }

      return {
        available: true,
        ...(init.agentName ? { agentName: init.agentName } : {}),
        ...(init.version ? { version: init.version } : {}),
        loadSupported: Boolean(init.loadMethod),
        status: 'ready',
      };
    } catch (err) {
      const rpcCode =
        err && typeof err === 'object' && typeof (err as { rpcCode?: unknown }).rpcCode === 'number'
          ? (err as { rpcCode: number }).rpcCode
          : undefined;
      const errMsg = err instanceof Error ? err.message : String(err);
      const stderrTail = proc.getStderrTail();
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
      channel.close();
      await proc.close();
    }
  }

  async open(input: {
    def: ExternalHarnessDefinition;
    workspaceRoot: string;
    nativeSessionId?: string;
    onEvent: (event: ExternalEvent) => void;
    signal?: AbortSignal;
  }): Promise<ExternalDriverOpenResult> {
    const { def, onEvent, signal } = input;
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
    let boundSessionId: string | undefined = input.nativeSessionId;
    let replayingLoad = false;
    let replayProjector: ExternalTranscriptProjector | undefined;
    let lastActivityAt = Date.now();
    let userClosed = false;

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
        settlePendingApprovalsAsCancelled();
        channel.close();
        if (!userClosed) {
          onEvent({
            type: 'closed',
            code: closeRes.code,
            signal: closeRes.signal,
            ...(closeRes.stderrTail ? { stderrTail: closeRes.stderrTail } : {}),
          });
        }
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
            const existingId =
              typeof update.toolCallId === 'string'
                ? update.toolCallId
                : typeof update.id === 'string'
                  ? update.id
                  : undefined;
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
        const rawToolCall = asRecord(reqObj?.toolCall);
        const rawCallId =
          typeof rawToolCall?.toolCallId === 'string'
            ? rawToolCall.toolCallId
            : typeof reqObj?.toolCallId === 'string'
              ? reqObj.toolCallId
              : `perm-${String(id)}`;
        const normalized = normalizeAcpPermissionRequest(params, knownTools.get(rawCallId));

        // 审批前置补卡（noteToolCall）：防止代理尚未发 tool_call 通知即请求权限导致界面缺少对应工具上下文。
        knownTools.set(normalized.tool.callId, normalized.tool);
        onEvent({ type: 'tool_upsert', tool: normalized.tool });

        const requestKey = String(id);
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
          return {
            outcome: {
              outcome: 'selected',
              optionId: decision.optionId,
            },
          };
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
      if (authMethodId) {
        await channel.request(
          'authenticate',
          { methodId: authMethodId },
          { timeoutMs: handshakeTimeoutMs, signal },
        );
      }

      let sessionResultRaw: unknown;
      if (input.nativeSessionId) {
        if (!init.loadMethod) {
          throw new ExternalHarnessError(
            'EXTERNAL_PROTOCOL_ERROR',
            `外部代理 '${def.name}' 不支持加载已有会话`,
          );
        }
        // 发请求前预绑 nativeSessionId 并开启重放收集，确保响应返回前到达的 session/update 一帧不漏。
        boundSessionId = input.nativeSessionId;
        replayProjector = new ExternalTranscriptProjector(`replay:${input.nativeSessionId}`);
        replayingLoad = true;
        try {
          sessionResultRaw = await channel.request(
            init.loadMethod,
            {
              sessionId: input.nativeSessionId,
              cwd: nativeWorkspaceRoot,
              mcpServers: [],
            },
            { timeoutMs: handshakeTimeoutMs, signal },
          );
        } finally {
          replayingLoad = false;
        }
        replayProjector.completeTurn();
        const returnedId = asRecord(sessionResultRaw)?.sessionId;
        if (typeof returnedId === 'string' && returnedId.trim()) {
          boundSessionId = returnedId.trim();
        }
      } else {
        sessionResultRaw = await channel.request(
          'session/new',
          {
            cwd: nativeWorkspaceRoot,
            mcpServers: [],
          },
          { timeoutMs: handshakeTimeoutMs, signal },
        );
        const createdId = asRecord(sessionResultRaw)?.sessionId;
        if (typeof createdId !== 'string' || !createdId.trim()) {
          throw new ExternalHarnessError(
            'EXTERNAL_PROTOCOL_ERROR',
            `外部代理 '${def.name}' session/new 未返回有效的 sessionId`,
          );
        }
        boundSessionId = createdId.trim();
      }

      const configSummary = normalizeAcpConfigSummary(sessionResultRaw);
      const resumable = Boolean(boundSessionId && init.loadMethod && flavor.verifiedResumable);

      let activeTurnCancel: (() => Promise<void>) | undefined;
      const watchdogLimitMs = this.options.turnWatchdogMs ?? DEFAULT_TURN_WATCHDOG_MS;

      const handle: ExternalDriverSessionHandle = {
        pid: proc.pid,
        prompt: async (text: string, turnSignal?: AbortSignal): Promise<ExternalTurnResult> => {
          if (activeTurnCancel) {
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
          const turnAbortController = new AbortController();

          const sendCancelAndSettle = async (): Promise<void> => {
            if (cancelRequested) return;
            cancelRequested = true;
            settlePendingApprovalsAsCancelled();
            try {
              channel.notify('session/cancel', { sessionId: boundSessionId });
            } catch {
              /* ignore closed pipe */
            }
            const graceTimer = setTimeout(() => {
              turnAbortController.abort();
            }, CANCEL_SETTLE_GRACE_MS);
            graceTimer.unref?.();
          };

          activeTurnCancel = sendCancelAndSettle;
          const onExternalAbort = (): void => {
            void sendCancelAndSettle();
          };
          turnSignal?.addEventListener('abort', onExternalAbort, { once: true });

          let lastTickAt = Date.now();
          const watchdogInterval = setInterval(() => {
            const now = Date.now();
            const tickDelta = now - lastTickAt;
            lastTickAt = now;
            // 若系统发生休眠唤醒跳变，顺延活动基准避免唤醒瞬间误杀长轮次。
            if (tickDelta > SLEEP_JUMP_TOLERANCE_MS) {
              lastActivityAt += tickDelta;
              return;
            }
            // 等待用户审批期间暂停无进展看门狗（由上层审批到期计时器接管）。
            if (pendingApprovalResolvers.size > 0) {
              lastActivityAt = now;
              return;
            }
            if (now - lastActivityAt > watchdogLimitMs) {
              void sendCancelAndSettle();
              turnAbortController.abort();
            }
          }, 1_000);
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
            if (cancelRequested) {
              await proc.close();
              return { stopReason: 'cancelled' };
            }
            if (Date.now() - lastActivityAt > watchdogLimitMs) {
              await proc.close();
              throw new ExternalHarnessError(
                'EXTERNAL_TIMEOUT',
                `外部代理 '${def.name}' 超过 ${Math.round(watchdogLimitMs / 1000)} 秒无响应，已自动终止`,
              );
            }
            throw err;
          } finally {
            clearInterval(watchdogInterval);
            turnSignal?.removeEventListener('abort', onExternalAbort);
            activeTurnCancel = undefined;
          }
        },
        cancel: async (): Promise<void> => {
          if (activeTurnCancel) {
            await activeTurnCancel();
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
        nativeSessionId: boundSessionId,
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
