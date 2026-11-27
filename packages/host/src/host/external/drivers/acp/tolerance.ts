import type {
  ViewExternalConfigCategory,
  ViewExternalConfigChoice,
  ViewExternalConfigOption,
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
  /** 对端是否声明支持 `session/delete`（供非破坏性探测结束后立即回收临时会话记录）。 */
  readonly canDeleteSession?: boolean;
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
  const canDeleteSession = Boolean(sessionCaps?.delete && typeof sessionCaps.delete === 'object');

  return {
    ...(agentName ? { agentName } : {}),
    ...(version ? { version } : {}),
    authMethods,
    ...(loadMethod ? { loadMethod } : {}),
    ...(canDeleteSession ? { canDeleteSession: true } : {}),
  };
}

/** 旧式 ACP（仅提供 `models.availableModels`）的合成配置 ID，驱动据此改调 `session/set_model`。 */
export const LEGACY_ACP_MODEL_CONFIG_ID = '__legacy_model__';
/** 旧式 ACP（仅提供 `modes.availableModes`）的合成配置 ID，驱动据此改调 `session/set_mode`。 */
export const LEGACY_ACP_MODE_CONFIG_ID = '__legacy_mode__';
/** 单个配置项最多保留的候选数量，防止异常巨大的目录击穿单帧快照预算。 */
const MAX_CONFIG_CHOICES = 200;

/** 在平铺或分组（`SessionConfigSelectGroup`）的 ACP `options` 数组中查找指定 `value` 对应的候选项。 */
function findConfigOptionChoice(
  options: unknown,
  value: string,
): { readonly value: string; readonly name: string } | undefined {
  if (!Array.isArray(options)) return undefined;
  for (const entry of options) {
    const rec = asRecord(entry);
    if (!rec) continue;
    if (rec.value === value) {
      return {
        value,
        name: typeof rec.name === 'string' && rec.name.trim() ? rec.name : value,
      };
    }
    if (Array.isArray(rec.options)) {
      const nested = findConfigOptionChoice(rec.options, value);
      if (nested) return nested;
    }
  }
  return undefined;
}

function flattenConfigChoices(
  options: unknown,
  groupName?: string,
  out: ViewExternalConfigChoice[] = [],
  seen = new Set<string>(),
): ViewExternalConfigChoice[] {
  if (!Array.isArray(options)) return out;
  for (const entry of options) {
    if (out.length >= MAX_CONFIG_CHOICES) break;
    const rec = asRecord(entry);
    if (!rec) continue;
    if (Array.isArray(rec.options)) {
      const nextGroup =
        typeof rec.name === 'string' && rec.name.trim()
          ? sanitizeDisplayText(rec.name, 48)
          : typeof rec.group === 'string' && rec.group.trim()
            ? sanitizeDisplayText(rec.group, 48)
            : groupName;
      flattenConfigChoices(rec.options, nextGroup, out, seen);
      continue;
    }
    if (typeof rec.value !== 'string' || !rec.value.trim()) continue;
    const value = rec.value.trim().slice(0, 256);
    if (seen.has(value)) continue;
    seen.add(value);
    const rawName = typeof rec.name === 'string' && rec.name.trim() ? rec.name : value;
    const name = sanitizeDisplayText(redactCommonSecrets(rawName), 80) ?? value;
    const description =
      typeof rec.description === 'string' && rec.description.trim()
        ? sanitizeDisplayText(redactCommonSecrets(rec.description), 160)
        : undefined;
    out.push({
      value,
      name,
      ...(description ? { description } : {}),
      ...(groupName ? { group: groupName } : {}),
    });
  }
  return out;
}

function resolveOptionCategory(
  id: string,
  category: string,
): ViewExternalConfigCategory | undefined {
  const lowerCat = category.toLowerCase();
  const lowerId = id.toLowerCase();
  if (lowerCat === 'model' || lowerId === 'model') return 'model';
  if (lowerCat === 'mode' || lowerId === 'mode') return 'mode';
  if (lowerCat === 'thought_level' || lowerId === 'thought_level' || lowerId === 'effort') {
    return 'thought_level';
  }
  return undefined;
}

function defaultCategoryName(category: ViewExternalConfigCategory): string {
  if (category === 'model') return '模型';
  if (category === 'mode') return '模式';
  return '推理档位';
}

/**
 * 将 ACP `session/new`、`session/load` 或 `session/set_config_option` 返回的可选配置项归一化为只读展示目录。
 *
 * 兼容策略：优先读取标准 `configOptions[]`（支持平铺与分组选项），缺失时自动回退旧式
 * `models.availableModels` 与 `modes.availableModes`；每个类别至多保留首个有效配置项且候选封顶 200 条。
 */
export function normalizeAcpConfigOptions(raw: unknown): ViewExternalConfigOption[] {
  const obj = asRecord(raw);
  if (!obj) return [];

  const result: ViewExternalConfigOption[] = [];
  const seenCategories = new Set<ViewExternalConfigCategory>();

  if (Array.isArray(obj.configOptions)) {
    for (const rawOpt of obj.configOptions) {
      const opt = asRecord(rawOpt);
      if (!opt || typeof opt.id !== 'string' || !opt.id.trim()) continue;
      const optId = opt.id.trim().slice(0, 128);
      const category = resolveOptionCategory(
        optId,
        typeof opt.category === 'string' ? opt.category : '',
      );
      if (!category || seenCategories.has(category)) continue;
      const choices = flattenConfigChoices(opt.options);
      if (choices.length === 0) continue;
      const currentValue =
        typeof opt.currentValue === 'string' && opt.currentValue.trim()
          ? opt.currentValue.trim().slice(0, 256)
          : undefined;
      const name =
        typeof opt.name === 'string' && opt.name.trim()
          ? (sanitizeDisplayText(opt.name, 48) ?? defaultCategoryName(category))
          : defaultCategoryName(category);
      seenCategories.add(category);
      result.push({
        id: optId,
        name,
        category,
        ...(currentValue ? { currentValue } : {}),
        options: choices,
      });
    }
  }

  if (!seenCategories.has('model')) {
    const models = asRecord(obj.models);
    if (Array.isArray(models?.availableModels)) {
      const choices: ViewExternalConfigChoice[] = [];
      const seenValues = new Set<string>();
      for (const entry of models.availableModels) {
        if (choices.length >= MAX_CONFIG_CHOICES) break;
        const item = asRecord(entry);
        const value = typeof item?.modelId === 'string' ? item.modelId.trim().slice(0, 256) : '';
        if (!value || seenValues.has(value)) continue;
        seenValues.add(value);
        const rawName = typeof item?.name === 'string' && item.name.trim() ? item.name : value;
        const name = sanitizeDisplayText(redactCommonSecrets(rawName), 80) ?? value;
        const description =
          typeof item?.description === 'string' && item.description.trim()
            ? sanitizeDisplayText(redactCommonSecrets(item.description), 160)
            : undefined;
        choices.push({ value, name, ...(description ? { description } : {}) });
      }
      if (choices.length > 0) {
        const currentValue =
          typeof models.currentModelId === 'string' && models.currentModelId.trim()
            ? models.currentModelId.trim().slice(0, 256)
            : undefined;
        seenCategories.add('model');
        result.push({
          id: LEGACY_ACP_MODEL_CONFIG_ID,
          name: '模型',
          category: 'model',
          ...(currentValue ? { currentValue } : {}),
          options: choices,
        });
      }
    }
  }

  if (!seenCategories.has('mode')) {
    const modes = asRecord(obj.modes);
    if (Array.isArray(modes?.availableModes)) {
      const choices: ViewExternalConfigChoice[] = [];
      const seenValues = new Set<string>();
      for (const entry of modes.availableModes) {
        if (choices.length >= MAX_CONFIG_CHOICES) break;
        const item = asRecord(entry);
        const value = typeof item?.id === 'string' ? item.id.trim().slice(0, 256) : '';
        if (!value || seenValues.has(value)) continue;
        seenValues.add(value);
        const rawName = typeof item?.name === 'string' && item.name.trim() ? item.name : value;
        const name = sanitizeDisplayText(redactCommonSecrets(rawName), 80) ?? value;
        const description =
          typeof item?.description === 'string' && item.description.trim()
            ? sanitizeDisplayText(redactCommonSecrets(item.description), 160)
            : undefined;
        choices.push({ value, name, ...(description ? { description } : {}) });
      }
      if (choices.length > 0) {
        const currentValue =
          typeof modes.currentModeId === 'string' && modes.currentModeId.trim()
            ? modes.currentModeId.trim().slice(0, 256)
            : undefined;
        seenCategories.add('mode');
        result.push({
          id: LEGACY_ACP_MODE_CONFIG_ID,
          name: '模式',
          category: 'mode',
          ...(currentValue ? { currentValue } : {}),
          options: choices,
        });
      }
    }
  }

  return result;
}

/** 根据增量配置通知刷新已有配置目录的 `currentValue`；若通知自带完整 `configOptions` 则整体替换。 */
export function patchAcpConfigOptions(
  existing: readonly ViewExternalConfigOption[],
  update: Record<string, unknown>,
): ViewExternalConfigOption[] {
  if (Array.isArray(update.configOptions)) {
    const fresh = normalizeAcpConfigOptions(update);
    if (fresh.length > 0) return fresh;
  }
  if (existing.length === 0) return [];

  const patches = new Map<ViewExternalConfigCategory, string>();
  const singleId =
    typeof update.configId === 'string'
      ? update.configId
      : typeof update.id === 'string'
        ? update.id
        : '';
  const singleCategory = resolveOptionCategory(
    singleId,
    typeof update.category === 'string' ? update.category : '',
  );
  const singleValue =
    typeof update.currentValue === 'string'
      ? update.currentValue.trim()
      : typeof update.value === 'string'
        ? update.value.trim()
        : '';
  if (singleCategory && singleValue) {
    patches.set(singleCategory, singleValue);
  }
  const modeVal =
    typeof update.currentModeId === 'string'
      ? update.currentModeId.trim()
      : typeof update.modeId === 'string'
        ? update.modeId.trim()
        : '';
  if (modeVal && !patches.has('mode')) patches.set('mode', modeVal);
  const modelVal =
    typeof update.currentModelId === 'string'
      ? update.currentModelId.trim()
      : typeof update.modelId === 'string'
        ? update.modelId.trim()
        : '';
  if (modelVal && !patches.has('model')) patches.set('model', modelVal);

  if (patches.size === 0) return [...existing];
  return existing.map((opt) => {
    const nextVal = patches.get(opt.category);
    return nextVal ? { ...opt, currentValue: nextVal } : opt;
  });
}

/** 从归一化后的配置项列表中提取模型、模式与推理档位的展示名摘要。 */
export function summarizeAcpConfigOptions(options: readonly ViewExternalConfigOption[]): {
  readonly modelLabel?: string;
  readonly modeLabel?: string;
  readonly thoughtLevelLabel?: string;
} {
  let modelLabel: string | undefined;
  let modeLabel: string | undefined;
  let thoughtLevelLabel: string | undefined;
  for (const opt of options) {
    if (!opt.currentValue) continue;
    const hit = opt.options.find((c) => c.value === opt.currentValue);
    const label = hit?.name ?? opt.currentValue;
    if (opt.category === 'model' && !modelLabel) {
      modelLabel = sanitizeDisplayText(label, 64);
    } else if (opt.category === 'mode' && !modeLabel) {
      modeLabel = sanitizeDisplayText(label, 48);
    } else if (opt.category === 'thought_level' && !thoughtLevelLabel) {
      thoughtLevelLabel = sanitizeDisplayText(label, 32);
    }
  }
  return {
    ...(modelLabel ? { modelLabel } : {}),
    ...(modeLabel ? { modeLabel } : {}),
    ...(thoughtLevelLabel ? { thoughtLevelLabel } : {}),
  };
}

/** 已解析的单个 ACP `configOptions` 条目，供驱动校验候选值并发起 `session/set_config_option`。 */
export interface AcpConfigOptionHandle {
  readonly id: string;
  readonly currentValue?: string;
  readonly hasOption: (value: string) => boolean;
}

/**
 * 从 ACP `session/new`、`session/load` 或 `session/set_config_option` 载荷中按语义类别查找配置项。
 *
 * 兼容规则：`category` 精确命中优先，次选按 `id` 兜底（`thought_level` 同时兼容 `id === 'effort'`）；
 * 候选值核验同时支持平铺项与分组项（`options[].options`），避免把不支持的模型 ID 盲发给对端。
 */
export function findAcpConfigOption(
  raw: unknown,
  target: 'model' | 'mode' | 'thought_level',
): AcpConfigOptionHandle | undefined {
  const obj = asRecord(raw);
  if (!obj || !Array.isArray(obj.configOptions)) return undefined;

  const matchesCategory = (opt: Record<string, unknown>): boolean => {
    const category = typeof opt.category === 'string' ? opt.category.toLowerCase() : '';
    return category === target;
  };
  const matchesId = (opt: Record<string, unknown>): boolean => {
    const id = typeof opt.id === 'string' ? opt.id.toLowerCase() : '';
    if (target === 'thought_level') return id === 'thought_level' || id === 'effort';
    return id === target;
  };

  let fallback: Record<string, unknown> | undefined;
  for (const rawOpt of obj.configOptions) {
    const opt = asRecord(rawOpt);
    if (!opt || typeof opt.id !== 'string' || !opt.id.trim()) continue;
    if (matchesCategory(opt)) {
      return {
        id: opt.id,
        ...(typeof opt.currentValue === 'string' ? { currentValue: opt.currentValue } : {}),
        hasOption: (value) => Boolean(findConfigOptionChoice(opt.options, value)),
      };
    }
    if (!fallback && matchesId(opt)) {
      fallback = opt;
    }
  }
  if (!fallback || typeof fallback.id !== 'string') return undefined;
  return {
    id: fallback.id,
    ...(typeof fallback.currentValue === 'string' ? { currentValue: fallback.currentValue } : {}),
    hasOption: (value) => Boolean(findConfigOptionChoice(fallback.options, value)),
  };
}

/**
 * 从 `session/new`、`session/load`、`session/set_config_option` 或配置更新通知中提取只读模型与模式展示名。
 *
 * 宽容策略（对齐 Cindy）：单个损坏配置项独立跳过，同时兼容新式 `configOptions[]`（含分组选项）、
 * 单项 `configId` 更新通知，以及旧式 `models` / `modes`（含 `availableModels` / `availableModes` 显示名反查）。
 */
export function normalizeAcpConfigSummary(raw: unknown): {
  readonly modelLabel?: string;
  readonly modeLabel?: string;
  readonly thoughtLevelLabel?: string;
} {
  const obj = asRecord(raw) ?? {};
  let modelLabel: string | undefined;
  let modeLabel: string | undefined;
  let thoughtLevelLabel: string | undefined;

  if (Array.isArray(obj.configOptions)) {
    for (const rawOpt of obj.configOptions) {
      const opt = asRecord(rawOpt);
      if (!opt) continue;
      const id = typeof opt.id === 'string' ? opt.id.toLowerCase() : '';
      const category = typeof opt.category === 'string' ? opt.category.toLowerCase() : '';
      const currentValue = typeof opt.currentValue === 'string' ? opt.currentValue : undefined;
      if (!currentValue) continue;

      const resolvedName = findConfigOptionChoice(opt.options, currentValue)?.name ?? currentValue;

      if (!modelLabel && (category === 'model' || id === 'model')) {
        modelLabel = sanitizeDisplayText(resolvedName, 64);
      } else if (!modeLabel && (category === 'mode' || id === 'mode')) {
        modeLabel = sanitizeDisplayText(resolvedName, 48);
      } else if (
        !thoughtLevelLabel &&
        (category === 'thought_level' || id === 'thought_level' || id === 'effort')
      ) {
        thoughtLevelLabel = sanitizeDisplayText(resolvedName, 32);
      }
    }
  }

  // 兼容单项配置更新通知（如 `{ configId: 'model', currentValue: '...' }` 或 `{ id: 'model', value: '...' }`）
  const singleId = (
    typeof obj.configId === 'string' ? obj.configId : typeof obj.id === 'string' ? obj.id : ''
  ).toLowerCase();
  const singleCategory = typeof obj.category === 'string' ? obj.category.toLowerCase() : '';
  const singleValue =
    typeof obj.currentValue === 'string'
      ? obj.currentValue
      : typeof obj.value === 'string'
        ? obj.value
        : undefined;
  if (singleValue) {
    const resolvedSingle = findConfigOptionChoice(obj.options, singleValue)?.name ?? singleValue;
    if (!modelLabel && (singleCategory === 'model' || singleId === 'model')) {
      modelLabel = sanitizeDisplayText(resolvedSingle, 64);
    } else if (!modeLabel && (singleCategory === 'mode' || singleId === 'mode')) {
      modeLabel = sanitizeDisplayText(resolvedSingle, 48);
    } else if (
      !thoughtLevelLabel &&
      (singleCategory === 'thought_level' || singleId === 'thought_level' || singleId === 'effort')
    ) {
      thoughtLevelLabel = sanitizeDisplayText(resolvedSingle, 32);
    }
  }

  if (!modelLabel) {
    const models = asRecord(obj.models);
    const currentModelId =
      typeof models?.currentModelId === 'string'
        ? models.currentModelId
        : typeof obj.currentModelId === 'string'
          ? obj.currentModelId
          : typeof obj.modelId === 'string'
            ? obj.modelId
            : undefined;
    if (currentModelId) {
      let resolvedModelName = currentModelId;
      if (Array.isArray(models?.availableModels)) {
        for (const entry of models.availableModels) {
          const item = asRecord(entry);
          if (
            item &&
            item.modelId === currentModelId &&
            typeof item.name === 'string' &&
            item.name.trim()
          ) {
            resolvedModelName = item.name;
            break;
          }
        }
      }
      modelLabel = sanitizeDisplayText(resolvedModelName, 64);
    }
  }
  if (!modeLabel) {
    const modes = asRecord(obj.modes);
    const currentModeId =
      typeof modes?.currentModeId === 'string'
        ? modes.currentModeId
        : typeof obj.currentModeId === 'string'
          ? obj.currentModeId
          : typeof obj.modeId === 'string'
            ? obj.modeId
            : undefined;
    if (currentModeId) {
      let resolvedModeName = currentModeId;
      if (Array.isArray(modes?.availableModes)) {
        for (const entry of modes.availableModes) {
          const item = asRecord(entry);
          if (
            item &&
            item.id === currentModeId &&
            typeof item.name === 'string' &&
            item.name.trim()
          ) {
            resolvedModeName = item.name;
            break;
          }
        }
      }
      modeLabel = sanitizeDisplayText(resolvedModeName, 48);
    }
  }

  return {
    ...(modelLabel ? { modelLabel } : {}),
    ...(modeLabel ? { modeLabel } : {}),
    ...(thoughtLevelLabel ? { thoughtLevelLabel } : {}),
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
  if (raw === 'inProgress') return 'in_progress';
  if (raw === 'canceled') return 'cancelled';
  return 'pending';
}

/**
 * 归一化外部代理计划更新为宿主标准 `ViewTodoItem[]`（同时兼容 ACP `entries`/`content`、Claude `todos`/`content` 与 Codex `plan`/`step`）。
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
          : typeof entry.step === 'string'
            ? entry.step
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
  const callId = rawId.trim().slice(0, 256);

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
  fallbackCallId = 'perm-tool',
): {
  readonly tool: ViewTool;
  readonly toolTitle: string;
  readonly target?: string;
  readonly warning?: string;
  readonly options: readonly ExternalApprovalOption[];
} {
  const obj = asRecord(params) ?? {};
  const rawToolCall = asRecord(obj.toolCall) ?? obj;
  const resolvedCallId =
    rawToolCall.toolCallId ??
    rawToolCall.id ??
    rawToolCall.callId ??
    obj.toolCallId ??
    existingTool?.callId ??
    fallbackCallId;
  const synthesizedTool =
    normalizeAcpToolUpdate(
      {
        ...rawToolCall,
        toolCallId: resolvedCallId,
        status: existingTool?.status ?? 'running',
      },
      existingTool,
    ) ??
    ({
      callId: existingTool?.callId ?? fallbackCallId,
      name: 'permission',
      displayName: '权限确认',
      invocation: '请求执行外部操作',
      input: '',
      status: 'running',
    } satisfies ViewTool);

  const options: ExternalApprovalOption[] = [];
  if (Array.isArray(obj.options)) {
    for (const rawOpt of obj.options) {
      if (options.length >= 32) break;
      const item = asRecord(rawOpt);
      if (!item) continue;
      const optionId = (
        typeof item.optionId === 'string'
          ? item.optionId.trim()
          : typeof item.id === 'string'
            ? item.id.trim()
            : ''
      ).slice(0, 256);
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

  const rawToolInput = asRecord(rawToolCall.rawInput) ?? asRecord(obj.rawInput);
  const fullTargetSource =
    typeof rawToolInput?.command === 'string'
      ? rawToolInput.command
      : typeof rawToolInput?.CommandLine === 'string'
        ? rawToolInput.CommandLine
        : typeof rawToolInput?.cmd === 'string'
          ? rawToolInput.cmd
          : typeof rawToolInput?.path === 'string'
            ? rawToolInput.path
            : typeof rawToolInput?.filePath === 'string'
              ? rawToolInput.filePath
              : synthesizedTool.chip;
  const fullTarget = fullTargetSource
    ? sanitizeDisplayText(redactCommonSecrets(fullTargetSource), 2_000)
    : undefined;

  const warning =
    typeof obj.reason === 'string'
      ? sanitizeDisplayText(redactCommonSecrets(obj.reason), 240)
      : typeof obj.message === 'string'
        ? sanitizeDisplayText(redactCommonSecrets(obj.message), 240)
        : undefined;

  return {
    tool: synthesizedTool,
    toolTitle: synthesizedTool.displayName,
    ...(fullTarget ? { target: fullTarget } : {}),
    ...(warning ? { warning } : {}),
    options,
  };
}

function clampSafeTokenCount(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.trunc(value)));
}

/** 归一化 `session/prompt` 结算响应中的 Token 用量（缺失或非法时返回 `undefined`，不伪造 0）。 */
export function normalizeAcpUsage(raw: unknown): ViewUsage | undefined {
  const obj = asRecord(raw);
  const usage = asRecord(obj?.usage) ?? obj;
  if (!usage) return undefined;

  const promptTokens = clampSafeTokenCount(
    typeof usage.inputTokens === 'number'
      ? usage.inputTokens
      : typeof usage.promptTokens === 'number'
        ? usage.promptTokens
        : undefined,
  );
  const completionTokens = clampSafeTokenCount(
    typeof usage.outputTokens === 'number'
      ? usage.outputTokens
      : typeof usage.completionTokens === 'number'
        ? usage.completionTokens
        : undefined,
  );
  if (promptTokens === undefined && completionTokens === undefined) return undefined;

  const p = promptTokens ?? 0;
  const c = completionTokens ?? 0;
  const explicitTotal = clampSafeTokenCount(
    typeof usage.totalTokens === 'number' ? usage.totalTokens : undefined,
  );
  const totalTokens = explicitTotal ?? Math.min(Number.MAX_SAFE_INTEGER, p + c);

  return { promptTokens: p, completionTokens: c, totalTokens };
}
