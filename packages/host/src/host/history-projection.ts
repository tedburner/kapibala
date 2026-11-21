import type { CanonicalMessage, ToolResultBlock } from '@kiturone/kapibala';
import type {
  ViewBlock,
  ViewMessage,
  ViewTodoItem,
  ViewTodoState,
  ViewTodoStatus,
  ViewTool,
} from '../view-model/index.js';
import type { ArtifactPolicy } from './preview-policy.js';
import { type PublicTextRedactor, redactViewMessage } from './public-projection.js';
import { sanitizeUntrustedOutput } from './ui/text-safety.js';
import {
  describeToolActivity,
  formatToolDetail,
  formatToolInvocation,
  resolveToolDisplay,
  sanitizeToolName,
} from './ui/tool-presentation.js';

interface MatchedResult {
  block: ToolResultBlock;
  messageId?: string;
}

/**
 * 「/skill <名称>」无任务直发时宿主合成的启动任务文本。
 * core 要求显式技能的 userInput 非空，宿主因此注入一句占位任务；它不是用户输入，
 * 投影时随技能信封一起折叠，避免气泡里冒出一行用户从未写过的文字。
 */
export const EXPLICIT_SKILL_KICKOFF = '开始执行该技能。';

/** canonical ID 优先；旧消息按源序号补展示身份，同正文不合并，不伪造 Core ID。 */
export function displayMessageId(message: CanonicalMessage, index: number, scope: string): string {
  return JSON.stringify([scope, 'message', message.id ?? null, message.id ? null : index]);
}

/** 块身份依附原消息与原内容序号，剥离私有块后也不重新编号。 */
export function displayBlockId(messageId: string, index: number): string {
  return JSON.stringify([messageId, 'block', index]);
}

/**
 * 只从原始 getHistory() 的公开字段重建展示；不使用压缩上下文、不重放任何工具。
 * 工具结果按历史顺序匹配最近尚未闭合的调用，合入调用卡片，兼容逆序结束与后续复用 ID。
 * 未配对结果保留为可检查卡片；历史中缺结果的调用标中断，不恢复为仍在执行。
 * `options.artifacts` 只在调用配对到成功结果时补充产物；缺省不投影任何产物。
 */
export function projectHistory(
  history: readonly CanonicalMessage[],
  scope: string,
  redact?: PublicTextRedactor,
  options?: { readonly artifacts?: ArtifactPolicy },
): ViewMessage[] {
  const waiting = new Map<string, string>();
  const results = new Map<string, MatchedResult>();
  const pairedResults = new Set<string>();
  for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
    const message = history[messageIndex];
    const id = displayMessageId(message, messageIndex, scope);
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex];
      const key = displayBlockId(id, blockIndex);
      if (block.type === 'tool_use') waiting.set(block.id, key);
      else if (block.type === 'tool_result') {
        const use = waiting.get(block.toolUseId);
        if (!use) continue;
        waiting.delete(block.toolUseId);
        results.set(use, { block, messageId: message.id });
        pairedResults.add(key);
      }
    }
  }

  const projected: ViewMessage[] = [];
  for (let messageIndex = 0; messageIndex < history.length; messageIndex++) {
    const message = history[messageIndex];
    const id = displayMessageId(message, messageIndex, scope);
    // 带技能信封的用户消息由徽章承载全部语义；首块若是宿主合成的启动任务则不进投影。
    const hasSkillEnvelope =
      message.role === 'user' &&
      message.content.some((item) => item.type === 'text' && item.skillSource !== undefined);
    const blocks: ViewBlock[] = [];
    for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
      const block = message.content[blockIndex];
      if (
        block.type === 'text' &&
        hasSkillEnvelope &&
        blockIndex === 0 &&
        block.text === EXPLICIT_SKILL_KICKOFF
      )
        continue;
      const blockId = displayBlockId(id, blockIndex);
      if (block.type === 'text' || block.type === 'thinking') {
        blocks.push({
          id: blockId,
          kind: block.type,
          state:
            message.state === 'draft' ||
            message.state === 'failed' ||
            message.state === 'interrupted'
              ? 'interrupted'
              : 'completed',
          revision: 0,
          text: sanitizeUntrustedOutput(block.type === 'text' ? block.text : block.thinking),
          // 技能信封块透传来源名：渲染层折叠为徽章，元数据与正文不进公开原文。
          ...(block.type === 'text' && block.skillSource
            ? { skillName: block.skillSource.name }
            : {}),
        });
      } else if (block.type === 'tool_use') {
        const result = results.get(blockId);
        const activity = describeToolActivity(block.name, block.input);
        const artifacts =
          result && !result.block.isError
            ? options?.artifacts?.(block.name, block.input, true)
            : undefined;
        const tool: ViewTool = {
          callId: block.id,
          name: sanitizeToolName(block.name),
          displayName: resolveToolDisplay(block.name).label,
          invocation: sanitizeUntrustedOutput(formatToolInvocation(block.name, block.input)),
          ...(activity.verb ? { verb: activity.verb } : {}),
          ...(activity.chip ? { chip: sanitizeUntrustedOutput(activity.chip) } : {}),
          ...(activity.mono ? { mono: true } : {}),
          input: sanitizeUntrustedOutput(formatToolDetail(block.input)),
          status: result ? (result.block.isError ? 'failed' : 'succeeded') : 'interrupted',
          ...(result
            ? {
                result: sanitizeUntrustedOutput(formatToolDetail(result.block.content)),
                durationMs: result.block.durationMs,
                resultMessageId: result.messageId,
              }
            : {}),
          ...(artifacts?.length ? { artifacts } : {}),
        };
        blocks.push({
          id: blockId,
          kind: 'tool',
          text: tool.invocation,
          state: result ? 'completed' : 'interrupted',
          revision: 0,
          tool,
        });
      } else if (block.type === 'tool_result' && !pairedResults.has(blockId)) {
        const tool: ViewTool = {
          callId: block.toolUseId,
          name: 'unknown',
          displayName: resolveToolDisplay('unknown').label,
          invocation: '工具结果',
          input: '',
          status: block.isError ? 'failed' : 'succeeded',
          result: sanitizeUntrustedOutput(formatToolDetail(block.content)),
          durationMs: block.durationMs,
          resultMessageId: message.id,
        };
        blocks.push({
          id: blockId,
          kind: 'tool',
          text: '工具结果',
          state: 'completed',
          revision: 0,
          tool,
        });
      }
      // provider_state、redacted_thinking、签名与协议元数据不进入白名单。
    }
    if (blocks.length)
      projected.push({
        id,
        role: message.role,
        persisted: true,
        blocks,
        state:
          message.state === 'draft' || message.state === 'failed' || message.state === 'interrupted'
            ? 'interrupted'
            : 'completed',
      });
  }
  return projected.map((message) => redactViewMessage(message, redact));
}

/** 允许的任务状态；与 Core `todo_write` 校验同口径，非法值一律丢弃整次声明。 */
const TODO_STATUSES: ReadonlySet<string> = new Set<ViewTodoStatus>([
  'pending',
  'in_progress',
  'completed',
  'cancelled',
]);

/** 只从成功调用入参解析条目；结构不合法返回 undefined，绝不猜测缺失字段。 */
function parseTodoItems(input: unknown): ViewTodoItem[] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const raw = (input as { items?: unknown }).items;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const items: ViewTodoItem[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return undefined;
    const { id, title, status } = entry as Record<string, unknown>;
    if (
      typeof id !== 'string' ||
      !id ||
      typeof title !== 'string' ||
      typeof status !== 'string' ||
      !TODO_STATUSES.has(status)
    )
      return undefined;
    items.push({ id, title, status: status as ViewTodoStatus });
  }
  return items;
}

/**
 * 从 canonical 历史重算会话任务清单：只认**最近一次成功**（配对结果非 error）的
 * `todo_write` 调用，失败、中断或无结果的调用不改变视图，避免一次坏写入把面板闪空。
 *
 * 边界与用途：
 * - 纯函数，不落盘、不新增记录类型；历史重放与实时观察必然同一口径。
 * - 标题是模型提交的不可信文本：经 `redact(sanitize(...))` 双层处理（与证据聚合同管线），
 *   宿主注入凭证闭包脱敏，缺省恒等便于纯结构测试。
 * - `items` 保持模型提交顺序，不做二次排序；`revision` 为成功调用累计数，仅用于
 *   渲染层判断是否需要重绘，不参与权限或持久化。
 * - 从未成功调用时返回 `undefined`，桌面 pill / 浮层与 CLI 据此隐藏。
 */
export function buildTodoState(
  history: readonly CanonicalMessage[],
  redact: PublicTextRedactor = (text) => text,
): ViewTodoState | undefined {
  const inputs = new Map<string, { input: unknown; timestamp?: number }>();
  let latest: ViewTodoItem[] | undefined;
  let updatedAt: number | undefined;
  let revision = 0;
  for (const message of history) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && block.name === 'todo_write') {
        inputs.set(block.id, { input: block.input, timestamp: message.timestamp });
      } else if (block.type === 'tool_result' && !block.isError) {
        const call = inputs.get(block.toolUseId);
        if (!call) continue;
        const items = parseTodoItems(call.input);
        if (!items) continue;
        // 标题来自模型 tool_use 入参，属不可信文本：先消毒再过凭证脱敏，与证据聚合同管线。
        latest = items.map((item) => ({
          ...item,
          title: redact(sanitizeUntrustedOutput(item.title)),
        }));
        updatedAt = message.timestamp ?? call.timestamp;
        revision += 1;
      }
    }
  }
  if (!latest) return undefined;
  return {
    items: latest,
    revision,
    ...(updatedAt !== undefined ? { updatedAt } : {}),
  };
}
