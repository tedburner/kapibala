import {
  type CanonicalMessage,
  type SessionEvent,
  sanitizeModelErrorMessage,
} from '@kiturone/kapibala';
import { formatModelError } from '../ui/model-errors.js';
import { sanitizeUntrustedOutput } from '../ui/text-safety.js';
import {
  formatToolDetail,
  formatToolInvocation,
  sanitizeToolName,
} from '../ui/tool-presentation.js';
import type {
  OperationResult,
  PresentationChange,
  ViewBlock,
  ViewIdentity,
  ViewMessage,
  ViewTool,
} from '../view-model/index.js';
import { displayMessageId, projectHistory } from './history-projection.js';
import type { PresentationStore } from './presentation-store.js';

/** 展示身份只按会话/分支分组；viewEpoch 隔离事件但不改变 canonical 消息自身身份。 */
export function presentationScope(identity: ViewIdentity): string {
  return JSON.stringify([identity.conversationId, identity.branchId]);
}

/**
 * 单次宿主操作的事件投影；getHistory 必须绑定实际操作 Session 的原始历史。
 * 不执行 Agent、不自行解除控制器锁；settle 仅由宿主在迭代与清理真正完成后调用。
 */
export class SessionPresentation {
  private readonly identity: ViewIdentity;
  private readonly scope: string;
  private readonly known = new Set<string>();
  private readonly thinking = new Map<string, string>();
  private readonly tools = new Map<string, ViewBlock>();
  private turn = 0;
  private counter = 0;
  private messageId = '';
  private textId: string | undefined;
  private anonymousThinking: string | undefined;
  private firstEvent = true;
  private result: OperationResult | undefined;

  constructor(
    private readonly store: PresentationStore,
    private readonly operationId: string,
    private readonly getHistory: () => readonly CanonicalMessage[],
  ) {
    this.identity = { ...store.snapshot().identity };
    this.scope = presentationScope(this.identity);
    for (const message of store.snapshot().messages) this.known.add(message.id);
    if (!this.emit({ type: 'operation_started' }))
      throw new Error('展示操作无法在当前执行阶段启动');
    this.resetTurn(0);
  }

  /**
   * 消费已由 AgentSession 闭合/持久化约束保护的事件；迟到旧视图不再读取历史。
   * 工具消息完成 canonical 对齐后，以历史结果为准，后续完成通知不再生成临时卡片。
   */
  consume(event: SessionEvent): void {
    if (!this.isCurrent() || this.store.snapshot().operation?.phase === 'idle') return;
    if (this.firstEvent) {
      this.syncHistory();
      this.firstEvent = false;
    }
    switch (event.type) {
      case 'turn_start':
        this.resetTurn(event.turn);
        this.syncHistory();
        break;
      case 'text_delta': {
        this.anonymousThinking = undefined;
        this.textId ??= this.nextId('text');
        this.emit({
          type: 'append',
          messageId: this.messageId,
          blockId: this.textId,
          kind: 'text',
          text: sanitizeUntrustedOutput(event.text),
        });
        break;
      }
      case 'thinking_block_start': {
        this.textId = undefined;
        const id = this.thinkingId(event.blockId);
        this.emit({
          type: 'append',
          messageId: this.messageId,
          blockId: id,
          kind: 'thinking',
          text: '',
        });
        break;
      }
      case 'thinking_delta': {
        this.textId = undefined;
        const id = this.thinkingId(event.blockId);
        this.emit({
          type: 'append',
          messageId: this.messageId,
          blockId: id,
          kind: 'thinking',
          text: sanitizeUntrustedOutput(event.thinking),
        });
        break;
      }
      case 'thinking_block_stop': {
        const id = this.thinking.get(event.blockId);
        if (id) this.emit({ type: 'block_stopped', blockId: id });
        this.anonymousThinking = undefined;
        break;
      }
      case 'tool_start': {
        this.textId = undefined;
        const tool: ViewTool = {
          callId: event.id,
          name: sanitizeToolName(event.name),
          invocation: sanitizeUntrustedOutput(formatToolInvocation(event.name, event.input)),
          input: sanitizeUntrustedOutput(formatToolDetail(event.input)),
          status: 'running',
        };
        const block: ViewBlock = {
          id: this.nextId('tool'),
          kind: 'tool',
          text: tool.invocation,
          state: 'streaming',
          revision: 0,
          tool,
        };
        this.tools.set(event.id, block);
        this.updateTool(block);
        break;
      }
      case 'tool_progress': {
        const previous = this.tools.get(event.id);
        if (previous?.tool) {
          const block = {
            ...previous,
            tool: { ...previous.tool, elapsedMs: event.elapsedMs, outputBytes: event.outputBytes },
          };
          this.tools.set(event.id, block);
          this.updateTool(block);
        }
        break;
      }
      case 'tool_finish': {
        const previous = this.tools.get(event.id);
        if (previous?.tool) {
          const block: ViewBlock = {
            ...previous,
            state: 'completed',
            tool: {
              ...previous.tool,
              status: event.isError ? 'failed' : 'succeeded',
              durationMs: event.durationMs,
              result: sanitizeUntrustedOutput(formatToolDetail(event.result)),
            },
          };
          this.tools.set(event.id, block);
          this.updateTool(block);
        }
        break;
      }
      case 'message_stop':
        this.syncHistory(event.message);
        break;
      case 'tool_messages':
        this.syncHistory();
        break;
      case 'run_finish':
        this.result = event.metrics.status;
        this.emit({ type: 'operation_result', result: this.result });
        break;
      case 'error':
        this.diagnostic(
          event.modelError
            ? formatModelError(event.modelError)
            : sanitizeModelErrorMessage(event.error.message),
        );
        this.result = 'failed';
        this.emit({ type: 'operation_result', result: 'failed' });
        break;
    }
  }

  /** 只改变取消展示阶段，真正 AbortSignal 和执行门由原控制器负责。 */
  cancelling(): void {
    this.emit({ type: 'cancellation_requested' });
  }

  /** 用户覆盖属于当前展示块，不保存到 canonical；旧视图动作不能影响新会话。 */
  setExpanded(blockId: string, expanded: boolean): void {
    this.emit({ type: 'set_expanded', blockId, expanded });
  }

  /**
   * 宿主确认控制器 finally 已完成后校对原历史，再解除展示忙碌状态。
   * 最后落盘/清理失败覆盖早先成功结果；无 canonical 的片段仍保留为临时中断。
   */
  settle(result?: OperationResult, failure?: unknown): void {
    if (!this.isCurrent() || this.store.snapshot().operation?.phase === 'idle') return;
    let finalResult = result ?? this.result;
    try {
      this.syncHistory();
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined) {
      this.diagnostic(
        sanitizeModelErrorMessage(failure instanceof Error ? failure.message : String(failure)),
      );
      finalResult = 'failed';
    }
    this.emit({ type: 'operation_settled', result: finalResult });
  }

  private resetTurn(turn: number): void {
    this.turn = turn;
    this.counter = 0;
    this.messageId = JSON.stringify([this.operationId, this.identity.viewEpoch, turn, 'assistant']);
    this.textId = undefined;
    this.anonymousThinking = undefined;
    this.thinking.clear();
    this.tools.clear();
  }

  private nextId(kind: string): string {
    return JSON.stringify([this.messageId, kind, ++this.counter]);
  }

  private thinkingId(sourceId?: string): string {
    if (sourceId) {
      const existing = this.thinking.get(sourceId);
      if (existing) return existing;
      const id = this.nextId('thinking');
      this.thinking.set(sourceId, id);
      return id;
    }
    this.anonymousThinking ??= this.nextId('thinking');
    return this.anonymousThinking;
  }

  private updateTool(block: ViewBlock): void {
    this.emit({ type: 'tool_changed', messageId: this.messageId, block });
  }

  /**
   * 在完成边界才做原历史白名单重建，按块类型/调用身份对齐，不依正文 hash 猜测身份。
   * 临时消息成功对齐后释放其工具映射，避免 Core 随后发送的 tool_finish 重新创建副本；
   * 尚未对齐的工具仍接收实时进度与完成结果，不能提前丢弃。
   */
  private syncHistory(target?: CanonicalMessage): void {
    const history = this.getHistory();
    const projected = projectHistory(history, this.scope);
    const targetIndex = target
      ? history.findIndex(
          (message) => message === target || (target.id !== undefined && message.id === target.id),
        )
      : -1;
    const targetId =
      targetIndex >= 0
        ? displayMessageId(history[targetIndex], targetIndex, this.scope)
        : undefined;
    for (const message of projected) {
      if (this.known.has(message.id) && message.id !== targetId) continue;
      const pending =
        message.role === 'assistant'
          ? this.store.snapshot().pendingMessages.find((item) => item.id === this.messageId)
          : undefined;
      const aliases: Record<string, string> = {};
      if (pending) {
        const used = new Set<string>();
        for (const block of message.blocks) {
          const previous = pending.blocks.find(
            (item) =>
              !used.has(item.id) &&
              item.kind === block.kind &&
              (block.kind !== 'tool' || item.tool?.callId === block.tool?.callId),
          );
          if (previous) {
            aliases[block.id] = previous.id;
            used.add(previous.id);
          }
        }
      }
      if (this.emit({ type: 'message_committed', message, provisionalId: pending?.id, aliases })) {
        this.known.add(message.id);
        if (pending) this.tools.clear();
      }
    }
  }

  private diagnostic(text: string): void {
    this.emit({
      type: 'diagnostic',
      id: this.nextId('error'),
      level: 'error',
      text: sanitizeUntrustedOutput(text),
    });
  }

  private isCurrent(): boolean {
    const state = this.store.snapshot();
    return (
      state.identity.conversationId === this.identity.conversationId &&
      state.identity.branchId === this.identity.branchId &&
      state.identity.viewEpoch === this.identity.viewEpoch &&
      state.operation?.id === this.operationId
    );
  }

  private emit(change: PresentationChange): boolean {
    return this.store.dispatch({
      ...this.identity,
      operationId: this.operationId,
      sequence: this.store.snapshot().sequence + 1,
      change,
    });
  }
}
