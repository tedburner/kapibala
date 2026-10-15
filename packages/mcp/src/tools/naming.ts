/**
 * @fileoverview MCP 工具规范命名与原始身份映射
 *
 * 约束与边界：
 * 1. 工具规范命名格式为 `mcp__<server>__<tool>`，字符仅允许字母、数字、下划线 `[a-zA-Z0-9_]`；
 * 2. 总长度严格限制在 64 字符以内，以保证主流模型协议（如 Anthropic / OpenAI / Gemini）的工具名边界兼容；
 * 3. 当工具名或服务名包含非法字符被清洗、或者总长超过 64 字符、或者发生命名碰撞时，
 *    通过确定性的哈希摘要（基于原始 server 与 tool 名）截断补齐，绝不依赖本次发现顺序决定谁保留短名；
 * 4. 无论正序还是倒序遍历发现，相同 Server/Tool 映射产生的规范名称保持绝对一致。
 */

import { createHash } from 'node:crypto';

/** 工具名称全局最大长度限制（64 字符）。 */
export const MAX_TOOL_NAME_LENGTH = 64;

/** 非法字符替换正则：非字母、数字、下划线的字符均替换为下划线。 */
const ILLEGAL_CHARS_REGEX = /[^a-zA-Z0-9_]/g;

/** 规范命名提取正则：匹配 `^mcp__([a-zA-Z0-9_-]+)__(.+)$` */
const NORMALIZED_TOOL_NAME_REGEX = /^mcp__([a-zA-Z0-9_]+)__(.+)$/;

/**
 * 清洗字符为模型协议安全字符。
 */
function sanitizeIdentifier(ident: string): string {
  return ident.replace(ILLEGAL_CHARS_REGEX, '_');
}

/**
 * 计算原始身份的确定性短哈希（8 字符十六进制）。
 */
function computeIdentityShortHash(serverName: string, rawToolName: string): string {
  return createHash('sha256')
    .update(`${serverName}::${rawToolName}`, 'utf8')
    .digest('hex')
    .slice(0, 8);
}

/**
 * 将原始 Server 名称与原始 Tool 名称规范化为全局唯一的 MCP 工具名。
 *
 * 保证：
 * - 格式为 `mcp__<server>__<tool>`；
 * - 长度 <= 64 字符；
 * - 若清洗后发生超长或变更，确定性附加 8 位哈希保证唯一且抗碰撞；
 * - 倒序发现时生成的名称与正序完全一致，不随运行期发现次序产生漂移。
 *
 * @param serverName - MCP 服务配置名称（已校验为合法标识符）。
 * @param rawToolName - 服务端暴露的原始工具名称。
 * @returns 规范化的全局唯一工具名称。
 */
export function normalizeToolName(serverName: string, rawToolName: string): string {
  const cleanServer = sanitizeIdentifier(serverName);
  const cleanTool = sanitizeIdentifier(rawToolName);
  const shortHash = computeIdentityShortHash(serverName, rawToolName);

  // 基础候选：mcp__<server>__<tool>
  const prefix = `mcp__${cleanServer}__`;
  const candidate = `${prefix}${cleanTool}`;

  // 若无清洗变动且未超长，直接采用短名
  if (cleanTool === rawToolName && candidate.length <= MAX_TOOL_NAME_LENGTH) {
    return candidate;
  }

  // 若原始名称有非法字符或超长，通过固定截断 + 8位唯一短哈希生成确定性安全名称
  // 结构：prefix + truncatedTool + "_" + shortHash (总长 <= 64)
  const maxAvailableToolLen = MAX_TOOL_NAME_LENGTH - prefix.length - 1 - shortHash.length;
  const safeToolPart = cleanTool.slice(0, Math.max(1, maxAvailableToolLen));

  return `${prefix}${safeToolPart}_${shortHash}`;
}

/**
 * 反向解析规范化的工具名称。
 *
 * @param normalizedName - 规范工具名称。
 * @returns 提取到的 serverName 与规范工具主体，若非合规 MCP 工具名返回 undefined。
 */
export function parseNormalizedToolName(
  normalizedName: string,
): { serverName: string; toolIdentifier: string } | undefined {
  if (!normalizedName || typeof normalizedName !== 'string') return undefined;
  const match = normalizedName.match(NORMALIZED_TOOL_NAME_REGEX);
  if (!match) return undefined;

  return {
    serverName: match[1],
    toolIdentifier: match[2],
  };
}

/**
 * 计算工具定义的确定性内容摘要（SHA-256），用于执行前指纹复核与防止定义篡改。
 *
 * @param toolDef - 工具原始定义结构。
 * @returns SHA-256 十六进制摘要。
 */
export function computeToolDefinitionDigest(toolDef: {
  name: string;
  description?: string;
  inputSchema?: unknown;
}): string {
  const canonicalString = JSON.stringify({
    name: toolDef.name,
    description: toolDef.description ?? '',
    inputSchema: toolDef.inputSchema ?? {},
  });

  return createHash('sha256').update(canonicalString, 'utf8').digest('hex');
}
