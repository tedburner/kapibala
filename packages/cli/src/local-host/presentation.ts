import type { JsonValue, WireEvent } from '../protocol/index.js';
import {
  type PresentationChange,
  type PresentationState,
  type ViewBlock,
  type ViewMessage,
  createPresentation,
  reducePresentation,
} from '../view-model/index.js';

/**
 * wire 到现有纯展示 reducer 的薄适配；只有 canonical 快照可将消息标为 persisted。
 * 流式事件不能伪造历史提交，收到终态后由宿主显式刷新快照。
 */
export class ConnectedPresentation {
  private current: PresentationState;
  private sequence = 0;
  private wireSequence = 0;
  constructor(
    private readonly sessionId: string,
    private readonly instance: string,
    private readonly epoch: string,
  ) {
    this.current = createPresentation({
      conversationId: sessionId,
      branchId: 'main',
      viewEpoch: 1,
    });
  }

  /** 展示快照只读，渲染者不能通过此入口改变会话权限或控制权。 */
  get state(): PresentationState {
    return this.current;
  }

  private apply(change: PresentationChange, operationId?: string): void {
    this.current = reducePresentation(this.current, {
      ...this.current.identity,
      sequence: ++this.sequence,
      operationId,
      change,
    });
  }

  /** 工具块按 runId/toolId 定位；进度与终态不能另建重复条目。 */
  private toolBlock(messageId: string, blockId: string): ViewBlock | undefined {
    return this.current.pendingMessages
      .find((message) => message.id === messageId)
      ?.blocks.find((block) => block.id === blockId);
  }

  /** 工具事件只映射公开事实；原始参数与未脱敏结果已在宿主侧剔除。 */
  private applyTool(
    event: Extract<WireEvent, { type: 'tool_start' | 'tool_progress' | 'tool_finish' }>,
  ): void {
    const messageId = event.runId ?? 'pending';
    const blockId = `${messageId}:tool:${event.payload.toolId}`;
    const existing = this.toolBlock(messageId, blockId);
    const fallbackName =
      event.type === 'tool_finish' ? event.payload.toolId : event.payload.toolName;
    const tool = existing?.tool ?? {
      callId: event.payload.toolId,
      name: fallbackName,
      invocation: event.type === 'tool_start' ? event.payload.target : fallbackName,
      input: '',
      status: 'running' as const,
    };
    this.apply(
      {
        type: 'tool_changed',
        messageId,
        block: {
          id: blockId,
          kind: 'tool',
          text: existing?.text ?? tool.invocation,
          state: event.type === 'tool_finish' ? 'completed' : 'streaming',
          revision: 0,
          tool:
            event.type === 'tool_start'
              ? tool
              : event.type === 'tool_progress'
                ? {
                    ...tool,
                    elapsedMs: event.payload.elapsedMs,
                    outputBytes: event.payload.outputBytes,
                  }
                : {
                    ...tool,
                    status: event.payload.isError ? ('failed' as const) : ('succeeded' as const),
                    result: event.payload.result,
                  },
        },
      },
      event.runId,
    );
  }

  /** 拒绝旧实例/代际/序号；协议层已验证类型，连接层负责缺号重同步。 */
  consume(event: WireEvent): void {
    if (
      event.sessionId !== this.sessionId ||
      event.serverInstanceId !== this.instance ||
      event.streamEpoch !== this.epoch ||
      event.seq <= this.wireSequence
    )
      return;
    this.wireSequence = event.seq;
    if (event.type === 'run_started') this.apply({ type: 'operation_started' }, event.runId);
    else if (event.type === 'text_delta' || event.type === 'thinking_delta')
      this.apply(
        {
          type: 'append',
          messageId: event.runId ?? 'pending',
          blockId: `${event.runId}:${event.type}`,
          kind: event.type === 'text_delta' ? 'text' : 'thinking',
          text: event.payload.text,
        },
        event.runId,
      );
    else if (
      event.type === 'tool_start' ||
      event.type === 'tool_progress' ||
      event.type === 'tool_finish'
    )
      this.applyTool(event);
    else if (event.type === 'run_settled')
      this.apply(
        {
          type: 'operation_settled',
          result: event.payload.outcome === 'cancelled' ? 'aborted' : event.payload.outcome,
        },
        event.runId,
      );
    else if (event.type === 'diagnostic')
      this.apply(
        { type: 'diagnostic', id: `${event.seq}`, text: event.payload.message, level: 'error' },
        event.runId,
      );
  }

  /** 重建公开历史白名单；私有字段或未知块不会被搬到展示状态。 */
  restore(history: JsonValue[]): void {
    const messages: ViewMessage[] = [];
    for (const raw of history) {
      if (
        !raw ||
        typeof raw !== 'object' ||
        Array.isArray(raw) ||
        typeof raw.id !== 'string' ||
        !Array.isArray(raw.blocks) ||
        !['user', 'assistant', 'tool'].includes(String(raw.role))
      )
        continue;
      const blocks = raw.blocks.flatMap((block, index) => {
        if (
          !block ||
          typeof block !== 'object' ||
          Array.isArray(block) ||
          typeof block.text !== 'string'
        )
          return [];
        return [
          {
            id: `${raw.id}:${index}`,
            kind: block.kind === 'thinking' ? ('thinking' as const) : ('text' as const),
            text: block.text,
            revision: 0,
            state: 'completed' as const,
          },
        ];
      });
      messages.push({
        id: raw.id,
        role: raw.role as 'user' | 'assistant' | 'tool',
        state: 'completed',
        persisted: true,
        blocks,
      });
    }
    this.current = createPresentation(
      { ...this.current.identity, viewEpoch: this.current.identity.viewEpoch + 1 },
      messages,
    );
    this.sequence = 0;
  }
}
