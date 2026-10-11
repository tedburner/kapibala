import path from 'node:path';
import type { SkillDiagnostic, SkillDocument } from './types.js';
import { SKILL_LIMITS } from './types.js';

/** 安全名称语法；不接受厂商命名空间、路径或连续连字符。 */
export function isSkillName(value: string): boolean {
  return value.length <= 64 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);
}

function fail(message: string): never {
  throw new Error(`Invalid skill frontmatter: ${message}`);
}

/**
 * 只在引号外识别注释，保留引号内的冒号、井号及转义字符。
 * 引号仅在值或方括号列表项起始进入成对状态；值中部的孤立引号按 YAML 纯标量原样保留，
 * 未配对也不再让整个技能拒绝。
 */
function uncomment(value: string): string {
  let quote = '';
  let bracket = false;
  let previous = ''; // 引号外上一个非空白字符；'' 表示处于值或列表项起始
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quote === '"' && char === '\\') {
      i++;
      continue;
    }
    if (quote === "'" && char === "'" && value[i + 1] === "'") {
      i++;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      continue;
    }
    if (/\s/.test(char)) continue;
    if (
      (char === "'" || char === '"') &&
      (previous === '' || (bracket && (previous === '[' || previous === ',')))
    ) {
      quote = char;
    } else if (char === '[') bracket = true;
    else if (char === ']') bracket = false;
    else if (char === '#' && (previous === '' || /\s/.test(value[i - 1]!)))
      return value.slice(0, i).trimEnd();
    previous = char;
  }
  if (quote) fail('unterminated quote');
  return value.trimEnd();
}

/** 解析支持的标量/字符串数组；拒绝会引入别名、标签或对象合并的语法。 */
function scalar(raw: string): unknown {
  const value = uncomment(raw.trim());
  if (!value) return '';
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      fail('invalid double-quoted string');
    }
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) fail('invalid single-quoted string');
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) fail('unterminated list');
    const inner = value.slice(1, -1);
    if (!inner.trim()) return [];
    const parts: string[] = [];
    let quote = '';
    let start = 0;
    for (let i = 0; i < inner.length; i++) {
      const char = inner[i];
      if (quote === '"' && char === '\\') {
        i++;
        continue;
      }
      if (quote === "'" && char === "'" && inner[i + 1] === "'") {
        i++;
        continue;
      }
      if (quote) {
        if (char === quote) quote = '';
      } else if (char === "'" || char === '"') quote = char;
      else if (char === ',') {
        parts.push(inner.slice(start, i));
        start = i + 1;
      }
    }
    if (quote) fail('unterminated list quote');
    parts.push(inner.slice(start));
    const items = parts.map((part) => scalar(part));
    if (items.some((item) => typeof item !== 'string')) fail('list values must be strings');
    return items;
  }
  if (/^[!&*{}]|^<<:/.test(value)) fail('unsupported YAML structure');
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+(?:\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/**
 * 按 YAML 字符串块语义处理折叠及尾部换行；字面样式逐行保留换行。
 * 折叠样式下，相邻普通行折叠为空格；空行各计一个换行，与更缩进行相邻的断行额外保留。
 */
function blockScalar(lines: string[], indicator: string): string {
  const nonempty = lines.filter((line) => line.trim());
  const indent = nonempty.length
    ? Math.min(...nonempty.map((line) => line.match(/^ */)![0].length))
    : 0;
  if (nonempty.some((line) => line.match(/^ */)![0].length === 0))
    fail('block scalar must be indented');
  const values = lines.map((line) => (line.trim() ? line.slice(indent) : ''));
  let text = '';
  if (indicator.startsWith('|')) {
    text = values.join('\n') + (values.length ? '\n' : '');
  } else {
    const moreIndented = (line: string): boolean => line.startsWith(' ');
    let blanks = 0;
    let previous: string | undefined;
    for (const value of values) {
      if (!value) {
        blanks++;
        continue;
      }
      if (previous === undefined) text += '\n'.repeat(blanks);
      else if (!blanks) text += moreIndented(previous) || moreIndented(value) ? '\n' : ' ';
      else
        text += '\n'.repeat(blanks) + (moreIndented(previous) || moreIndented(value) ? '\n' : '');
      blanks = 0;
      text += value;
      previous = value;
    }
    text += '\n'.repeat(blanks);
    if (values.length) text += '\n';
  }
  if (indicator.endsWith('-')) return text.replace(/\n+$/, '');
  if (indicator.endsWith('+')) return text;
  return text.replace(/\n+$/, '') + (text ? '\n' : '');
}

/** 解析常用 Frontmatter 子集；格式错误抛出，未知执行扩展返回不可执行诊断，正文不截断。 */
export function parseSkillDocument(content: string, filePath: string): SkillDocument {
  if (Buffer.byteLength(content, 'utf8') > SKILL_LIMITS.fileBytes) fail('file exceeds 128 KiB');
  const raw = content.replace(/^\uFEFF/, '');
  const opening = /^---[ \t]*\r?\n/.exec(raw);
  if (!opening) fail('missing opening delimiter');
  const rest = raw.slice(opening[0].length);
  const closing = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
  if (!closing) fail('missing closing delimiter');
  const header = rest.slice(0, closing.index);
  if (Buffer.byteLength(header, 'utf8') > SKILL_LIMITS.frontmatterBytes)
    fail('header exceeds 16 KiB');
  const body = rest.slice(closing.index + closing[0].length).replace(/\r\n/g, '\n');
  const lines = header.replace(/\r\n/g, '\n').split('\n');
  const values: Record<string, unknown> = Object.create(null);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^([a-zA-Z0-9_-]+):(?:[ \t]*(.*))?$/.exec(line);
    if (!match) fail('invalid top-level mapping');
    const key = match[1]!;
    if (Object.hasOwn(values, key)) fail('duplicate key');
    const value = uncomment(match[2] ?? '').trim();
    if (/^[|>][+-]?$/.test(value)) {
      const block: string[] = [];
      while (i + 1 < lines.length && (!lines[i + 1]!.trim() || /^ +/.test(lines[i + 1]!))) {
        block.push(lines[++i]!);
      }
      // split 产生的末尾哨兵不属于额外空白标量行，不能改变 YAML 尾部换行。
      if (i === lines.length - 1 && block.at(-1) === '') block.pop();
      values[key] = blockScalar(block, value);
    } else if (!value && /^ +\S/.test(lines[i + 1] ?? '')) {
      const nested: string[] = [];
      while (i + 1 < lines.length && (!lines[i + 1]!.trim() || /^ +/.test(lines[i + 1]!)))
        nested.push(lines[++i]!);
      const significant = nested.filter((item) => item.trim() && !item.trimStart().startsWith('#'));
      if (significant.every((item) => /^ +- /.test(item))) {
        values[key] = significant.map((item) => scalar(item.trimStart().slice(2)));
        if ((values[key] as unknown[]).some((item) => typeof item !== 'string'))
          fail('list values must be strings');
      } else {
        const mapping: Record<string, unknown> = Object.create(null);
        const indent = significant[0]?.match(/^ */)![0].length;
        for (const item of significant) {
          if (item.match(/^ */)![0].length !== indent) fail('nested mappings are unsupported');
          const pair = /^ +([a-zA-Z0-9_-]+):\s*(.*)$/.exec(item);
          if (!pair || Object.hasOwn(mapping, pair[1]!)) fail('invalid or duplicate nested key');
          mapping[pair[1]!] = scalar(pair[2]!);
        }
        values[key] = mapping;
      }
    } else values[key] = scalar(value);
  }
  const diagnostics: SkillDiagnostic[] = [];
  const warn = (code: string, message: string) =>
    diagnostics.push({ code, level: 'warn' as const, path: filePath, message });
  const directoryName = path.basename(path.dirname(filePath));
  const name = values.name === undefined ? directoryName : values.name;
  if (typeof name !== 'string' || !isSkillName(name)) fail('invalid name');
  if (values.name === undefined) warn('SKILL_NAME_FALLBACK', '名称缺省，使用目录名');
  else if (name !== directoryName) warn('SKILL_NAME_MISMATCH', '名称与目录名不同');
  const description = values.description;
  if (typeof description !== 'string' || !description.trim())
    fail('description must be a nonempty string');
  if (Array.from(description).length > 1024)
    warn('SKILL_DESCRIPTION_LONG', '描述超过规范长度，目录展示将缩短');
  for (const key of ['disable-model-invocation', 'user-invocable']) {
    if (values[key] !== undefined && typeof values[key] !== 'boolean')
      fail('invocation flag must be boolean');
  }
  const optional = (key: string): string | undefined => {
    const value = values[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'string') fail(`${key} must be a string`);
    return value;
  };
  const compatibility = optional('compatibility');
  if (compatibility && Array.from(compatibility).length > 500)
    warn('SKILL_COMPATIBILITY_LONG', '兼容说明超过规范长度');
  let allowedTools: string[] | undefined;
  if (values['allowed-tools'] !== undefined) {
    const allowed = values['allowed-tools'];
    allowedTools =
      typeof allowed === 'string'
        ? allowed.split(/\s+/).filter(Boolean)
        : Array.isArray(allowed) && allowed.every((item) => typeof item === 'string')
          ? [...allowed]
          : fail('allowed-tools must be string or string list');
    warn('SKILL_PERMISSION_SEMANTICS', '工具声明仅收紧权限，不新增预批准授权');
  }
  let metadata: Record<string, string> | undefined;
  if (values.metadata !== undefined) {
    if (
      !values.metadata ||
      typeof values.metadata !== 'object' ||
      Array.isArray(values.metadata) ||
      Object.values(values.metadata).some((item) => typeof item !== 'string')
    )
      fail('metadata must map strings to strings');
    metadata = values.metadata as Record<string, string>;
  }
  const known = new Set([
    'name',
    'description',
    'license',
    'compatibility',
    'metadata',
    'allowed-tools',
    'when',
    'when_to_use',
    'disable-model-invocation',
    'user-invocable',
    'argument-hint',
  ]);
  const unsupported = new Set(['context', 'hooks', 'model', 'agent', 'shell']);
  const blocked = Object.keys(values).filter((key) => unsupported.has(key));
  if (/!\x60[^\x60]+\x60|^\s*\x60{3}!/m.test(body)) blocked.push('dynamic-shell');
  for (const key of Object.keys(values)) {
    if (!known.has(key) && !unsupported.has(key))
      warn('SKILL_UNKNOWN_FIELD', `未解释元数据字段：${key}`);
  }
  const unavailableReason = blocked.length ? `不支持的执行扩展：${blocked.join(', ')}` : undefined;
  if (unavailableReason) warn('SKILL_UNSUPPORTED', unavailableReason);
  return {
    name,
    description,
    body,
    frontmatter: values,
    metadata,
    allowedTools,
    license: optional('license'),
    compatibility,
    when: optional('when') ?? optional('when_to_use'),
    argumentHint: optional('argument-hint'),
    modelInvocable: values['disable-model-invocation'] !== true,
    userInvocable: values['user-invocable'] !== false,
    available: !unavailableReason,
    unavailableReason,
    diagnostics,
  };
}
