const SENSITIVE_FIELD =
  /(?:apikey|authorization|cookie|password|secret|credential|token|auth|key)$/i;
const ESC = '\x1b';
const ANSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g');
// ⚠️ 与 packages/core/src/tools/builtin/fs.ts 的空结果文案逐字一致（改动任一侧必须同步）。
// 这两个字符串是 glob/grep「未命中」的判定依据，文案漂移会导致未命中被误报为「1 个匹配」。
const GLOB_EMPTY_RESULT = 'No matching files found.';
const GREP_EMPTY_RESULT = 'No matches found.';

function isSensitiveField(key: string): boolean {
  return SENSITIVE_FIELD.test(key.replace(/[^a-z0-9]/gi, ''));
}

function sanitizeText(value: unknown): string {
  const withoutAnsi = String(value ?? '').replace(ANSI_PATTERN, '');
  let safe = '';
  for (const character of withoutAnsi) {
    const codePoint = character.codePointAt(0) ?? 0;
    safe += codePoint < 0x20 || codePoint === 0x7f ? ' ' : character;
  }
  return safe.replace(/\s+/g, ' ').trim();
}

/** 将工具名净化为可安全写入终端的单行文本。 */
export function sanitizeToolName(name: string): string {
  return sanitizeText(name) || 'unknown';
}

function truncate(text: string, maxLength: number): string {
  const characters = [...text];
  return characters.length <= maxLength
    ? text
    : `${characters.slice(0, Math.max(0, maxLength - 1)).join('')}…`;
}

function redactSensitiveFields(value: unknown, key?: string): unknown {
  if (key && isSensitiveField(key)) return '[REDACTED]';
  if (Array.isArray(value)) return value.map((item) => redactSensitiveFields(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [
        childKey,
        redactSensitiveFields(childValue, childKey),
      ]),
    );
  }
  return value;
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes}B`;
  if (bytes < 1_024 * 1_024) {
    const value = bytes / 1_024;
    return `${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, '')}KB`;
  }
  const value = bytes / (1_024 * 1_024);
  return `${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, '')}MB`;
}

function stringInput(input: Record<string, unknown>, key: string, fallback = ''): string {
  const value = input[key];
  return typeof value === 'string' ? sanitizeText(value) : fallback;
}

function formatGenericValue(key: string, value: unknown): string {
  if (isSensitiveField(key)) return '[REDACTED]';
  if (typeof value === 'string') return truncate(sanitizeText(value), 48);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return String(value);
  }
  return truncate(sanitizeText(JSON.stringify(redactSensitiveFields(value))), 48);
}

/**
 * 把工具名与入参转换为面向终端用户的安全动作摘要。
 * 内置工具映射为 Read / Search / Write / Edit；未知与 MCP 工具保留真实名称。
 */
export function formatToolInvocation(name: string, input: Record<string, unknown>): string {
  const safeName = sanitizeToolName(name);

  if (name === 'read_file') {
    const path = stringInput(input, 'path', '.');
    const startLine = typeof input.startLine === 'number' ? input.startLine : undefined;
    const endLine = typeof input.endLine === 'number' ? input.endLine : undefined;
    const range =
      startLine === undefined && endLine === undefined
        ? ''
        : ` · 行 ${startLine ?? 1}-${endLine ?? '末尾'}`;
    return `Read ${path}${range}`;
  }

  if (name === 'glob') {
    const pattern = stringInput(input, 'pattern', '*');
    const directory = stringInput(input, 'subDirectory');
    return `Search ${pattern}${directory ? ` in ${directory}` : ''}`;
  }

  if (name === 'grep') {
    const pattern = JSON.stringify(stringInput(input, 'pattern'));
    const target = stringInput(input, 'path', '.');
    return `Search ${pattern} in ${target}`;
  }

  if (name === 'write_file') {
    const path = stringInput(input, 'path', '.');
    const content = typeof input.content === 'string' ? input.content : '';
    return `Write ${path} · ${formatBytes(Buffer.byteLength(content, 'utf-8'))}`;
  }

  if (name === 'edit_file') {
    const path = stringInput(input, 'path', '.');
    const target = typeof input.targetContent === 'string' ? input.targetContent : '';
    return `Edit ${path} · 替换 ${[...target].length} 字符`;
  }

  const entries = Object.entries(input)
    .slice(0, 3)
    .map(([key, value]) => `${sanitizeText(key)}=${formatGenericValue(key, value)}`);
  return truncate([safeName, ...entries].join(' '), 120);
}

/** 将工具结果压缩为状态行元数据；成功结果不回显正文。 */
export function formatToolResultSummary(
  name: string,
  result: string,
  isError: boolean,
): string | undefined {
  const cleanResult = sanitizeText(result);
  if (isError) return truncate(cleanResult || '工具执行失败', 120);

  if (name === 'glob') {
    const count = result === GLOB_EMPTY_RESULT ? 0 : result.split(/\r?\n/).filter(Boolean).length;
    return `${count} 个匹配`;
  }
  if (name === 'grep') {
    const count = result === GREP_EMPTY_RESULT ? 0 : result.split(/\r?\n/).filter(Boolean).length;
    return `${count} 个匹配`;
  }
  if (name === 'read_file') {
    // 剥掉可能存在的单个尾换行再计数，避免 split 出尾部空行导致行数多算 1。
    const body = result.length === 0 ? '' : result.replace(/\r?\n$/, '');
    const lines = body.length === 0 ? 0 : body.split(/\r?\n/).length;
    return `${formatBytes(Buffer.byteLength(result, 'utf-8'))} · ${lines} 行`;
  }
  return undefined;
}
