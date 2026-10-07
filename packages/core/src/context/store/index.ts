import type { CanonicalMessage } from '../../types/index.js';

/**
 * 消息级持久化最小契约：user、assistant、tool 三类消息逐条经 append 落盘，
 * load 恢复原始正文（而非模型请求投影），clear 实现 SDK 清空语义。
 * 需要持久压缩、交互终态等能力的宿主另实现 StatefulMessageStore。
 */
export interface MessageStore {
  append(message: CanonicalMessage): Promise<void>;
  load(): Promise<CanonicalMessage[]>;
  clear(): Promise<void>;
}

export * from './jsonl.js';
