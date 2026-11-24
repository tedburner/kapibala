import type {
  ViewBlock,
  ViewMessage,
  ViewTodoItem,
  ViewTodoState,
  ViewTool,
  ViewUsage,
} from '../../../../view-model/index.js';
import { redactText } from '../../../redaction.js';
import { sanitizeUntrustedOutput } from '../../../ui/text-safety.js';
import type { ExternalEvent } from '../../types.js';

interface MutableBlock {
  id: string;
  kind: 'text' | 'thinking' | 'tool';
  text: string;
  state: 'streaming' | 'completed' | 'interrupted';
  revision: number;
  tool?: ViewTool;
}

interface MutableMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  state: 'streaming' | 'completed' | 'interrupted';
  persisted: boolean;
  blocks: MutableBlock[];
  usage?: ViewUsage;
}

/**
 * 协议中立的外部会话消息流与计划投影器。
 *
 * 复用设计：直接产出与本地会话 100% 同构的 `ViewMessage[]` 与 `ViewTodoState`，
 * 使桌面端 Streamdown Markdown、思考折叠块、工具耗时行与任务清单浮层零分叉复用。
 */
export class ExternalTranscriptProjector {
  private readonly messages: MutableMessage[] = [];
  private readonly toolBlockLocation = new Map<
    string,
    { readonly messageIndex: number; readonly blockIndex: number }
  >();
  private planState?: ViewTodoState;
  private planRevision = 0;
  private messageCounter = 0;
  private pendingEchoRemainder = '';

  constructor(
    private readonly scopeId: string,
    private readonly secrets: readonly string[] = [],
  ) {}

  /**
   * 在发起实时 `prompt(text)` 前写入用户消息，并开启对部分 ACP 代理回显 `user_message_chunk` 的前缀去重窗口。
   */
  beginUserTurn(rawText: string): ViewMessage {
    this.sealStreamingMessages('completed');
    const safeText = this.cleanText(rawText);
    this.pendingEchoRemainder = rawText;

    const msgId = this.nextMessageId('user');
    const message: MutableMessage = {
      id: msgId,
      role: 'user',
      state: 'completed',
      persisted: true,
      blocks: [
        {
          id: `${msgId}:b0`,
          kind: 'text',
          text: safeText,
          state: 'completed',
          revision: 0,
        },
      ],
    };
    this.messages.push(message);
    return this.freezeMessage(message);
  }

  /** 消费一条由任意底层驱动产出的 `ExternalEvent` 并推进展示投影。 */
  applyEvent(event: ExternalEvent): void {
    switch (event.type) {
      case 'user_delta': {
        if (!event.text) return;
        if (!event.replay && this.consumeExpectedEcho(event.text)) {
          return;
        }
        this.appendTextBlock('user', 'text', event.text, Boolean(event.replay));
        return;
      }
      case 'text_delta': {
        if (!event.text) return;
        this.pendingEchoRemainder = '';
        this.appendTextBlock('assistant', 'text', event.text, Boolean(event.replay));
        return;
      }
      case 'thought_delta': {
        if (!event.text) return;
        this.pendingEchoRemainder = '';
        this.appendTextBlock('assistant', 'thinking', event.text, Boolean(event.replay));
        return;
      }
      case 'tool_upsert': {
        this.pendingEchoRemainder = '';
        this.upsertTool(event.tool, Boolean(event.replay));
        return;
      }
      case 'plan_updated': {
        this.updatePlan(event.items);
        return;
      }
      default:
        return;
    }
  }

  /** 当前轮次正常完成时闭合所有流式块，并把可选 Token 用量挂在最后一条助手消息上。 */
  completeTurn(usage?: ViewUsage): void {
    this.pendingEchoRemainder = '';
    this.sealStreamingMessages('completed', usage);
  }

  /** 当前轮次被用户取消或进程异常断开时将未完结块标为 `interrupted`。 */
  interruptTurn(): void {
    this.pendingEchoRemainder = '';
    this.sealStreamingMessages('interrupted');
  }

  /** 用恢复阶段重放得到的历史整体初始化投影器。 */
  replaceMessages(messages: readonly ViewMessage[]): void {
    this.messages.length = 0;
    this.toolBlockLocation.clear();
    for (const msg of messages) {
      const msgIndex = this.messages.length;
      const clonedBlocks: MutableBlock[] = msg.blocks.map((b, bIndex) => {
        if (b.kind === 'tool' && b.tool) {
          this.toolBlockLocation.set(b.tool.callId, { messageIndex: msgIndex, blockIndex: bIndex });
        }
        return {
          id: b.id,
          kind: b.kind,
          text: b.text,
          state: b.state,
          revision: b.revision,
          ...(b.tool ? { tool: { ...b.tool } } : {}),
        };
      });
      this.messages.push({
        id: msg.id,
        role: msg.role,
        state: msg.state,
        persisted: msg.persisted,
        blocks: clonedBlocks,
        ...(msg.usage ? { usage: { ...msg.usage } } : {}),
      });
    }
  }

  /** 读取当前不可变消息快照副本。 */
  getMessages(): ViewMessage[] {
    return this.messages.map((m) => this.freezeMessage(m));
  }

  /** 读取指定 `callId` 的已投影工具状态（供增量 `tool_call_update` 与审批补卡合并）。 */
  getTool(callId: string): ViewTool | undefined {
    const loc = this.toolBlockLocation.get(callId);
    if (!loc) return undefined;
    return this.messages[loc.messageIndex]?.blocks[loc.blockIndex]?.tool;
  }

  /** 读取当前会话计划清单状态。 */
  getPlan(): ViewTodoState | undefined {
    return this.planState;
  }

  private consumeExpectedEcho(chunk: string): boolean {
    if (!this.pendingEchoRemainder) return false;
    if (this.pendingEchoRemainder.startsWith(chunk)) {
      this.pendingEchoRemainder = this.pendingEchoRemainder.slice(chunk.length);
      return true;
    }
    if (this.pendingEchoRemainder.trim() === chunk.trim()) {
      this.pendingEchoRemainder = '';
      return true;
    }
    this.pendingEchoRemainder = '';
    return false;
  }

  private appendTextBlock(
    role: 'user' | 'assistant',
    kind: 'text' | 'thinking',
    rawChunk: string,
    completedImmediately: boolean,
  ): void {
    const safeChunk = this.cleanText(rawChunk);
    if (!safeChunk) return;

    let targetMsg = this.messages.at(-1);
    if (
      !targetMsg ||
      targetMsg.role !== role ||
      (!completedImmediately && targetMsg.state !== 'streaming')
    ) {
      // 重放模式下连续同角色 chunk 仍归并到同一条消息；切换角色时收口上一条并新建消息。
      if (!targetMsg || targetMsg.role !== role) {
        if (targetMsg && targetMsg.state === 'streaming') {
          this.sealMessage(targetMsg, 'completed');
        }
        const id = this.nextMessageId(role);
        targetMsg = {
          id,
          role,
          state: completedImmediately ? 'completed' : 'streaming',
          persisted: true,
          blocks: [],
        };
        this.messages.push(targetMsg);
      }
    }

    const lastBlock = targetMsg.blocks.at(-1);
    if (lastBlock && lastBlock.kind === kind) {
      lastBlock.text += safeChunk;
      lastBlock.revision += 1;
      lastBlock.state = completedImmediately ? 'completed' : 'streaming';
      return;
    }

    if (lastBlock && lastBlock.kind !== 'tool' && lastBlock.state === 'streaming') {
      lastBlock.state = 'completed';
    }

    targetMsg.blocks.push({
      id: `${targetMsg.id}:b${targetMsg.blocks.length}`,
      kind,
      text: safeChunk,
      state: completedImmediately ? 'completed' : 'streaming',
      revision: 0,
    });
  }

  private upsertTool(rawTool: ViewTool, replay: boolean): void {
    const sanitizedTool: ViewTool = {
      ...rawTool,
      invocation: this.cleanText(rawTool.invocation),
      input: this.cleanText(rawTool.input),
      ...(rawTool.chip ? { chip: this.cleanText(rawTool.chip) } : {}),
      ...(rawTool.result !== undefined ? { result: this.cleanText(rawTool.result) } : {}),
    };

    const existingLoc = this.toolBlockLocation.get(sanitizedTool.callId);
    if (existingLoc) {
      const block = this.messages[existingLoc.messageIndex]?.blocks[existingLoc.blockIndex];
      if (block) {
        block.tool = sanitizedTool;
        block.text = sanitizedTool.invocation;
        block.state =
          sanitizedTool.status === 'running'
            ? 'streaming'
            : sanitizedTool.status === 'interrupted'
              ? 'interrupted'
              : 'completed';
        block.revision += 1;
        return;
      }
    }

    let assistantMsg = this.messages.at(-1);
    if (!assistantMsg || assistantMsg.role !== 'assistant') {
      if (assistantMsg && assistantMsg.state === 'streaming') {
        this.sealMessage(assistantMsg, 'completed');
      }
      const id = this.nextMessageId('assistant');
      assistantMsg = {
        id,
        role: 'assistant',
        state: replay ? 'completed' : 'streaming',
        persisted: true,
        blocks: [],
      };
      this.messages.push(assistantMsg);
    }

    const prevBlock = assistantMsg.blocks.at(-1);
    if (prevBlock && prevBlock.kind !== 'tool' && prevBlock.state === 'streaming') {
      prevBlock.state = 'completed';
    }

    const messageIndex = this.messages.length - 1;
    const blockIndex = assistantMsg.blocks.length;
    assistantMsg.blocks.push({
      id: `${assistantMsg.id}:b${blockIndex}`,
      kind: 'tool',
      text: sanitizedTool.invocation,
      state:
        sanitizedTool.status === 'running'
          ? 'streaming'
          : sanitizedTool.status === 'interrupted'
            ? 'interrupted'
            : 'completed',
      revision: 0,
      tool: sanitizedTool,
    });
    this.toolBlockLocation.set(sanitizedTool.callId, { messageIndex, blockIndex });
  }

  private updatePlan(items: readonly ViewTodoItem[]): void {
    this.planRevision += 1;
    this.planState = {
      items: items.map((item) => ({
        id: item.id,
        title: this.cleanText(item.title),
        status: item.status,
      })),
      updatedAt: Date.now(),
      revision: this.planRevision,
    };
  }

  private sealStreamingMessages(finalState: 'completed' | 'interrupted', usage?: ViewUsage): void {
    for (const msg of this.messages) {
      if (msg.state === 'streaming') {
        this.sealMessage(msg, finalState);
      }
    }
    if (usage) {
      for (let i = this.messages.length - 1; i >= 0; i--) {
        if (this.messages[i]!.role === 'assistant') {
          this.messages[i]!.usage = usage;
          break;
        }
      }
    }
  }

  private sealMessage(msg: MutableMessage, finalState: 'completed' | 'interrupted'): void {
    msg.state = finalState;
    for (const block of msg.blocks) {
      if (block.state === 'streaming') {
        block.state = finalState;
        if (block.kind === 'tool' && block.tool && block.tool.status === 'running') {
          block.tool = {
            ...block.tool,
            status: finalState === 'interrupted' ? 'interrupted' : 'succeeded',
          };
        }
      }
    }
  }

  private freezeMessage(msg: MutableMessage): ViewMessage {
    return {
      id: msg.id,
      role: msg.role,
      state: msg.state,
      persisted: msg.persisted,
      blocks: msg.blocks.map((b) => ({
        id: b.id,
        kind: b.kind,
        text: b.text,
        state: b.state,
        revision: b.revision,
        ...(b.tool ? { tool: { ...b.tool } } : {}),
      })),
      ...(msg.usage ? { usage: { ...msg.usage } } : {}),
    };
  }

  private cleanText(raw: string): string {
    return redactText(sanitizeUntrustedOutput(raw), this.secrets);
  }

  private nextMessageId(role: string): string {
    this.messageCounter += 1;
    return `${this.scopeId}:${role}:${this.messageCounter}`;
  }
}
