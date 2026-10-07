import { createHash } from 'node:crypto';
import { ModelError } from '../errors/index.js';
import { type ContextWindowValue, resolveContextWindow } from '../models/router.js';
import type { ModelRequest } from '../types/index.js';
import { stableSerialize } from '../types/serialization.js';
export { stableSerialize } from '../types/serialization.js';

/** 由生效窗口推导的请求预算；实际请求与只读展示必须共用同一份推导。 */
export interface ContextBudget {
  contextWindow: number;
  /** 窗口来自保守估算（未知按 32K 推导）时为 true。 */
  estimatedWindow: boolean;
  /** 输出预留（含私有推理消耗），同时作为实际请求的 maxTokens。 */
  outputReserve: number;
  /** 至少 128 的窗口安全余量，防止输入预算顶满窗口。 */
  safetyReserve: number;
  /** 输入预算 = 窗口 − 输出预留 − 安全余量；超限请求在 Provider 调用前失败。 */
  inputBudget: number;
  /** 触发阈值 0.85B：超过才启动一级剪裁/二级摘要（迁移文档：剪裁后低于触发阈值则不调用摘要模型）。 */
  trigger: number;
  /**
   * 目标 0.65B：压缩后期望达到的占用水平，随 ContextSnapshot 暴露给 /context 展示。
   * 当前算法的启停条件是 trigger；设计文档未定义向该目标迭代收敛的机制，
   * 故不作为候选接受条件或强制收敛线使用。
   */
  target: number;
}

/** 单次请求的 token 占用分解；total 与各部分独立取整，不保证严格相加。 */
export interface TokenEstimate {
  total: number;
  system: number;
  tools: number;
  history: number;
  overhead: number;
  /** calibrated 表示该请求指纹已有实测校准；估算结果仍非计费依据。 */
  source: 'estimated' | 'calibrated';
}

/** 可替换估算器；不得执行 Provider、Hook 或改写传入请求。 */
export interface TokenEstimator {
  estimate(request: ModelRequest, modelFingerprint?: string): TokenEstimate;
  observe?(request: ModelRequest, actualPromptTokens: number, modelFingerprint?: string): void;
}

/**
 * 计算一次有效输出预留及输入预算；输出上限须为正安全整数，缺省沿用 4096。
 * 未知窗口以 32K 控制，输出最多占窗口 12.5%，另留至少 128 的 5% 安全余量。
 * 输出预留包含思考/推理；不能把 Profile 的较低覆盖重新放大为默认值。
 * @param window 模型声明的上下文窗口；缺省采用保守估算。
 * @param maxOutputTokens 当前目的的输出上限，包含可见文字及私有推理消耗。
 * @returns 实际请求与上下文展示共用的预算。
 * @throws {ModelError} 输出上限不是正安全整数或窗口过小；错误纳入统一脱敏诊断通道。
 */
export function createContextBudget(
  window?: ContextWindowValue,
  maxOutputTokens = 4096,
): ContextBudget {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0)
    throw new ModelError('Invalid output token budget: expected a positive safe integer', {
      code: 'MODEL_INVALID_REQUEST',
      stage: 'request',
      retryable: false,
    });
  const resolved = resolveContextWindow(window);
  const contextWindow = resolved.estimated ? 32000 : resolved.tokens;
  const outputReserve = Math.min(maxOutputTokens, Math.floor(contextWindow * 0.125));
  const safetyReserve = Math.max(128, Math.ceil(contextWindow * 0.05));
  const inputBudget = contextWindow - outputReserve - safetyReserve;
  const trigger = Math.floor(inputBudget * 0.85);
  const target = Math.floor(inputBudget * 0.65);
  if (!(0 < target && target < trigger && trigger < inputBudget && outputReserve > 0))
    throw new ModelError('Invalid context budget: model window is too small', {
      code: 'MODEL_INVALID_REQUEST',
      stage: 'request',
      retryable: false,
    });
  return {
    contextWindow,
    estimatedWindow: resolved.estimated,
    outputReserve,
    safetyReserve,
    inputBudget,
    trigger,
    target,
  };
}

/** 请求 fingerprint 不包含 AbortSignal 等宿主对象，包含实际指令、schema、正文和输出配置。 */
export function requestFingerprint(request: ModelRequest, modelFingerprint = ''): string {
  return createHash('sha256')
    .update(
      stableSerialize({
        modelFingerprint,
        systemPrompt: request.systemPrompt,
        messages: request.messages,
        tools: request.tools,
        maxTokens: request.maxTokens,
        temperature: request.temperature,
      }),
    )
    .digest('hex');
}

/**
 * 无依赖 Unicode 分类估算器；非 ASCII 按 code point 保守计数，ASCII 按四字符估算。
 * 观测 usage 仅校准相同最终请求与模型，改变指令或工具会自然失效；未知值不伪造为实测。
 */
export class UnicodeTokenEstimator implements TokenEstimator {
  private readonly calibration = new Map<string, number>();

  /** 计算系统、工具、历史和协议开销，返回估算/校准来源，保持请求不变。 */
  estimate(request: ModelRequest, modelFingerprint = ''): TokenEstimate {
    const count = (text: string): number => {
      let ascii = 0;
      let unicode = 0;
      for (const char of text) {
        if (char.codePointAt(0)! < 128) ascii++;
        else unicode++;
      }
      return Math.ceil(ascii / 4) + unicode;
    };
    const system = count(request.systemPrompt ?? '');
    const tools = request.tools?.length
      ? count(stableSerialize(request.tools)) + request.tools.length * 8
      : 0;
    const history = request.messages.reduce(
      (total, message) => total + count(stableSerialize(message.content)) + 6,
      0,
    );
    const overhead = 12;
    const factor = this.calibration.get(requestFingerprint(request, modelFingerprint)) ?? 1;
    return {
      total: Math.ceil((system + tools + history + overhead) * factor),
      system: Math.ceil(system * factor),
      tools: Math.ceil(tools * factor),
      history: Math.ceil(history * factor),
      overhead: Math.ceil(overhead * factor),
      source: factor === 1 ? 'estimated' : 'calibrated',
    };
  }

  /** 仅接受真实正整数 prompt usage，校准不会降低原保守估算；缓存最多 64 个最终请求。 */
  observe(request: ModelRequest, actualPromptTokens: number, modelFingerprint = ''): void {
    if (!Number.isSafeInteger(actualPromptTokens) || actualPromptTokens <= 0) return;
    const key = requestFingerprint(request, modelFingerprint);
    this.calibration.delete(key);
    const baseline = this.estimate(request, modelFingerprint).total;
    this.calibration.set(key, Math.max(1, actualPromptTokens / baseline));
    if (this.calibration.size > 64) this.calibration.delete(this.calibration.keys().next().value!);
  }
}
