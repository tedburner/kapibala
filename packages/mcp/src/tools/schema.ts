/**
 * @fileoverview MCP 工具输入 Schema 安全校验与约束检查
 *
 * 约束与边界：
 * 1. 单工具 inputSchema 尺寸上限为 32 KiB（32768 字节），防止超大 Schema 耗尽模型上下文与解析内存；
 * 2. 嵌套深度严格限制在 20 层以内，杜绝深层递归结构引发栈溢出；
 * 3. 显式禁止远端 `$ref`（如 `http://`, `https://`），禁止在运行时发起任何外部网络获取 Schema 的行为；
 * 4. 严禁为了兼容模型而静默删除约束（No silent dropping of constraints）；校验不通过时整项拒绝该工具并记录诊断。
 */

/** 单个工具输入 Schema 最大字节数限制（32 KiB）。 */
export const MAX_SCHEMA_SIZE_BYTES = 32768;

/** Schema 对象最大嵌套深度限制。 */
export const MAX_SCHEMA_DEPTH = 20;

/**
 * 校验工具 inputSchema 的安全性与结构约束。
 *
 * @param schema - 原始 inputSchema 对象。
 * @returns 校验结果，valid 为 false 时附带明确错误原因。
 */
export function validateToolInputSchema(schema: unknown): { valid: boolean; error?: string } {
  if (schema === undefined || schema === null) {
    return { valid: true }; // 允许无参数工具
  }

  if (typeof schema !== 'object' || Array.isArray(schema)) {
    return {
      valid: false,
      error: 'inputSchema must be a valid JSON Schema object',
    };
  }

  // 1. 检查序列化尺寸上限
  let jsonStr: string;
  try {
    jsonStr = JSON.stringify(schema);
  } catch (err: unknown) {
    return {
      valid: false,
      error: `Failed to serialize inputSchema: ${(err as Error).message}`,
    };
  }

  const byteLength = Buffer.byteLength(jsonStr, 'utf8');
  if (byteLength > MAX_SCHEMA_SIZE_BYTES) {
    return {
      valid: false,
      error: `inputSchema size (${byteLength} bytes) exceeds maximum allowed limit of ${MAX_SCHEMA_SIZE_BYTES} bytes (32 KiB)`,
    };
  }

  // 2. 检查嵌套深度与禁止远端 $ref
  try {
    checkSchemaDepthAndRefs(schema as Record<string, unknown>, 1);
  } catch (err: unknown) {
    return {
      valid: false,
      error: (err as Error).message,
    };
  }

  return { valid: true };
}

/**
 * 递归检查 Schema 嵌套深度与禁止远端 $ref 引用。
 */
function checkSchemaDepthAndRefs(node: unknown, currentDepth: number): void {
  if (currentDepth > MAX_SCHEMA_DEPTH) {
    throw new Error(
      `inputSchema nesting depth exceeds maximum allowed limit of ${MAX_SCHEMA_DEPTH} levels`,
    );
  }

  if (!node || typeof node !== 'object') return;

  if (Array.isArray(node)) {
    for (const item of node) {
      checkSchemaDepthAndRefs(item, currentDepth + 1);
    }
    return;
  }

  const obj = node as Record<string, unknown>;

  // 检查远端 $ref 攻击向量
  if (typeof obj.$ref === 'string') {
    const ref = obj.$ref.trim().toLowerCase();
    if (
      ref.startsWith('http://') ||
      ref.startsWith('https://') ||
      ref.startsWith('//') ||
      ref.startsWith('ftp://')
    ) {
      throw new Error(
        `Remote $ref '${obj.$ref}' is strictly forbidden in MCP inputSchema to prevent SSRF and network fetches`,
      );
    }
  }

  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === 'object' && val !== null) {
      checkSchemaDepthAndRefs(val, currentDepth + 1);
    }
  }
}
