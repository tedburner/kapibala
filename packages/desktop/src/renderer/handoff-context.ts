import type { ViewMessage } from '@kiturone/kapibala-host/view-model';

const MAX_HANDOFF_TOTAL_CHARS = 12_000;
const MAX_HANDOFF_ENTRY_CHARS = 2_400;

/**
 * 从当前历史会话提取有界、脱敏后的纯文本对话摘要，供跨代理或跨会话切换时在下一轮自动接力上下文。
 *
 * 前置约束与边界：
 * - 仅抽取用户真实输入与助手文本回复（跳过技能信封、前序接力徽章与原始工具调用详情）；
 * - 按从新到旧倒序纳入并钳制在 12,000 字符预算内，确保切换代理时最近的多轮上下文完整保留；
 * - 若当前会话尚无有效历史消息则返回 `undefined`，调用方退化为普通新建会话。
 */
export function buildSessionHandoffPayload(
  sourceTitle: string | undefined,
  messages: readonly ViewMessage[],
): { readonly fromTitle: string; readonly context: string } | undefined {
  const collectedReversed: string[] = [];
  let usedChars = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant')) continue;
    const rawText = msg.blocks
      .filter((block) => block.kind === 'text' && !block.skillName)
      .map((block) => block.text.trim())
      .filter(Boolean)
      .join('\n')
      .trim();
    if (!rawText) continue;

    const clipped =
      rawText.length > MAX_HANDOFF_ENTRY_CHARS
        ? `${rawText.slice(0, MAX_HANDOFF_ENTRY_CHARS)}…[已截断]`
        : rawText;
    const roleTag = msg.role === 'user' ? '用户' : '助手';
    const entry = `[${roleTag}]:\n${clipped}`;
    if (usedChars + entry.length > MAX_HANDOFF_TOTAL_CHARS && collectedReversed.length > 0) {
      break;
    }
    collectedReversed.push(entry);
    usedChars += entry.length + 2;
  }

  if (collectedReversed.length === 0) return undefined;
  const cleanTitle =
    sourceTitle?.trim() && sourceTitle.trim() !== '新对话' ? sourceTitle.trim() : '历史对话';
  const transcript = collectedReversed.reverse().join('\n\n');
  const context = [
    '<conversation_handoff>',
    `以下是用户在切换模型或代理前的历史对话上下文（原会话：${cleanTitle}）。请结合这段上下文直接回答用户接下来的新请求，无需重复总结前文：`,
    '',
    transcript,
    '</conversation_handoff>',
  ].join('\n');

  return {
    fromTitle: cleanTitle.slice(0, 120),
    context,
  };
}
