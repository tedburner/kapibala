/**
 * @fileoverview MCP Prompt 参数与权限校验器
 *
 * 约束与边界：
 * 1. 严格参数校验：支持 JSON 字符串或 Record<string, string> 输入；
 * 2. 必填字段缺失直接拒绝，未知参数严格报错拦截（禁止静默丢弃未知字段）；
 * 3. 严格受控权限：Plan 模式始终拒绝，deny 规则优先于用户意图；
 * 4. 服务状态校验：执行 Prompt 获取前必须确保对应 Server 的 prompts 能力处于 ready 状态。
 */

import type { SessionMode } from '@kiturone/kapibala';
import type { CapabilityCatalogState } from '../types.js';
import type { McpPromptDefinition } from './registry.js';

/**
 * Prompt 参数解析与校验结果。
 */
export type ValidatePromptArgsResult =
  | {
      valid: true;
      arguments: Record<string, string>;
    }
  | {
      valid: false;
      error: string;
      code: string;
    };

/**
 * 校验并解析用户传入的 Prompt 参数。
 *
 * @param prompt - 目标 Prompt 定义元数据。
 * @param rawInput - 原始用户输入，支持 JSON 字符串或已解析的对象。
 * @returns 校验结果。
 */
export function validatePromptArguments(
  prompt: McpPromptDefinition,
  rawInput: string | Record<string, unknown> | undefined,
): ValidatePromptArgsResult {
  let parsedArgs: Record<string, unknown> = {};

  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (trimmed.length > 0) {
      try {
        const parsed = JSON.parse(trimmed);
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          return {
            valid: false,
            error: 'Prompt arguments must be a JSON object (key-value dictionary)',
            code: 'MCP_PROMPT_INVALID_ARGUMENTS',
          };
        }
        parsedArgs = parsed as Record<string, unknown>;
      } catch (err: unknown) {
        return {
          valid: false,
          error: `Failed to parse prompt arguments JSON: ${err instanceof Error ? err.message : String(err)}`,
          code: 'MCP_PROMPT_INVALID_ARGUMENTS',
        };
      }
    }
  } else if (typeof rawInput === 'object' && rawInput !== null) {
    if (Array.isArray(rawInput)) {
      return {
        valid: false,
        error: 'Prompt arguments cannot be an array',
        code: 'MCP_PROMPT_INVALID_ARGUMENTS',
      };
    }
    parsedArgs = rawInput;
  }

  // 1. 校验所有值必须为字符串
  const finalArgs: Record<string, string> = {};
  for (const [k, v] of Object.entries(parsedArgs)) {
    if (typeof v !== 'string') {
      return {
        valid: false,
        error: `Argument '${k}' must be a string value, received ${typeof v}`,
        code: 'MCP_PROMPT_INVALID_ARGUMENTS',
      };
    }
    finalArgs[k] = v;
  }

  const declaredArgs = prompt.arguments ?? [];
  const declaredNames = new Set(declaredArgs.map((a) => a.name));

  // 2. 未知参数检测：严禁传入未在 Prompt 中声明的参数（零静默丢弃约束）
  for (const key of Object.keys(finalArgs)) {
    if (!declaredNames.has(key)) {
      return {
        valid: false,
        error: `Unknown argument '${key}' provided for prompt '${prompt.stableId}'. Declared arguments: [${Array.from(declaredNames).join(', ')}]`,
        code: 'MCP_PROMPT_INVALID_ARGUMENTS',
      };
    }
  }

  // 3. 必填参数检测
  for (const arg of declaredArgs) {
    if (arg.required && (!(arg.name in finalArgs) || finalArgs[arg.name].trim().length === 0)) {
      return {
        valid: false,
        error: `Missing required argument '${arg.name}' for prompt '${prompt.stableId}'`,
        code: 'MCP_PROMPT_INVALID_ARGUMENTS',
      };
    }
  }

  return { valid: true, arguments: finalArgs };
}

/**
 * 校验获取 Prompt 的环境模式与能力就绪状态。
 *
 * @param mode - 当前会话模式（'full' | 'auto' | 'plan'）。
 * @param promptsState - 对应 Server 的 prompts 目录能力状态。
 * @param promptId - 目标 Prompt 稳定标识。
 * @returns 允许执行时返回 null，被阻断时返回错误信息。
 */
export function checkPromptExecutionPermission(
  mode: SessionMode,
  promptsState: CapabilityCatalogState,
  promptId: string,
): { allowed: false; error: string; code: string } | { allowed: true } {
  // Plan 模式始终拒绝
  if (mode === 'Plan') {
    return {
      allowed: false,
      error: `Execution of prompt '${promptId}' is strictly prohibited in 'Plan' mode`,
      code: 'PERMISSION_DENIED',
    };
  }

  // 服务能力必须 ready
  if (promptsState !== 'ready') {
    return {
      allowed: false,
      error: `Server for prompt '${promptId}' prompts capability is not ready (current state: ${promptsState})`,
      code: 'MCP_SERVER_UNAVAILABLE',
    };
  }

  return { allowed: true };
}
