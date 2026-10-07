import type {
  CanonicalMessage,
  ModelEvent,
  ModelRequest,
  ToolResultBlock,
} from '../types/index.js';
import type { ModelProtocol } from './router.js';

/** 内置适配器的实际请求目标；用于拒绝模型、协议或端点错配的绑定。 */
export interface ModelProviderBinding {
  protocol: ModelProtocol;
  modelName: string;
  baseURL: string;
  workspaceId?: string;
}

/** 协议适配器：把 canonical 请求翻译为 wire 协议并流式返回事件。 */
export interface ModelProvider {
  /** 用于诊断与脱敏说明的稳定名称。 */
  readonly name: string;
  readonly binding?: ModelProviderBinding;
  /** 内置 Provider 凭据是否可用；自定义无需鉴权的 Provider 可省略。 */
  readonly credentialsReady?: boolean;
  /** 发起一次模型调用；signal 取消时立即停止，实现负责协议翻译、私有状态校验与流清理。 */
  create(req: ModelRequest): AsyncIterable<ModelEvent>;
  /** 返回统一 canonical tool 消息；wire 角色转换仅发生在请求翻译阶段。 */
  assembleToolResults(results: ToolResultBlock[]): CanonicalMessage[];
}

/** 按消息级事务装配工具结果；任何协议都不得把 wire user/Item 写为历史角色。 */
export function assembleCanonicalToolResults(results: ToolResultBlock[]): CanonicalMessage[] {
  return results.map((result) => ({
    role: 'tool',
    content: [structuredClone(result)],
    timestamp: Date.now(),
  }));
}

export * from './router.js';
