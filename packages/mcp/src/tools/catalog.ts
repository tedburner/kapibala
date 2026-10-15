/**
 * @fileoverview MCP 工具完整分页发现、Schema 校验与原子发布
 *
 * 约束与边界：
 * 1. 完整分页获取：支持基于 cursor 的多页加载；单个服务硬上限为最多 20 页、最多 200 个工具；
 * 2. 重复 cursor 防护：若服务端返回重复 cursor 导致死循环，立即中止并标记为 stale，保留旧目录；
 * 3. 严格全有或全无（All-or-Nothing）：分页加载若发生网络异常、超时或某页获取失败，整份候选批次拒绝发布，绝不发布半残的残缺目录；
 * 4. 原子发布：通过 ToolRegistry.replaceSource 机制原子替换该来源的工具集合，旧运行快照不可变不受影响。
 */

import type { ToolRegistry } from '@kiturone/kapibala';
import type { McpClientSession } from '../client.js';
import type { ServerConfig } from '../config.js';
import { createMcpToolAdapter } from './adapter.js';
import {
  type CandidateMcpTool,
  type FilterAndBudgetResult,
  filterAndBudgetTools,
} from './budget.js';
import { computeToolDefinitionDigest, normalizeToolName } from './naming.js';
import { validateToolInputSchema } from './schema.js';

/** 单服务分页获取最大页数限制。 */
export const MAX_PAGES_LIMIT = 20;

/** 单服务工具最大总量硬上限。 */
export const MAX_TOOLS_PER_SERVER_LIMIT = 200;

/**
 * 工具目录发现与发布结果。
 */
export interface DiscoverAndPublishResult {
  /** 最终发布的工具数量。 */
  publishedCount: number;
  /** 预算或校验省略的工具数量。 */
  omittedCount: number;
  /** 预算筛选详情。 */
  budgetResult: FilterAndBudgetResult;
}

/**
 * 完整分页获取指定 MCP 服务的工具列表，执行 Schema 校验、预算筛选并原子发布到 ToolRegistry。
 *
 * @param session - 当前处于 ready 状态的客户端会话。
 * @param config - 服务配置。
 * @param toolRegistry - 宿主共享的 ToolRegistry 实例。
 * @param catalogTimeoutMs - 目录发现超时时间（毫秒）。
 * @returns 发现与发布结果。
 * @throws 分页中断或网络错误时抛出异常（整批候选拒绝发布）。
 */
export async function discoverAndPublishTools(
  session: McpClientSession,
  config: ServerConfig,
  toolRegistry: ToolRegistry,
  catalogTimeoutMs = 10000,
  verifyBeforePublish?: () => boolean,
): Promise<DiscoverAndPublishResult> {
  const serverName = session.serverName;
  const source = `mcp:${serverName}`;

  // 1. 分页加载全部原始工具
  const rawTools: any[] = [];
  const seenCursors = new Set<string>();
  let currentCursor: string | undefined = undefined;
  let pageCount = 0;

  while (pageCount < MAX_PAGES_LIMIT) {
    pageCount += 1;

    let response: any;
    try {
      const listParams = currentCursor ? { cursor: currentCursor } : undefined;
      response = await session.client.listTools(listParams as any, {
        timeout: catalogTimeoutMs,
      });
    } catch (err: unknown) {
      // 分页不完整整批拒绝发布
      throw new Error(
        `Failed to complete paged tool discovery for server '${serverName}' on page ${pageCount}: ${(err as Error).message}`,
      );
    }

    const pageTools = response?.tools ?? [];
    rawTools.push(...pageTools);

    if (rawTools.length >= MAX_TOOLS_PER_SERVER_LIMIT) {
      break;
    }

    const nextCursor = response?.nextCursor;
    if (!nextCursor || typeof nextCursor !== 'string') {
      break;
    }

    // 重复 cursor 检查
    if (seenCursors.has(nextCursor)) {
      break;
    }
    seenCursors.add(nextCursor);
    currentCursor = nextCursor;
  }

  // 2. 校验与构建候选工具
  const candidates: CandidateMcpTool[] = [];
  const omittedTools: FilterAndBudgetResult['omittedTools'] = [];

  for (const raw of rawTools) {
    if (!raw.name || typeof raw.name !== 'string') continue;

    // Schema 校验
    const schemaValidation = validateToolInputSchema(raw.inputSchema);
    const normalizedName = normalizeToolName(serverName, raw.name);

    if (!schemaValidation.valid) {
      omittedTools.push({
        normalizedName,
        serverName,
        reason: 'schema_invalid',
        detail: schemaValidation.error,
      });
      continue;
    }

    const toolDigest = computeToolDefinitionDigest({
      name: raw.name,
      description: raw.description,
      inputSchema: raw.inputSchema,
    });

    candidates.push({
      normalizedName,
      rawName: raw.name,
      serverName,
      description: raw.description || '',
      inputSchema: (raw.inputSchema as Record<string, unknown>) ?? {},
      toolDigest,
    });
  }

  // 3. 预算与黑白名单筛选
  const budgetResult = filterAndBudgetTools(candidates, {
    includeTools: config.includeTools,
    excludeTools: config.excludeTools,
  });
  budgetResult.omittedTools.push(...omittedTools);

  // 4. 构建 Core Tool 适配器实例
  const targetGeneration = session.generation;
  const targetCatalogEpoch = session.toolsCatalogEpoch;
  const requireNetOutbound = 'url' in config && typeof (config as any).url === 'string';

  const adaptedTools = budgetResult.publishedTools.map((candidate) =>
    createMcpToolAdapter({
      candidate,
      getSession: () => session,
      targetGeneration,
      targetCatalogEpoch,
      requireNetOutbound,
      requestTimeoutMs: config.requestTimeoutMs,
    }),
  );

  // 5. 原子发布替换到 ToolRegistry（发布前复核 session / generation / epoch 身份）
  if (verifyBeforePublish && !verifyBeforePublish()) {
    return {
      publishedCount: 0,
      omittedCount: budgetResult.omittedTools.length,
      budgetResult,
    };
  }

  toolRegistry.replaceSource(source, adaptedTools);

  return {
    publishedCount: adaptedTools.length,
    omittedCount: budgetResult.omittedTools.length,
    budgetResult,
  };
}
