import { ModelError } from '../../errors/index.js';
import type { ModelProviderBinding } from '../../models/index.js';
import { projectProtocolHistory } from '../../models/protocol-state.js';
import type { CanonicalMessage, ModelRequest } from '../../types/index.js';
import { stableSerialize } from '../budget.js';

/**
 * 校验投影后的请求私有块完整性，并剥离来源不明的协议元数据。
 *
 * 约束与边界：
 * - 按「内容多重集」而非块索引对齐匹配：Hook 合法增删/重排同消息内的普通块时不误报；
 * - provider_state / redacted_thinking / 带来源的 thinking 属签名或私有溯源，缺失或不明
 *   即抛 {@link ModelError} fail-closed，签名前缀由冻结前缀校验兜底；
 * - 带 protocolMeta 的 text / tool_use 块若在源视图中找不到同内容原件，剥除
 *   protocolMeta（就地修改 projected），避免把宿主伪造的协议元数据发给厂商。
 */
export function verifyPrivateBlockIntegrity(
  projected: CanonicalMessage[],
  sourceView: readonly CanonicalMessage[],
): void {
  for (const message of projected) {
    const original = sourceView.find((source) => source.id === message.id);
    const privateBag = new Map<string, number>();
    const blockBag = new Map<string, number>();
    for (const block of original?.content ?? []) {
      const serialized = stableSerialize(block);
      if (
        block.type === 'provider_state' ||
        block.type === 'redacted_thinking' ||
        (block.type === 'thinking' && block.origin)
      )
        privateBag.set(serialized, (privateBag.get(serialized) ?? 0) + 1);
      blockBag.set(serialized, (blockBag.get(serialized) ?? 0) + 1);
    }
    const take = (bag: Map<string, number>, serialized: string): boolean => {
      const count = bag.get(serialized) ?? 0;
      if (!count) return false;
      if (count === 1) bag.delete(serialized);
      else bag.set(serialized, count - 1);
      return true;
    };
    for (const block of message.content) {
      if (
        block.type === 'provider_state' ||
        block.type === 'redacted_thinking' ||
        (block.type === 'thinking' && block.origin)
      ) {
        if (!original || !take(privateBag, stableSerialize(block)))
          throw new ModelError('Hook changed signed or private request provenance', {
            stage: 'request',
            retryable: false,
          });
      }
      if (block.type !== 'text' && block.type !== 'tool_use') continue;
      if (block.protocolMeta && !take(blockBag, stableSerialize(block)))
        block.protocolMeta = undefined;
    }
  }
}

/** 冻结前缀校验的依赖集合；投影与历史由调用方注入，函数保持纯校验语义。 */
export interface SignedContinuationCheck {
  /** 已完成投影与环境锚点注入的候选请求。 */
  candidate: ModelRequest;
  /** 上一成功请求；undefined 表示本次为本 run 首个请求，不冻结。 */
  previousRequest: ModelRequest | undefined;
  /** 本次 run 的原始（未投影）历史。 */
  history: readonly CanonicalMessage[];
  runId: string;
  /** 原生协议绑定；无绑定时按原样历史校验。 */
  nativeBinding: ModelProviderBinding | undefined;
  /** 会话投影函数（this.context.project），用于重放生成当前 run 的签名消息。 */
  projectHistory: (history: readonly CanonicalMessage[]) => CanonicalMessage[];
}

/**
 * 冻结续答前缀校验：本轮历史一旦出现签名私有块，身份、工具链与前缀全部冻结。
 *
 * 返回是否处于冻结状态（调用方据此把 ContextManager.prepare 的可剪裁参数取反）。
 * 保证 fail-closed：签名续答消息被增删改、前缀消息/系统提示词/工具定义发生任何
 * 序列化差异都抛 {@link ModelError}，绝不把被篡改的请求发往厂商。
 */
export function assertSignedContinuationStable(check: SignedContinuationCheck): boolean {
  const { candidate, previousRequest, history, runId, nativeBinding, projectHistory } = check;
  const frozen = Boolean(
    previousRequest &&
      history.some(
        (message) =>
          message.interactionId === runId &&
          message.content.some(
            (block) =>
              block.type === 'provider_state' ||
              block.type === 'redacted_thinking' ||
              (block.type === 'thinking' &&
                Boolean(block.signature && block.origin?.runId === runId)),
          ),
      ),
  );
  if (frozen) {
    const generated = nativeBinding
      ? projectProtocolHistory(
          projectHistory(history).filter(
            (message) => message.interactionId === runId && message.role !== 'user',
          ),
          nativeBinding,
          candidate.context,
        )
      : [];
    for (const original of generated) {
      const matches = candidate.messages.filter((message) => message.id === original.id);
      if (matches.length !== 1 || stableSerialize(matches[0]) !== stableSerialize(original))
        throw new ModelError('Signed continuation prefix or tool chain changed', {
          stage: 'request',
          retryable: false,
        });
    }
  }
  if (
    frozen &&
    previousRequest &&
    (stableSerialize(candidate.messages.slice(0, previousRequest.messages.length)) !==
      stableSerialize(previousRequest.messages) ||
      candidate.systemPrompt !== previousRequest.systemPrompt ||
      stableSerialize(candidate.tools) !== stableSerialize(previousRequest.tools))
  )
    throw new ModelError('Signed continuation prefix changed', {
      stage: 'request',
      retryable: false,
    });
  return frozen;
}
