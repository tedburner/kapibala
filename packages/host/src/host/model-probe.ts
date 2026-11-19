/** 窗口探测结果的可信下限：低于该值视为端点返回的无关数值（如 max_output_tokens），不采信。 */
const MIN_PLAUSIBLE_CONTEXT_WINDOW = 1024;

/** 窗口探测结果的可信上限：与桌面契约（contracts.ts）的 contextWindow 上限保持一致。 */
const MAX_PLAUSIBLE_CONTEXT_WINDOW = 10_000_000;

/** 探测结论状态：ok 可达、auth 密钥被拒、unreachable 网络失败或端点未实现 /models。 */
export type ModelCatalogProbeStatus = 'ok' | 'auth' | 'unreachable';

/** GET {baseURL}/models 的只读探测结论；contextWindow 缺失表示端点未声明或数值不可信。 */
export interface ModelCatalogProbeResult {
  status: ModelCatalogProbeStatus;
  /** 判定依据的简短描述（HTTP 状态或错误摘要），供宿主原样展示，不回显响应正文。 */
  detail: string;
  /**
   * 端点为探测目标模型声明的上下文窗口（Token 数）。
   * 仅在数值通过合理区间校验时给出；宿主据此回填 profile.contextWindow，
   * 探测失败或缺失时由调用方回退到 DEFAULT_CONTEXT_WINDOW_TOKENS 的统一估算。
   */
  contextWindow?: number;
}

/** 探测入参；credential 缺省表示不带鉴权头（免密钥端点或密钥尚未配置）。 */
export interface ModelCatalogProbeOptions {
  /** 端点 Base URL；尾随斜杠会被剥掉，协议必须是 http/https。 */
  baseURL: string;
  /** wire 协议族；anthropic 按官方约定同时发 x-api-key 与 Bearer（与 Core Provider 同源）。 */
  provider: 'openai-compatible' | 'anthropic' | 'openai-responses';
  /** 请求目标模型名；用于在目录中精确匹配该模型的窗口声明。 */
  modelName?: string;
  /** 已解析的密钥；不落盘、不进日志，仅用于本次请求的鉴权头。 */
  credential?: string;
  /** Anthropic 请求携带的 workspace。 */
  anthropicWorkspaceId?: string;
  /** 超时毫秒数；必须同时覆盖建连与响应体读取，缺省 8000。 */
  timeoutMs?: number;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** 从单个目录条目提取窗口声明；兼容 context_length / context_window / max_input_tokens 三种字段名。 */
function extractEntryContextWindow(entry: Record<string, unknown>): number | undefined {
  for (const field of ['context_length', 'context_window', 'max_input_tokens']) {
    const value = entry[field];
    if (
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= MIN_PLAUSIBLE_CONTEXT_WINDOW &&
      value <= MAX_PLAUSIBLE_CONTEXT_WINDOW
    )
      return value;
  }
  return undefined;
}

/** 依据目录条目挑选窗口：优先精确匹配 modelName，仅一条结果时兜底采用；返回 undefined 表示无法采信。 */
function pickContextWindow(
  entries: readonly unknown[],
  modelName: string | undefined,
): number | undefined {
  const windows = entries.map((entry) =>
    typeof entry === 'string' || !isRecord(entry) ? undefined : extractEntryContextWindow(entry),
  );
  if (modelName) {
    const index = entries.findIndex((entry) => {
      if (typeof entry === 'string' || !isRecord(entry)) return false;
      const id = entry.id ?? entry.name ?? entry.model;
      return typeof id === 'string' && id.trim() === modelName;
    });
    if (index >= 0) return windows[index];
    return undefined;
  }
  // 目录里只有一个模型时才允许兜底，多模型网关取第一个条目容易张冠李戴。
  return entries.length === 1 ? windows[0] : undefined;
}

/**
 * 只读探测 OpenAI 兼容端点的模型目录与上下文窗口声明：GET {baseURL}/models。
 *
 * 约束与边界：
 * - 仅发起一次 GET 请求，不产生计费 token；credential 只参与本次鉴权头，不落盘；
 * - 超时用显式 AbortController 同时覆盖建连与响应体读取（网关拖住正文时不至于永久挂起）；
 * - 任何失败都以固定状态返回，绝不抛错 —— 调用方（向导/桌面保存流程）据此降级，
 *   探测永远不阻塞配置保存；
 * - 本模块属 host 层：core 保持 Headless，禁止把 fetch 下沉到 core。
 */
export async function probeModelCatalog(
  options: ModelCatalogProbeOptions,
): Promise<ModelCatalogProbeResult> {
  const timeoutMs = options.timeoutMs ?? 8_000;
  let url: URL;
  try {
    url = new URL(options.baseURL);
  } catch {
    return { status: 'unreachable', detail: 'BaseURL 无法解析' };
  }
  if (!['http:', 'https:'].includes(url.protocol))
    return { status: 'unreachable', detail: '仅支持 http/https 端点' };
  url.search = '';
  url.hash = '';
  const endpoint = `${url.href.replace(/\/$/, '')}/models`;

  const headers: Record<string, string> = { accept: 'application/json' };
  const credential = options.credential?.trim();
  if (credential && credential !== 'none') {
    if (options.provider === 'anthropic') {
      headers['x-api-key'] = credential;
      headers.Authorization = `Bearer ${credential}`;
      headers['anthropic-version'] = '2023-06-01';
      if (options.anthropicWorkspaceId) headers['anthropic-workspace-id'] = options.anthropicWorkspaceId;
    } else {
      headers.Authorization = `Bearer ${credential}`;
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let body: string;
  try {
    let response: Response;
    try {
      response = await fetch(endpoint, { headers, signal: controller.signal });
    } catch {
      return {
        status: 'unreachable',
        detail: controller.signal.aborted
          ? `探测超时（${timeoutMs}ms）`
          : '网络不可达或端点未实现 GET /models',
      };
    }
    if (response.status === 401 || response.status === 403)
      return { status: 'auth', detail: `HTTP ${response.status} ${response.statusText}` };
    if (!response.ok)
      return {
        status: 'unreachable',
        detail: `HTTP ${response.status} ${response.statusText}（端点可能未实现 GET /models）`,
      };
    try {
      body = await response.text();
    } catch {
      return {
        status: 'unreachable',
        detail: controller.signal.aborted ? `读取响应超时（${timeoutMs}ms）` : '读取响应失败',
      };
    }
  } finally {
    clearTimeout(timer);
  }
  // 响应体上限与桌面 listModels 对齐：目录响应不可能合理地超过 1MB，超限按不可信处理。
  if (body.length > 1_000_000)
    return { status: 'ok', detail: 'HTTP 200（响应体超限，未解析窗口）' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 'ok', detail: 'HTTP 200（响应不是 JSON，未解析窗口）' };
  }
  // 兼容三类常见形状：OpenAI `{data:[...]}`、Ollama `{models:[...]}`、裸数组。
  const entries = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.data)
      ? parsed.data
      : isRecord(parsed) && Array.isArray(parsed.models)
        ? parsed.models
        : undefined;
  if (!entries) return { status: 'ok', detail: 'HTTP 200（目录形状未知，未解析窗口）' };
  const contextWindow = pickContextWindow(entries, options.modelName?.trim() || undefined);
  return {
    status: 'ok',
    detail: 'HTTP 200',
    ...(contextWindow === undefined ? {} : { contextWindow }),
  };
}
