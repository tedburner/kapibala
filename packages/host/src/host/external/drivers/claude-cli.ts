import { randomUUID } from 'node:crypto';
import type { ViewTodoItem, ViewTool, ViewUsage } from '../../../view-model/index.js';
import { redactCommonSecrets, sanitizeDisplayText } from '../../redaction.js';
import { sanitizeUntrustedOutput } from '../../ui/text-safety.js';
import {
  describeToolActivity,
  formatToolDetail,
  formatToolInvocation,
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

const CLAUDE_INSTALL_HINT = 'npm install -g @anthropic-ai/claude-code';
const CLAUDE_LOGIN_HINT = 'claude auth login';
const CLAUDE_DISALLOWED_INTERACTIVE_TOOLS = 'AskUserQuestion,EnterPlanMode,ExitPlanMode';

/** `ClaudeCliDriver` 构造可选项（支持单测覆盖超时与宿主环境）。 */
export interface ClaudeCliDriverOptions {
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

function isClaudeAuthErrorText(text: string): boolean {
  return /not logged in|please run [`'"]?claude|authentication[_\s-]?error|invalid[_\s-]?api[_\s-]?key|unauthorized|401\b|login required/i.test(
    text,
  );
}

function parseVersionToken(text: string): string | undefined {
  const match = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(text);
  return match?.[1];
}

function buildClaudeLaunchArgs(baseArgs: readonly string[], nativeSessionId?: string): string[] {
  const sepIdx = baseArgs.indexOf('--');
  const head = sepIdx >= 0 ? [...baseArgs.slice(0, sepIdx)] : [...baseArgs];
  const tail = sepIdx >= 0 ? baseArgs.slice(sepIdx) : [];

  if (!head.includes('-p') && !head.includes('--print')) {
    head.push('-p');
  }
  if (!head.includes('--input-format')) {
    head.push('--input-format', 'stream-json');
  }
  if (!head.includes('--output-format')) {
    head.push('--output-format', 'stream-json');
  }
  if (!head.includes('--verbose')) {
    head.push('--verbose');
  }
  if (!head.includes('--include-partial-messages')) {
    head.push('--include-partial-messages');
  }
  if (!head.includes('--permission-prompt-tool')) {
    head.push('--permission-prompt-tool', 'stdio');
  }
  // 始终追加无 TTY 交互式工具黑名单，防止用户自定义 --disallowedTools 冲掉默认保护导致子进程挂死
  head.push('--disallowedTools', CLAUDE_DISALLOWED_INTERACTIVE_TOOLS);
  if (nativeSessionId && isValidNativeSessionId(nativeSessionId) && !head.includes('--resume')) {
    head.push('--resume', nativeSessionId.trim());
  }
  return [...head, ...tail];
}

function sanitizeClaudeApprovalTarget(raw: string): string | undefined {
  return sanitizeDisplayText(redactCommonSecrets(sanitizeUntrustedOutput(raw)), 2_000);
}

function extractClaudeToolTarget(input: Record<string, unknown>): {
  verb?: string;
  chip?: string;
  mono?: boolean;
  target?: string;
} {
  const filePath =
    typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.filePath === 'string'
        ? input.filePath
        : typeof input.notebook_path === 'string'
          ? input.notebook_path
          : undefined;
  if (filePath) {
    return {
      chip: sanitizeDisplayText(filePath, 96),
      mono: true,
      target: sanitizeClaudeApprovalTarget(filePath),
    };
  }
  if (typeof input.command === 'string' && input.command.trim()) {
    return {
      verb: '运行',
      chip: sanitizeDisplayText(input.command, 96),
      mono: true,
      target: sanitizeClaudeApprovalTarget(input.command),
    };
  }
  if (typeof input.pattern === 'string' && input.pattern.trim()) {
    return {
      verb: '搜索',
      chip: sanitizeDisplayText(input.pattern, 96),
      mono: true,
      target: sanitizeClaudeApprovalTarget(input.pattern),
    };
  }
  if (typeof input.url === 'string' && input.url.trim()) {
    return {
      verb: '请求',
      chip: sanitizeDisplayText(input.url, 96),
      target: sanitizeClaudeApprovalTarget(input.url),
    };
  }
  return {};
}

function clampCallId(raw: string, fallback = 'claude-tool'): string {
  const trimmed = raw.trim().slice(0, 256);
  return trimmed || fallback;
}

function buildClaudeViewTool(
  callId: string,
  rawName: string,
  rawInput: Record<string, unknown>,
  previous?: ViewTool,
): ViewTool {
  const safeCallId = clampCallId(callId, previous?.callId ?? 'claude-tool');
  const name = sanitizeToolName(rawName || previous?.name || 'tool');
  const displayName = sanitizeDisplayText(rawName, 40) ?? resolveToolDisplay(name).label;
  const builtin = describeToolActivity(name, rawInput);
  const extracted = extractClaudeToolTarget(rawInput);
  const verb =
    builtin.verb ??
    extracted.verb ??
    (/^(Read|FileReadTool)$/i.test(rawName)
      ? '读取'
      : /^(Write|Edit|MultiEdit|FileWriteTool|FileEditTool)$/i.test(rawName)
        ? '编辑'
        : /^(Glob|Grep|GlobTool|GrepTool)$/i.test(rawName)
          ? '搜索'
          : previous?.verb);
  const chip = builtin.chip ?? extracted.chip ?? previous?.chip;
  const mono = builtin.mono ?? extracted.mono ?? previous?.mono;
  const invocation = redactCommonSecrets(
    sanitizeUntrustedOutput(
      chip ? `${verb ?? displayName} ${chip}` : formatToolInvocation(name, rawInput),
    ),
  );
  const inputText =
    Object.keys(rawInput).length > 0
      ? redactCommonSecrets(sanitizeUntrustedOutput(formatToolDetail(rawInput)))
      : (previous?.input ?? '');

  return {
    callId: safeCallId,
    name,
    displayName,
    invocation,
    ...(verb ? { verb } : {}),
    ...(chip ? { chip } : {}),
    ...(mono ? { mono: true } : {}),
    input: inputText,
    status: previous?.status ?? 'running',
    ...(previous?.result !== undefined ? { result: previous.result } : {}),
    ...(previous?.durationMs !== undefined ? { durationMs: previous.durationMs } : {}),
  };
}

function extractToolResultText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return redactCommonSecrets(sanitizeUntrustedOutput(content));
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const entry of content) {
      const item = asRecord(entry);
      if (typeof item?.text === 'string' && item.text) {
        parts.push(item.text);
      }
    }
    if (parts.length > 0) {
      return redactCommonSecrets(sanitizeUntrustedOutput(parts.join('\n')));
    }
  }
  if (content !== undefined && content !== null) {
    return redactCommonSecrets(sanitizeUntrustedOutput(formatToolDetail(content)));
  }
  return undefined;
}

function clampUsageCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function parseClaudeUsage(raw: unknown): ViewUsage | undefined {
  const u = asRecord(raw);
  if (!u) return undefined;
  const input = clampUsageCount(u.input_tokens);
  const cacheRead = clampUsageCount(u.cache_read_input_tokens);
  const cacheWrite = clampUsageCount(u.cache_creation_input_tokens);
  const output = clampUsageCount(u.output_tokens);
  const promptTokens = Math.min(Number.MAX_SAFE_INTEGER, input + cacheRead + cacheWrite);
  const completionTokens = output;
  const totalTokens = Math.min(Number.MAX_SAFE_INTEGER, promptTokens + completionTokens);
  if (totalTokens <= 0) return undefined;
  return {
    promptTokens,
    completionTokens,
    totalTokens,
  };
}

/**
 * Claude Code 原生双向 `stream-json` 传输驱动（零外部 SDK 依赖）。
 *
 * 设计约束与协议边界：
 * - 直接复用本机 `claude` / `claude.exe` 的 `--input-format stream-json --output-format stream-json --permission-prompt-tool stdio` 管道；
 * - 显式禁用 `AskUserQuestion,EnterPlanMode,ExitPlanMode`，杜绝无 TTY 子进程因隐藏交互挂死；
 * - 严格按 `SDKControlResponse` 嵌套信封回复 `can_use_tool`（允许时携带原 `updatedInput`，拒绝/超时取消时回 `deny`）；
 * - 跨进程恢复通过 `--resume <session_id>` 衔接，并配合上层只读展示快照保障历史立即可见。
 */
export class ClaudeCliDriver implements ExternalHarnessDriver {
  readonly transport = 'claude-cli' as const;

  constructor(private readonly options: ClaudeCliDriverOptions = {}) {}

  /** 执行只读 `--version` 与 `auth status --json` 探测，核验 Claude Code 安装与登录授权状态。 */
  async inspect(
    def: ExternalHarnessDefinition,
    cwd: string,
    signal?: AbortSignal,
  ): Promise<ExternalInspectResult> {
    if (signal?.aborted) {
      throw new ExternalHarnessError('EXTERNAL_ABORTED', '探测已取消');
    }
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
          reason: err instanceof Error ? err.message : '未找到 claude 可执行文件',
          installHint: CLAUDE_INSTALL_HINT,
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

    const deadline = Date.now() + (this.options.inspectTimeoutMs ?? DEFAULT_INSPECT_TIMEOUT_MS);
    // CLI 认证状态只读；共享同一探测预算，输出仅用于提取版本与认证布尔值。
    const probe = async (args: string[]) => {
      if (signal?.aborted) throw new ExternalHarnessError('EXTERNAL_ABORTED', '探测已取消');
      const proc = ExternalProcessSupervisor.spawn({
        executable: resolvedCmd.executable,
        args: [...resolvedCmd.args, ...args],
        cwd,
        env: launchEnv.env,
      });
      let stdout = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.subarray(0, Math.max(0, 8192 - stdout.length)).toString('utf8');
      });
      const abort = () => void proc.close();
      signal?.addEventListener('abort', abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const exit = await Promise.race([
          proc.waitForClose(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => {
                reject(new ExternalHarnessError('EXTERNAL_TIMEOUT', 'Claude Code 探测超时'));
              },
              Math.max(1, deadline - Date.now()),
            );
            timer.unref?.();
          }),
        ]);
        if (signal?.aborted) throw new ExternalHarnessError('EXTERNAL_ABORTED', '探测已取消');
        return { code: exit.code, stdout };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        await proc.close();
      }
    };

    try {
      const versionResult = await probe(['--version']);
      if (versionResult.code !== 0) {
        throw new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', 'Claude Code 版本探测未成功退出');
      }
      const version = parseVersionToken(versionResult.stdout);
      const identity = {
        agentName: 'Claude Code',
        ...(version ? { version } : {}),
        loadSupported: true,
      };
      const auth = await probe(['auth', 'status', '--json']);
      let loggedIn: unknown;
      try {
        loggedIn = asRecord(JSON.parse(auth.stdout))?.loggedIn;
      } catch {
        // 旧版或包装器可能未实现结构化认证探测。
      }
      if (loggedIn === true && auth.code === 0) {
        return { ...identity, available: true, status: 'ready' };
      }
      if (loggedIn === false) {
        return {
          ...identity,
          available: false,
          status: 'needs_login',
          reason: 'Claude Code 尚未完成登录授权',
          loginHint: CLAUDE_LOGIN_HINT,
        };
      }
      return {
        ...identity,
        available: false,
        status: 'auth_unverified',
        reason: '当前 Claude Code 未返回可识别的认证状态。',
        loginHint: CLAUDE_LOGIN_HINT,
      };
    } catch (err) {
      return {
        available: false,
        loadSupported: false,
        status: 'handshake_failed',
        reason: err instanceof ExternalHarnessError ? err.safeMessage : '探测 Claude Code 失败',
        loginHint: CLAUDE_LOGIN_HINT,
        installHint: CLAUDE_INSTALL_HINT,
      };
    }
  }

  /** 启动双向 `stream-json` 管道并完成 `initialize` 控制握手（按需通过 `--resume` 衔接已有会话）。 */
  async open(input: {
    def: ExternalHarnessDefinition;
    workspaceRoot: string;
    nativeSessionId?: string;
    onEvent: (event: ExternalEvent) => void;
    signal?: AbortSignal;
  }): Promise<ExternalDriverOpenResult> {
    if (input.signal?.aborted) {
      throw new ExternalHarnessError('EXTERNAL_ABORTED', 'Claude Code 启动已取消');
    }
    if (input.nativeSessionId !== undefined && !isValidNativeSessionId(input.nativeSessionId)) {
      throw new ExternalHarnessError('EXTERNAL_PROTOCOL_ERROR', 'Claude Code 恢复会话 ID 格式非法');
    }
    const sanitizedResumeId = input.nativeSessionId?.trim();

    const resolvedCmd = resolveExternalCommand({
      command: input.def.command,
      args: input.def.args,
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

    const cliArgs = buildClaudeLaunchArgs(resolvedCmd.args, sanitizedResumeId);
    const proc = ExternalProcessSupervisor.spawn({
      executable: resolvedCmd.executable,
      args: cliArgs,
      cwd: input.workspaceRoot,
      env: launchEnv.env,
    });

    let currentSessionId = sanitizedResumeId;
    let currentModelLabel: string | undefined;
    let currentModeLabel: string | undefined;
    let closingByClient = false;

    const toolsByCallId = new Map<string, { view: ViewTool; startedAt: number }>();
    const pendingApprovalResolvers = new Map<
      string,
      (decision: ExternalApprovalDecision, suppressReply?: boolean) => void
    >();

    const settleAllApprovalsCancelled = (suppressReply = false): void => {
      for (const [reqId, settle] of pendingApprovalResolvers) {
        pendingApprovalResolvers.delete(reqId);
        settle({ outcome: 'cancelled' }, suppressReply);
      }
    };

    interface ActiveClaudeTurn {
      sawStreamText: boolean;
      sawStreamThinking: boolean;
      emittedAnyText: boolean;
      cancelled: boolean;
      pendingApprovals: number;
      bumpActivity: () => void;
      resolve: (res: ExternalTurnResult) => void;
      reject: (err: unknown) => void;
      cleanup: () => void;
    }

    let activeTurn: ActiveClaudeTurn | undefined;
    const initRequestId = `init_${randomUUID().slice(0, 8)}`;
    let handshakeSettled = false;
    let resolveHandshake: (() => void) | undefined;
    let rejectHandshake: ((err: unknown) => void) | undefined;

    const settleHandshakeOk = (): void => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      channel.markHandshakeCompleted();
      resolveHandshake?.();
    };

    const settleHandshakeErr = (err: unknown): void => {
      if (handshakeSettled) return;
      handshakeSettled = true;
      rejectHandshake?.(err);
    };

    const emitToolUpsert = (tool: ViewTool, startedAt?: number): void => {
      const prev = toolsByCallId.get(tool.callId);
      toolsByCallId.set(tool.callId, {
        view: tool,
        startedAt: startedAt ?? prev?.startedAt ?? Date.now(),
      });
      input.onEvent({ type: 'tool_upsert', tool });
    };

    const channel = new NdjsonChannel(proc.stdout, proc.stdin, {
      onMessage: (payload) => {
        const type = typeof payload.type === 'string' ? payload.type : '';

        if (type === 'control_response') {
          const resp = asRecord(payload.response);
          const reqId = typeof resp?.request_id === 'string' ? resp.request_id : undefined;
          if (reqId === initRequestId) {
            if (resp?.subtype === 'error') {
              const errMsg =
                typeof resp.error === 'string' ? resp.error : 'Claude Code 初始化握手返回错误';
              settleHandshakeErr(
                new ExternalHarnessError(
                  isClaudeAuthErrorText(errMsg)
                    ? 'EXTERNAL_AUTH_REQUIRED'
                    : 'EXTERNAL_PROTOCOL_ERROR',
                  redactCommonSecrets(sanitizeUntrustedOutput(errMsg)),
                  isClaudeAuthErrorText(errMsg) ? { loginHint: CLAUDE_LOGIN_HINT } : undefined,
                ),
              );
            } else {
              settleHandshakeOk();
            }
          }
          return;
        }

        if (type === 'system') {
          const subtype = typeof payload.subtype === 'string' ? payload.subtype : '';
          if (subtype === 'init') {
            settleHandshakeOk();
            activeTurn?.bumpActivity();
            const sid =
              typeof payload.session_id === 'string' && isValidNativeSessionId(payload.session_id)
                ? payload.session_id.trim()
                : undefined;
            const model =
              typeof payload.model === 'string'
                ? sanitizeDisplayText(payload.model, 64)
                : undefined;
            const mode =
              typeof payload.permissionMode === 'string'
                ? sanitizeDisplayText(payload.permissionMode, 48)
                : undefined;
            if (sid) currentSessionId = sid;
            if (model) currentModelLabel = model;
            if (mode) currentModeLabel = mode;
            input.onEvent({
              type: 'config_updated',
              ...(sid ? { nativeSessionId: sid, resumable: true } : {}),
              ...(model ? { modelLabel: model } : {}),
              ...(mode ? { modeLabel: mode } : {}),
            });
            return;
          }
          if (subtype === 'api_retry') {
            activeTurn?.bumpActivity();
            input.onEvent({
              type: 'diagnostic',
              level: 'warning',
              text: 'Claude Code 正在重试上游模型请求…',
            });
            return;
          }
          if (subtype === 'permission_denied') {
            activeTurn?.bumpActivity();
            const msg =
              typeof payload.message === 'string'
                ? payload.message
                : 'Claude Code 拒绝了某项工具调用';
            input.onEvent({
              type: 'diagnostic',
              level: 'warning',
              text: redactCommonSecrets(sanitizeUntrustedOutput(msg)),
            });
            return;
          }
          return;
        }

        if (type === 'stream_event') {
          settleHandshakeOk();
          activeTurn?.bumpActivity();
          // 忽略子代理内部流式事件，防止子代理文本增量混入顶层助手气泡或污染 sawStreamText
          if (
            typeof payload.parent_tool_use_id === 'string' &&
            payload.parent_tool_use_id.length > 0
          ) {
            return;
          }
          const ev = asRecord(payload.event);
          if (ev?.type === 'content_block_delta') {
            const delta = asRecord(ev.delta);
            if (delta?.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
              if (activeTurn) {
                activeTurn.sawStreamText = true;
                activeTurn.emittedAnyText = true;
              }
              input.onEvent({ type: 'text_delta', text: delta.text });
            } else if (
              delta?.type === 'thinking_delta' &&
              typeof delta.thinking === 'string' &&
              delta.thinking
            ) {
              if (activeTurn) {
                activeTurn.sawStreamThinking = true;
              }
              input.onEvent({ type: 'thought_delta', text: delta.thinking });
            }
          }
          return;
        }

        if (type === 'assistant') {
          settleHandshakeOk();
          activeTurn?.bumpActivity();
          if (
            typeof payload.parent_tool_use_id === 'string' &&
            payload.parent_tool_use_id.length > 0
          ) {
            return;
          }
          const msg = asRecord(payload.message);
          const content = Array.isArray(msg?.content) ? msg.content : [];
          for (const rawBlock of content) {
            const block = asRecord(rawBlock);
            if (!block) continue;
            if (
              block.type === 'thinking' &&
              !activeTurn?.sawStreamThinking &&
              typeof block.thinking === 'string' &&
              block.thinking
            ) {
              input.onEvent({ type: 'thought_delta', text: block.thinking });
            } else if (
              block.type === 'text' &&
              !activeTurn?.sawStreamText &&
              typeof block.text === 'string' &&
              block.text
            ) {
              if (activeTurn) activeTurn.emittedAnyText = true;
              input.onEvent({ type: 'text_delta', text: block.text });
            } else if (block.type === 'tool_use') {
              const callId =
                typeof block.id === 'string' && block.id.trim()
                  ? clampCallId(block.id)
                  : `claude-tool-${randomUUID().slice(0, 8)}`;
              const toolName = typeof block.name === 'string' ? block.name : 'tool';
              const toolInput = asRecord(block.input) ?? {};
              if (toolName === 'TodoWrite' && Array.isArray(toolInput.todos)) {
                const items: ViewTodoItem[] = normalizeAcpPlanUpdate({ entries: toolInput.todos });
                input.onEvent({ type: 'plan_updated', items });
              }
              const prev = toolsByCallId.get(callId)?.view;
              emitToolUpsert(buildClaudeViewTool(callId, toolName, toolInput, prev));
            }
          }
          // 单轮多步工具调用时，每条 assistant 消息收尾后重置流式观测位，防后续步骤非流式块被误吞
          if (activeTurn) {
            activeTurn.sawStreamText = false;
            activeTurn.sawStreamThinking = false;
          }
          return;
        }

        if (type === 'user') {
          activeTurn?.bumpActivity();
          if (
            typeof payload.parent_tool_use_id === 'string' &&
            payload.parent_tool_use_id.length > 0
          ) {
            return;
          }
          const msg = asRecord(payload.message);
          const content = Array.isArray(msg?.content) ? msg.content : [];
          for (const rawBlock of content) {
            const block = asRecord(rawBlock);
            if (block?.type !== 'tool_result') continue;
            const callId =
              typeof block.tool_use_id === 'string' && block.tool_use_id.trim()
                ? clampCallId(block.tool_use_id)
                : undefined;
            if (!callId) continue;
            const tracked = toolsByCallId.get(callId);
            const isError = block.is_error === true;
            const resultText = extractToolResultText(block.content);
            const durationMs = tracked ? Math.max(0, Date.now() - tracked.startedAt) : undefined;
            const baseTool = tracked?.view ?? buildClaudeViewTool(callId, 'tool', {}, undefined);
            emitToolUpsert(
              {
                ...baseTool,
                status: isError ? 'failed' : 'succeeded',
                ...(resultText !== undefined ? { result: resultText } : {}),
                ...(durationMs !== undefined ? { durationMs } : {}),
              },
              tracked?.startedAt,
            );
          }
          return;
        }

        if (type === 'control_cancel_request') {
          const cancelledId =
            typeof payload.request_id === 'string' && payload.request_id.trim()
              ? clampCallId(payload.request_id, '')
              : '';
          if (cancelledId) {
            const settle = pendingApprovalResolvers.get(cancelledId);
            if (settle) {
              pendingApprovalResolvers.delete(cancelledId);
              settle({ outcome: 'cancelled' }, true);
            }
          }
          return;
        }

        if (type === 'control_request') {
          settleHandshakeOk();
          const requestId =
            typeof payload.request_id === 'string' && payload.request_id.trim()
              ? clampCallId(payload.request_id, `ctrl_${randomUUID().slice(0, 8)}`)
              : `ctrl_${randomUUID().slice(0, 8)}`;
          const req = asRecord(payload.request);
          if (req?.subtype === 'can_use_tool') {
            const toolUseId =
              typeof req.tool_use_id === 'string' && req.tool_use_id.trim()
                ? clampCallId(req.tool_use_id, requestId)
                : requestId;

            if (!activeTurn) {
              try {
                channel.send({
                  type: 'control_response',
                  response: {
                    subtype: 'success',
                    request_id: requestId,
                    response: {
                      behavior: 'deny',
                      message: '当前无活跃执行轮次，已拒绝非预期工具调用',
                      interrupt: true,
                      toolUseID: toolUseId,
                    },
                  },
                });
              } catch {
                /* ignore */
              }
              return;
            }

            const toolName = typeof req.tool_name === 'string' ? req.tool_name : 'tool';
            const toolInput = asRecord(req.input) ?? {};

            // 先确保消息流中存在对应工具卡（对齐 noteToolCall 不变量）
            const existing = toolsByCallId.get(toolUseId)?.view;
            const toolCard = buildClaudeViewTool(toolUseId, toolName, toolInput, existing);
            emitToolUpsert(toolCard, toolsByCallId.get(toolUseId)?.startedAt);

            const targetMeta = extractClaudeToolTarget(toolInput);
            const warning =
              typeof req.decision_reason === 'string' && req.decision_reason.trim()
                ? sanitizeDisplayText(
                    redactCommonSecrets(sanitizeUntrustedOutput(req.decision_reason)),
                    200,
                  )
                : undefined;

            activeTurn.pendingApprovals += 1;
            activeTurn.bumpActivity();

            let responded = false;
            const finishApproval = (
              decision: ExternalApprovalDecision,
              suppressReply = false,
            ): void => {
              if (responded) return;
              responded = true;
              pendingApprovalResolvers.delete(requestId);
              if (activeTurn) {
                activeTurn.pendingApprovals = Math.max(0, activeTurn.pendingApprovals - 1);
                activeTurn.bumpActivity();
              }
              if (suppressReply) return;
              const allowed = decision.outcome === 'selected' && decision.optionId === 'allow_once';
              try {
                if (allowed) {
                  channel.send({
                    type: 'control_response',
                    response: {
                      subtype: 'success',
                      request_id: requestId,
                      response: {
                        behavior: 'allow',
                        updatedInput: toolInput,
                        toolUseID: toolUseId,
                      },
                    },
                  });
                } else {
                  channel.send({
                    type: 'control_response',
                    response: {
                      subtype: 'success',
                      request_id: requestId,
                      response: {
                        behavior: 'deny',
                        message:
                          decision.outcome === 'cancelled'
                            ? '审批超时或本轮已取消'
                            : '用户拒绝了本次工具调用',
                        interrupt: decision.outcome === 'cancelled',
                        toolUseID: toolUseId,
                      },
                    },
                  });
                }
              } catch {
                /* ignore write error if process already closed */
              }
            };
            pendingApprovalResolvers.set(requestId, finishApproval);
            input.onEvent({
              type: 'approval_requested',
              requestId,
              toolCallId: toolUseId,
              toolTitle:
                typeof req.title === 'string' && req.title.trim()
                  ? (sanitizeDisplayText(req.title, 80) ?? toolCard.displayName)
                  : toolCard.displayName,
              ...(targetMeta.target ? { target: targetMeta.target } : {}),
              ...(warning ? { warning } : {}),
              options: [
                { optionId: 'allow_once', label: '允许本次', kind: 'allow_once' },
                { optionId: 'reject_once', label: '拒绝本次', kind: 'reject_once' },
              ],
              respond: (decision: ExternalApprovalDecision) => finishApproval(decision, false),
            });
            return;
          }

          // 未支持的其它 control_request 子类型立即回复标准错误，防子进程死等
          try {
            channel.send({
              type: 'control_response',
              response: {
                subtype: 'error',
                request_id: requestId,
                error: `Unsupported control_request subtype: ${String(req?.subtype ?? 'unknown')}`,
              },
            });
          } catch {
            /* ignore */
          }
          return;
        }

        if (type === 'result') {
          settleHandshakeOk();
          const sid =
            typeof payload.session_id === 'string' && isValidNativeSessionId(payload.session_id)
              ? payload.session_id.trim()
              : undefined;
          if (sid && sid !== currentSessionId) {
            currentSessionId = sid;
            input.onEvent({
              type: 'config_updated',
              nativeSessionId: sid,
              resumable: true,
            });
          }

          const turn = activeTurn;
          if (!turn) return;
          activeTurn = undefined;
          turn.cleanup();
          settleAllApprovalsCancelled(true);

          const usage = parseClaudeUsage(payload.usage);
          const subtype = typeof payload.subtype === 'string' ? payload.subtype : '';
          const isError = payload.is_error === true || subtype.startsWith('error');
          const resultText = typeof payload.result === 'string' ? payload.result : '';

          if (!isError && !turn.emittedAnyText && resultText.trim()) {
            input.onEvent({ type: 'text_delta', text: resultText });
          }

          if (turn.cancelled || subtype === 'error_interrupted') {
            turn.resolve({
              stopReason: 'cancelled',
              ...(usage ? { usage } : {}),
            });
            return;
          }

          if (isError) {
            const errList = Array.isArray(payload.errors)
              ? payload.errors.filter((e): e is string => typeof e === 'string').join('; ')
              : '';
            const rawDetail = resultText || errList || subtype || 'Claude Code 执行失败';
            const safeDetail = redactCommonSecrets(sanitizeUntrustedOutput(rawDetail));
            const authErr = isClaudeAuthErrorText(safeDetail);
            turn.reject(
              new ExternalHarnessError(
                authErr ? 'EXTERNAL_AUTH_REQUIRED' : 'EXTERNAL_PROTOCOL_ERROR',
                safeDetail,
                authErr ? { loginHint: CLAUDE_LOGIN_HINT } : undefined,
              ),
            );
            return;
          }

          turn.resolve({
            stopReason: 'completed',
            ...(usage ? { usage } : {}),
          });
        }
      },
      onNonJsonLine: (line) => {
        input.onEvent({ type: 'diagnostic', level: 'info', text: line });
      },
      onFatalError: (err) => {
        settleHandshakeErr(err);
        settleAllApprovalsCancelled(true);
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

    void proc.waitForClose().then(async (exit) => {
      const closeErr = new ExternalHarnessError(
        'EXTERNAL_PROTOCOL_ERROR',
        `Claude Code 进程已退出（code=${exit.code ?? 'null'}）`,
      );
      await channel.drainAndClose(closeErr);
      settleHandshakeErr(closeErr);
      settleAllApprovalsCancelled(true);
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
    try {
      await new Promise<void>((resolve, reject) => {
        resolveHandshake = resolve;
        rejectHandshake = reject;
        const timer = setTimeout(() => {
          reject(
            new ExternalHarnessError(
              'EXTERNAL_TIMEOUT',
              `等待 Claude Code stream-json 握手超时（${handshakeTimeoutMs}ms）`,
            ),
          );
        }, handshakeTimeoutMs);
        timer.unref?.();

        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new ExternalHarnessError('EXTERNAL_ABORTED', 'Claude Code 启动已取消'));
        };
        input.signal?.addEventListener('abort', onAbort, { once: true });

        const origResolve = resolve;
        const origReject = reject;
        resolveHandshake = () => {
          clearTimeout(timer);
          input.signal?.removeEventListener('abort', onAbort);
          origResolve();
        };
        rejectHandshake = (err) => {
          clearTimeout(timer);
          input.signal?.removeEventListener('abort', onAbort);
          origReject(err);
        };

        channel.send({
          type: 'control_request',
          request_id: initRequestId,
          request: {
            subtype: 'initialize',
          },
        });
      });
    } catch (err) {
      closingByClient = true;
      channel.close();
      await proc.close();
      throw err;
    }

    const turnWatchdogMs = this.options.turnWatchdogMs ?? DEFAULT_TURN_WATCHDOG_MS;

    const handle: ExternalDriverSessionHandle = {
      get pid() {
        return proc.pid;
      },
      async prompt(text: string, signal?: AbortSignal): Promise<ExternalTurnResult> {
        if (activeTurn) {
          throw new ExternalHarnessError(
            'EXTERNAL_SESSION_BUSY',
            '当前 Claude Code 会话已有在途轮次，禁止并发发送',
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
                `Claude Code 超过 ${Math.round(turnWatchdogMs / 1000)} 秒无响应进展，已中止当前轮次`,
                { processTerminated: true },
              );
              closingByClient = true;
              void proc.close().finally(() => {
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

          activeTurn = {
            sawStreamText: false,
            sawStreamThinking: false,
            emittedAnyText: false,
            cancelled: false,
            pendingApprovals: 0,
            bumpActivity: () => {
              lastActivityAt = Date.now();
            },
            resolve,
            reject,
            cleanup,
          };

          try {
            channel.send({
              type: 'user',
              session_id: currentSessionId ?? '',
              message: {
                role: 'user',
                content: [{ type: 'text', text }],
              },
              parent_tool_use_id: null,
            });
          } catch (err) {
            activeTurn = undefined;
            cleanup();
            reject(err);
          }
        });
      },
      async cancel(): Promise<void> {
        if (!activeTurn || activeTurn.cancelled) return;
        activeTurn.cancelled = true;
        settleAllApprovalsCancelled(false);
        try {
          channel.send({
            type: 'control_request',
            request_id: `interrupt_${randomUUID().slice(0, 8)}`,
            request: {
              subtype: 'interrupt',
            },
          });
        } catch {
          /* ignore */
        }

        const snapshotTurn = activeTurn;
        const graceTimer = setTimeout(() => {
          if (activeTurn === snapshotTurn) {
            activeTurn = undefined;
            snapshotTurn.cleanup();
            settleAllApprovalsCancelled(true);
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
        settleAllApprovalsCancelled(true);
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
      ...(currentSessionId ? { nativeSessionId: currentSessionId } : {}),
      resumable: true,
      ...(currentModelLabel ? { modelLabel: currentModelLabel } : {}),
      ...(currentModeLabel ? { modeLabel: currentModeLabel } : {}),
    };
  }
}
