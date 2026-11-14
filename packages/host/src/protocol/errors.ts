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

const coreCodes: Readonly<Record<string, WireErrorCode>> = {
  SESSION_LOCKED: 'SESSION_BUSY',
  SESSION_RECOVERY_IN_PROGRESS: 'SESSION_BUSY',
  SESSION_LOCK_OWNER_CHANGED: 'SESSION_BUSY',
  SESSION_ID_AMBIGUOUS: 'SESSION_NOT_FOUND',
  HISTORY_PAGE_INVALID: 'INVALID_PARAMS',
  CONFIG_INVALID: 'INVALID_PARAMS',
  WORKSPACE_ESCAPE: 'INVALID_PARAMS',
};

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
 * 优先识别稳定 code，旧异常才走消息兜底；未知 code 不回显，也不能借 message 伪装分类。
 */
export function toWireErrorCode(error: unknown): WireErrorCode {
  if (!(error instanceof Error)) return 'INTERNAL_ERROR';
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  if (descriptor) {
    const code = descriptor.value;
    if (typeof code !== 'string') return 'INTERNAL_ERROR';
    return Object.hasOwn(coreCodes, code)
      ? coreCodes[code]
      : publicCodes.has(code)
        ? (code as WireErrorCode)
        : 'INTERNAL_ERROR';
  }
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
