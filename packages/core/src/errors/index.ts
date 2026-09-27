/**
 * Error Taxonomy for Kapibala Agent Harness
 */

export type ModelErrorCategory =
  | 'authentication'
  | 'quota'
  | 'rate_limit'
  | 'context'
  | 'service'
  | 'network'
  | 'timeout'
  | 'invalid_request'
  | 'invalid_response'
  | 'unknown';
export interface ModelErrorOptions {
  status?: number;
  retryable?: boolean;
  code?: string;
  transportCode?: string;
  providerCode?: string;
  providerType?: string;
  stage?: 'connect' | 'response' | 'stream' | 'request';
}
/** 跨协议模型失败的脱敏说明；适用于主任务和摘要，不代表自动重试授权。 */
export interface ModelErrorInfo {
  category: ModelErrorCategory;
  code: string;
  message: string;
  status?: number;
  providerCode?: string;
  providerType?: string;
  transportCode?: string;
  stage?: ModelErrorOptions['stage'];
  operation?: 'primary' | 'summary';
  modelId?: string;
  provider?: string;
  retryPolicy: KapibalaError['retryPolicy'];
  suggestion: string;
}

/** 清理服务端报错中的终端控制符、常见凭据及带凭据的 URL，限制长度；不展示完整响应或请求头。 */
export function sanitizeModelErrorMessage(value: string): string {
  return value
    .replace(
      /\b(?:Authorization|Proxy-Authorization)\s*:\s*(?:Bearer|Basic)\s+[^\s,;"']+/gi,
      'Authorization: [redacted]',
    )
    .replace(/\b(?:Cookie|Set-Cookie)\s*:[^\r\n]*/gi, 'Cookie: [redacted]')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|api|key)-[A-Za-z0-9_-]{5,}/g, '[redacted]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|token|password|secret|authorization|cookie)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1[redacted]',
    )
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        if (url.username || url.password) {
          url.username = 'redacted';
          url.password = 'redacted';
        }
        if (url.search) url.search = '?redacted';
        if (url.hash) url.hash = '#redacted';
        return url.toString();
      } catch {
        return '[redacted URL]';
      }
    })
    .slice(0, 600);
}

/** 错误标识仅接受短 ASCII 符号，不把模型正文或凭据伪装为错误码。 */
function safeErrorIdentifier(value?: string): string | undefined {
  return value && /^[A-Za-z0-9_.:-]{1,80}$/.test(value) && !/^(?:sk|api|key)-/i.test(value)
    ? value
    : undefined;
}

/** 按协议状态和明确错误码分类，不根据自然语言猜测根因。 */
function classifyModelError(options: ModelErrorOptions): ModelErrorCategory {
  const codes = [options.providerCode, options.providerType, options.code];
  if (
    codes.some((c) =>
      [
        'context_length_exceeded',
        'context_window_exceeded',
        'max_context_length_exceeded',
        'MODEL_CONTEXT_EXCEEDED',
      ].includes(c ?? ''),
    )
  )
    return 'context';
  if (
    codes.some((c) =>
      [
        'insufficient_quota',
        'insufficient_balance',
        'quota_exceeded',
        'billing_hard_limit_reached',
      ].includes(c ?? ''),
    ) ||
    options.status === 402
  )
    return 'quota';
  if (
    codes.some((c) =>
      ['invalid_api_key', 'authentication_error', 'permission_error'].includes(c ?? ''),
    ) ||
    options.status === 401 ||
    options.status === 403
  )
    return 'authentication';
  if (
    codes.some((c) => ['rate_limit_exceeded', 'rate_limit_error'].includes(c ?? '')) ||
    options.status === 429
  )
    return 'rate_limit';
  if (options.status === 408 || /TIMEOUT|ETIMEDOUT/.test(options.transportCode ?? ''))
    return 'timeout';
  if (
    options.transportCode ||
    options.code === 'MODEL_STREAM_INTERRUPTED' ||
    options.stage === 'connect'
  )
    return 'network';
  if (
    codes.some((c) =>
      ['server_error', 'overloaded_error', 'api_error', 'internal_server_error'].includes(c ?? ''),
    ) ||
    (options.status && options.status >= 500)
  )
    return 'service';
  if (codes.some((c) => ['invalid_request_error', 'invalid_argument'].includes(c ?? '')))
    return 'invalid_request';
  if (options.status && options.status >= 400) return 'invalid_request';
  if (options.code === 'MODEL_STREAM_INCOMPLETE' || options.code === 'MODEL_INVALID_RESPONSE')
    return 'invalid_response';
  return 'unknown';
}

const MODEL_ERROR_ADVICE: Record<ModelErrorCategory, string> = {
  authentication: '检查 API Key、模型权限及端点配置后重试。',
  quota: '检查账户余额或配额后重试。',
  rate_limit: '稍后重试，或降低请求频率。',
  context: '选择更大上下文窗口、压缩历史或拆分任务后重试。',
  service: '服务暂时异常，可稍后在当前会话重试。',
  network: '检查网络、代理和端点；连接恢复后可在当前会话重试。',
  timeout: '检查网络及服务响应情况，稍后重试。',
  invalid_request: '检查模型与端点的协议兼容性及请求配置。',
  invalid_response: '响应不完整或格式异常，可在当前会话重试并检查端点协议兼容性。',
  unknown: '原因未确认，请结合错误码和运行日志检查。',
};

/** 生成统一脱敏说明；上下文补充调用场景，不携带原始异常、请求正文或密钥。 */
export function describeModelError(
  error: ModelError,
  context: Pick<ModelErrorInfo, 'modelId' | 'provider' | 'operation'> = {},
): ModelErrorInfo {
  return {
    category: error.category,
    code: error.code,
    message: sanitizeModelErrorMessage(error.message),
    status: error.status,
    providerCode: error.providerCode,
    providerType: error.providerType,
    transportCode: error.transportCode,
    stage: error.stage,
    retryPolicy: error.retryPolicy,
    suggestion: MODEL_ERROR_ADVICE[error.category],
    modelId: context.modelId ? sanitizeModelErrorMessage(context.modelId) : undefined,
    provider: context.provider ? sanitizeModelErrorMessage(context.provider) : undefined,
    operation: context.operation,
  };
}

export class KapibalaError extends Error {
  readonly code: string;
  readonly retryPolicy: 'never' | 'immediate' | 'backoff' | 'after_user_action';
  readonly safeMessage: string;

  constructor(
    message: string,
    options?: {
      code?: string;
      retryPolicy?: 'never' | 'immediate' | 'backoff' | 'after_user_action';
      safeMessage?: string;
    },
  ) {
    super(message);
    this.name = 'KapibalaError';
    this.code = options?.code ?? 'INTERNAL_ERROR';
    this.retryPolicy = options?.retryPolicy ?? 'never';
    this.safeMessage = options?.safeMessage ?? 'Operation failed';
  }
}

export class ModelError extends KapibalaError {
  readonly status?: number;
  readonly retryable: boolean;
  /** 可选的受控底层连接错误码，不包含原始传输异常文本。 */
  readonly transportCode?: string;
  readonly providerCode?: string;
  readonly providerType?: string;
  readonly stage?: ModelErrorOptions['stage'];
  readonly category: ModelErrorCategory;

  /** 构建模型错误，清理服务端原因并按明确状态/错误码分类；重试策略仅为建议，不授权重放。 */
  constructor(message: string, options: ModelErrorOptions = {}) {
    const category = classifyModelError(options);
    const actionRequired = ['authentication', 'quota', 'context', 'invalid_request'].includes(
      category,
    );
    const retryable =
      options.retryable ?? ['rate_limit', 'service', 'timeout', 'network'].includes(category);
    super(sanitizeModelErrorMessage(message), {
      code:
        safeErrorIdentifier(options.code) ??
        (category === 'unknown' ? 'MODEL_ERROR' : `MODEL_${category.toUpperCase()}`),
      retryPolicy: actionRequired ? 'after_user_action' : retryable ? 'backoff' : 'never',
      safeMessage: sanitizeModelErrorMessage(message),
    });
    this.name = 'ModelError';
    this.status = options?.status;
    this.transportCode = safeErrorIdentifier(options.transportCode);
    this.providerCode = safeErrorIdentifier(options.providerCode);
    this.providerType = safeErrorIdentifier(options.providerType);
    this.stage = options.stage;
    this.category = category;
    this.retryable = retryable;
  }
}

/** Provider 明确拒绝上下文长度；仅无输出请求允许预算处理后重发一次。 */
export class ContextOverflowError extends ModelError {
  /** 保留明确上下文错误的脱敏服务端原因；只允许尚无输出的请求进入一次预算处理。 */
  constructor(
    status?: number,
    details: Pick<ModelErrorOptions, 'providerCode' | 'providerType' | 'stage'> & {
      message?: string;
    } = {},
  ) {
    super(details.message ?? 'Model context window exceeded', {
      ...details,
      status,
      retryable: false,
      code: 'MODEL_CONTEXT_EXCEEDED',
    });
    this.name = 'ContextOverflowError';
  }
}

export class TransportError extends KapibalaError {
  readonly retryable: boolean;

  constructor(message: string, retryable = true) {
    super(message);
    this.name = 'TransportError';
    this.retryable = retryable;
  }
}

export class ToolError extends KapibalaError {
  constructor(message: string) {
    super(message, {
      code: 'TOOL_ERROR',
      retryPolicy: 'never',
      safeMessage: 'Tool execution failed',
    });
    this.name = 'ToolError';
  }
}

export class ToolNotFound extends KapibalaError {
  readonly toolName: string;
  readonly availableTools: string[];

  constructor(toolName: string, availableTools: string[] = []) {
    super(`Tool '${toolName}' not found. Available tools: ${availableTools.join(', ') || 'none'}`, {
      code: 'TOOL_NOT_FOUND',
      retryPolicy: 'never',
      safeMessage: 'Requested tool is unavailable',
    });
    this.name = 'ToolNotFound';
    this.toolName = toolName;
    this.availableTools = availableTools;
  }
}

export class AbortError extends KapibalaError {
  constructor(message = 'Execution aborted by user') {
    super(message, {
      code: 'ABORTED',
      retryPolicy: 'after_user_action',
      safeMessage: 'Operation cancelled',
    });
    this.name = 'AbortError';
  }
}

export class FatalError extends KapibalaError {
  constructor(message: string) {
    super(message);
    this.name = 'FatalError';
  }
}

export class SessionBusyError extends KapibalaError {
  constructor(operation: string) {
    super(`Session is already running; cannot ${operation}`);
    this.name = 'SessionBusyError';
  }
}

/** 请求硬预算不足；需用户缩小任务或选择更大窗口，不允许切掉当前任务继续。 */
export class ContextBudgetError extends KapibalaError {
  constructor(
    readonly usedTokens: number,
    readonly inputBudget: number,
  ) {
    super(
      `Context input requires approximately ${usedTokens} tokens; budget is ${inputBudget}. Choose a larger context window or start a smaller task.`,
      {
        code: 'CONTEXT_BUDGET_EXCEEDED',
        retryPolicy: 'after_user_action',
        safeMessage: '上下文预算不足，请选择更大窗口或拆分任务。',
      },
    );
    this.name = 'ContextBudgetError';
  }
}

/** 压缩状态持久提交失败，与模型预算或生成失败分别处理，不允许未落盘候选生效。 */
export class ContextStorageError extends KapibalaError {
  constructor(message: string) {
    super(message, {
      code: 'CONTEXT_STORAGE_ERROR',
      retryPolicy: 'after_user_action',
      safeMessage: '上下文状态保存失败，候选未生效。',
    });
    this.name = 'ContextStorageError';
  }
}
