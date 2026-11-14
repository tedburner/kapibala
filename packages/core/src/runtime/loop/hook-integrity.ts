import type { ToolRegistrySnapshot } from '../../capabilities/tools/registry.js';
import { ModelError } from '../../errors/index.js';
import type { CanonicalMessage, ModelRequest } from '../../types/index.js';
import { stableSerialize } from '../../types/serialization.js';

/**
 * 校验 model:before 钩子未注入快照之外的工具、未漂移既有工具定义。
 *
 * 保证 fail-closed：钩子只能修改请求其余部分，不能凭空注入执行面或偷换
 * 工具描述/参数——否则权限裁决与协议投影都基于被篡改的定义进行。
 */
export function assertHookToolDefinitionsIntact(
  request: ModelRequest,
  snapshot: ToolRegistrySnapshot,
): void {
  if (!request.tools) return;
  for (const t of request.tools) {
    const original = snapshot.get(t.name);
    if (!original) {
      throw new ModelError(`Hook injected tool '${t.name}' not present in snapshot`, {
        stage: 'request',
        retryable: false,
      });
    }
    if (
      t.description !== original.description ||
      JSON.stringify(t.parameters) !== JSON.stringify(original.parameters)
    ) {
      throw new ModelError(
        `Hook mutated tool definition for '${t.name}' (description or parameters drifted from snapshot)`,
        {
          stage: 'request',
          retryable: false,
        },
      );
    }
  }
}

/** model:after 钩子触发前的消息完整性快照；全部字段为稳定序列化文本。 */
export interface AssistantIntegritySnapshot {
  /** 消息身份（除 content 外全部字段）的稳定序列化。 */
  identity: string;
  /** 已校验工具模型输出（tool_use 与 tool_result 块）的稳定序列化。 */
  originalTools: string;
  /** 完整内容的稳定序列化。 */
  originalContent: string;
  /** 内容是否含签名或私有块（provider_state / redacted_thinking / 带来源 thinking）。 */
  privateOutput: boolean;
  /** 内容是否携带工具调用；整批工具输出被钩子改写时拒绝。 */
  hasToolCalls: boolean;
}

/**
 * 钩子触发前采集 assistant 消息完整性快照。
 *
 * 保证：快照基于 stableSerialize 的确定性序列化，钩子在同消息内合法增删普通块
 * 不会改变 identity 基准（identity 不含 content）；privateOutput 只收紧不改宽。
 */
export function snapshotAssistantIntegrity(message: CanonicalMessage): AssistantIntegritySnapshot {
  return {
    identity: stableSerialize({ ...message, content: undefined }),
    originalTools: stableSerialize(
      message.content.filter((block) => block.type === 'tool_use' || block.type === 'tool_result'),
    ),
    originalContent: stableSerialize(message.content),
    privateOutput: message.content.some(
      (block) =>
        block.type === 'provider_state' ||
        block.type === 'redacted_thinking' ||
        (block.type === 'thinking' && Boolean(block.origin || block.signature)),
    ),
    hasToolCalls: message.content.some((block) => block.type === 'tool_use'),
  };
}

/**
 * model:after 钩子触发后校验消息未被越权改写。
 *
 * 保证与边界：
 * - 身份或已校验工具输出被改写：一律拒绝本轮结果；
 * - 签名/私有块被改写：拒绝，不区分改写来源；
 * - 普通正文改写：允许钩子改写纯文本内容，但不得携带工具调用（整批不能被偷换），
 *   且改写后的 text / tool_use 块剥除 protocolMeta，不得继承源 Item 身份。
 * 函数不调用 validateProtocolContent——调用方在钩子后按原顺序再做整批协议校验。
 */
export function assertAssistantMessageUntampered(
  message: CanonicalMessage,
  snapshot: AssistantIntegritySnapshot,
): void {
  if (snapshot.identity !== stableSerialize({ ...message, content: undefined }))
    throw new ModelError('Hook changed assistant message identity', {
      stage: 'request',
      retryable: false,
    });
  if (
    snapshot.originalTools !==
    stableSerialize(
      message.content.filter((block) => block.type === 'tool_use' || block.type === 'tool_result'),
    )
  )
    throw new ModelError('Hook changed validated tool model output', {
      stage: 'request',
      retryable: false,
    });
  if (snapshot.originalContent !== stableSerialize(message.content)) {
    if (
      snapshot.privateOutput ||
      message.content.some(
        (block) =>
          block.type === 'provider_state' ||
          block.type === 'redacted_thinking' ||
          (block.type === 'thinking' && Boolean(block.origin || block.signature)),
      )
    )
      throw new ModelError('Hook changed signed or private model output', {
        stage: 'request',
        retryable: false,
      });
    // 普通正文改写后不得继承源 Item 身份；有工具的整批不能被 Hook 偷换。
    if (snapshot.hasToolCalls)
      throw new ModelError('Hook changed validated tool model output', {
        stage: 'request',
        retryable: false,
      });
    for (const block of message.content)
      if (block.type === 'text' || block.type === 'tool_use') block.protocolMeta = undefined;
  }
}
