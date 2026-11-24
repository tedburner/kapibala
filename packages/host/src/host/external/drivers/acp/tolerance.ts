import type {
  ViewTodoItem,
  ViewTodoStatus,
  ViewTool,
  ViewUsage,
} from '../../../../view-model/index.js';
import { redactCommonSecrets, sanitizeDisplayText } from '../../../redaction.js';
import { sanitizeUntrustedOutput } from '../../../ui/text-safety.js';
import {
  describeToolActivity,
  formatToolDetail,
  formatToolInvocation,
  resolveToolDisplay,
  sanitizeToolName,
} from '../../../ui/tool-presentation.js';
import type { ExternalApprovalOption } from '../../types.js';

/** 归一化后的 ACP `initialize` 响应事实。 */
export interface NormalizedAcpInitialize {
  readonly agentName?: string;
  readonly version?: string;
  readonly authMethods: readonly { readonly id: string; readonly name: string }[];
  /** 优先 `'session/load'`（标准 ACP v1），次选 `'session/resume'`（兼容 DSH `sessionCapabilities.resume`）。 */
  readonly loadMethod?: 'session/load' | 'session/resume';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 宽容解析 ACP `initialize` 响应。
 *
 * 容错保证：`authMethods` 中混入 `null` 或缺字段脏条目时单条跳过，不使整个握手失败。
 */
export function normalizeAcpInitializeResult(raw: unknown): NormalizedAcpInitialize {
  const obj = asRecord(raw) ?? {};
  const agentInfo = asRecord(obj.agentInfo);
  const agentName =
    typeof agentInfo?.name === 'string' ? sanitizeDisplayText(agentInfo.name, 80) : undefined;
  const version =
    typeof agentInfo?.version === 'string' ? sanitizeDisplayText(agentInfo.version, 64) : undefined;

  const authMethods: { id: string; name: string }[] = [];
  if (Array.isArray(obj.authMethods)) {
    for (const entry of obj.authMethods) {
      const item = asRecord(entry);
      if (!item || typeof item.id !== 'string' || !item.id.trim()) continue;
      authMethods.push({
        id: item.id.trim(),
        name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : item.id.trim(),
      });
    }
  }

  const caps = asRecord(obj.agentCapabilities);
  const sessionCaps = asRecord(caps?.sessionCapabilities);
  let loadMethod: 'session/load' | 'session/resume' | undefined;
  if (caps?.loadSession === true) {
    loadMethod = 'session/load';
  } else if (sessionCaps?.resume && typeof sessionCaps.resume === 'object') {
    loadMethod = 'session/resume';
  }

  return {
    ...(agentName ? { agentName } : {}),
    ...(version ? { version } : {}),
    authMethods,
    ...(loadMethod ? { loadMethod } : {}),
  };
}

/**
 * 从 `session/new`、`session/load` 或 `config_option_update` 载荷中提取只读模型与模式展示名。
 *
 * 宽容策略（对齐 Cindy）：单个损坏配置项独立跳过，同时兼容新式 `configOptions[]` 与旧式 `models` / `modes` 字段。
 */
export function normalizeAcpConfigSummary(raw: unknown): {
  readonly modelLabel?: string;
  readonly modeLabel?: string;
} {
  const obj = asRecord(raw) ?? {};
  let modelLabel: string | undefined;
  let modeLabel: string | undefined;

  if (Array.isArray(obj.configOptions)) {
    for (const rawOpt of obj.configOptions) {
      const opt = asRecord(rawOpt);
      if (!opt) continue;
      const id = typeof opt.id === 'string' ? opt.id.toLowerCase() : '';
      const category = typeof opt.category === 'string' ? opt.category.toLowerCase() : '';
      const currentValue = typeof opt.currentValue === 'string' ? opt.currentValue : undefined;
      if (!currentValue) continue;

      let resolvedName = currentValue;
      if (Array.isArray(opt.options)) {
        for (const choice of opt.options) {
          const choiceRec = asRecord(choice);
          if (choiceRec && choiceRec.value === currentValue && typeof choiceRec.name === 'string') {
            resolvedName = choiceRec.name;
            break;
          }
        }
      }

      if (!modelLabel && (category === 'model' || id === 'model')) {
        modelLabel = sanitizeDisplayText(resolvedName, 64);
      } else if (!modeLabel && (category === 'mode' || id === 'mode')) {
        modeLabel = sanitizeDisplayText(resolvedName, 48);
      }
    }
  }

  if (!modelLabel) {
    const models = asRecord(obj.models);
    if (typeof models?.currentModelId === 'string') {
      modelLabel = sanitizeDisplayText(models.currentModelId, 64);
    }
  }
  if (!modeLabel) {
    const modes = asRecord(obj.modes);
    if (typeof modes?.currentModeId === 'string') {
      modeLabel = sanitizeDisplayText(modes.currentModeId, 48);
    } else if (typeof obj.currentModeId === 'string') {
      modeLabel = sanitizeDisplayText(obj.currentModeId, 48);
    } else if (typeof obj.modeId === 'string') {
      modeLabel = sanitizeDisplayText(obj.modeId, 48);
    }
  }

  return {
    ...(modelLabel ? { modelLabel } : {}),
    ...(modeLabel ? { modeLabel } : {}),
  };
}

/**
 * 提取文本流块（`agent_message_chunk` / `agent_thought_chunk` / `user_message_chunk`）中的纯文本；
 * 非文本资源或 base64 图片载荷返回空串，绝不将二进制串混入消息文本流。
 */
export function extractAcpChunkText(update: Record<string, unknown>): string {
  if (typeof update.text === 'string') {
    return sanitizeUntrustedOutput(update.text);
  }
  const content = asRecord(update.content);
  if (!content) return '';
  if ((content.type === undefined || content.type === 'text') && typeof content.text === 'string') {
    return sanitizeUntrustedOutput(content.text);
  }
  return '';
}

function mapPlanStatus(raw: unknown): ViewTodoStatus {
  if (raw === 'in_progress' || raw === 'completed' || raw === 'cancelled' || raw === 'pending') {
    return raw;
  }
  return 'pending';
}

/**
 * 归一化 ACP `plan` 更新为宿主标准 `ViewTodoItem[]`（双读 `entries` 与 `plan` 数组字段）。
 */
export function normalizeAcpPlanUpdate(update: Record<string, unknown>): ViewTodoItem[] {
  const rawList = Array.isArray(update.entries)
    ? update.entries
    : Array.isArray(update.plan)
      ? update.plan
      : [];
  const items: ViewTodoItem[] = [];
  for (let i = 0; i < rawList.length; i++) {
    const entry = asRecord(rawList[i]);
    if (!entry) continue;
    const rawTitle =
      typeof entry.content === 'string'
        ? entry.content
        : typeof entry.title === 'string'
          ? entry.title
          : '';
    const title = sanitizeDisplayText(redactCommonSecrets(sanitizeUntrustedOutput(rawTitle)), 200);
    if (!title) continue;
    const id =
      typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `ext-todo-${i + 1}`;
    items.push({
      id,
      title,
      status: mapPlanStatus(entry.status),
    });
  }
  return items;
}

function mapAcpToolStatus(raw: unknown, fallback: ViewTool['status']): ViewTool['status'] {
  if (raw === 'pending' || raw === 'in_progress' || raw === 'running') return 'running';
  if (raw === 'completed' || raw === 'succeeded') return 'succeeded';
  if (raw === 'failed' || raw === 'error') return 'failed';
  if (raw === 'cancelled' || raw === 'canceled' || raw === 'interrupted') return 'interrupted';
  return fallback;
}

function extractToolChipAndVerb(
  kind: string | undefined,
  rawInput: Record<string, unknown> | undefined,
  locations: unknown,
): { verb?: string; chip?: string; mono?: boolean } {
  const command =
    typeof rawInput?.command === 'string'
      ? rawInput.command
      : typeof rawInput?.CommandLine === 'string'
        ? rawInput.CommandLine
        : typeof rawInput?.cmd === 'string'
          ? rawInput.cmd
          : undefined;
  if (command) {
    return { verb: '运行', chip: sanitizeDisplayText(command, 96), mono: true };
  }

  let firstPath =
    typeof rawInput?.path === 'string'
      ? rawInput.path
      : typeof rawInput?.filePath === 'string'
        ? rawInput.filePath
        : undefined;
  if (!firstPath && Array.isArray(locations) && locations.length > 0) {
    const loc = asRecord(locations[0]);
    if (typeof loc?.path === 'string') firstPath = loc.path;
  }
  if (firstPath) {
    const verb =
      kind === 'edit' || kind === 'delete' ? '编辑' : kind === 'search' ? '搜索' : '读取';
    return { verb, chip: sanitizeDisplayText(firstPath, 96), mono: true };
  }

  if (kind === 'execute') return { verb: '运行', mono: true };
  if (kind === 'edit') return { verb: '编辑', mono: true };
  if (kind === 'read') return { verb: '读取', mono: true };
  if (kind === 'search') return { verb: '搜索', mono: true };
  if (kind === 'fetch') return { verb: '请求' };
  return {};
}

function extractAcpToolOutput(update: Record<string, unknown>): string | undefined {
  const chunks: string[] = [];

  if (Array.isArray(update.content)) {
    for (const rawItem of update.content) {
      const item = asRecord(rawItem);
      if (!item) continue;
      if (item.type === 'content') {
        const nested = asRecord(item.content);
        if (typeof nested?.text === 'string' && nested.text) {
          chunks.push(nested.text);
        }
      } else if (typeof item.text === 'string' && item.text) {
        chunks.push(item.text);
      } else if (item.type === 'diff' && typeof item.path === 'string') {
        const newText = typeof item.newText === 'string' ? item.newText : '';
        chunks.push(`[diff] ${item.path}${newText ? `\n${newText}` : ''}`);
      }
    }
  }

  const rawOutput = update.rawOutput;
  if (chunks.length === 0 && rawOutput !== undefined) {
    const outObj = asRecord(rawOutput);
    if (typeof rawOutput === 'string') {
      chunks.push(rawOutput);
    } else if (typeof outObj?.combinedOutput === 'string') {
      // 兼容 Antigravity 工具输出的 combinedOutput 字段
      chunks.push(outObj.combinedOutput);
    } else if (typeof outObj?.output === 'string') {
      chunks.push(outObj.output);
    } else if (typeof outObj?.stdout === 'string' || typeof outObj?.stderr === 'string') {
      chunks.push([outObj.stdout, outObj.stderr].filter(Boolean).join('\n'));
    } else {
      chunks.push(formatToolDetail(rawOutput));
    }
  }

  if (chunks.length === 0) return undefined;
  return redactCommonSecrets(sanitizeUntrustedOutput(chunks.join('\n')));
}

/**
 * 将 ACP `tool_call` 或增量 `tool_call_update` 合并为宿主标准 `ViewTool`。
 *
 * 合并保证：当 `tool_call_update` 仅携带 `{ toolCallId, status, rawOutput }` 时，完整保留前序建卡时的名称、入参与 chip。
 */
export function normalizeAcpToolUpdate(
  update: Record<string, unknown>,
  previous?: ViewTool,
): ViewTool | undefined {
  const rawId =
    typeof update.toolCallId === 'string'
      ? update.toolCallId
      : typeof update.id === 'string'
        ? update.id
        : typeof update.callId === 'string'
          ? update.callId
          : previous?.callId;
  if (!rawId || !rawId.trim()) return undefined;
  const callId = rawId.trim();

  const rawTitle =
    typeof update.title === 'string' && update.title.trim()
      ? update.title.trim()
      : typeof update.name === 'string' && update.name.trim()
        ? update.name.trim()
        : undefined;
  const kind = typeof update.kind === 'string' ? update.kind.toLowerCase() : undefined;
  const rawInputObj = asRecord(update.rawInput);

  const name = rawTitle
    ? sanitizeToolName(rawTitle)
    : (previous?.name ?? sanitizeToolName(kind ?? 'tool'));
  const displayName = rawTitle
    ? (sanitizeDisplayText(rawTitle, 40) ?? resolveToolDisplay(name).label)
    : (previous?.displayName ?? resolveToolDisplay(name).label);

  const builtinActivity = rawInputObj ? describeToolActivity(name, rawInputObj) : {};
  const acpActivity = extractToolChipAndVerb(kind, rawInputObj, update.locations);
  const verb = builtinActivity.verb ?? acpActivity.verb ?? previous?.verb;
  const chip = builtinActivity.chip ?? acpActivity.chip ?? previous?.chip;
  const mono = builtinActivity.mono ?? acpActivity.mono ?? previous?.mono;

  const invocation = rawInputObj
    ? redactCommonSecrets(
        sanitizeUntrustedOutput(
          chip ? `${verb ?? displayName} ${chip}` : formatToolInvocation(name, rawInputObj),
        ),
      )
    : (previous?.invocation ?? (chip ? `${verb ?? displayName} ${chip}` : displayName));

  const inputText =
    update.rawInput !== undefined
      ? redactCommonSecrets(sanitizeUntrustedOutput(formatToolDetail(update.rawInput)))
      : (previous?.input ?? '');

  const status = mapAcpToolStatus(update.status, previous?.status ?? 'running');
  const nextResult = extractAcpToolOutput(update) ?? previous?.result;

  return {
    callId,
    name,
    displayName,
    invocation,
    ...(verb ? { verb } : {}),
    ...(chip ? { chip } : {}),
    ...(mono ? { mono: true } : {}),
    input: inputText,
    status,
    ...(nextResult !== undefined ? { result: nextResult } : {}),
  };
}

/**
 * 归一化 ACP `session/request_permission` 请求。
 *
 * 关键保证：
 * - 支持审批先于 `tool_call` 到达时直接从 `params.toolCall` 构造预补工具卡（`noteToolCall`）；
 * - 原样保留 `allow_session`、`allow_always` 与 `interaction_*` 等全部代理自定义选项 `kind`。
 */
export function normalizeAcpPermissionRequest(
  params: unknown,
  existingTool?: ViewTool,
): {
  readonly tool: ViewTool;
  readonly toolTitle: string;
  readonly target?: string;
  readonly warning?: string;
  readonly options: readonly ExternalApprovalOption[];
} {
  const obj = asRecord(params) ?? {};
  const rawToolCall = asRecord(obj.toolCall) ?? obj;
  const synthesizedTool =
    normalizeAcpToolUpdate(
      {
        ...rawToolCall,
        toolCallId: rawToolCall.toolCallId ?? obj.toolCallId ?? existingTool?.callId ?? 'perm-tool',
        status: existingTool?.status ?? 'running',
      },
      existingTool,
    ) ??
    ({
      callId: existingTool?.callId ?? 'perm-tool',
      name: 'permission',
      displayName: '权限确认',
      invocation: '请求执行外部操作',
      input: '',
      status: 'running',
    } satisfies ViewTool);

  const options: ExternalApprovalOption[] = [];
  if (Array.isArray(obj.options)) {
    for (const rawOpt of obj.options) {
      const item = asRecord(rawOpt);
      if (!item) continue;
      const optionId =
        typeof item.optionId === 'string'
          ? item.optionId.trim()
          : typeof item.id === 'string'
            ? item.id.trim()
            : '';
      if (!optionId) continue;
      const rawLabel =
        typeof item.name === 'string'
          ? item.name
          : typeof item.label === 'string'
            ? item.label
            : optionId;
      const label = sanitizeDisplayText(redactCommonSecrets(rawLabel), 80) ?? optionId;
      const kind = typeof item.kind === 'string' && item.kind.trim() ? item.kind.trim() : 'custom';
      options.push({ optionId, label, kind });
    }
  }

  // 若代理未提供标准 options 数组，兜底提供标准允许/拒绝两项避免界面无按钮可点。
  if (options.length === 0) {
    options.push(
      { optionId: 'allow', label: '允许本次', kind: 'allow_once' },
      { optionId: 'reject', label: '拒绝', kind: 'reject_once' },
    );
  }

  const warning =
    typeof obj.reason === 'string'
      ? sanitizeDisplayText(redactCommonSecrets(obj.reason), 240)
      : typeof obj.message === 'string'
        ? sanitizeDisplayText(redactCommonSecrets(obj.message), 240)
        : undefined;

  return {
    tool: synthesizedTool,
    toolTitle: synthesizedTool.displayName,
    ...(synthesizedTool.chip ? { target: synthesizedTool.chip } : {}),
    ...(warning ? { warning } : {}),
    options,
  };
}

/** 归一化 `session/prompt` 结算响应中的 Token 用量（缺失或非法时返回 `undefined`，不伪造 0）。 */
export function normalizeAcpUsage(raw: unknown): ViewUsage | undefined {
  const obj = asRecord(raw);
  const usage = asRecord(obj?.usage) ?? obj;
  if (!usage) return undefined;

  const promptTokens =
    typeof usage.inputTokens === 'number'
      ? usage.inputTokens
      : typeof usage.promptTokens === 'number'
        ? usage.promptTokens
        : undefined;
  const completionTokens =
    typeof usage.outputTokens === 'number'
      ? usage.outputTokens
      : typeof usage.completionTokens === 'number'
        ? usage.completionTokens
        : undefined;
  if (promptTokens === undefined && completionTokens === undefined) return undefined;

  const p = Math.max(0, Math.trunc(promptTokens ?? 0));
  const c = Math.max(0, Math.trunc(completionTokens ?? 0));
  const totalTokens =
    typeof usage.totalTokens === 'number' ? Math.max(0, Math.trunc(usage.totalTokens)) : p + c;

  return { promptTokens: p, completionTokens: c, totalTokens };
}
