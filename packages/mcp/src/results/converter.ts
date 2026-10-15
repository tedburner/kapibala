/**
 * @fileoverview MCP 工具调用结果规范化转换与 execution v1 错误分类
 *
 * 约束与边界：
 * 1. 完整实现 execution v1 契约（version: 1, dispatchOutcome: not_sent | succeeded | failed | unknown）；
 * 2. 收到远端业务失败（isError=true）时标记为 failed，附带 MCP_TOOL_ERROR 错误码；
 * 3. 收到远端有效成功时标记为 succeeded；若后续宿主在结果投影转换时发生异常，
 *    必须保持 succeeded（保留远端真实执行成功的事实！），附带 hostError: { phase: 'projection', code: 'MCP_RESULT_INVALID' }，
 *    并设置 retryPolicy: 'after_user_action' 暂停等待用户，严禁自动重放；
 * 4. 超时、断连或无法断定远端状态时判定为 unknown 与 OUTCOME_UNKNOWN，严禁隐式自动重放；
 * 5. 有效响应之后的 hook 或审计错误绝对不得将 dispatchOutcome 改写为 unknown。
 */

import type { ToolExecutionResult } from '@kiturone/kapibala';
import {
  DEFAULT_RESULT_BUDGET_BYTES,
  MAX_WIRE_TRANSPORT_BYTES,
  sanitizeMcpContentBlock,
  sanitizeStructuredContent,
  truncateTextSafely,
} from './sanitizer.js';

/**
 * 将 MCP callTool 的原始返回值或异常转换为规范的 ToolExecutionResult。
 *
 * @param rawResponse - 原始响应或捕获的异常对象。
 * @returns 规范化的 ToolExecutionResult。
 */
export function convertMcpToolResponse(rawResponse: unknown): ToolExecutionResult {
  // 1. 异常处理：远端调用抛出错误或超时断连
  if (rawResponse instanceof Error) {
    const errorMsg = rawResponse.message;

    // 前置拒绝（未发送）
    if (errorMsg.includes('MCP_TOOL_CHANGED') || errorMsg.includes('MCP_SERVER_UNAVAILABLE')) {
      return {
        content: `Tool execution rejected: ${errorMsg}`,
        isError: true,
        errorCode: 'MCP_PRECHECK_REJECTED',
        retryPolicy: 'never',
        execution: {
          version: 1,
          dispatchOutcome: 'not_sent',
          hostError: {
            phase: 'validation',
            code: 'PRECHECK_FAILED',
          },
        },
      };
    }

    // 无法断定远端状态（超时、网络断流等）
    return {
      content: `Tool execution failed with undetermined outcome: ${errorMsg}`,
      isError: true,
      errorCode: 'OUTCOME_UNKNOWN',
      retryPolicy: 'after_user_action',
      execution: {
        version: 1,
        dispatchOutcome: 'unknown',
      },
    };
  }

  // 2. 正常响应对象解析
  try {
    const responseObj = (rawResponse ?? {}) as Record<string, unknown>;
    const isError = Boolean(responseObj.isError);

    // 检查 4 MiB 传输负载硬上限
    const payloadStr = JSON.stringify(responseObj);
    if (Buffer.byteLength(payloadStr, 'utf8') > MAX_WIRE_TRANSPORT_BYTES) {
      return {
        content: `MCP tool response exceeded transport wire limit of ${MAX_WIRE_TRANSPORT_BYTES} bytes`,
        isError: true,
        errorCode: 'MCP_RESULT_TOO_LARGE',
        retryPolicy: 'never',
        execution: {
          version: 1,
          dispatchOutcome: 'failed',
        },
      };
    }

    const parts: string[] = [];

    // 处理 content 数组
    if (Array.isArray(responseObj.content)) {
      for (const block of responseObj.content) {
        const text = sanitizeMcpContentBlock(block);
        if (text) parts.push(text);
      }
    }

    // 处理 structuredContent
    if (responseObj.structuredContent !== undefined && responseObj.structuredContent !== null) {
      const structuredText = sanitizeStructuredContent(responseObj.structuredContent);
      if (structuredText) parts.push(structuredText);
    }

    const rawMerged =
      parts.length > 0 ? parts.join('\n\n') : isError ? 'Tool execution failed' : 'Success';

    // 对合并后的完整结果应用整体 20 KiB 预算截断
    const mergedContent = truncateTextSafely(rawMerged, { maxBytes: DEFAULT_RESULT_BUDGET_BYTES });

    if (isError) {
      return {
        content: mergedContent,
        isError: true,
        errorCode: 'MCP_TOOL_ERROR',
        retryPolicy: 'never',
        execution: {
          version: 1,
          dispatchOutcome: 'failed',
        },
      };
    }

    return {
      content: mergedContent,
      isError: false,
      execution: {
        version: 1,
        dispatchOutcome: 'succeeded',
      },
    };
  } catch (err: unknown) {
    // 3. 宿主投影转换异常：远端实际上已经成功返回，保留 succeeded 事实！
    return {
      content: `Remote tool execution succeeded, but host projection failed: ${(err as Error).message}`,
      isError: true,
      errorCode: 'MCP_RESULT_INVALID',
      retryPolicy: 'after_user_action',
      execution: {
        version: 1,
        dispatchOutcome: 'succeeded', // 坚守远端事实！
        hostError: {
          phase: 'projection',
          code: 'MCP_RESULT_INVALID',
        },
      },
    };
  }
}
