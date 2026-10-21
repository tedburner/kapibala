import { redactText, sanitizeDisplayText } from './redaction.js';

/** 工具目标与结果预览的字符上限；预览不能占满单帧预算，也不冒充完整结果。 */
export const MAX_TOOL_TARGET_LENGTH = 2_000;
export const MAX_TOOL_RESULT_LENGTH = 4_000;

/** 只读取可以安全概括调用目标的字段，不序列化整个工具输入。 */
const TARGET_FIELDS = [
  'path',
  'file',
  'file_path',
  'command',
  'query',
  'url',
  'pattern',
  'name',
  'target',
] as const;

function clean(
  value: string,
  redact: ((text: string) => string) | undefined,
  maximum: number,
): string | undefined {
  return sanitizeDisplayText(redact ? redact(value) : redactText(value, []), maximum);
}

/** 把工具输入概括为单行目标；未知工具退化为工具名，不能回显完整参数。 */
export function summarizeToolTarget(
  name: string,
  input: Record<string, unknown>,
  redact?: (text: string) => string,
): string {
  for (const field of TARGET_FIELDS) {
    const value = input[field];
    if (typeof value !== 'string' || !value.trim()) continue;
    const summary = clean(value, redact, MAX_TOOL_TARGET_LENGTH);
    if (summary) return summary;
  }
  return clean(name, redact, MAX_TOOL_TARGET_LENGTH) ?? '工具调用';
}

/** 返回脱敏、单行化的结果预览；truncated 只表示原始结果超过预览上限。 */
export function previewToolResult(
  value: string,
  redact?: (text: string) => string,
): { result: string; truncated: boolean } {
  const redacted = redact ? redact(value) : redactText(value, []);
  return {
    result:
      sanitizeDisplayText(redacted.slice(0, MAX_TOOL_RESULT_LENGTH), MAX_TOOL_RESULT_LENGTH) ?? '',
    truncated: redacted.length > MAX_TOOL_RESULT_LENGTH,
  };
}
