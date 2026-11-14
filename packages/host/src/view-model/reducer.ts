import type {
  PresentationEvent,
  PresentationState,
  ViewBlock,
  ViewIdentity,
  ViewMessage,
} from './types.js';

/** 从公开投影建立新视图；历史加载不会恢复旧运行授权或用户折叠偏好。 */
export function createPresentation(
  identity: ViewIdentity,
  messages: readonly ViewMessage[] = [],
): PresentationState {
  return {
    identity: { ...identity },
    sequence: 0,
    messages: messages.map(copyMessage),
    pendingMessages: [],
    order: messages.map((message) => message.id),
    expanded: {},
    notices: [],
  };
}

function copyMessage(message: ViewMessage): ViewMessage {
  return {
    ...message,
    blocks: message.blocks.map((block) => ({
      ...block,
      ...(block.tool ? { tool: { ...block.tool } } : {}),
    })),
  };
}

const messageSelectionCache = new WeakMap<PresentationState, readonly ViewMessage[]>();

/** 在渲染边界按文档顺序合并原历史与临时片段；增量转换本身不遍历已提交历史，同快照复用缓存。 */
export function selectMessages(state: PresentationState): readonly ViewMessage[] {
  if (!state.pendingMessages.length) return state.messages;
  const cached = messageSelectionCache.get(state);
  if (cached) return cached;
  const indexed = new Map(
    [...state.messages, ...state.pendingMessages].map((message) => [message.id, message]),
  );
  const result = state.order.flatMap((id) => {
    const message = indexed.get(id);
    return message ? [message] : [];
  });
  messageSelectionCache.set(state, result);
  return result;
}

/** 用户显式选择优先；未选择的思考只在生成期间展开，工具详情缺省收起。 */
export function isBlockExpanded(state: PresentationState, blockId: string): boolean {
  if (Object.hasOwn(state.expanded, blockId)) return state.expanded[blockId];
  for (const message of selectMessages(state)) {
    const block = message.blocks.find((item) => item.id === blockId);
    if (block)
      return block.kind === 'text' || (block.kind === 'thinking' && block.state === 'streaming');
  }
  return false;
}

/** 操作结果时本地收尾未闭合片段，不制造已持久化消息或未出现的正文。 */
function interruptPending(messages: readonly ViewMessage[]): readonly ViewMessage[] {
  return messages.map((message) => ({
    ...message,
    state: 'interrupted',
    blocks: message.blocks.map((block) =>
      block.state === 'streaming'
        ? {
            ...block,
            state: 'interrupted',
            revision: block.revision + 1,
            ...(block.tool?.status === 'running'
              ? { tool: { ...block.tool, status: 'interrupted' as const } }
              : {}),
          }
        : block,
    ),
  }));
}

/**
 * 按原顺序应用公开语义事件；旧视图、重复序号或旧操作均原样拒绝。
 * 只更新受影响的临时消息，历史在提交边界才更新；不触发 I/O、计时器或框架通知。
 */
export function reducePresentation(
  state: PresentationState,
  event: PresentationEvent,
): PresentationState {
  const sameView =
    event.conversationId === state.identity.conversationId &&
    event.branchId === state.identity.branchId &&
    event.viewEpoch === state.identity.viewEpoch;
  if (!sameView || event.sequence <= state.sequence) return state;
  const change = event.change;
  if (change.type === 'operation_started') {
    if (!event.operationId || (state.operation && state.operation.phase !== 'idle')) return state;
    return {
      ...state,
      sequence: event.sequence,
      operation: { id: event.operationId, phase: 'running' },
    };
  }
  const viewOnly = change.type === 'set_expanded' || change.type === 'diagnostic';
  if (viewOnly && event.operationId && state.operation && event.operationId !== state.operation.id)
    return state;
  if (!viewOnly && (!state.operation || event.operationId !== state.operation.id)) return state;
  if (!viewOnly && state.operation?.phase === 'idle') return state;
  const next = { ...state, sequence: event.sequence };
  switch (change.type) {
    case 'cancellation_requested':
      return state.operation?.phase === 'running'
        ? { ...next, operation: { ...state.operation, phase: 'cancelling' } }
        : next;
    case 'operation_result':
      return {
        ...next,
        operation: { id: state.operation!.id, phase: 'settling', result: change.result },
        pendingMessages: interruptPending(state.pendingMessages),
      };
    case 'operation_settled':
      return {
        ...next,
        operation: {
          id: state.operation!.id,
          phase: 'idle',
          result: change.result ?? state.operation?.result,
        },
        pendingMessages: interruptPending(state.pendingMessages),
      };
    case 'append': {
      if (state.operation?.phase !== 'running' && state.operation?.phase !== 'cancelling')
        return state;
      const existing = state.pendingMessages.find((message) => message.id === change.messageId);
      const blocks = [...(existing?.blocks ?? [])];
      const index = blocks.findIndex((block) => block.id === change.blockId);
      if (index >= 0) {
        const block = blocks[index];
        if (block.state !== 'streaming') return state;
        blocks[index] = { ...block, text: block.text + change.text, revision: block.revision + 1 };
      } else {
        blocks.push({
          id: change.blockId,
          kind: change.kind,
          text: change.text,
          state: 'streaming',
          revision: 1,
        });
      }
      const message: ViewMessage = {
        id: change.messageId,
        role: 'assistant',
        state: 'streaming',
        persisted: false,
        blocks,
      };
      return {
        ...next,
        pendingMessages: existing
          ? state.pendingMessages.map((item) => (item.id === message.id ? message : item))
          : [...state.pendingMessages, message],
        order: existing ? state.order : [...state.order, message.id],
      };
    }
    case 'tool_changed': {
      const existing = state.pendingMessages.find((message) => message.id === change.messageId);
      const blocks = [...(existing?.blocks ?? [])];
      const index = blocks.findIndex((block) => block.id === change.block.id);
      const block = {
        ...change.block,
        revision: index < 0 ? 1 : blocks[index].revision + 1,
        ...(change.block.tool ? { tool: { ...change.block.tool } } : {}),
      };
      if (index < 0) blocks.push(block);
      else blocks[index] = block;
      const message: ViewMessage = {
        id: change.messageId,
        role: 'assistant',
        state: 'streaming',
        persisted: false,
        blocks,
      };
      return {
        ...next,
        pendingMessages: existing
          ? state.pendingMessages.map((item) => (item.id === message.id ? message : item))
          : [...state.pendingMessages, message],
        order: existing ? state.order : [...state.order, message.id],
      };
    }
    case 'block_stopped':
      return {
        ...next,
        pendingMessages: state.pendingMessages.map((message) => ({
          ...message,
          blocks: message.blocks.map(
            (block): ViewBlock =>
              block.id === change.blockId
                ? { ...block, state: 'completed', revision: block.revision + 1 }
                : block,
          ),
        })),
      };
    case 'message_committed': {
      const previous =
        state.pendingMessages.find((item) => item.id === change.provisionalId) ??
        state.messages.find((item) => item.id === change.message.id);
      const message: ViewMessage = {
        ...change.message,
        blocks: change.message.blocks.map((block) => {
          const id =
            change.aliases && Object.hasOwn(change.aliases, block.id)
              ? change.aliases[block.id]
              : block.id;
          const old = previous?.blocks.find((item) => item.id === id);
          return {
            ...block,
            id,
            revision: old ? old.revision + 1 : block.revision,
            ...(block.tool ? { tool: { ...block.tool } } : {}),
          };
        }),
      };
      const index = state.messages.findIndex((item) => item.id === message.id);
      const messages = [...state.messages];
      if (index < 0) messages.push(message);
      else messages[index] = message;
      const order = [
        ...new Set(
          state.order
            .map((id) => (id === change.provisionalId ? message.id : id))
            .concat(message.id),
        ),
      ];
      const indexed = new Map(messages.map((item) => [item.id, item]));
      return {
        ...next,
        messages: order.flatMap((id) => {
          const item = indexed.get(id);
          return item ? [item] : [];
        }),
        order,
        pendingMessages: state.pendingMessages.filter(
          (item) => item.id !== change.provisionalId && item.id !== message.id,
        ),
      };
    }
    case 'set_expanded':
      return { ...next, expanded: { ...state.expanded, [change.blockId]: change.expanded } };
    case 'diagnostic': {
      const notice = { id: change.id, level: change.level, text: change.text };
      return {
        ...next,
        notices: state.notices.filter((item) => item.id !== notice.id).concat(notice),
      };
    }
  }
}
