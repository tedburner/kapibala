/**
 * @fileoverview MCP 模型工具定义预算筛选与白名单/黑名单精确过滤
 *
 * 约束与边界：
 * 1. 模型 MCP 工具定义总预算严格限制为 64 KiB（65536 字节）且数量最多 64 个工具；
 * 2. 稳定排序：按 Server 配置名正序、工具规范名正序排序，确保不同执行轮次中模型看到的工具定义次序稳定；
 * 3. 严格整项截取：若加入某个工具会导致总字节数或总数量超限，必须整项省略（omitted）该工具，绝不输出残缺 JSON；
 * 4. 被省略的工具在本 run 中对模型不可见且不可调用，诊断记录列出省略原因；
 * 5. 支持 includeTools（白名单）与 excludeTools（黑名单）精确过滤。
 */

/** 模型可见 MCP 工具定义最大总字节数（64 KiB）。 */
export const MAX_MODEL_MCP_TOOLS_BUDGET_BYTES = 65536;

/** 模型可见 MCP 工具最大数量（64 个）。 */
export const MAX_MODEL_MCP_TOOLS_COUNT = 64;

/**
 * 候选工具项结构。
 */
export interface CandidateMcpTool {
  /** 规范工具名（如 mcp__git__status）。 */
  normalizedName: string;
  /** 原始工具名（如 status）。 */
  rawName: string;
  /** 所属 MCP 服务配置名。 */
  serverName: string;
  /** 工具描述文本。 */
  description: string;
  /** 已经过校验的 inputSchema。 */
  inputSchema: Record<string, unknown>;
  /** 对应工具实现的确定性摘要。 */
  toolDigest: string;
}

/**
 * 被过滤或超限省略的工具记录。
 */
export interface OmittedMcpTool {
  normalizedName: string;
  serverName: string;
  reason: 'filtered_by_include' | 'filtered_by_exclude' | 'schema_invalid' | 'budget_exceeded';
  detail?: string;
}

/**
 * 预算与过滤选项。
 */
export interface FilterAndBudgetOptions {
  /** 工具白名单（原始工具名列表）。 */
  includeTools?: string[];
  /** 工具黑名单（原始工具名列表）。 */
  excludeTools?: string[];
  /** 自定义总字节上限，默认 65536。 */
  maxTotalBytes?: number;
  /** 自定义工具数量上限，默认 64。 */
  maxToolCount?: number;
}

/**
 * 预算筛选结果。
 */
export interface FilterAndBudgetResult {
  /** 成功通过筛选并可在本 run 发布给模型的工具列表（按 server 及 name 稳定升序）。 */
  publishedTools: CandidateMcpTool[];
  /** 被过滤或预算超限省略的工具记录。 */
  omittedTools: OmittedMcpTool[];
  /** 发布的工具定义总序列化字节数。 */
  totalBytes: number;
}

/**
 * 对候选 MCP 工具集合执行白名单/黑名单过滤、稳定排序以及 64 KiB/64 工具预算整项截取。
 *
 * @param candidates - 原始候选工具列表。
 * @param options - 过滤与预算配置。
 * @returns 预算筛选与发布结果。
 */
export function filterAndBudgetTools(
  candidates: CandidateMcpTool[],
  options: FilterAndBudgetOptions = {},
): FilterAndBudgetResult {
  const maxBytes = options.maxTotalBytes ?? MAX_MODEL_MCP_TOOLS_BUDGET_BYTES;
  const maxCount = options.maxToolCount ?? MAX_MODEL_MCP_TOOLS_COUNT;

  const includeSet = options.includeTools ? new Set(options.includeTools) : null;
  const excludeSet = options.excludeTools ? new Set(options.excludeTools) : null;

  const filteredCandidates: CandidateMcpTool[] = [];
  const omittedTools: OmittedMcpTool[] = [];

  // 1. 白名单与黑名单精确过滤
  for (const tool of candidates) {
    if (includeSet && !includeSet.has(tool.rawName) && !includeSet.has(tool.normalizedName)) {
      omittedTools.push({
        normalizedName: tool.normalizedName,
        serverName: tool.serverName,
        reason: 'filtered_by_include',
        detail: `Tool '${tool.rawName}' is not in includeTools whitelist`,
      });
      continue;
    }

    if (excludeSet && (excludeSet.has(tool.rawName) || excludeSet.has(tool.normalizedName))) {
      omittedTools.push({
        normalizedName: tool.normalizedName,
        serverName: tool.serverName,
        reason: 'filtered_by_exclude',
        detail: `Tool '${tool.rawName}' is listed in excludeTools blacklist`,
      });
      continue;
    }

    filteredCandidates.push(tool);
  }

  // 2. 稳定排序：按 serverName 升序，再按 normalizedName 升序
  filteredCandidates.sort((a, b) => {
    const serverCmp = a.serverName.localeCompare(b.serverName);
    if (serverCmp !== 0) return serverCmp;
    return a.normalizedName.localeCompare(b.normalizedName);
  });

  // 3. 预算整项截取
  const publishedTools: CandidateMcpTool[] = [];
  let currentBytes = 0;

  for (const tool of filteredCandidates) {
    if (publishedTools.length >= maxCount) {
      omittedTools.push({
        normalizedName: tool.normalizedName,
        serverName: tool.serverName,
        reason: 'budget_exceeded',
        detail: `Tool count reached limit of ${maxCount}`,
      });
      continue;
    }

    // 估算模型可见定义（name, description, parameters）序列化开销
    const toolDefinitionJson = JSON.stringify({
      name: tool.normalizedName,
      description: tool.description,
      parameters: tool.inputSchema,
    });
    const toolBytes = Buffer.byteLength(toolDefinitionJson, 'utf8');

    if (currentBytes + toolBytes > maxBytes) {
      omittedTools.push({
        normalizedName: tool.normalizedName,
        serverName: tool.serverName,
        reason: 'budget_exceeded',
        detail: `Adding tool definition (${toolBytes} bytes) would exceed maximum budget of ${maxBytes} bytes (current: ${currentBytes})`,
      });
      continue;
    }

    publishedTools.push(tool);
    currentBytes += toolBytes;
  }

  return {
    publishedTools,
    omittedTools,
    totalBytes: currentBytes,
  };
}
