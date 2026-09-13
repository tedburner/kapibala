import type {
  CanonicalMessage,
  ModelEvent,
  ModelRequest,
  ToolResultBlock,
} from '../types/index.js';

export interface ModelProvider {
  readonly name: string;
  create(req: ModelRequest): AsyncIterable<ModelEvent>;
  /** 把一批工具结果装配成符合本协议的 canonical 消息序列 */
  assembleToolResults(results: ToolResultBlock[]): CanonicalMessage[];
}

export * from './router.js';
