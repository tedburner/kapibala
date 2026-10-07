import fs from 'node:fs';
import path from 'node:path';
import { ModelError } from '../../errors/index.js';
import { validateProtocolContent } from '../../models/protocol-state.js';
import {
  type CanonicalMessage,
  type ToolResultBlock,
  type ToolUseBlock,
  isToolResultBlock,
  isToolUseBlock,
} from '../../types/index.js';
import type { MessageStore } from './index.js';

/**
 * 旧版单文件 JSONL MessageStore：每行一条消息，无版本化状态能力。
 * 写入为同步追加，不做 fsync 或单写者保护；恢复时容错跳过损坏行并闭合悬挂事务。
 */
export class JSONLMessageStore implements MessageStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /** 校验协议内容后追加一行 JSON；不补身份、不查重、不 fsync。 */
  async append(message: CanonicalMessage): Promise<void> {
    validateProtocolContent(message.content);
    const record = {
      ts: message.timestamp ?? Date.now(),
      role: message.role,
      content: message.content,
      id: message.id,
      interactionId: message.interactionId,
      state: message.state,
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

  /** 读取全部消息；半截损坏行忽略，悬挂 tool_use 就地补 OUTCOME_UNKNOWN 结果。 */
  async load(): Promise<CanonicalMessage[]> {
    if (!fs.existsSync(this.filePath)) {
      return [];
    }

    const content = fs.readFileSync(this.filePath, 'utf-8');
    const lines = content.split('\n');
    const messages: CanonicalMessage[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed);
        if (record.role && record.content) {
          validateProtocolContent(record.content);
          messages.push({
            role: record.role,
            content: record.content,
            timestamp: record.ts,
            id: record.id,
            interactionId: record.interactionId,
            state: record.state,
          });
        }
      } catch (error) {
        if (error instanceof ModelError) throw error;
        // 遇到半截脏行忽略，实现容错恢复
      }
    }

    // 崩溃自愈：检查历史末尾是否存在悬挂的 tool_use
    this.healDanglingToolCalls(messages);

    return messages;
  }

  /** 删除整个文件；文件不存在时静默成功。 */
  async clear(): Promise<void> {
    if (fs.existsSync(this.filePath)) {
      fs.unlinkSync(this.filePath);
    }
  }

  /**
   * 历史自愈(设计文档 §4.4)：逐条扫描 assistant 的 tool_use，
   * 若其后的 tool 消息未完整覆盖这些 tool_use，就地补一条 is_error 的 tool_result。
   *
   * 之所以做**全历史扫描**而非只看末条：崩溃可能发生在任意一轮工具执行中途，
   * 悬挂的 tool_use 未必位于历史末尾(例如中断后用户又继续提了问)。
   * 只看末条会漏掉夹在中间的悬挂，下一次请求仍会因上下文非法而 400。
   */
  private healDanglingToolCalls(messages: CanonicalMessage[]): void {
    const healed: CanonicalMessage[] = [];
    let pending = new Map<string, ToolUseBlock>();
    let pendingTimestamp: number | undefined;
    let pendingInteraction: string | undefined;

    const closePending = () => {
      if (pending.size === 0) return;
      healed.push({
        role: 'tool',
        content: Array.from(pending.values()).map(
          (toolUse: ToolUseBlock): ToolResultBlock => ({
            type: 'tool_result',
            toolUseId: toolUse.id,
            content: 'Tool execution was interrupted or crashed in previous session',
            isError: true,
            errorCode: 'OUTCOME_UNKNOWN',
            retryPolicy: 'after_user_action',
          }),
        ),
        timestamp: pendingTimestamp,
        interactionId: pendingInteraction,
      });
      pending = new Map();
    };

    for (const msg of messages) {
      if (msg.role === 'tool') {
        // 结果只允许满足紧邻 assistant 打开的调用集合；迟到、重复和孤儿结果全部剔除。
        const valid = msg.content.filter((block): block is ToolResultBlock => {
          if (!isToolResultBlock(block) || !pending.has(block.toolUseId)) return false;
          pending.delete(block.toolUseId);
          return true;
        });
        if (valid.length === 0) continue;
        healed.push(valid.length === msg.content.length ? msg : { ...msg, content: valid });
        continue;
      }

      // 任何非 tool 消息都结束上一组调用；先补齐缺失结果，再接收新消息。
      closePending();
      healed.push(msg);
      if (msg.role !== 'assistant') continue;

      const toolUses = msg.content.filter(isToolUseBlock);
      if (toolUses.length === 0) continue;
      pending = new Map(toolUses.map((toolUse) => [toolUse.id, toolUse]));
      pendingTimestamp = msg.timestamp;
      pendingInteraction = msg.interactionId;
    }

    closePending();

    messages.length = 0;
    messages.push(...healed);
  }
}
