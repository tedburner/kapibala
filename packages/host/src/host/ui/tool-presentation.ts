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

/** 完整工具详情沿用摘要的敏感字段脱敏；字符串保持原文，终端控制序列由渲染器统一过滤。 */
export function formatToolDetail(value: unknown): string {
  if (typeof value === 'string') {
    try {
      return JSON.stringify(redactSensitiveFields(JSON.parse(value)), null, 2);
    } catch {
      return value;
    }
  }
  return JSON.stringify(redactSensitiveFields(value), null, 2) ?? '';
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
 * 工具显示信息；只影响 UI 渲染，不参与权限判定、不落盘、不进 Provider wire。
 * 权限匹配、审批记录与历史落盘继续使用原始工具 id，避免显示层污染协议。
 */
export interface ToolDisplay {
  /** 中文短名（如「读文件」）或 MCP 归一名（「服务 · 工具」）；未知工具为美化回退名。 */
  label: string;
  /** 动作动词（如「读取」），用于工具行前半段；缺省时渲染层回退为 label。 */
  verb?: string;
  /** 关键参数摘要，只承载一个 salience 字段（路径 / 查询词 / 命令等）；缺省时退回原摘要。 */
  chip?: (input: Record<string, unknown>) => string | undefined;
  /** chip 是否按等宽字体渲染（路径、命令类为 true）。 */
  mono?: boolean;
}

/**
 * 内置工具显示名表；新增内置工具必须在此登记，否则显示层退化为裸 id。
 * 门禁测试断言 registerBuiltinTools 注册的每个工具名都能在本表命中（与 BUILTIN_PROFILES
 * 漏同步同型的失败模式，故做成测试强制）。
 */
const BUILTIN_TOOL_DISPLAY: Record<string, ToolDisplay> = {
  read_file: {
    label: '读文件',
    verb: '读取',
    chip: (input) => stringInput(input, 'path') || undefined,
    mono: true,
  },
  write_file: {
    label: '写文件',
    verb: '写入',
    chip: (input) => stringInput(input, 'path') || undefined,
    mono: true,
  },
  edit_file: {
    label: '编辑文件',
    verb: '编辑',
    chip: (input) => stringInput(input, 'path') || undefined,
    mono: true,
  },
  glob: {
    label: '搜索文件',
    verb: '搜索',
    chip: (input) => stringInput(input, 'pattern') || undefined,
    mono: true,
  },
  grep: {
    label: '搜索内容',
    verb: '搜索',
    chip: (input) => stringInput(input, 'pattern') || undefined,
    mono: true,
  },
  run_command: {
    label: '运行命令',
    verb: '运行',
    chip: (input) => stringInput(input, 'command') || undefined,
    mono: true,
  },
  spawn_agent: {
    label: '派发子代理',
    verb: '派发',
    chip: (input) => stringInput(input, 'description') || undefined,
  },
  send_agent: {
    label: '续聊子代理',
    verb: '续聊',
    chip: (input) => stringInput(input, 'agentId') || undefined,
    mono: true,
  },
  list_agents: {
    label: '查询子代理',
    verb: '查询',
  },
  wait_agent: {
    label: '等待子代理',
    verb: '等待',
    chip: (input) => stringInput(input, 'agentId') || undefined,
    mono: true,
  },
  cancel_agent: {
    label: '取消子代理',
    verb: '取消',
    chip: (input) => stringInput(input, 'agentId') || undefined,
    mono: true,
  },
  load_skill: {
    label: '加载技能',
    verb: '加载',
    chip: (input) => stringInput(input, 'name') || undefined,
    mono: true,
  },
  list_skills: {
    label: '列出技能',
    verb: '查询',
    chip: (input) => stringInput(input, 'query') || undefined,
  },
  read_skill_resource: {
    label: '读取技能资源',
    verb: '读取',
    chip: (input) => stringInput(input, 'path') || undefined,
    mono: true,
  },
  watch_start: {
    label: '登记监视',
    verb: '监视',
    chip: (input) => stringInput(input, 'target') || undefined,
    mono: true,
  },
  watch_cancel: {
    label: '取消监视',
    verb: '取消',
    chip: (input) => stringInput(input, 'watchId') || undefined,
    mono: true,
  },
  todo_write: {
    label: '更新任务清单',
    verb: '更新',
  },
};

/** 归一 MCP 工具名为「服务 · 工具」；/mcp 工具清单与工具行共用本函数，保证同口径。 */
export function formatMcpToolLabel(server: string, tool: string): string {
  return `${sanitizeText(server)} · ${sanitizeText(tool)}`;
}

/** 未知工具的美化回退名：去 mcp__ 前缀、下划线转空格、首字母大写、截断 24 字符；绝不返回空串。 */
function beautifyUnknownToolName(name: string): string {
  const cleaned = sanitizeText(name)
    .replace(/^mcp__/, '')
    .replace(/__/g, '·')
    .replace(/_/g, ' ');
  const titled = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  return truncate(titled || 'Unknown tool', 24);
}

/**
 * 三级解析工具显示名：内置工具精确命中 → `mcp__<server>__<tool>` 归一为「服务 · 工具」
 * → 未知工具美化回退。绝不抛错、绝不返回空 label；未登记的内置工具会走回退分支，
 * 由门禁测试兜底拦截（见 tests 对 registerBuiltinTools 全量命中的断言）。
 */
export function resolveToolDisplay(name: string): ToolDisplay {
  const builtin = BUILTIN_TOOL_DISPLAY[name];
  if (builtin) return builtin;
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    if (parts.length >= 3) {
      const server = parts[1];
      const toolName = parts.slice(2).join('__');
      return { label: formatMcpToolLabel(server, toolName), mono: true };
    }
  }
  return { label: beautifyUnknownToolName(name) };
}

/**
 * 把工具名与入参投影为结构化的「动词 + 对象」两段（U1.5），供两端直接渲染而不是解析摘要。
 * 未登记的内置工具与未知工具返回空对象，调用方退回 `invocation`；绝不抛错。
 */
export function describeToolActivity(
  name: string,
  input: Record<string, unknown>,
): { verb?: string; chip?: string; mono?: boolean } {
  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    if (parts.length >= 3) {
      const server = sanitizeText(parts[1]);
      const toolName = sanitizeText(parts.slice(2).join('__'));
      return { verb: '调用', chip: `${server}/${toolName}`, mono: true };
    }
  }
  const display = BUILTIN_TOOL_DISPLAY[name];
  if (!display) return {};
  const chip = display.chip?.(input);
  return {
    ...(display.verb ? { verb: display.verb } : {}),
    ...(chip ? { chip } : {}),
    ...(display.mono ? { mono: true } : {}),
  };
}

/**
 * 把工具名与入参转换为面向终端用户的安全动作摘要。
 * 内置工具取显示名表的中文动词拼接关键参数；未知与 MCP 工具保留真实名称。
 */
export function formatToolInvocation(name: string, input: Record<string, unknown>): string {
  const safeName = sanitizeToolName(name);
  const verb = BUILTIN_TOOL_DISPLAY[name]?.verb;

  if (name === 'read_file') {
    const path = stringInput(input, 'path', '.');
    const startLine = typeof input.startLine === 'number' ? input.startLine : undefined;
    const endLine = typeof input.endLine === 'number' ? input.endLine : undefined;
    const range =
      startLine === undefined && endLine === undefined
        ? ''
        : ` · 行 ${startLine ?? 1}-${endLine ?? '末尾'}`;
    return `${verb ?? 'Read'} ${path}${range}`;
  }

  if (name === 'glob') {
    const pattern = stringInput(input, 'pattern', '*');
    const directory = stringInput(input, 'subDirectory');
    return `${verb ?? 'Search'} ${pattern}${directory ? ` in ${directory}` : ''}`;
  }

  if (name === 'grep') {
    const pattern = JSON.stringify(stringInput(input, 'pattern'));
    const target = stringInput(input, 'path', '.');
    return `${verb ?? 'Search'} ${pattern} in ${target}`;
  }

  if (name === 'write_file') {
    const path = stringInput(input, 'path', '.');
    const content = typeof input.content === 'string' ? input.content : '';
    return `${verb ?? 'Write'} ${path} · ${formatBytes(Buffer.byteLength(content, 'utf-8'))}`;
  }

  if (name === 'edit_file') {
    const path = stringInput(input, 'path', '.');
    const target = typeof input.targetContent === 'string' ? input.targetContent : '';
    return `${verb ?? 'Edit'} ${path} · 替换 ${[...target].length} 字符`;
  }

  if (name.startsWith('mcp__')) {
    const parts = name.split('__');
    if (parts.length >= 3) {
      const server = parts[1];
      const toolName = parts.slice(2).join('__');
      const entries = Object.entries(input)
        .slice(0, 3)
        .map(([key, value]) => `${sanitizeText(key)}=${formatGenericValue(key, value)}`);
      const payload = entries.length > 0 ? ` ${entries.join(' ')}` : '';
      return truncate(`[MCP: ${sanitizeText(server)}] ${sanitizeText(toolName)}${payload}`, 120);
    }
  }

  // 已登记的内置工具统一走「动词 · 关键参数」两段式，不再把裸 id 与全部入参拼成一行；
  // 这样 send_agent 等新工具不会在工具行露出英文 id（U1.1/U1.2 的口径要求）。
  const display = BUILTIN_TOOL_DISPLAY[name];
  if (display) {
    const chip = display.chip?.(input);
    return truncate(chip ? `${display.verb ?? display.label} · ${chip}` : display.label, 120);
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
