/**
 * @fileoverview MCP Prompt 注册表与目录管理
 *
 * 约束与边界：
 * 1. Prompt 唯一稳定 ID 格式为 `<server>/<prompt>`，与工具命名 `mcp__<server>__<tool>` 严格分离，杜绝解析歧义；
 * 2. 搜索操作 `search()` 仅基于内存元数据快速检索，绝不预取远端 Prompt 模板正文；
 * 3. 独立 epoch 与 refreshToken 机制，Prompts 刷新与通知暂停提交绝不影响或撤销 Tools 目录；
 * 4. 同名 Prompt 跨 Server 隔离，通过 `<server>/<prompt>` 明确归属；
 * 5. 目录故障判定为 unavailable，不冒充空集成功。
 */

import { createHash } from 'node:crypto';
import type { McpClientSession } from '../client.js';

/**
 * Prompt 参数声明契约。
 */
export interface McpPromptArgument {
  /** 参数名称。 */
  name: string;
  /** 参数用途说明。 */
  description?: string;
  /** 是否为必填项。 */
  required?: boolean;
}

/**
 * 经过规范化并注册的 MCP Prompt 定义元数据。
 */
export interface McpPromptDefinition {
  /** 命令稳定标识符，格式为 `<server>/<name>`。 */
  stableId: string;
  /** 所属 MCP 服务端名称。 */
  server: string;
  /** 原始 Prompt 名称。 */
  name: string;
  /** Prompt 描述说明。 */
  description?: string;
  /** 参数列表。 */
  arguments?: McpPromptArgument[];
  /** 服务连接代次。 */
  serverGeneration: number;
  /** 目录版本纪元（catalogEpoch）。 */
  catalogEpoch: number;
  /** 基于名称、描述与参数确定性排序生成的 SHA-256 摘要。 */
  contentDigest: string;
  /** 声明所属作用域。 */
  scope?: 'global' | 'project';
}

/**
 * 确定性计算 Prompt 定义的 SHA-256 内容摘要。
 *
 * @param prompt - 原始 Prompt 结构。
 * @returns 64 位十六进制 SHA-256 哈希字符串。
 */
export function calculatePromptDigest(prompt: {
  name: string;
  description?: string;
  arguments?: McpPromptArgument[];
}): string {
  const normalizedArgs = (prompt.arguments ?? [])
    .map((arg) => ({
      name: arg.name,
      description: arg.description ?? '',
      required: Boolean(arg.required),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const canonicalPayload = JSON.stringify({
    name: prompt.name,
    description: prompt.description ?? '',
    arguments: normalizedArgs,
  });

  return createHash('sha256').update(canonicalPayload, 'utf-8').digest('hex');
}

/**
 * MCP Prompt 集中式注册表。
 */
export class McpPromptRegistry {
  private readonly promptsByServer = new Map<string, Map<string, McpPromptDefinition>>();

  /**
   * 原子替换指定 Server 暴露的全部 Prompt 定义。
   *
   * @param serverName - 服务名称。
   * @param prompts - 经过校验的 Prompt 列表。
   */
  replaceServerPrompts(serverName: string, prompts: McpPromptDefinition[]): void {
    const serverMap = new Map<string, McpPromptDefinition>();
    for (const prompt of prompts) {
      serverMap.set(prompt.name, prompt);
    }
    this.promptsByServer.set(serverName, serverMap);
  }

  /**
   * 移除指定 Server 的所有已注册 Prompt。
   *
   * @param serverName - 服务名称。
   */
  removeServerPrompts(serverName: string): void {
    this.promptsByServer.delete(serverName);
  }

  /**
   * 根据 stableId 获取指定的 Prompt 定义。
   *
   * @param stableId - 形如 `<server>/<name>` 的稳定标识。
   * @returns 匹配的 Prompt 定义，未找到返回 undefined。
   */
  get(stableId: string): McpPromptDefinition | undefined {
    const slashIdx = stableId.indexOf('/');
    if (slashIdx <= 0 || slashIdx === stableId.length - 1) {
      return undefined;
    }
    const serverName = stableId.slice(0, slashIdx);
    const promptName = stableId.slice(slashIdx + 1);

    const serverMap = this.promptsByServer.get(serverName);
    return serverMap?.get(promptName);
  }

  /**
   * 获取指定服务暴露的全部 Prompt 定义。
   *
   * @param serverName - 目标服务名。
   * @returns Prompt 列表。
   */
  getPromptsByServer(serverName: string): McpPromptDefinition[] {
    const serverMap = this.promptsByServer.get(serverName);
    return serverMap ? Array.from(serverMap.values()) : [];
  }

  /**
   * 纯元数据搜索，不拉取任何正文内容。
   *
   * @param query - 可选过滤字符串（匹配 stableId, name 或 description）。
   * @returns 匹配的 Prompt 定义列表。
   */
  search(query?: string): McpPromptDefinition[] {
    const allPrompts: McpPromptDefinition[] = [];
    for (const serverMap of this.promptsByServer.values()) {
      for (const prompt of serverMap.values()) {
        allPrompts.push(prompt);
      }
    }

    if (!query || query.trim() === '') {
      return allPrompts;
    }

    const q = query.trim().toLowerCase();
    return allPrompts.filter(
      (p) =>
        p.stableId.toLowerCase().includes(q) ||
        p.name.toLowerCase().includes(q) ||
        Boolean(p.description?.toLowerCase().includes(q)),
    );
  }

  /**
   * 获取所有已注册的 Prompt 数量。
   */
  get size(): number {
    let count = 0;
    for (const serverMap of this.promptsByServer.values()) {
      count += serverMap.size;
    }
    return count;
  }
}

/** 单服务 Prompt 分页最大页数上限。 */
export const MAX_PROMPT_PAGES_LIMIT = 20;

/** 单服务 Prompt 总量硬上限。 */
export const MAX_PROMPTS_PER_SERVER_LIMIT = 200;

/**
 * 完整分页获取指定 MCP 服务的 Prompt 列表，计算内容摘要并原子发布到 McpPromptRegistry。
 *
 * @param session - 处于连接状态的客户端会话。
 * @param promptRegistry - 目标 Prompt 注册表。
 * @param catalogTimeoutMs - 超时时间（毫秒），默认 10000ms。
 * @returns 发现与发布的 Prompt 数量。
 * @throws 当分页请求失败或超时时抛出异常（整批候选拒绝发布）。
 */
export async function discoverAndPublishPrompts(
  session: McpClientSession,
  promptRegistry: McpPromptRegistry,
  catalogTimeoutMs = 10000,
  verifyBeforePublish?: () => boolean,
): Promise<{ publishedCount: number }> {
  const serverName = session.serverName;
  const status = session.getStatus();

  // 若服务端未声明 prompts 能力，跳过发现并返回 0
  if (status.promptsState === 'unsupported') {
    promptRegistry.removeServerPrompts(serverName);
    return { publishedCount: 0 };
  }

  const rawPrompts: any[] = [];
  const seenCursors = new Set<string>();
  let currentCursor: string | undefined = undefined;
  let pageCount = 0;

  while (pageCount < MAX_PROMPT_PAGES_LIMIT) {
    pageCount += 1;

    let response: any;
    try {
      const listParams = currentCursor ? { cursor: currentCursor } : undefined;
      response = await session.client.listPrompts(listParams as any, {
        timeout: catalogTimeoutMs,
      });
    } catch (err: unknown) {
      // 分页失败整批拒绝发布
      throw new Error(
        `Failed to complete paged prompt discovery for server '${serverName}' on page ${pageCount}: ${(err as Error).message}`,
      );
    }

    const pageItems = response?.prompts ?? [];
    rawPrompts.push(...pageItems);

    if (rawPrompts.length >= MAX_PROMPTS_PER_SERVER_LIMIT) {
      break;
    }

    const nextCursor = response?.nextCursor;
    if (!nextCursor || typeof nextCursor !== 'string') {
      break;
    }

    if (seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    currentCursor = nextCursor;
  }

  // 构建规范化的 PromptDefinition 列表
  const definitions: McpPromptDefinition[] = [];
  for (const raw of rawPrompts) {
    if (!raw || typeof raw.name !== 'string' || raw.name.trim().length === 0) {
      continue;
    }
    const name = raw.name.trim();
    const digest = calculatePromptDigest({
      name,
      description: raw.description,
      arguments: raw.arguments,
    });

    definitions.push({
      stableId: `${serverName}/${name}`,
      server: serverName,
      name,
      description: typeof raw.description === 'string' ? raw.description : undefined,
      arguments: Array.isArray(raw.arguments) ? raw.arguments : undefined,
      serverGeneration: status.generation,
      catalogEpoch: status.promptsCatalogEpoch,
      contentDigest: digest,
    });
  }

  // 原子发布至注册表（发布前复核 session / generation / epoch 身份）
  if (verifyBeforePublish && !verifyBeforePublish()) {
    return { publishedCount: 0 };
  }

  promptRegistry.replaceServerPrompts(serverName, definitions);

  return { publishedCount: definitions.length };
}
