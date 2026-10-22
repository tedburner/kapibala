import type { WireErrorCode } from '../protocol/index.js';

/** 宿主固定错误分类；cause 仅供内部诊断，wire 只读取 code，不能暴露原始消息。 */
export class LocalHostError extends Error {
  readonly code: WireErrorCode;

  constructor(code: WireErrorCode, cause?: unknown) {
    super(code, { cause });
    this.name = 'LocalHostError';
    this.code = code;
  }
}
