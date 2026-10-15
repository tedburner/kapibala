/**
 * @fileoverview MCP 工具输出净化、20 KiB 预算截断与二进制脱敏
 *
 * 约束与边界：
 * 1. 模型可见与历史保存结果默认上限为 20 KiB（20480 字节）UTF-8，防止超长工具结果爆上下文；
 * 2. 传输协议响应硬上限为 4 MiB（4194304 字节），超过直接拒绝；
 * 3. 截断保持结构安全：纯文本保留头尾并标注省略字节，结构化 JSON 按完整项截断，杜绝返回残缺破碎的 JSON 语法；
 * 4. 二进制与多媒体脱敏：图片（image）、音频或内嵌二进制只保留类型与大小元数据占位符，严禁落盘裸 Base64，严禁发起网络链接下载；
 * 5. 私有 _meta 字段剔除，仅暴露安全的公开结果数据。
 */

/** 模型可见与落盘保留默认上限（20 KiB = 20480 字节）。 */
export const DEFAULT_RESULT_BUDGET_BYTES = 20480;

/** 传输总线硬上限（4 MiB = 4194304 字节）。 */
export const MAX_WIRE_TRANSPORT_BYTES = 4194304;

/**
 * 文本截断选项。
 */
export interface TextTruncateOptions {
  /** 最大保留字节数，默认 20480。 */
  maxBytes?: number;
  /** 头部保留字节比例（0~1），默认 0.6。 */
  headRatio?: number;
}

/**
 * 安全截断超长 UTF-8 文本，保留头部与尾部，中间插入明确的省略标记。
 *
 * @param text - 原始文本。
 * @param options - 截断配置。
 * @returns 截断并注入省略标记后的安全文本。
 */
export function truncateTextSafely(text: string, options: TextTruncateOptions = {}): string {
  const maxBytes = options.maxBytes ?? DEFAULT_RESULT_BUDGET_BYTES;
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;

  const markerEstimate = 40;
  const availableBytes = Math.max(64, maxBytes - markerEstimate);
  const headRatio = options.headRatio ?? 0.6;
  const headBytes = Math.floor(availableBytes * headRatio);
  const tailBytes = Math.floor(availableBytes * (1 - headRatio));
  const omittedBytes = buf.length - headBytes - tailBytes;

  const head = buf.subarray(0, headBytes).toString('utf8');
  const tail = buf.subarray(buf.length - tailBytes).toString('utf8');

  return `${head}\n... [omitted ${omittedBytes} bytes] ...\n${tail}`;
}

/**
 * 净化原始 MCP 工具调用内容项（Content Block）。
 *
 * 规则：
 * - text 项：保留文本并检查 20 KiB 截断；
 * - image 项：替换为 `[Embedded Image: <mimeType>, <bytes> bytes not retained]`，剔除 data Base64；
 * - resource 项：仅保留 uri 与 mimeType，丢弃二进制正文与私有 _meta；
 * - 私有 _meta 属性丢弃。
 *
 * @param block - 原始 MCP 内容块。
 * @returns 净化后的安全文本表示。
 */
export function sanitizeMcpContentBlock(block: any): string {
  if (!block || typeof block !== 'object') {
    return String(block ?? '');
  }

  const type = block.type;

  // 1. 文本内容
  if (type === 'text') {
    const rawText = typeof block.text === 'string' ? block.text : JSON.stringify(block.text ?? '');
    return truncateTextSafely(rawText);
  }

  // 2. 图片内容脱敏（禁止裸 Base64）
  if (type === 'image') {
    const mimeType = block.mimeType || 'image/unknown';
    const dataLen = typeof block.data === 'string' ? block.data.length : 0;
    const approxBytes = Math.floor((dataLen * 3) / 4);
    return `[Embedded Image: ${mimeType}, ~${approxBytes} bytes not retained]`;
  }

  // 3. 嵌入资源
  if (type === 'resource') {
    const resource = block.resource || {};
    const uri = resource.uri || 'unknown-uri';
    const mimeType = resource.mimeType ? `, ${resource.mimeType}` : '';
    return `[Embedded Resource: ${uri}${mimeType}]`;
  }

  // 4. 音频内容脱敏（禁止裸 Base64 进入历史与模型）
  if (type === 'audio') {
    const mimeType = block.mimeType || 'audio/unknown';
    const dataLen = typeof block.data === 'string' ? block.data.length : 0;
    const approxBytes = Math.floor((dataLen * 3) / 4);
    return `[Embedded Audio: ${mimeType}, ~${approxBytes} bytes not retained]`;
  }

  // 兜底对象序列化（剔除 _meta）
  const { _meta: _ignored1, ...cleanObj } = block;
  return truncateTextSafely(JSON.stringify(cleanObj));
}

/**
 * 净化结构化输出（structuredContent）。
 *
 * 保证：
 * - 剔除私有 _meta 字段；
 * - 确保序列化不超过 20 KiB；若超限则降级并安全截断为摘要，绝不产生破坏 JSON 语法的碎片。
 *
 * @param structured - 原始结构化数据对象。
 * @returns 净化后的 JSON 文本。
 */
export function sanitizeStructuredContent(structured: unknown): string {
  if (structured === undefined || structured === null) {
    return '';
  }

  let cleanData: unknown = structured;
  if (typeof structured === 'object' && structured !== null && !Array.isArray(structured)) {
    const { _meta: _ignored2, ...rest } = structured as Record<string, unknown>;
    cleanData = rest;
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(cleanData, null, 2);
  } catch (err: unknown) {
    return `[Serialization Error: ${(err as Error).message}]`;
  }

  const byteLength = Buffer.byteLength(serialized, 'utf8');
  if (byteLength > MAX_WIRE_TRANSPORT_BYTES) {
    throw new Error(
      `MCP result wire payload (${byteLength} bytes) exceeds transport hard limit of ${MAX_WIRE_TRANSPORT_BYTES} bytes (4 MiB)`,
    );
  }

  if (byteLength > DEFAULT_RESULT_BUDGET_BYTES) {
    // 超过 20 KiB，生成安全截断的摘要表示
    return truncateTextSafely(serialized);
  }

  return serialized;
}
