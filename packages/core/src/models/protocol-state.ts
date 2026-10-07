import { createHash, randomUUID } from 'node:crypto';
import { ModelError } from '../errors/index.js';
import type {
  CanonicalMessage,
  ContentBlock,
  ModelRequest,
  ProtocolOrigin,
} from '../types/index.js';
import type { ModelProviderBinding } from './index.js';

function invalidState(): never {
  throw new ModelError('Invalid protocol state or provenance', {
    code: 'MODEL_INVALID_RESPONSE',
    stage: 'request',
    retryable: false,
  });
}

/** 端点/工作区来源不包含密钥；同一运行绑定保持稳定，跨运行不复用私有状态。 */
export function endpointScope(target: ModelProviderBinding): string {
  return createHash('sha256')
    .update(`${target.baseURL.replace(/\/+$/, '')}\0${target.workspaceId ?? ''}`)
    .digest('hex');
}

/** 原生输出记录其来源；直接 SDK 未提供 run 时生成独立身份，避免未知状态串用。 */
export function createProtocolOrigin(
  target: ModelProviderBinding & { protocol: 'anthropic' | 'openai-responses' },
  context?: ModelRequest['context'],
): ProtocolOrigin {
  return {
    version: 1,
    protocol: target.protocol,
    modelName: target.modelName,
    modelId: context?.modelId,
    runId: context?.runId ?? `unmanaged-${randomUUID()}`,
    endpointScope: endpointScope(target),
  };
}

function validOrigin(value: unknown): value is ProtocolOrigin {
  if (!value || typeof value !== 'object') return false;
  const origin = value as ProtocolOrigin;
  return (
    origin.version === 1 &&
    ['anthropic', 'openai-responses'].includes(origin.protocol) &&
    typeof origin.modelName === 'string' &&
    !!origin.modelName &&
    typeof origin.runId === 'string' &&
    !!origin.runId &&
    typeof origin.endpointScope === 'string' &&
    /^[a-f0-9]{64}$/.test(origin.endpointScope) &&
    (origin.modelId === undefined || typeof origin.modelId === 'string')
  );
}

/** 普通 Item 阶段只要求同目标协议/模型；与密文的同 run 规则分开。 */
export function sameProtocolModel(origin: ProtocolOrigin, target: ModelProviderBinding): boolean {
  return (
    validOrigin(origin) &&
    origin.protocol === target.protocol &&
    origin.modelName === target.modelName &&
    origin.endpointScope === endpointScope(target)
  );
}

/** 私有签名/密文只允许同 run、同模型、同端点和同 Profile 的有效续答。 */
export function privateReplayAllowed(
  origin: ProtocolOrigin | undefined,
  target: ModelProviderBinding,
  context?: ModelRequest['context'],
): boolean {
  return (
    !!origin &&
    !!context?.runId &&
    sameProtocolModel(origin, target) &&
    origin.runId === context.runId &&
    origin.modelId === context.modelId
  );
}

/** 校验结果按对象引用缓存；原始历史跨请求重复投影，避免每次全量重校验与 16MB 序列化。 */
const validatedBlocks = new WeakMap<object, true>();
const validatedContents = new WeakMap<object, true>();

/** 校验新增私有块和 Item 元数据，旧普通块维持原语义；坏状态不能进入请求或落盘。 */
export function validateProtocolContent(content: readonly ContentBlock[]): void {
  if (validatedContents.get(content as object)) return;
  for (const block of content) {
    if (!block || typeof block !== 'object') invalidState();
    if (validatedBlocks.get(block)) continue;
    if ('origin' in block && block.origin !== undefined && !validOrigin(block.origin))
      invalidState();
    if ('protocolMeta' in block && block.protocolMeta !== undefined) {
      const meta = block.protocolMeta;
      if (
        !meta ||
        !validOrigin(meta.origin) ||
        !Number.isSafeInteger(meta.itemIndex) ||
        meta.itemIndex < 0 ||
        (meta.itemId !== undefined && (typeof meta.itemId !== 'string' || !meta.itemId)) ||
        (meta.contentIndex !== undefined &&
          (!Number.isSafeInteger(meta.contentIndex) || meta.contentIndex < 0)) ||
        (meta.phase !== undefined && !['commentary', 'final_answer'].includes(meta.phase)) ||
        (meta.contentType !== undefined &&
          !['output_text', 'refusal'].includes(meta.contentType)) ||
        (meta.arguments !== undefined && typeof meta.arguments !== 'string')
      )
        invalidState();
    }
    if (block.type === 'provider_state') {
      const item = block.item;
      if (
        !validOrigin(block.origin) ||
        block.origin.protocol !== 'openai-responses' ||
        !item ||
        item.type !== 'reasoning' ||
        typeof item.id !== 'string' ||
        !item.id ||
        !Array.isArray(item.summary) ||
        item.summary.some((s) => !s || s.type !== 'summary_text' || typeof s.text !== 'string') ||
        (item.encrypted_content !== undefined && typeof item.encrypted_content !== 'string') ||
        (item.status !== undefined &&
          !['completed', 'in_progress', 'incomplete'].includes(item.status))
      )
        invalidState();
      try {
        if (JSON.stringify(item).length > 16 * 1024 * 1024) invalidState();
      } catch {
        invalidState();
      }
    }
    validatedBlocks.set(block, true);
  }
  validatedContents.set(content as object, true);
}

/** 独立协议请求投影；不改原始历史，跨模型保留文字/工具语义并移除不适用私有状态。 */
export function projectProtocolHistory(
  messages: readonly CanonicalMessage[],
  target: ModelProviderBinding,
  context?: ModelRequest['context'],
): CanonicalMessage[] {
  return messages.map((message) => {
    validateProtocolContent(message.content);
    const copy = structuredClone(message);
    copy.content = copy.content.flatMap((block): ContentBlock[] => {
      if (block.type === 'provider_state')
        return privateReplayAllowed(block.origin, target, context) &&
          (block.item.status === undefined || block.item.status === 'completed')
          ? [block]
          : [];
      if (block.type === 'redacted_thinking')
        return privateReplayAllowed(block.origin, target, context) ? [block] : [];
      if (block.type === 'thinking') {
        if (privateReplayAllowed(block.origin, target, context)) return [block];
        if (!block.origin && target.protocol === 'openai-compatible') return [block];
        return block.thinking ? [{ type: 'text', text: block.thinking }] : [];
      }
      if (
        (block.type === 'text' || block.type === 'tool_use') &&
        block.protocolMeta &&
        !sameProtocolModel(block.protocolMeta.origin, target)
      )
        block.protocolMeta = undefined;
      return [block];
    });
    return copy;
  });
}

/** 摘要仅消费可见文本和工具语义，剔除签名、密文与协议 Item 来源。 */
export function summarySafeMessage(message: CanonicalMessage): CanonicalMessage {
  const copy = structuredClone(message);
  copy.content = copy.content.flatMap((block): ContentBlock[] => {
    if (block.type === 'provider_state' || block.type === 'redacted_thinking') return [];
    if (block.type === 'thinking')
      return block.thinking ? [{ type: 'text', text: block.thinking }] : [];
    if (block.type === 'text' || block.type === 'tool_use') block.protocolMeta = undefined;
    return [block];
  });
  return copy;
}
