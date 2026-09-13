import fs from 'node:fs';
import path from 'node:path';
import {
  type CanonicalMessage,
  type ToolResultBlock,
  type ToolUseBlock,
  isToolResultBlock,
  isToolUseBlock,
} from '../types/index.js';
import type { MessageStore } from './index.js';

export class JSONLMessageStore implements MessageStore {
  readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = path.resolve(filePath);
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  async append(message: CanonicalMessage): Promise<void> {
    const record = {
      ts: message.timestamp ?? Date.now(),
      role: message.role,
      content: message.content,
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf-8');
  }

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
          messages.push({
            role: record.role,
            content: record.content,
            timestamp: record.ts,
          });
        }
      } catch {
        // 遇到半截脏行忽略，实现容错恢复
      }
    }

    // 崩溃自愈：检查历史末尾是否存在悬挂的 tool_use
    this.healDanglingToolCalls(messages);

    return messages;
  }

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
    const declared = new Set<string>();

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]!;

      if (msg.role === 'tool') {
        // 孤儿 tool_result(没有任何 assistant 声明过该 tool_call_id)会让下游直接 400，直接剔除
        const valid = msg.content.filter(
          (block): block is ToolResultBlock =>
            isToolResultBlock(block) && declared.has(block.toolUseId),
        );
        if (valid.length === 0) continue;
        healed.push(valid.length === msg.content.length ? msg : { ...msg, content: valid });
        continue;
      }

      healed.push(msg);
      if (msg.role !== 'assistant') continue;

      const toolUses = msg.content.filter(isToolUseBlock);
      if (toolUses.length === 0) continue;
      for (const tu of toolUses) declared.add(tu.id);

      // 统计紧随其后的连续 tool 消息已覆盖了哪些 tool_use
      const satisfied = new Set<string>();
      for (let j = i + 1; j < messages.length && messages[j]!.role === 'tool'; j++) {
        for (const block of messages[j]!.content) {
          if (isToolResultBlock(block)) satisfied.add(block.toolUseId);
        }
      }

      const missing = toolUses.filter((tu) => !satisfied.has(tu.id));
      if (missing.length === 0) continue;

      // complete-with-error(§4.3)：补齐中断/崩溃遗留的 tool_result，保证历史闭合
      healed.push({
        role: 'tool',
        content: missing.map(
          (tu: ToolUseBlock): ToolResultBlock => ({
            type: 'tool_result',
            toolUseId: tu.id,
            content: 'Tool execution was interrupted or crashed in previous session',
            isError: true,
          }),
        ),
        timestamp: Date.now(),
      });
    }

    messages.length = 0;
    messages.push(...healed);
  }
}
