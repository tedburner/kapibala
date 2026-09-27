import { createHash } from 'node:crypto';
import { type ContextWindowValue, resolveContextWindow } from '../models/router.js';
import type { ModelRequest } from '../types/index.js';

export interface ContextBudget {
  contextWindow: number;
  estimatedWindow: boolean;
  outputReserve: number;
  safetyReserve: number;
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

export interface TokenEstimate {
  total: number;
  system: number;
  tools: number;
  history: number;
  overhead: number;
  source: 'estimated' | 'calibrated';
}

/** 可替换估算器；不得执行 Provider、Hook 或改写传入请求。 */
export interface TokenEstimator {
  estimate(request: ModelRequest, modelFingerprint?: string): TokenEstimate;
  observe?(request: ModelRequest, actualPromptTokens: number, modelFingerprint?: string): void;
}

/** 未知窗口以 32K 控制，保留 12.5%（最多 4096）输出与至少 128 的 5% 安全余量。 */
export function createContextBudget(window?: ContextWindowValue): ContextBudget {
  const resolved = resolveContextWindow(window);
  const contextWindow = resolved.estimated ? 32000 : resolved.tokens;
  const outputReserve = Math.min(4096, Math.floor(contextWindow * 0.125));
  const safetyReserve = Math.max(128, Math.ceil(contextWindow * 0.05));
  const inputBudget = contextWindow - outputReserve - safetyReserve;
  const trigger = Math.floor(inputBudget * 0.85);
  const target = Math.floor(inputBudget * 0.65);
  if (!(0 < target && target < trigger && trigger < inputBudget && outputReserve > 0))
    throw new Error('Invalid context budget: model window is too small');
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

/** 对对象 key 确定性排序，保证摘要、工具 schema 与 fingerprint 不受插入顺序影响。 */
export function stableSerialize(value: unknown): string {
  const visit = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(visit);
    if (v && typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, val]) => val !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, val]) => [key, visit(val)]),
      );
    return v;
  };
  return JSON.stringify(visit(value));
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
