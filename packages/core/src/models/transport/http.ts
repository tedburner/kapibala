import { ContextOverflowError, ModelError, type ModelErrorOptions } from '../../errors/index.js';
import type { ModelProtocol } from '../router.js';

/**
 * 解析服务端响应头中的重试提示与退避等待时长。
 *
 * 规则与边界：
 * - `x-should-retry`：`'false'` / `'0'` 返回 `shouldRetry: false`；`'true'` / `'1'` 返回 `shouldRetry: true`；
 * - `retry-after-ms`：优先于 `retry-after`，接受有限非负毫秒数并向上取整；
 * - `retry-after`：接受非负浮点秒（转毫秒向上取整）或 RFC HTTP-date（相对 `nowMs` 夹取非负差值）；
 * - 负数、NaN 或不可识别的字符串静默忽略，绝不向退避定时器传递非法时长。
 */
export function parseRetryHeaders(
  headers?: Headers | null,
  nowMs = Date.now(),
): { shouldRetry?: boolean; retryAfterMs?: number } {
  if (!headers || typeof headers.get !== 'function') return {};
  const result: { shouldRetry?: boolean; retryAfterMs?: number } = {};

  const rawShouldRetry = headers.get('x-should-retry')?.trim().toLowerCase();
  if (rawShouldRetry === 'false' || rawShouldRetry === '0') {
    result.shouldRetry = false;
  } else if (rawShouldRetry === 'true' || rawShouldRetry === '1') {
    result.shouldRetry = true;
  }

  const rawMs = headers.get('retry-after-ms')?.trim();
  if (rawMs && /^[+-]?\d+(?:\.\d+)?$/.test(rawMs)) {
    const parsedMs = Number(rawMs);
    if (Number.isFinite(parsedMs) && parsedMs >= 0) {
      result.retryAfterMs = Math.ceil(parsedMs);
    }
  }

  if (result.retryAfterMs === undefined) {
    const rawRetryAfter = headers.get('retry-after')?.trim();
    if (rawRetryAfter) {
      if (/^[+-]?\d+(?:\.\d+)?$/.test(rawRetryAfter)) {
        const sec = Number(rawRetryAfter);
        if (Number.isFinite(sec) && sec >= 0) {
          result.retryAfterMs = Math.ceil(sec * 1000);
        }
      } else {
        const dateMs = Date.parse(rawRetryAfter);
        if (Number.isFinite(dateMs)) {
          result.retryAfterMs = Math.max(0, Math.ceil(dateMs - nowMs));
        }
      }
    }
  }

  return result;
}

/** 仅提取安全的传输错误码，不携带 socket、端点凭据或请求正文。 */
export function safeTransportCode(error: unknown): string | undefined {
  const codes = new Set([
    'UND_ERR_SOCKET',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_CONNECT_TIMEOUT',
    'ECONNRESET',
    'ETIMEDOUT',
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
  ]);
  let current = error;
  for (let depth = 0; depth < 4 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (typeof value.code === 'string' && codes.has(value.code)) return value.code;
    current = value.cause;
  }
}

/**
 * 按明确错误码识别溢出；仅 Anthropic 额外接受 invalid_request_error 的已知超限格式。
 * 不搜索任意消息中的关键词，不将原始错误正文带入诊断；其他协议维持仅错误码的规则。
 */
export function isContextOverflow(error: unknown, protocol?: ModelProtocol): boolean {
  if (!error || typeof error !== 'object') return false;
  const detail = error as { code?: unknown; type?: unknown; message?: unknown };
  if (
    ['context_length_exceeded', 'context_window_exceeded', 'max_context_length_exceeded'].includes(
      String(detail.code),
    )
  )
    return true;
  return (
    protocol === 'anthropic' &&
    detail.type === 'invalid_request_error' &&
    typeof detail.message === 'string' &&
    detail.message.length <= 160 &&
    /^prompt is too long(?:: [0-9]+ tokens > [0-9]+ maximum)?$/.test(detail.message)
  );
}

export interface ModelHTTPOpenOptions {
  /** 显式协议限定厂商特有错误格式，不根据 URL 或模型名称猜测。 */
  protocol?: ModelProtocol;
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  /** 外部取消信号；与建连超时先触发者生效，流式阶段同样联动。 */
  signal?: AbortSignal;
  /** 建连（响应头阶段）超时毫秒数，缺省 60 秒；不约束流式读取。 */
  connectTimeoutMs?: number;
  /** 是否在非 2xx 错误中保留脱敏后的服务端错误消息（供兼容网关诊断）；缺省 false 使用固定状态码摘要。 */
  preserveErrorMessage?: boolean;
}

/**
 * 从非 2xx JSON 响应体中兼容提取错误标识字段：
 * 同时覆盖嵌套 `{ error: { code, type, message } }`、字符串 `{ error: "insufficient_quota" }`
 * 与国产厂商顶层 `{ code, type, message }` 结构（如智谱 `429 {"code":"1304","message":"配额已耗尽"}`）。
 */
function extractErrorDetail(
  rawText: string,
): { code?: unknown; type?: unknown; message?: unknown } | undefined {
  if (!rawText) return undefined;
  try {
    const parsed = JSON.parse(rawText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    const record = parsed as Record<string, unknown>;
    const nested = record.error;
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
      const errObj = nested as Record<string, unknown>;
      return {
        code: errObj.code ?? record.code,
        type: errObj.type ?? record.type,
        message: errObj.message ?? record.message,
      };
    }
    if (typeof nested === 'string') {
      return {
        code: record.code ?? nested,
        type: record.type,
        message: typeof record.message === 'string' ? record.message : nested,
      };
    }
    if (
      record.code !== undefined ||
      record.type !== undefined ||
      record.message !== undefined ||
      record.msg !== undefined
    ) {
      return {
        code: record.code,
        type: record.type,
        message:
          typeof record.message === 'string'
            ? record.message
            : typeof record.msg === 'string'
              ? record.msg
              : undefined,
      };
    }
  } catch {
    /* 不回显未脱敏原始错误体。 */
  }
  return undefined;
}

/** 建连超时约束响应头阶段，非 2xx 错误体读取施加有界超时保护；调用者必须在流消费 finally 中 close。 */
export async function openModelResponse(
  options: ModelHTTPOpenOptions,
): Promise<{ response: Response; close: () => void }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (options.signal?.aborted) abort();
  else options.signal?.addEventListener('abort', abort, { once: true });
  const timeout = options.connectTimeoutMs ?? 60_000;
  const timer = setTimeout(abort, timeout);
  const close = () => {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    controller.abort();
  };
  try {
    let response: Response;
    try {
      response = await fetch(options.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...options.headers },
        body: JSON.stringify(options.payload),
        signal: controller.signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      throw new ModelError(
        controller.signal.aborted ? 'Model connection timed out' : 'Model connection failed',
        {
          stage: 'connect',
          status: controller.signal.aborted ? 408 : undefined,
          transportCode: safeTransportCode(error),
        },
      );
    } finally {
      clearTimeout(timer);
    }
    if (!response.ok) {
      const retryHeaders = parseRetryHeaders(response.headers);
      let rawText = '';
      const errorBodyTimeoutMs = Math.max(1, Math.min(timeout, 15_000));
      let bodyTimer: ReturnType<typeof setTimeout> | undefined;
      let onCallerAbort: (() => void) | undefined;
      try {
        const textPromise = Promise.resolve().then(() => response.text());
        textPromise.catch(() => {});
        rawText = await Promise.race([
          textPromise,
          new Promise<string>((_, reject) => {
            if (options.signal?.aborted) {
              reject(new Error('Aborted'));
              return;
            }
            onCallerAbort = () => reject(new Error('Aborted'));
            options.signal?.addEventListener('abort', onCallerAbort, { once: true });
            bodyTimer = setTimeout(() => {
              controller.abort();
              reject(new Error('Error response body timed out'));
            }, errorBodyTimeoutMs);
          }),
        ]);
      } catch (bodyError) {
        if (options.signal?.aborted) throw bodyError;
        /* 非 2xx 响应体挂起或损坏时降级为空正文，按状态码与响应头继续分类，防止阻塞重试循环。 */
      } finally {
        if (bodyTimer !== undefined) clearTimeout(bodyTimer);
        if (onCallerAbort) options.signal?.removeEventListener('abort', onCallerAbort);
      }
      const detail = extractErrorDetail(rawText);
      const providerMessage = typeof detail?.message === 'string' ? detail.message : undefined;
      let errorMsg = `Model API request failed (${response.status})`;
      if (options.preserveErrorMessage) {
        errorMsg = `API request failed with status ${response.status}: ${response.statusText ?? ''}`;
        if (providerMessage) {
          errorMsg = providerMessage;
        } else if (rawText) {
          errorMsg += ` - ${rawText.slice(0, 300)}`;
        }
      }
      const errorOptions: ModelErrorOptions = {
        status: response.status,
        stage: 'response',
        providerCode:
          typeof detail?.code === 'string' || typeof detail?.code === 'number'
            ? String(detail.code)
            : undefined,
        providerType: typeof detail?.type === 'string' ? detail.type : undefined,
        providerMessage,
        ...(retryHeaders.retryAfterMs !== undefined
          ? { retryAfterMs: retryHeaders.retryAfterMs }
          : {}),
      };
      if ([400, 413, 422].includes(response.status) && isContextOverflow(detail, options.protocol))
        throw new ContextOverflowError(response.status, {
          ...errorOptions,
          ...(options.preserveErrorMessage ? { message: errorMsg } : {}),
        });
      let retryableOverride: boolean | undefined;
      if (retryHeaders.shouldRetry === false) {
        retryableOverride = false;
      } else if (retryHeaders.shouldRetry === true) {
        const probe = new ModelError(errorMsg, errorOptions);
        if (!['authentication', 'quota', 'context'].includes(probe.category)) {
          retryableOverride = true;
        }
      }
      throw new ModelError(errorMsg, {
        ...errorOptions,
        ...(retryableOverride !== undefined ? { retryable: retryableOverride } : {}),
      });
    }
    if (!response.body)
      throw new ModelError('Model response body is missing', {
        code: 'MODEL_INVALID_RESPONSE',
        stage: 'response',
      });
    return { response, close };
  } catch (error) {
    close();
    throw error;
  }
}

/** 验证 SSE data 为对象事件；坏 JSON 明确归类，避免原始数据进入诊断。 */
export function parseWireEvent(data: string): Record<string, any> {
  try {
    const value = JSON.parse(data);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* 统一安全错误。 */
  }
  throw new ModelError('Model response contained an invalid JSON event', {
    code: 'MODEL_INVALID_RESPONSE',
    stage: 'stream',
    retryable: false,
  });
}

/** 工具参数必须是完整 JSON 对象；空参数串仅表示无参数对象。 */
export function parseToolArguments(argumentsText: string): Record<string, unknown> {
  try {
    const value = argumentsText.trim() ? JSON.parse(argumentsText) : {};
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  } catch {
    /* 不把坏参数 _raw 送到工具端。 */
  }
  throw new ModelError('Invalid model tool arguments', {
    code: 'MODEL_INVALID_RESPONSE',
    stage: 'stream',
    retryable: false,
  });
}
