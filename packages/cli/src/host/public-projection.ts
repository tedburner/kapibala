import type {
  PresentationChange,
  PresentationState,
  ViewBlock,
  ViewMessage,
} from '../view-model/index.js';
import { redactText } from './redaction.js';

/** 公共文本统一脱敏函数；由宿主闭包注入已知凭证，不把凭证集合放入 DTO。 */
export type PublicTextRedactor = (text: string) => string;

/** 只处理展示文字，保留消息、工具调用和块身份，避免脱敏改变 reducer 的对齐依据。 */
export function redactViewMessage(
  message: ViewMessage,
  redact: PublicTextRedactor = (text) => redactText(text, []),
): ViewMessage {
  return { ...message, blocks: message.blocks.map((block) => redactViewBlock(block, redact)) };
}

/** 工具卡片与普通块走同一文字出口；结构化私有字段由上游白名单投影排除。 */
export function redactViewBlock(block: ViewBlock, redact: PublicTextRedactor): ViewBlock {
  return {
    ...block,
    text: redact(block.text),
    tool: block.tool && {
      ...block.tool,
      name: redact(block.tool.name),
      invocation: redact(block.tool.invocation),
      input: redact(block.tool.input),
      result: block.tool.result === undefined ? undefined : redact(block.tool.result),
    },
  };
}

/** 历史提交、实时文字、工具与诊断统一处理；不改写任何控制身份或序号。 */
export function redactPresentationChange(
  change: PresentationChange,
  redact: PublicTextRedactor,
): PresentationChange {
  switch (change.type) {
    case 'append':
    case 'diagnostic':
      return { ...change, text: redact(change.text) };
    case 'tool_changed':
      return { ...change, block: redactViewBlock(change.block, redact) };
    case 'message_committed':
      return { ...change, message: redactViewMessage(change.message, redact) };
    default:
      return change;
  }
}

/** 公共快照重复使用当前脱敏集，防止新增凭证使已缓存的旧展示文字变成秘密出口。 */
export function redactPresentationState(
  state: PresentationState,
  redact: PublicTextRedactor,
): PresentationState {
  return {
    ...structuredClone(state),
    messages: state.messages.map((message) => redactViewMessage(message, redact)),
    pendingMessages: state.pendingMessages.map((message) => redactViewMessage(message, redact)),
    notices: state.notices.map((notice) => ({ ...notice, text: redact(notice.text) })),
  };
}
