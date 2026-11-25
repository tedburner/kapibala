import { randomUUID } from 'node:crypto';
import type { ViewTodoItem, ViewTool, ViewUsage } from '../../../view-model/index.js';
import { redactCommonSecrets, sanitizeDisplayText } from '../../redaction.js';
import { sanitizeUntrustedOutput } from '../../ui/text-safety.js';
import {
  formatToolDetail,
  resolveToolDisplay,
  sanitizeToolName,
} from '../../ui/tool-presentation.js';
import { buildExternalLaunchEnv } from '../env.js';
import { NdjsonChannel } from '../ndjson-channel.js';
import { ExternalProcessSupervisor, resolveExternalCommand } from '../process.js';
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
} from '../types.js';
import { normalizeAcpPlanUpdate } from './acp/tolerance.js';

const DEFAULT_INSPECT_TIMEOUT_MS = 15_000;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 60_000;
const DEFAULT_TURN_WATCHDOG_MS = 10 * 60_000;
const CANCEL_SETTLE_GRACE_MS = 5_000;
const SLEEP_JUMP_TOLERANCE_MS = 10_000;

const CODEX_INSTALL_HINT = 'npm install -g @openai/codex';
const CODEX_LOGIN_HINT = 'codex login';

/** `CodexAppServerDriver` 构造可选项（支持单测覆盖超时与宿主环境）。 */
export interface CodexAppServerDriverOptions {
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

function isCodexAuthErrorText(text: string): boolean {
  return /not logged in|codex login|authentication|invalid[_\s-]?api[_\s-]?key|unauthorized|401\b|missing.*openai_api_key/i.test(
    text,
  );
}

function extractCodexVersion(initRaw: unknown): string | undefined {
  const obj = asRecord(initRaw);
  if (!obj) return undefined;
  const serverInfo = asRecord(obj.serverInfo);
  if (typeof serverInfo?.version === 'string' && serverInfo.version.trim()) {
    return sanitizeDisplayText(serverInfo.version.trim(), 64);
  }
  if (typeof obj.version === 'string' && obj.version.trim()) {
    return sanitizeDisplayText(obj.version.trim(), 64);
  }
  if (typeof obj.userAgent === 'string' && obj.userAgent.trim()) {
    const match = /\/(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(obj.userAgent);
    return match?.[1] ?? sanitizeDisplayText(obj.userAgent.trim(), 64);
  }
  return undefined;
}

function buildCodexCliArgs(command: string, baseArgs: readonly string[]): string[] {
  const args = [...baseArgs];
  const cmdBase = command.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
  const isRuntimeHost =
    cmdBase === 'node' || cmdBase === 'node.exe' || cmdBase === 'bun' || cmdBase === 'bun.exe';
  const insertAt =
    isRuntimeHost &&
    args.length > 0 &&
    (/\.[cm]?[jt]s$/i.test(args[0]!) || args[0]!.includes('/') || args[0]!.includes('\\'))
      ? 1
      : 0;

  if (!args.includes('app-server')) {
    args.splice(insertAt, 0, 'app-server');
  }
  const hasUnloadDelayOverride = args.some((item) => item.includes('thread_unload_delay_secs='));
  if (!hasUnloadDelayOverride) {
    const idx = args.indexOf('app-server');
    args.splice(idx + 1, 0, '-c', 'thread_unload_delay_secs=0');
  }
  return args;
}

function mapCodexItemStatus(item: Record<string, unknown>, completed: boolean): ViewTool['status'] {
  const raw = typeof item.status === 'string' ? item.status.toLowerCase() : '';
  if (raw === 'failed' || raw === 'error' || raw === 'declined') return 'failed';
  if (raw === 'interrupted' || raw === 'cancelled' || raw === 'canceled') return 'interrupted';
  if (completed) {
    if (typeof item.exitCode === 'number' && item.exitCode !== 0) return 'failed';
    return 'succeeded';
  }
  return 'running';
}

function clampCodexCallId(raw: string, fallback = 'codex-item'): string {
  const trimmed = raw.trim().slice(0, 256);
  return trimmed || fallback;
}

function buildCodexToolFromItem(
  item: Record<string, unknown>,
  completed: boolean,
  previous?: ViewTool,
  accumulatedOutput?: string,
  durationMs?: number,
): ViewTool | undefined {
  const rawId =
    typeof item.id === 'string' && item.id.trim()
      ? clampCodexCallId(item.id)
      : previous?.callId
        ? clampCodexCallId(previous.callId)
        : undefined;
  if (!rawId) return undefined;
  const kind = typeof item.type === 'string' ? item.type : '';

  if (kind === 'commandExecution') {
    const cmdText =
      typeof item.command === 'string'
        ? item.command
        : Array.isArray(item.command)
          ? item.command.filter((part): part is string => typeof part === 'string').join(' ')
          : (previous?.chip ?? '');
    const chip = cmdText ? sanitizeDisplayText(cmdText, 96) : previous?.chip;
    const rawOut =
      typeof item.aggregatedOutput === 'string'
        ? item.aggregatedOutput
        : typeof item.output === 'string'
          ? item.output
          : accumulatedOutput;
    const result =
      rawOut !== undefined
        ? redactCommonSecrets(sanitizeUntrustedOutput(rawOut))
        : previous?.result;
    return {
      callId: rawId,
      name: 'bash',
      displayName: '终端命令',
      invocation: redactCommonSecrets(sanitizeUntrustedOutput(chip ? `运行 ${chip}` : '运行命令')),
      verb: '运行',
      ...(chip ? { chip } : {}),
      mono: true,
      input: cmdText
        ? redactCommonSecrets(sanitizeUntrustedOutput(cmdText))
        : (previous?.input ?? ''),
      status: mapCodexItemStatus(item, completed),
      ...(result !== undefined ? { result } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  if (kind === 'fileChange') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const paths: string[] = [];
    const diffs: string[] = [];
    for (const entry of changes) {
      const ch = asRecord(entry);
      if (typeof ch?.path === 'string' && ch.path.trim()) {
        paths.push(ch.path.trim());
      }
      if (typeof ch?.diff === 'string' && ch.diff.trim()) {
        diffs.push(ch.diff);
      }
    }
    const firstPath = paths[0] ?? previous?.chip;
    const chip = firstPath ? sanitizeDisplayText(firstPath, 96) : undefined;
    const diffText =
      diffs.length > 0
        ? diffs.join('\n')
        : accumulatedOutput !== undefined
          ? accumulatedOutput
          : undefined;
    const result =
      diffText !== undefined
        ? redactCommonSecrets(sanitizeUntrustedOutput(diffText))
        : previous?.result;
    return {
      callId: rawId,
      name: 'edit_file',
      displayName: '文件修改',
      invocation: redactCommonSecrets(sanitizeUntrustedOutput(chip ? `编辑 ${chip}` : '修改文件')),
      verb: '编辑',
      ...(chip ? { chip } : {}),
      mono: true,
      input:
        paths.length > 0
          ? redactCommonSecrets(sanitizeUntrustedOutput(paths.join('\n')))
          : (previous?.input ?? ''),
      status: mapCodexItemStatus(item, completed),
      ...(result !== undefined ? { result } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  if (kind === 'mcpToolCall' || kind === 'dynamicToolCall' || kind === 'webSearch') {
    const rawName =
      typeof item.tool === 'string'
        ? item.tool
        : typeof item.query === 'string'
          ? 'web_search'
          : kind;
    const name = sanitizeToolName(rawName);
    const displayName = sanitizeDisplayText(rawName, 40) ?? resolveToolDisplay(name).label;
    const argsVal = item.arguments ?? (item.query ? { query: item.query } : undefined);
    const inputText =
      argsVal !== undefined
        ? redactCommonSecrets(sanitizeUntrustedOutput(formatToolDetail(argsVal)))
        : (previous?.input ?? '');
    const resVal = item.result ?? item.error;
    const result =
      resVal !== undefined
        ? redactCommonSecrets(sanitizeUntrustedOutput(formatToolDetail(resVal)))
        : previous?.result;
    return {
      callId: rawId,
      name,
      displayName,
      invocation: displayName,
      input: inputText,
      status: mapCodexItemStatus(item, completed),
      ...(result !== undefined ? { result } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }

  return undefined;
}

function clampCodexTokens(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function parseCodexTokenUsage(params: unknown): ViewUsage | undefined {
  const obj = asRecord(params);
  const tokenUsage = asRecord(obj?.tokenUsage) ?? obj;
  const last = asRecord(tokenUsage?.last) ?? asRecord(tokenUsage?.total) ?? tokenUsage;
  if (!last) return undefined;
  const input = clampCodexTokens(last.inputTokens ?? last.input_tokens);
  const cached = clampCodexTokens(last.cachedInputTokens ?? last.cached_input_tokens);
  const output = clampCodexTokens(last.outputTokens ?? last.output_tokens);
  const promptTokens = Math.min(Number.MAX_SAFE_INTEGER, input + cached);
  const completionTokens = output;
  const totalFromPayload = clampCodexTokens(last.totalTokens ?? last.total_tokens);
  const totalTokens = Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.max(promptTokens + completionTokens, totalFromPayload),
  );
  if (totalTokens <= 0) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

/**
 * Codex 原生 `app-server` 传输驱动（JSON-RPC lite over NDJSON stdio，零外部 SDK 依赖）。
 *
 * 设计约束与协议边界：
 * - 直连用户本机 `codex app-server -c thread_unload_delay_secs=0`；
 * - 适配 Codex `jsonrpc_lite` 线格式（请求、通知与双向审批回复均省略 `"jsonrpc": "2.0"` 字段）；
 * - 完整承载 `thread/start`、`thread/resume`、`turn/start`、`turn/interrupt` 以及命令/文件修改双向审批。
 */
export class CodexAppServerDriver implements ExternalHarnessDriver {
  readonly transport = 'codex-app-server' as const;

  constructor(private readonly options: CodexAppServerDriverOptions = {}) {}

  async inspect(
    def: ExternalHarnessDefinition,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ExternalInspectResult> {
    let resolvedCmd: ReturnType<typeof resolveExternalCommand>;
    try {
      resolvedCmd = resolveExternalCommand({
        command: def.command,
        args: buildCodexCliArgs(def.command, def.args),
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
          reason: err instanceof Error ? err.message : '未找到 codex 可执行文件',
          installHint: CODEX_INSTALL_HINT,
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
      const initRes = await channel.request(
        'initialize',
        {
          clientInfo: {
            name: 'Kapibala',
            version: this.options.clientVersion ?? '0.1.5',
          },
          capabilities: {
            experimentalApi: true,
          },
        },
        { omitJsonRpcVersion: true, timeoutMs, signal },
      );
      channel.markHandshakeCompleted();
      channel.notify('initialized', {}, { omitJsonRpcVersion: true });

      const version = extractCodexVersion(initRes);

      // 尝试轻量读取认证状态；若版本不支持 account/read（-32601）则静默视为就绪
      try {
        const accountRes = asRecord(
          await channel.request(
            'account/read',
            { refreshToken: false },
            { omitJsonRpcVersion: true, timeoutMs: Math.min(5_000, timeoutMs), signal },
          ),
        );
        if (
          accountRes &&
          accountRes.requiresOpenaiAuth === true &&
          !accountRes.account &&
          !launchEnv.env.OPENAI_API_KEY
        ) {
          return {
            available: false,
            agentName: 'Codex',
            ...(version ? { version } : {}),
            loadSupported: true,
            status: 'needs_login',
            reason: 'Codex 尚未登录且未配置 OPENAI_API_KEY',
            loginHint: CODEX_LOGIN_HINT,
          };
        }
      } catch (accountErr) {
        const rpcCode =
          accountErr &&
          typeof accountErr === 'object' &&
          typeof (accountErr as { rpcCode?: unknown }).rpcCode === 'number'
            ? (accountErr as { rpcCode: number }).rpcCode
            : undefined;
        if (rpcCode !== -32601 && accountErr instanceof Error) {
          if (isCodexAuthErrorText(accountErr.message)) {
            return {
              available: false,
              agentName: 'Codex',
              ...(version ? { version } : {}),
              loadSupported: true,
              status: 'needs_login',
              reason: accountErr.message,
              loginHint: CODEX_LOGIN_HINT,
            };
          }
        }
      }

      return {
        available: true,
        agentName: 'Codex',
        ...(version ? { version } : {}),
        loadSupported: true,
        status: 'ready',
      };
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err);
      const stderrTail = proc.getStderrTail();
      const combined = redactCommonSecrets(
        sanitizeUntrustedOutput([errText, stderrTail].filter(Boolean).join(' | ')),
      );
      if (isCodexAuthErrorText(combined)) {
        return {
          available: false,
          agentName: 'Codex',
          loadSupported: false,
          status: 'needs_login',
          reason: sanitizeDisplayText(combined, 240) ?? 'Codex 需要登录授权',
          loginHint: CODEX_LOGIN_HINT,
        };
      }
      return {
        available: false,
        loadSupported: false,
        status: 'handshake_failed',
        reason: sanitizeDisplayText(combined, 240) ?? 'Codex app-server 握手失败',
        loginHint: CODEX_LOGIN_HINT,
        installHint: CODEX_INSTALL_HINT,
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
    if (input.nativeSessionId !== undefined && !isValidNativeSessionId(input.nativeSessionId)) {
      throw new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', 'Codex 恢复会话 threadId 格式非法');
    }
    const sanitizedResumeId = input.nativeSessionId?.trim();

    const resolvedCmd = resolveExternalCommand({
      command: input.def.command,
      args: buildCodexCliArgs(input.def.command, input.def.args),
      platform: this.options.platform,
      homeDir: this.options.homeDir,
      hostEnv: this.options.hostEnv,
    });

    const launchEnv = buildExternalLaunchEnv({
      hostEnv: this.options.hostEnv,
      env: input.def.env,
      envFrom: input.def.envFrom,
      extraPathDirs: resolvedCmd.extraPathDirs,
      platform: this.options.platform,
    });

    const proc = ExternalProcessSupervisor.spawn({
      executable: resolvedCmd.executable,
      args: resolvedCmd.args,
      cwd: input.workspaceRoot,
      env: launchEnv.env,
    });

    let threadId = sanitizedResumeId;
    let closingByClient = false;
    const toolsById = new Map<
      string,
      { view: ViewTool; startedAt: number; outputBuffer: string }
    >();
    const streamedAgentTextLen = new Map<string, number>();
    const streamedReasoningIds = new Set<string>();

    interface ActiveCodexTurn {
      turnId?: string;
      cancelled: boolean;
      pendingApprovals: number;
      latestUsage?: ViewUsage;
      bumpActivity: () => void;
      resolve: (res: ExternalTurnResult) => void;
      reject: (err: unknown) => void;
      cleanup: () => void;
    }

    let activeTurn: ActiveCodexTurn | undefined;

    const emitToolUpsert = (tool: ViewTool, startedAt?: number, outputBuffer = ''): void => {
      const prev = toolsById.get(tool.callId);
      toolsById.set(tool.callId, {
        view: tool,
        startedAt: startedAt ?? prev?.startedAt ?? Date.now(),
        outputBuffer: outputBuffer || prev?.outputBuffer || '',
      });
      input.onEvent({ type: 'tool_upsert', tool });
    };

    const channel = new NdjsonChannel(proc.stdout, proc.stdin, {
      onNotification: (method, params) => {
        const p = asRecord(params) ?? {};

        if (method === 'item/agentMessage/delta') {
          activeTurn?.bumpActivity();
          const delta = typeof p.delta === 'string' ? p.delta : '';
          const itemId = typeof p.itemId === 'string' ? clampCodexCallId(p.itemId, '') : '';
          if (delta) {
            if (itemId) {
              streamedAgentTextLen.set(
                itemId,
                (streamedAgentTextLen.get(itemId) ?? 0) + delta.length,
              );
            }
            input.onEvent({ type: 'text_delta', text: delta });
          }
          return;
        }

        if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
          activeTurn?.bumpActivity();
          const delta = typeof p.delta === 'string' ? p.delta : '';
          const itemId = typeof p.itemId === 'string' ? clampCodexCallId(p.itemId, '') : '';
          if (delta) {
            if (itemId) streamedReasoningIds.add(itemId);
            input.onEvent({ type: 'thought_delta', text: delta });
          }
          return;
        }

        if (
          method === 'item/commandExecution/outputDelta' ||
          method === 'item/fileChange/outputDelta'
        ) {
          activeTurn?.bumpActivity();
          const itemId = typeof p.itemId === 'string' ? clampCodexCallId(p.itemId, '') : '';
          const delta = typeof p.delta === 'string' ? p.delta : '';
          if (!itemId || !delta) return;
          const tracked = toolsById.get(itemId);
          const nextBuf = `${tracked?.outputBuffer ?? ''}${delta}`.slice(-256 * 1024);
          const baseView = tracked?.view ?? {
            callId: itemId,
            name: method.includes('fileChange') ? 'edit_file' : 'bash',
            displayName: method.includes('fileChange') ? '文件修改' : '终端命令',
            invocation: method.includes('fileChange') ? '修改文件' : '运行命令',
            input: '',
            status: 'running' as const,
          };
          emitToolUpsert(
            {
              ...baseView,
              result: redactCommonSecrets(sanitizeUntrustedOutput(nextBuf)),
            },
            tracked?.startedAt,
            nextBuf,
          );
          return;
        }

        if (method === 'item/started' || method === 'item/completed') {
          activeTurn?.bumpActivity();
          const item = asRecord(p.item);
          if (!item) return;
          const kind = typeof item.type === 'string' ? item.type : '';
          const itemId = typeof item.id === 'string' ? clampCodexCallId(item.id, '') : '';
          const completed = method === 'item/completed';

          if (kind === 'agentMessage' && completed && typeof item.text === 'string') {
            const alreadyStreamed = itemId ? (streamedAgentTextLen.get(itemId) ?? 0) : 0;
            const suffix = item.text.slice(alreadyStreamed);
            if (suffix) {
              input.onEvent({ type: 'text_delta', text: suffix });
            }
            return;
          }

          if (kind === 'reasoning' && completed && itemId && !streamedReasoningIds.has(itemId)) {
            const summary = Array.isArray(item.summary)
              ? item.summary.filter((s): s is string => typeof s === 'string').join('\n')
              : '';
            if (summary) {
              input.onEvent({ type: 'thought_delta', text: summary });
            }
            return;
          }

          const tracked = itemId ? toolsById.get(itemId) : undefined;
          const durationMs =
            completed && tracked ? Math.max(0, Date.now() - tracked.startedAt) : undefined;
          const built = buildCodexToolFromItem(
            item,
            completed,
            tracked?.view,
            tracked?.outputBuffer,
            durationMs,
          );
          if (built) {
            emitToolUpsert(built, tracked?.startedAt, tracked?.outputBuffer);
          }
          return;
        }

        if (method === 'turn/plan/updated') {
          activeTurn?.bumpActivity();
          const items: ViewTodoItem[] = normalizeAcpPlanUpdate(p);
          input.onEvent({ type: 'plan_updated', items });
          return;
        }

        if (method === 'thread/tokenUsage/updated') {
          activeTurn?.bumpActivity();
          const usage = parseCodexTokenUsage(p);
          if (usage && activeTurn) {
            activeTurn.latestUsage = usage;
          }
          return;
        }

        if (method === 'error') {
          activeTurn?.bumpActivity();
          const errObj = asRecord(p.error);
          const msg =
            typeof errObj?.message === 'string'
              ? errObj.message
              : typeof p.message === 'string'
                ? p.message
                : 'Codex 运行异常';
          input.onEvent({
            type: 'diagnostic',
            level: p.willRetry === true ? 'warning' : 'error',
            text: redactCommonSecrets(sanitizeUntrustedOutput(msg)),
          });
          return;
        }

        if (method === 'turn/completed') {
          const turnObj = asRecord(p.turn) ?? p;
          const incomingTurnId = typeof turnObj.id === 'string' ? turnObj.id : undefined;
          if (!activeTurn) return;
          if (activeTurn.turnId && incomingTurnId && activeTurn.turnId !== incomingTurnId) {
            return;
          }
          const turn = activeTurn;
          activeTurn = undefined;
          turn.cleanup();

          const status = typeof turnObj.status === 'string' ? turnObj.status.toLowerCase() : '';
          if (
            turn.cancelled ||
            status === 'interrupted' ||
            status === 'cancelled' ||
            status === 'canceled'
          ) {
            turn.resolve({
              stopReason: 'cancelled',
              ...(turn.latestUsage ? { usage: turn.latestUsage } : {}),
            });
            return;
          }

          if (status === 'failed' || status === 'error') {
            const errObj = asRecord(turnObj.error);
            const rawDetail =
              typeof errObj?.message === 'string' ? errObj.message : 'Codex 轮次执行失败';
            const safeDetail = redactCommonSecrets(sanitizeUntrustedOutput(rawDetail));
            const authErr = isCodexAuthErrorText(safeDetail);
            turn.reject(
              new ExternalHarnessError(
                authErr ? 'EXTERNAL_AUTH_REQUIRED' : 'EXTERNAL_PROTOCOL_ERROR',
                safeDetail,
                authErr ? { loginHint: CODEX_LOGIN_HINT } : undefined,
              ),
            );
            return;
          }

          turn.resolve({
            stopReason: 'completed',
            ...(turn.latestUsage ? { usage: turn.latestUsage } : {}),
          });
        }
      },
      onRequest: async (id, method, params) => {
        const p = asRecord(params) ?? {};
        const isCmdApproval =
          method === 'item/commandExecution/requestApproval' || method === 'execCommandApproval';
        const isFileApproval =
          method === 'item/fileChange/requestApproval' || method === 'applyPatchApproval';

        if (!isCmdApproval && !isFileApproval) {
          throw Object.assign(new Error(`Unsupported Codex client request: ${method}`), {
            rpcCode: -32601,
          });
        }

        if (!activeTurn) {
          return { decision: 'cancel' };
        }

        const itemId =
          typeof p.itemId === 'string' && p.itemId.trim()
            ? clampCodexCallId(p.itemId)
            : typeof p.callId === 'string' && p.callId.trim()
              ? clampCodexCallId(p.callId)
              : clampCodexCallId(`codex-item-${String(id)}`);

        const cmdText =
          typeof p.command === 'string'
            ? p.command
            : Array.isArray(p.command)
              ? p.command.filter((x): x is string => typeof x === 'string').join(' ')
              : undefined;
        const grantRoot = typeof p.grantRoot === 'string' ? p.grantRoot : undefined;
        const changePaths: string[] = [];
        if (Array.isArray(p.changes)) {
          for (const entry of p.changes) {
            const ch = asRecord(entry);
            if (typeof ch?.path === 'string' && ch.path.trim()) {
              changePaths.push(ch.path.trim());
            }
          }
        }
        const reason =
          typeof p.reason === 'string' && p.reason.trim()
            ? sanitizeDisplayText(redactCommonSecrets(sanitizeUntrustedOutput(p.reason)), 200)
            : undefined;

        const existing = toolsById.get(itemId)?.view;
        const fallbackFileTarget =
          grantRoot ??
          (changePaths.length > 0 ? changePaths.join(', ') : existing?.input || undefined);
        const rawTarget = cmdText ?? fallbackFileTarget;
        const safeTarget = rawTarget
          ? sanitizeDisplayText(redactCommonSecrets(sanitizeUntrustedOutput(rawTarget)), 2_000)
          : undefined;

        if (!existing) {
          const synth: ViewTool = isCmdApproval
            ? {
                callId: itemId,
                name: 'bash',
                displayName: '终端命令',
                invocation: safeTarget ? `运行 ${safeTarget.slice(0, 96)}` : '运行命令',
                verb: '运行',
                ...(safeTarget ? { chip: sanitizeDisplayText(safeTarget, 96) } : {}),
                mono: true,
                input: safeTarget ?? '',
                status: 'running',
              }
            : {
                callId: itemId,
                name: 'edit_file',
                displayName: '文件修改',
                invocation: safeTarget ? `编辑 ${safeTarget.slice(0, 96)}` : '修改文件',
                verb: '编辑',
                ...(safeTarget ? { chip: sanitizeDisplayText(safeTarget, 96) } : {}),
                mono: true,
                input: safeTarget ?? '',
                status: 'running',
              };
          emitToolUpsert(synth);
        }

        activeTurn.pendingApprovals += 1;
        activeTurn.bumpActivity();

        return await new Promise<Record<string, unknown>>((resolve) => {
          let settled = false;
          input.onEvent({
            type: 'approval_requested',
            requestId: clampCodexCallId(String(id), 'codex-req'),
            toolCallId: itemId,
            toolTitle: isCmdApproval ? '终端命令执行' : '文件写入修改',
            ...(safeTarget ? { target: safeTarget } : {}),
            ...(reason ? { warning: reason } : {}),
            options: isCmdApproval
              ? [
                  { optionId: 'accept', label: '批准本次', kind: 'allow_once' },
                  {
                    optionId: 'acceptForSession',
                    label: '本会话批准同类命令',
                    kind: 'allow_session',
                  },
                  { optionId: 'decline', label: '拒绝', kind: 'reject_once' },
                ]
              : [
                  { optionId: 'accept', label: '允许写入', kind: 'allow_once' },
                  {
                    optionId: 'acceptForSession',
                    label: '本会话允许修改文件',
                    kind: 'allow_session',
                  },
                  { optionId: 'decline', label: '拒绝', kind: 'reject_once' },
                ],
            respond: (decision: ExternalApprovalDecision) => {
              if (settled) return;
              settled = true;
              if (activeTurn) {
                activeTurn.pendingApprovals = Math.max(0, activeTurn.pendingApprovals - 1);
                activeTurn.bumpActivity();
              }
              if (decision.outcome === 'cancelled') {
                resolve({ decision: 'cancel' });
                return;
              }
              if (decision.optionId === 'acceptForSession') {
                resolve({ decision: 'acceptForSession' });
                return;
              }
              if (decision.optionId === 'accept') {
                resolve({ decision: 'accept' });
                return;
              }
              resolve({ decision: 'decline' });
            },
          });
        });
      },
      onNonJsonLine: (line) => {
        input.onEvent({ type: 'diagnostic', level: 'info', text: line });
      },
      onFatalError: (err) => {
        if (activeTurn) {
          const turn = activeTurn;
          activeTurn = undefined;
          turn.cleanup();
          turn.reject(err);
        }
        input.onEvent({ type: 'diagnostic', level: 'error', text: err.message });
        void proc.close();
      },
    });

    void proc.waitForClose().then((exit) => {
      const closeErr = new ExternalHarnessError(
        'EXTERNAL_PROTOCOL_ERROR',
        `Codex app-server 进程已退出（code=${exit.code ?? 'null'}）`,
      );
      channel.close(closeErr);
      if (activeTurn) {
        const turn = activeTurn;
        activeTurn = undefined;
        turn.cleanup();
        if (turn.cancelled || closingByClient) {
          turn.resolve({ stopReason: 'cancelled', processTerminated: true });
        } else {
          turn.reject(closeErr);
        }
      }
      if (!closingByClient) {
        input.onEvent({
          type: 'closed',
          code: exit.code,
          signal: exit.signal,
          stderrTail: proc.getStderrTail() || undefined,
        });
      }
    });

    const handshakeTimeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    let modelLabel: string | undefined;
    let modeLabel: string | undefined;

    try {
      await channel.request(
        'initialize',
        {
          clientInfo: {
            name: 'Kapibala',
            version: this.options.clientVersion ?? '0.1.5',
          },
          capabilities: {
            experimentalApi: true,
          },
        },
        { omitJsonRpcVersion: true, timeoutMs: handshakeTimeoutMs, signal: input.signal },
      );
      channel.markHandshakeCompleted();
      channel.notify('initialized', {}, { omitJsonRpcVersion: true });

      const threadParams: Record<string, unknown> = {
        cwd: input.workspaceRoot,
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        ...(sanitizedResumeId ? { threadId: sanitizedResumeId } : {}),
      };
      const openedRaw = await channel.request(
        sanitizedResumeId ? 'thread/resume' : 'thread/start',
        threadParams,
        { omitJsonRpcVersion: true, timeoutMs: handshakeTimeoutMs, signal: input.signal },
      );
      const opened = asRecord(openedRaw) ?? {};
      const threadObj = asRecord(opened.thread);
      const resolvedThreadId =
        typeof threadObj?.id === 'string' && threadObj.id.trim()
          ? threadObj.id.trim()
          : typeof opened.threadId === 'string' && opened.threadId.trim()
            ? opened.threadId.trim()
            : sanitizedResumeId;

      if (!resolvedThreadId || !isValidNativeSessionId(resolvedThreadId)) {
        throw new ExternalHarnessError(
          'EXTERNAL_PROTOCOL_ERROR',
          'Codex thread/start 响应缺少合法的 thread.id',
        );
      }
      threadId = resolvedThreadId;

      if (typeof opened.model === 'string' && opened.model.trim()) {
        modelLabel = sanitizeDisplayText(opened.model.trim(), 64);
      } else if (typeof threadObj?.model === 'string' && threadObj.model.trim()) {
        modelLabel = sanitizeDisplayText(threadObj.model.trim(), 64);
      }

      const sandboxObj = asRecord(opened.sandbox);
      if (typeof sandboxObj?.type === 'string') {
        modeLabel = sanitizeDisplayText(sandboxObj.type, 48);
      } else if (typeof opened.approvalPolicy === 'string') {
        modeLabel = sanitizeDisplayText(opened.approvalPolicy, 48);
      }
    } catch (err) {
      closingByClient = true;
      channel.close();
      await proc.close();
      if (err instanceof Error && isCodexAuthErrorText(err.message)) {
        throw new ExternalHarnessError('EXTERNAL_AUTH_REQUIRED', err.message, {
          loginHint: CODEX_LOGIN_HINT,
          cause: err,
        });
      }
      throw err;
    }

    const turnWatchdogMs = this.options.turnWatchdogMs ?? DEFAULT_TURN_WATCHDOG_MS;
    const activeThreadId = threadId;

    const handle: ExternalDriverSessionHandle = {
      get pid() {
        return proc.pid;
      },
      async prompt(text: string, signal?: AbortSignal): Promise<ExternalTurnResult> {
        if (activeTurn) {
          throw new ExternalHarnessError(
            'EXTERNAL_SESSION_BUSY',
            '当前 Codex 会话已有在途轮次，禁止并发发送',
          );
        }
        if (signal?.aborted) {
          throw new ExternalHarnessError('EXTERNAL_ABORTED', '轮次已取消');
        }

        return await new Promise<ExternalTurnResult>((resolve, reject) => {
          let lastActivityAt = Date.now();
          let lastTickAt = Date.now();
          const checkIntervalMs = Math.max(25, Math.min(2_000, Math.floor(turnWatchdogMs / 4)));

          const watchdogTimer = setInterval(() => {
            const now = Date.now();
            const wallJump = now - lastTickAt - checkIntervalMs;
            lastTickAt = now;
            if (wallJump > SLEEP_JUMP_TOLERANCE_MS) {
              lastActivityAt += wallJump;
            }
            if (activeTurn && activeTurn.pendingApprovals > 0) {
              lastActivityAt = now;
              return;
            }
            if (now - lastActivityAt > turnWatchdogMs) {
              const turn = activeTurn;
              activeTurn = undefined;
              turn?.cleanup();
              const timeoutErr = new ExternalHarnessError(
                'EXTERNAL_TIMEOUT',
                `Codex 超过 ${Math.round(turnWatchdogMs / 1000)} 秒无响应进展，已中止当前轮次`,
              );
              closingByClient = true;
              void proc.close().finally(() => {
                input.onEvent({ type: 'closed', code: 1, signal: null });
                reject(timeoutErr);
              });
            }
          }, checkIntervalMs);
          watchdogTimer.unref?.();

          const onAbort = (): void => {
            void handle.cancel();
          };
          signal?.addEventListener('abort', onAbort, { once: true });

          const cleanup = (): void => {
            clearInterval(watchdogTimer);
            signal?.removeEventListener('abort', onAbort);
          };

          const currentTurn: ActiveCodexTurn = {
            cancelled: false,
            pendingApprovals: 0,
            bumpActivity: () => {
              lastActivityAt = Date.now();
            },
            resolve,
            reject,
            cleanup,
          };
          activeTurn = currentTurn;

          void channel
            .request(
              'turn/start',
              {
                threadId: activeThreadId,
                input: [{ type: 'text', text }],
              },
              { omitJsonRpcVersion: true, signal },
            )
            .then((startedRaw) => {
              const started = asRecord(startedRaw);
              const turnObj = asRecord(started?.turn);
              const idStr =
                typeof turnObj?.id === 'string'
                  ? turnObj.id
                  : typeof started?.turnId === 'string'
                    ? started.turnId
                    : `turn-${randomUUID().slice(0, 8)}`;
              if (activeTurn === currentTurn) {
                currentTurn.turnId = idStr;
                if (currentTurn.cancelled && activeThreadId) {
                  void channel
                    .request(
                      'turn/interrupt',
                      {
                        threadId: activeThreadId,
                        turnId: idStr,
                      },
                      { omitJsonRpcVersion: true, timeoutMs: 3_000 },
                    )
                    .catch(() => {});
                }
              }
            })
            .catch((err) => {
              if (activeTurn === currentTurn) {
                activeTurn = undefined;
                cleanup();
                if (currentTurn.cancelled) {
                  resolve({ stopReason: 'cancelled' });
                } else {
                  reject(err);
                }
              }
            });
        });
      },
      async cancel(): Promise<void> {
        if (!activeTurn || activeTurn.cancelled) return;
        activeTurn.cancelled = true;
        if (activeTurn.turnId) {
          void channel
            .request(
              'turn/interrupt',
              {
                threadId: activeThreadId,
                turnId: activeTurn.turnId,
              },
              { omitJsonRpcVersion: true, timeoutMs: 3_000 },
            )
            .catch(() => {});
        }

        const snapshotTurn = activeTurn;
        const graceTimer = setTimeout(() => {
          if (activeTurn === snapshotTurn) {
            activeTurn = undefined;
            snapshotTurn.cleanup();
            closingByClient = true;
            void proc.close().finally(() => {
              snapshotTurn.resolve({ stopReason: 'cancelled', processTerminated: true });
            });
          }
        }, CANCEL_SETTLE_GRACE_MS);
        graceTimer.unref?.();
      },
      async close(): Promise<void> {
        closingByClient = true;
        if (activeTurn) {
          const turn = activeTurn;
          activeTurn = undefined;
          turn.cleanup();
          turn.resolve({ stopReason: 'cancelled', processTerminated: true });
        }
        channel.close();
        await proc.close();
      },
    };

    return {
      handle,
      nativeSessionId: activeThreadId,
      resumable: true,
      ...(modelLabel ? { modelLabel } : {}),
      ...(modeLabel ? { modeLabel } : {}),
    };
  }
}
