/** 可公开给客户端的业务分类；未知内部 Error 一律折叠为 INTERNAL_ERROR。 */
export const WIRE_ERROR_CODES = [
  'PROTOCOL_MISMATCH',
  'UNAUTHORIZED',
  'SESSION_BUSY',
  'CONTROL_REQUIRED',
  'STALE_CONTROL',
  'APPROVAL_EXPIRED',
  'RESYNC_REQUIRED',
  'RESOURCE_LIMIT',
  'SHUTTING_DOWN',
  'TRUST_REQUIRED',
  'CONFIG_REQUIRED',
  'SESSION_NOT_FOUND',
  'RUN_NOT_FOUND',
  'OPERATION_CONFLICT',
  'MCP_CONFIG_INVALID',
  'WORKSPACE_ROOT_REQUIRED',
  'SESSION_CLEANUP_FAILED',
  'INVALID_PARAMS',
  'INVALID_REQUEST',
  'METHOD_NOT_FOUND',
  'PARSE_ERROR',
  'INTERNAL_ERROR',
] as const;

/** 当前实现的稳定错误分类；读取响应时仍允许未来 minor 新增分类。 */
export type WireErrorCode = (typeof WIRE_ERROR_CODES)[number];

const publicCodes = new Set<string>(WIRE_ERROR_CODES);

/**
 * Core 仍以人类可读消息表达少数状态；这里只做保守前缀兜底，避免把内部堆栈带出边界。
 * 资源创建等主路径应先把锁错误规范化为 SESSION_BUSY，不应依赖本表。
 */
const CORE_MESSAGE_CODES: readonly (readonly [RegExp, WireErrorCode])[] = [
  [/^Session locked\b/, 'SESSION_BUSY'],
  [/^Session not found\b/, 'SESSION_NOT_FOUND'],
  [/^Ambiguous session prefix\b/, 'SESSION_NOT_FOUND'],
  [/^History page\b/, 'INVALID_PARAMS'],
];

/**
 * 把所有 handler 抛出的错误收敛为稳定分类；不返回原始 message、堆栈或输入。
 * 只识别白名单消息与少量 Core 已知前缀，其余统一 INTERNAL_ERROR。
 */
export function toWireErrorCode(error: unknown): WireErrorCode {
  if (!(error instanceof Error)) return 'INTERNAL_ERROR';
  if (publicCodes.has(error.message)) return error.message as WireErrorCode;
  for (const [pattern, code] of CORE_MESSAGE_CODES) {
    if (pattern.test(error.message)) return code;
  }
  return 'INTERNAL_ERROR';
}

/**
 * 把传输/校验层产生的 JSON-RPC 错误码映射为稳定 data.code。
 * 只用于宿主合成错误响应；业务 handler 的异常仍走 toWireErrorCode。
 */
export function wireCodeForRpcCode(code: number): WireErrorCode {
  switch (code) {
    case -32700:
      return 'PARSE_ERROR';
    case -32601:
      return 'METHOD_NOT_FOUND';
    case -32602:
      return 'INVALID_PARAMS';
    default:
      return 'INVALID_REQUEST';
  }
}
