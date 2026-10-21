import type { NegotiatedProtocol, ProtocolOffer, ValidationResult } from './types.js';

/** 首个本地 wire 协议；产品版本升级不自动改变协议主版本。 */
export const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 });

/** v1 服务端实际支持的能力；初始化时按客户端声明校验，未知能力不做静默降级。 */
export const SERVER_CAPABILITIES = Object.freeze(['sessions', 'approval', 'cancel'] as const);

/** 协商后的能力名只能来自固定集合，避免调用方拼写差异被当作新能力接受。 */
export type ServerCapability = (typeof SERVER_CAPABILITIES)[number];

/** 集中预算，握手公布实际采用值；传输和宿主不得另写宽松默认值。 */
export const DEFAULT_LIMITS = Object.freeze({
  maxFrameBytes: 1_048_576,
  initializationTimeoutMs: 5_000,
  maxInflightRequests: 64,
  maxConnections: 16,
  maxOpenSessions: 8,
  maxConcurrentRuns: 4,
  maxPendingApprovals: 128,
  maxSnapshotBytes: 8_388_608,
  maxSendQueueBytes: 4_194_304,
  maxOperationIds: 1_024,
  approvalTimeoutMs: 120_000,
});

/**
 * 只取本机实现支持的交集；认证和能力准入由宿主执行，不因协商而授予权限。
 * `offer.capabilities` 表示客户端本次依赖的能力：任一不被支持都明确失败，
 * 服务端返回的列表即客户端可安全使用的完整集合。
 */
export function negotiateProtocol(offer: ProtocolOffer): ValidationResult<NegotiatedProtocol> {
  if (
    !offer ||
    !Array.isArray(offer.capabilities) ||
    offer.capabilities.length > 64 ||
    offer.capabilities.some((capability) => typeof capability !== 'string')
  ) {
    return {
      ok: false,
      error: {
        code: -32602,
        message: 'Invalid protocol offer',
        data: { code: 'PROTOCOL_MISMATCH' },
      },
    };
  }
  if (
    ![offer.major, offer.minMinor, offer.maxMinor].every(Number.isSafeInteger) ||
    offer.major !== PROTOCOL_VERSION.major ||
    offer.minMinor < 0 ||
    offer.minMinor > offer.maxMinor ||
    offer.minMinor > PROTOCOL_VERSION.minor
  ) {
    return {
      ok: false,
      error: {
        code: -32000,
        message: 'Unsupported protocol version',
        data: { code: 'PROTOCOL_MISMATCH' },
      },
    };
  }
  const capabilities = [...new Set(offer.capabilities)];
  const supported = new Set<string>(SERVER_CAPABILITIES);
  if (capabilities.some((capability) => !supported.has(capability))) {
    return {
      ok: false,
      error: {
        code: -32000,
        message: 'Unsupported capability',
        data: { code: 'PROTOCOL_MISMATCH' },
      },
    };
  }
  return { ok: true, value: { ...PROTOCOL_VERSION, capabilities } };
}
