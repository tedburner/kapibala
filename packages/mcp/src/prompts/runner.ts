/**
 * @fileoverview MCP Prompt 任务准备与角色标签降级执行器
 *
 * 约束与边界：
 * 1. 角色标签降级：服务端返回的 user/assistant 消息序列按顺序组装为一段带角色标签的文本，
 *    绝对不伪造真实的 assistant 消息，不提升为 system 消息；
 * 2. 文本内容约束：仅支持文本内容；若包含无可读文本或必需的二进制块，明确抛出 MCP_PROMPT_UNSUPPORTED；
 * 3. 最终提交前复核（verifyIdentity）：核对 generation、promptsCatalogEpoch 与 contentDigest，
 *    若在准备或预算等待期间发生目录变更，立即拒绝提交并报错 MCP_PROMPT_CHANGED；
 * 4. 显式调用标识不包含 arguments-json：避免敏感参数在命令标识中无界暴露。
 */

import type { PreparedTaskResult, PromptContentSource } from '@kiturone/kapibala';
import type { McpClientSession } from '../client.js';
import type { McpPromptDefinition } from './registry.js';
import { validatePromptArguments } from './validator.js';

/**
 * Prompt 任务执行准备配置选项。
 */
export interface PreparePromptTaskOptions {
  /** 目标 Prompt 定义元数据。 */
  prompt: McpPromptDefinition;
  /** 用户传入的原始参数（JSON 字符串或字典）。 */
  rawArguments?: string | Record<string, unknown>;
  /** 用户显式附加的任务补充说明正文。 */
  userTaskText?: string;
  /** 客户端会话句柄。 */
  session: McpClientSession;
  /** 显式取消信号。 */
  signal?: AbortSignal;
  /** 当前最新的 Prompt 定义快照获取函数，用于提交前同步身份复核。 */
  getCurrentPrompt: () => McpPromptDefinition | undefined;
}

/**
 * 将远端返回的 Prompt 消息转换为带角色标签的降级文本。
 *
 * @param messages - 远端返回的消息列表。
 * @param description - 可选 Prompt 描述。
 * @returns 角色标签降级后的纯文本内容。
 * @throws 当包含不支持的二进制块或无可读文本时抛出 MCP_PROMPT_UNSUPPORTED。
 */
export function formatPromptMessagesWithRoleTags(
  messages: Array<{
    role: string;
    content: unknown;
  }>,
  description?: string,
): string {
  if (!messages || messages.length === 0) {
    throw new Error('MCP server returned empty messages array for prompt');
  }

  const sections: string[] = [];

  if (description && description.trim().length > 0) {
    sections.push(`[Prompt Description]\n${description.trim()}\n`);
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const role = msg.role || 'user';
    let textContent = '';

    const content = msg.content;
    if (typeof content === 'string') {
      textContent = content;
    } else if (typeof content === 'object' && content !== null) {
      if (
        'type' in content &&
        (content as any).type === 'text' &&
        typeof (content as any).text === 'string'
      ) {
        textContent = (content as any).text;
      } else if (
        'type' in content &&
        ((content as any).type === 'image' || (content as any).type === 'resource')
      ) {
        // 必需的二进制/多媒体块直接拒绝，不把残缺模板当做完整成功
        throw new Error(
          `MCP prompt contains unsupported non-text content block (type='${(content as any).type}'); only text blocks are supported`,
        );
      } else {
        // 尝试提取普通文本或确定性序列化
        textContent = JSON.stringify(content);
      }
    }

    if (!textContent || textContent.trim().length === 0) {
      throw new Error(`MCP prompt message at index ${i} contains no readable text content`);
    }

    sections.push(`Role: ${role}\n${textContent.trim()}`);
  }

  return sections.join('\n\n');
}

/**
 * 准备受控 MCP Prompt 任务（供 AgentSession.runPreparedTask 调用）。
 *
 * @param options - 准备选项。
 * @returns 包含任务命令、正文与 promptSource 的准备结果。
 */
export async function prepareMcpPromptTask(options: PreparePromptTaskOptions): Promise<{
  userInput: string;
  result: PreparedTaskResult;
}> {
  const { prompt, rawArguments, userTaskText, session, getCurrentPrompt } = options;

  // 1. 严格校验参数
  const validation = validatePromptArguments(prompt, rawArguments);
  if (!validation.valid) {
    throw new Error(validation.error);
  }
  const validatedArgs = validation.arguments;

  // 获取前复核当前 session 状态与 epoch
  if (
    session.connectionState !== 'ready' ||
    session.promptsState !== 'ready' ||
    session.generation !== prompt.serverGeneration ||
    session.promptsCatalogEpoch !== prompt.catalogEpoch
  ) {
    throw new Error(
      `MCP_PROMPT_CHANGED: Server '${prompt.server}' prompts state or epoch changed before fetch`,
    );
  }

  // 2. 调用远端获取 Prompt 模板（透传取消信号与超时）
  const getPromptResult = await session.client.getPrompt(
    {
      name: prompt.name,
      arguments: validatedArgs,
    },
    {
      signal: options.signal,
    },
  );

  if (!getPromptResult || !getPromptResult.messages) {
    throw new Error(`Failed to get prompt '${prompt.stableId}': server returned no messages`);
  }

  // 3. 角色标签降级
  let promptText: string;
  try {
    promptText = formatPromptMessagesWithRoleTags(
      getPromptResult.messages as any,
      getPromptResult.description,
    );
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    throw new Error(`MCP_PROMPT_UNSUPPORTED: ${errorMsg}`);
  }

  // 4. 组装 promptSource v1
  const promptSource: PromptContentSource = {
    version: 1,
    server: prompt.server,
    name: prompt.name,
    scope: prompt.scope,
    contentDigest: prompt.contentDigest,
  };

  // 5. 组装用户端任务标识：/prompt <server>/<name>（不含 arguments-json）
  const commandIdentifier = `/prompt ${prompt.stableId}`;
  const userInput =
    userTaskText && userTaskText.trim().length > 0
      ? `${commandIdentifier}\n\n${userTaskText.trim()}`
      : commandIdentifier;

  // 6. 构造 PreparedTaskResult，带最终提交前的同步身份复核 verifyIdentity
  const expectedGeneration = prompt.serverGeneration;
  const expectedEpoch = prompt.catalogEpoch;
  const expectedDigest = prompt.contentDigest;

  const result: PreparedTaskResult = {
    content: promptText,
    promptSource,
    verifyIdentity: () => {
      // 1. 复核活动 session 的连接状态与能力状态
      if (session.connectionState !== 'ready' || session.promptsState !== 'ready') {
        return false;
      }
      // 2. 复核活动 session 的实时 generation 与 promptsCatalogEpoch
      if (
        session.generation !== expectedGeneration ||
        session.promptsCatalogEpoch !== expectedEpoch
      ) {
        return false;
      }
      // 3. 复核注册表项
      const current = getCurrentPrompt();
      if (!current) {
        return false;
      }
      return (
        current.serverGeneration === expectedGeneration &&
        current.catalogEpoch === expectedEpoch &&
        current.contentDigest === expectedDigest
      );
    },
  };

  return {
    userInput,
    result,
  };
}
