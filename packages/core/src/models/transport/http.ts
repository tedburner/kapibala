import { ContextOverflowError, ModelError } from '../../errors/index.js';
import type { ModelProtocol } from '../router.js';

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
}

/** 建连超时只约束响应头阶段；调用者必须在流消费 finally 中 close，保持全程取消联动。 */
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
      let detail: { code?: unknown; type?: unknown } | undefined;
      try {
        detail = JSON.parse(await response.text())?.error;
      } catch {
        /* 不回显原始错误体。 */
      }
      const errorOptions = {
        status: response.status,
        stage: 'response' as const,
        providerCode: typeof detail?.code === 'string' ? detail.code : undefined,
        providerType: typeof detail?.type === 'string' ? detail.type : undefined,
      };
      if ([400, 413, 422].includes(response.status) && isContextOverflow(detail, options.protocol))
        throw new ContextOverflowError(response.status, errorOptions);
      throw new ModelError(`Model API request failed (${response.status})`, errorOptions);
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
