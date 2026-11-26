import type { ViewMessage } from '@kiturone/kapibala-host/view-model';

/** 单个作用域内最多保留的历史输入条数，与宿主历史列表预算同量级。 */
export const MAX_PROMPT_HISTORY = 100;

/** 单个输入作用域（本地会话、外部会话或 `:new`）的已发送历史与 ↑/↓ 浏览位置。 */
export interface PromptHistoryState {
  entries: string[];
  index: number;
  draft?: string;
  /** 是否已从该会话已加载的公开消息投影中回填过历史问句。 */
  seeded?: boolean;
}

/** 统一换行为 LF，避免与浏览器 `<textarea>` 内部归一化后的长度失配导致光标边界误判。 */
function normalizePromptText(text: string): string {
  return text.replace(/\r\n?/g, '\n');
}

/** 按顺序合并两段历史并去除连续重复项，超出上限时仅保留最近 `MAX_PROMPT_HISTORY` 条。 */
function mergeDeduplicated(lists: readonly (readonly string[])[]): string[] {
  const merged: string[] = [];
  for (const list of lists) {
    for (const raw of list) {
      const entry = normalizePromptText(raw);
      if (!entry.trim() || merged.at(-1) === entry) continue;
      merged.push(entry);
    }
  }
  if (merged.length > MAX_PROMPT_HISTORY) {
    merged.splice(0, merged.length - MAX_PROMPT_HISTORY);
  }
  return merged;
}

/**
 * 从会话的公开展示消息中提取真实用户问句序列，供继续历史会话时通过 ↑/↓ 召回。
 *
 * 边界与约束：
 * - 只读取已完成白名单投影与脱敏的 `ViewMessage`，绝不绕过宿主脱敏链路；
 * - 跳过后台监视（`<watch-event ...>`）与子代理完成通知（`<subagent-notification ...>`）等系统背景消息；
 * - 显式技能触发消息还原为 `/skill <名称>` 或 `/skill <名称> <任务>`，与用户输入口径一致；
 * - 连续相同问句自动去重，上限保留最近 100 条。
 */
export function extractUserPrompts(messages: readonly ViewMessage[]): string[] {
  const prompts: string[] = [];
  for (const message of messages) {
    if (message.role !== 'user') continue;
    const text = normalizePromptText(
      message.blocks
        .filter((block) => block.kind === 'text' && !block.skillName)
        .map((block) => block.text)
        .join('\n'),
    ).trim();
    if (text.startsWith('<watch-event ') || text.startsWith('<subagent-notification ')) continue;
    const skillName = message.blocks.find(
      (block) => block.kind === 'text' && block.skillName,
    )?.skillName;
    const prompt = skillName
      ? text
        ? `/skill ${skillName} ${text}`
        : `/skill ${skillName}`
      : text;
    if (!prompt || prompts.at(-1) === prompt) continue;
    prompts.push(prompt);
  }
  if (prompts.length > MAX_PROMPT_HISTORY) {
    prompts.splice(0, prompts.length - MAX_PROMPT_HISTORY);
  }
  return prompts;
}

/**
 * 用会话已加载的历史消息为作用域补种输入历史（幂等）。
 *
 * 若该作用域已完成过补种且已有条目（或历史消息为空），直接原样返回，保留会话内斜杠命令与当前浏览游标；
 * 首次打开历史会话时把已落盘用户问句置于当前进程增量之前并去重，使继续对话后立即支持 ↑/↓ 召回。
 */
export function seedPromptHistory(
  current: PromptHistoryState | undefined,
  messages: readonly ViewMessage[],
): PromptHistoryState {
  const historical = extractUserPrompts(messages);
  if (current?.seeded && (current.entries.length > 0 || historical.length === 0)) {
    return current;
  }
  const existingEntries = current?.entries ?? [];
  const entries = mergeDeduplicated([historical, existingEntries]);
  const wasBrowsing = Boolean(current && current.index < current.entries.length);
  if (wasBrowsing && current) {
    const offsetFromEnd = current.entries.length - current.index;
    const nextIndex = Math.max(0, entries.length - offsetFromEnd);
    return {
      entries,
      index: nextIndex,
      draft: current.draft,
      seeded: true,
    };
  }
  return {
    entries,
    index: entries.length,
    draft: undefined,
    seeded: true,
  };
}

/** 记录一条本次真正发出的输入；空白与连续重复不增加，重置浏览位置到最新草稿。 */
export function rememberPromptEntry(
  current: PromptHistoryState | undefined,
  text: string,
): PromptHistoryState {
  const entries = current ? [...current.entries] : [];
  const normalized = normalizePromptText(text);
  if (normalized.trim() && entries.at(-1) !== normalized) {
    entries.push(normalized);
  }
  if (entries.length > MAX_PROMPT_HISTORY) {
    entries.splice(0, entries.length - MAX_PROMPT_HISTORY);
  }
  return {
    entries,
    index: entries.length,
    draft: undefined,
    ...(current?.seeded ? { seeded: true } : {}),
  };
}

/** 当前是否处于历史浏览态（游标已上翻离开最新未提交草稿）。 */
export function isPromptHistoryBrowsing(history: PromptHistoryState | undefined): boolean {
  return Boolean(history && history.index < history.entries.length);
}

/** 退出历史浏览态并丢弃暂存草稿，防止用户手动编辑后按 ↓ 被旧草稿覆盖。 */
export function resetPromptBrowsing(history: PromptHistoryState | undefined): void {
  if (!history) return;
  history.index = history.entries.length;
  history.draft = undefined;
}

/**
 * 在历史问句中向前（`-1`）或向后（`1`）移动一步。
 * 首次上翻保存当前未提交草稿，下翻越过最新项时原样恢复草稿而不是清空。
 */
export function stepPromptHistory(
  history: PromptHistoryState | undefined,
  direction: -1 | 1,
  currentDraft: string,
): { readonly consumed: boolean; readonly value?: string } {
  if (!history?.entries.length) return { consumed: false };
  if (direction === -1) {
    if (history.index <= 0) return { consumed: false };
    if (history.index === history.entries.length) history.draft = currentDraft;
    history.index -= 1;
  } else {
    if (history.index >= history.entries.length) return { consumed: false };
    history.index += 1;
  }
  const value =
    history.index === history.entries.length
      ? (history.draft ?? '')
      : history.entries[history.index];
  return { consumed: true, value };
}
