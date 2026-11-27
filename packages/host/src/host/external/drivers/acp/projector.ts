import type {
  ViewMessage,
  ViewTodoItem,
  ViewTodoState,
  ViewTool,
  ViewTurnMeta,
  ViewUsage,
} from '../../../../view-model/index.js';
import { redactText } from '../../../redaction.js';
import { sanitizeUntrustedOutput } from '../../../ui/text-safety.js';
import type { ExternalEvent } from '../../types.js';

/** 单个外部文本/思考/工具结果块的最大保留字符数（对齐桌面 `LIMITS.displayBudget = 64KiB`）。 */
const MAX_BLOCK_TEXT_CHARS = 64 * 1024;
/** 实时投影保留的最大消息条数，确保序列化后远低于单帧 10 万 JSON 节点上限。 */
const MAX_LIVE_MESSAGES = 160;
/**
 * 实时投影累计文本预算（620 KiB UTF-8）。
 *
 * 设计取舍：桌面 `BoundedPeer` 与本地 Wire `StdioTransport` 单帧硬上限均为 `1 MiB`（1,048,576 字节）；
 * 外部会话未做分块快照，因此投影层主动控制总负载在 ~620 KiB 以内（加上 JSON 键名开销仍稳处于 750 KiB 以下），
 * 超限时从头部裁剪早期消息并置 `truncated = true`，彻底杜绝 `OUTPUT_CONGESTED` 断连。
 */
const MAX_LIVE_TRANSCRIPT_BYTES = 620 * 1024;

interface MutableBlock {
  id: string;
  kind: 'text' | 'thinking' | 'tool';
  text: string;
  /** 仅在流式拼接期间保留净化后、脱敏前的有限缓冲，确保跨 chunk 拆分的密钥拼接后可被完整识别脱敏。 */
  rawCleanBuffer?: string;
  state: 'streaming' | 'completed' | 'interrupted';
  revision: number;
  tool?: ViewTool;
  skillName?: string;
}

interface MutableMessage {
  id: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  state: 'streaming' | 'completed' | 'interrupted';
  persisted: boolean;
  blocks: MutableBlock[];
  usage?: ViewUsage;
  turnMeta?: ViewTurnMeta;
}

function clampBlockText(value: string): { text: string; truncated: boolean } {
  if (value.length <= MAX_BLOCK_TEXT_CHARS) {
    return { text: value, truncated: false };
  }
  return {
    text: `${value.slice(0, MAX_BLOCK_TEXT_CHARS)}\n…[输出过长已截断]`,
    truncated: true,
  };
}

function estimateMessageBytes(msg: MutableMessage): number {
  let bytes = 128 + Buffer.byteLength(msg.id, 'utf8');
  for (const b of msg.blocks) {
    bytes += 96 + Buffer.byteLength(b.text, 'utf8');
    if (b.tool) {
      bytes +=
        160 +
        Buffer.byteLength(b.tool.invocation, 'utf8') +
        Buffer.byteLength(b.tool.input, 'utf8') +
        (b.tool.result ? Buffer.byteLength(b.tool.result, 'utf8') : 0);
    }
  }
  return bytes;
}

/**
 * 外部代理会话事件流到 `ViewMessage[]` / `ViewTodoState` 的有状态投影器。
 *
 * 关键保证：
 * 1. **跨分片密钥脱敏**：流式文本/思考块按累积缓冲整体执行 `redactText`，防止跨两个 `text_delta` 切分的 API Key 逃逸；
 * 2. **冷恢复 ID 单调递增**：`replaceMessages` 自动扫描历史消息尾号推进 `messageCounter`，杜绝续聊时产生重复 `ViewMessage.id`；
 * 3. **单帧 `< 1 MiB` 自适应裁剪**：单块 64KiB 封顶 + 全局 620KiB 滑动窗口裁剪并记录 `wasTruncated()`，保障桌面 IPC 与 Wire 通道永不因大输出断连。
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
  private truncated = false;

  constructor(
    private readonly scopeId: string,
    private readonly secrets: readonly string[] = [],
  ) {}

  /** 当前会话投影是否曾因单块超长或总帧预算发生过裁剪。 */
  wasTruncated(): boolean {
    return this.truncated;
  }

  /**
   * 在发起实时 `prompt(text)` 前写入用户消息，并开启对部分 ACP 代理回显 `user_message_chunk` 的前缀去重窗口。
   * 若上一轮计划已全部完结（无进行中或待办项），同步清出旧计划看板，避免长期滞留在后续对话轮次。
   */
  beginUserTurn(rawText: string, handoffFromTitle?: string): ViewMessage {
    this.sealStreamingMessages('completed');
    this.clearSettledPlan();
    const clamped = clampBlockText(this.cleanText(rawText));
    if (clamped.truncated) this.truncated = true;
    this.pendingEchoRemainder = rawText.replace(/\r\n?/g, '\n');

    const msgId = this.nextMessageId('user');
    const blocks: MutableBlock[] = [
      {
        id: `${msgId}:b0`,
        kind: 'text',
        text: clamped.text,
        state: 'completed',
        revision: 0,
      },
    ];
    if (handoffFromTitle?.trim()) {
      const cleanFrom = this.cleanText(handoffFromTitle.trim()).slice(0, 80) || '历史会话';
      blocks.push({
        id: `${msgId}:b1`,
        kind: 'text',
        text: '',
        skillName: `承接 · ${cleanFrom}`,
        state: 'completed',
        revision: 0,
      });
    }
    const message: MutableMessage = {
      id: msgId,
      role: 'user',
      state: 'completed',
      persisted: true,
      blocks,
    };
    this.messages.push(message);
    this.enforceBudget();
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
        this.clearSettledPlan();
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

  /** 当前轮次正常完成时闭合所有流式块，并把可选 Token 用量与当轮模型/推理快照挂在最后一条助手消息上。 */
  completeTurn(usage?: ViewUsage, turnMeta?: ViewTurnMeta): void {
    this.pendingEchoRemainder = '';
    this.sealStreamingMessages('completed', usage, turnMeta);
  }

  /** 当前轮次被用户取消或进程异常断开时将未完结块标为 `interrupted`，并保留当轮模型/推理快照。 */
  interruptTurn(turnMeta?: ViewTurnMeta): void {
    this.pendingEchoRemainder = '';
    this.sealStreamingMessages('interrupted', undefined, turnMeta);
  }

  /** 用恢复阶段重放或本地归档的消息整体初始化投影器，同时推进消息序号计数器并补齐脱敏。 */
  replaceMessages(messages: readonly ViewMessage[], alreadyTruncated = false): void {
    this.messages.length = 0;
    this.toolBlockLocation.clear();
    if (alreadyTruncated) {
      this.truncated = true;
    }
    let maxParsedCounter = this.messageCounter;
    const prefix = `${this.scopeId}:`;

    for (const msg of messages) {
      if (msg.id.startsWith(prefix)) {
        const lastColon = msg.id.lastIndexOf(':');
        if (lastColon > prefix.length) {
          const parsedNum = Number.parseInt(msg.id.slice(lastColon + 1), 10);
          if (Number.isSafeInteger(parsedNum) && parsedNum > maxParsedCounter) {
            maxParsedCounter = parsedNum;
          }
        }
      }
      const msgIndex = this.messages.length;
      const clonedBlocks: MutableBlock[] = msg.blocks.map((b, bIndex) => {
        const sanitizedTool = b.tool ? this.sanitizeToolFields(b.tool) : undefined;
        if (b.kind === 'tool' && sanitizedTool) {
          this.toolBlockLocation.set(sanitizedTool.callId, {
            messageIndex: msgIndex,
            blockIndex: bIndex,
          });
        }
        const clampedText = clampBlockText(this.cleanText(b.text));
        if (clampedText.truncated) this.truncated = true;
        return {
          id: b.id,
          kind: b.kind,
          text: clampedText.text,
          state: b.state,
          revision: b.revision,
          ...(sanitizedTool ? { tool: sanitizedTool } : {}),
          ...(b.skillName ? { skillName: this.cleanText(b.skillName).slice(0, 120) } : {}),
        };
      });
      const sanitizedTurnMeta: ViewTurnMeta | undefined = msg.turnMeta
        ? {
            ...(msg.turnMeta.agentName
              ? { agentName: this.cleanText(msg.turnMeta.agentName).slice(0, 80) }
              : {}),
            ...(msg.turnMeta.modelLabel
              ? { modelLabel: this.cleanText(msg.turnMeta.modelLabel).slice(0, 120) }
              : {}),
            ...(msg.turnMeta.effortLabel
              ? { effortLabel: this.cleanText(msg.turnMeta.effortLabel).slice(0, 64) }
              : {}),
            ...(msg.turnMeta.modeLabel
              ? { modeLabel: this.cleanText(msg.turnMeta.modeLabel).slice(0, 64) }
              : {}),
          }
        : undefined;
      this.messages.push({
        id: msg.id,
        role: msg.role,
        state: msg.state,
        persisted: msg.persisted,
        blocks: clonedBlocks,
        ...(msg.usage ? { usage: { ...msg.usage } } : {}),
        ...(sanitizedTurnMeta ? { turnMeta: sanitizedTurnMeta } : {}),
      });
    }

    this.messageCounter = Math.max(maxParsedCounter, messages.length);
    this.enforceBudget();
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
    const normalizedChunk = chunk.replace(/\r\n?/g, '\n');
    if (this.pendingEchoRemainder.startsWith(normalizedChunk)) {
      this.pendingEchoRemainder = this.pendingEchoRemainder.slice(normalizedChunk.length);
      return true;
    }
    if (this.pendingEchoRemainder.trim() === normalizedChunk.trim()) {
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
    const cleanChunk = sanitizeUntrustedOutput(rawChunk);
    if (!cleanChunk) return;

    let targetMsg = this.messages.at(-1);
    if (
      !targetMsg ||
      targetMsg.role !== role ||
      (!completedImmediately && targetMsg.state !== 'streaming')
    ) {
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

    const lastBlock = targetMsg.blocks.at(-1);
    if (lastBlock && lastBlock.kind === kind) {
      const baseRaw = lastBlock.rawCleanBuffer ?? lastBlock.text;
      if (baseRaw.length < MAX_BLOCK_TEXT_CHARS) {
        const combinedRaw = baseRaw + cleanChunk;
        const clamped = clampBlockText(combinedRaw);
        if (clamped.truncated) this.truncated = true;
        lastBlock.rawCleanBuffer = completedImmediately ? undefined : clamped.text;
        lastBlock.text = redactText(clamped.text, this.secrets);
      } else {
        this.truncated = true;
      }
      lastBlock.revision += 1;
      lastBlock.state = completedImmediately ? 'completed' : 'streaming';
      this.enforceBudget();
      return;
    }

    if (lastBlock && lastBlock.kind !== 'tool' && lastBlock.state === 'streaming') {
      lastBlock.rawCleanBuffer = undefined;
      lastBlock.state = 'completed';
    }

    const clamped = clampBlockText(cleanChunk);
    if (clamped.truncated) this.truncated = true;
    targetMsg.blocks.push({
      id: `${targetMsg.id}:b${targetMsg.blocks.length}`,
      kind,
      text: redactText(clamped.text, this.secrets),
      ...(completedImmediately ? {} : { rawCleanBuffer: clamped.text }),
      state: completedImmediately ? 'completed' : 'streaming',
      revision: 0,
    });
    this.enforceBudget();
  }

  private sanitizeToolFields(rawTool: ViewTool): ViewTool {
    const safeCallId = rawTool.callId.slice(0, 256) || 'tool';
    const inv = clampBlockText(this.cleanText(rawTool.invocation));
    const inp = clampBlockText(this.cleanText(rawTool.input));
    const res =
      rawTool.result !== undefined ? clampBlockText(this.cleanText(rawTool.result)) : undefined;
    if (inv.truncated || inp.truncated || res?.truncated) {
      this.truncated = true;
    }
    return {
      ...rawTool,
      callId: safeCallId,
      invocation: inv.text,
      input: inp.text,
      ...(rawTool.chip ? { chip: this.cleanText(rawTool.chip).slice(0, 240) } : {}),
      ...(res !== undefined ? { result: res.text } : {}),
    };
  }

  private upsertTool(rawTool: ViewTool, replay: boolean): void {
    const sanitizedTool = this.sanitizeToolFields(rawTool);

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
        this.enforceBudget();
        return;
      }
    }

    let assistantMsg = this.messages.at(-1);
    if (
      !assistantMsg ||
      assistantMsg.role !== 'assistant' ||
      (!replay && assistantMsg.state !== 'streaming')
    ) {
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
      prevBlock.rawCleanBuffer = undefined;
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
    this.enforceBudget();
  }

  private rebuildToolLocations(): void {
    this.toolBlockLocation.clear();
    for (let mIdx = 0; mIdx < this.messages.length; mIdx++) {
      const blocks = this.messages[mIdx]!.blocks;
      for (let bIdx = 0; bIdx < blocks.length; bIdx++) {
        const tool = blocks[bIdx]!.tool;
        if (tool) {
          this.toolBlockLocation.set(tool.callId, { messageIndex: mIdx, blockIndex: bIdx });
        }
      }
    }
  }

  private enforceBudget(): void {
    let droppedMessages = false;
    if (this.messages.length > MAX_LIVE_MESSAGES) {
      this.messages.splice(0, this.messages.length - MAX_LIVE_MESSAGES);
      this.truncated = true;
      droppedMessages = true;
    }

    let totalBytes = 0;
    for (const msg of this.messages) {
      totalBytes += estimateMessageBytes(msg);
    }

    while (totalBytes > MAX_LIVE_TRANSCRIPT_BYTES && this.messages.length > 1) {
      const removed = this.messages.shift()!;
      totalBytes -= estimateMessageBytes(removed);
      this.truncated = true;
      droppedMessages = true;
    }

    // 单条消息内含极多工具调用时（例如单轮连续调用十余次大输出工具），裁剪早期已完成工具的输出详情，保留最近块完整可读。
    if (totalBytes > MAX_LIVE_TRANSCRIPT_BYTES && this.messages.length === 1) {
      const only = this.messages[0]!;
      for (let i = 0; i < only.blocks.length - 2 && totalBytes > MAX_LIVE_TRANSCRIPT_BYTES; i++) {
        const b = only.blocks[i]!;
        if (b.tool?.result && b.tool.result.length > 1024) {
          const prevBytes = Buffer.byteLength(b.tool.result, 'utf8');
          const slim = `${b.tool.result.slice(0, 1024)}\n…[历史工具输出已折叠以控制快照体积]`;
          b.tool = { ...b.tool, result: slim };
          totalBytes -= Math.max(0, prevBytes - Buffer.byteLength(slim, 'utf8'));
          this.truncated = true;
        }
        if (b.tool && b.tool.input.length > 1024 && totalBytes > MAX_LIVE_TRANSCRIPT_BYTES) {
          const prevBytes = Buffer.byteLength(b.tool.input, 'utf8');
          const slim = `${b.tool.input.slice(0, 1024)}\n…[历史入参已截断]`;
          b.tool = { ...b.tool, input: slim };
          totalBytes -= Math.max(0, prevBytes - Buffer.byteLength(slim, 'utf8'));
          this.truncated = true;
        }
      }
      // 兜底：若块数量极多仍超限，移除该单条消息最早的已完成块并重建索引。
      while (totalBytes > MAX_LIVE_TRANSCRIPT_BYTES && only.blocks.length > 2) {
        const removedBlock = only.blocks.shift()!;
        const removedBytes =
          96 +
          Buffer.byteLength(removedBlock.text, 'utf8') +
          (removedBlock.tool?.result ? Buffer.byteLength(removedBlock.tool.result, 'utf8') : 0) +
          (removedBlock.tool ? Buffer.byteLength(removedBlock.tool.input, 'utf8') : 0);
        totalBytes = Math.max(0, totalBytes - removedBytes);
        this.truncated = true;
        droppedMessages = true;
      }
    }

    if (droppedMessages) {
      this.rebuildToolLocations();
    }
  }

  /** 已全部完结（无 pending/in_progress）的计划只展示到所属轮次结束，进入后续用户轮次自动清空。 */
  private clearSettledPlan(): void {
    if (
      this.planState &&
      !this.planState.items.some(
        (item) => item.status === 'pending' || item.status === 'in_progress',
      )
    ) {
      this.planState = undefined;
    }
  }

  private updatePlan(items: readonly ViewTodoItem[]): void {
    this.planRevision += 1;
    this.planState = {
      items: items.slice(0, 100).map((item) => ({
        id: item.id.slice(0, 256) || 'todo',
        title: this.cleanText(item.title).slice(0, 500),
        status: item.status,
      })),
      updatedAt: Date.now(),
      revision: this.planRevision,
    };
  }

  private sealStreamingMessages(
    finalState: 'completed' | 'interrupted',
    usage?: ViewUsage,
    turnMeta?: ViewTurnMeta,
  ): void {
    for (const msg of this.messages) {
      if (msg.state === 'streaming') {
        this.sealMessage(msg, finalState);
      }
    }
    let lastUserIndex = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!.role === 'user') {
        lastUserIndex = i;
        break;
      }
    }
    if (usage || turnMeta) {
      const cleanedMeta: ViewTurnMeta | undefined = turnMeta
        ? {
            ...(turnMeta.agentName
              ? { agentName: this.cleanText(turnMeta.agentName).slice(0, 80) }
              : {}),
            ...(turnMeta.modelLabel
              ? { modelLabel: this.cleanText(turnMeta.modelLabel).slice(0, 120) }
              : {}),
            ...(turnMeta.effortLabel
              ? { effortLabel: this.cleanText(turnMeta.effortLabel).slice(0, 64) }
              : {}),
            ...(turnMeta.modeLabel
              ? { modeLabel: this.cleanText(turnMeta.modeLabel).slice(0, 64) }
              : {}),
          }
        : undefined;
      for (let i = this.messages.length - 1; i > lastUserIndex; i--) {
        if (this.messages[i]!.role === 'assistant') {
          if (usage) this.messages[i]!.usage = usage;
          if (cleanedMeta) this.messages[i]!.turnMeta = cleanedMeta;
          break;
        }
      }
    }
  }

  private sealMessage(msg: MutableMessage, finalState: 'completed' | 'interrupted'): void {
    msg.state = finalState;
    for (const block of msg.blocks) {
      block.rawCleanBuffer = undefined;
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
        ...(b.skillName ? { skillName: b.skillName } : {}),
      })),
      ...(msg.usage ? { usage: { ...msg.usage } } : {}),
      ...(msg.turnMeta ? { turnMeta: { ...msg.turnMeta } } : {}),
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
