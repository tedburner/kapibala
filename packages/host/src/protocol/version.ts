import type { NegotiatedProtocol, ProtocolOffer, ValidationResult } from './types.js';

/**
 * 本地 wire 协议代际（整数）；只在破坏性变更时 +1，新增能力走能力集合而非升版本号。
 * 与产品版本相互独立：v0.1.4 起为 2，旧 `{major, minor}` 报价会在握手阶段被明确拒绝。
 */
export const PROTOCOL_VERSION = 2 as const;

/**
 * 服务端实际支持的能力；initialize 按客户端声明取交集，未知能力不做静默降级。
 * `watch` / `evidence` 随 v0.1.4 新增，纯字段扩展与非本地 wire 宿主入口不单列能力名。
 */
export const SERVER_CAPABILITIES = Object.freeze([
  'sessions',
  'approval',
  'cancel',
  'watch',
  'evidence',
] as const);

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
 * 版本为严格相等校验：不接受区间协商，也不承诺字段级降级；旧 `{major, minMinor, maxMinor}`
 * 报价在初始化参数校验阶段即被拒绝（`INVALID_PARAMS`），不会再走到这里。
 * `offer.capabilities` 表示客户端本次依赖的能力：任一不被支持都明确失败，
 * 返回本次声明且受支持的去重列表，不补齐服务端支持但客户端未声明的能力。
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
    !('protocolVersion' in offer) ||
    !Number.isSafeInteger(offer.protocolVersion) ||
    offer.protocolVersion !== PROTOCOL_VERSION
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
  return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, capabilities } };
}
