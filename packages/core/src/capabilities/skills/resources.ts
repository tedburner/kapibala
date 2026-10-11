import fs from 'node:fs/promises';
import path from 'node:path';
import { isWithinSkillRoot, skillFailure, skillPathKey } from './scanner.js';
import { SKILL_LIMITS, type SkillDefinition } from './types.js';

/** 受控文本范围；offset 用于 UTF-8 大行续读，不能与行范围混用。 */
export interface SkillResourceInput {
  name: string;
  path: string;
  startLine?: number;
  endLine?: number;
  offset?: number;
}
/** 只读资源页；nextOffset 是完整 UTF-8 字符边界，不代表文件执行授权。 */
export interface SkillResourcePage {
  text: string;
  truncated: boolean;
  nextOffset?: number;
}

/** 读取技能根内文本；复核物理边界，有界返回并关闭文件，不扩大普通文件沙箱。 */
export async function readSkillResource(
  skill: SkillDefinition,
  input: SkillResourceInput,
  signal?: AbortSignal,
): Promise<SkillResourcePage> {
  if (
    typeof input.path !== 'string' ||
    !input.path ||
    input.path.length > 4096 ||
    path.win32.isAbsolute(input.path) ||
    path.posix.isAbsolute(input.path) ||
    /^[a-zA-Z]:/.test(input.path)
  )
    throw skillFailure('SKILL_RESOURCE_DENIED', '资源必须使用技能目录内的相对路径');
  const start = input.startLine ?? 1;
  const end = input.endLine;
  const offset = input.offset ?? 0;
  if (
    !Number.isSafeInteger(start) ||
    start < 1 ||
    (end !== undefined && (!Number.isSafeInteger(end) || end < start)) ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    (input.offset !== undefined && (input.startLine !== undefined || end !== undefined))
  )
    throw skillFailure('SKILL_INVALID_INPUT', '资源行范围或字节续读参数无效');
  const lexical = path.resolve(skill.baseDir, input.path.split(/[\\/]/).join(path.sep));
  if (!isWithinSkillRoot(skill.baseDir, lexical))
    throw skillFailure('SKILL_RESOURCE_DENIED', '资源路径离开技能根目录');
  let actual: string;
  try {
    actual = await fs.realpath(lexical);
  } catch {
    throw skillFailure('SKILL_RESOURCE_DENIED', '资源不存在或链接无法解析');
  }
  if (!isWithinSkillRoot(skill.baseDir, actual))
    throw skillFailure('SKILL_RESOURCE_DENIED', '资源物理路径离开技能根目录');
  signal?.throwIfAborted();
  const handle = await fs.open(actual, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || offset > stat.size)
      throw skillFailure('SKILL_RESOURCE_DENIED', '资源不是有效文本文件或续读范围已失效');
    const decoder = new TextDecoder('utf8', { fatal: true, ignoreBOM: true });
    const output: string[] = [];
    let bytes = 0;
    let position = offset;
    let consumed = offset;
    let line = 1;
    const consume = (text: string): SkillResourcePage | undefined => {
      for (const character of text) {
        if (character === '\0') throw skillFailure('SKILL_RESOURCE_DENIED', '不支持二进制资源');
        if (end !== undefined && line > end) return { text: output.join(''), truncated: false };
        const length = Buffer.byteLength(character);
        if (line >= start) {
          if (bytes + length > SKILL_LIMITS.resourceBytes)
            return { text: output.join(''), truncated: true, nextOffset: consumed };
          output.push(character);
          bytes += length;
        }
        consumed += length;
        if (character === '\n') line++;
      }
      return undefined;
    };
    while (position < stat.size) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(16 * 1024, stat.size - position));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      position += bytesRead;
      let text: string;
      try {
        text = decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
      } catch {
        throw skillFailure('SKILL_RESOURCE_DENIED', '资源不是有效 UTF-8 文本或续读不在字符边界');
      }
      const result = consume(text);
      if (result) return result;
    }
    try {
      const result = consume(decoder.decode());
      if (result) return result;
    } catch {
      throw skillFailure('SKILL_RESOURCE_DENIED', '资源不是完整 UTF-8 文本');
    }
    return { text: output.join(''), truncated: false };
  } finally {
    await handle.close();
  }
}

/** 限量列出包内资源名而不读取正文；外部链接、默认忽略目录及深层资源不展开。 */
export async function listSkillResources(
  skill: SkillDefinition,
  signal?: AbortSignal,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  const visited = new Set<string>();
  let entries = 0;
  let truncated = false;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (
      depth > SKILL_LIMITS.depth ||
      files.length > SKILL_LIMITS.resourceFiles ||
      entries >= SKILL_LIMITS.entries ||
      visited.size >= SKILL_LIMITS.directories
    ) {
      truncated = true;
      return;
    }
    signal?.throwIfAborted();
    const actual = await fs.realpath(directory);
    if (!isWithinSkillRoot(skill.baseDir, actual) || visited.has(skillPathKey(actual))) return;
    visited.add(skillPathKey(actual));
    const dir = await fs.opendir(directory);
    const names: string[] = [];
    for await (const item of dir) {
      if (++entries > SKILL_LIMITS.entries) return;
      if (!['.git', 'node_modules', 'dist', 'SKILL.md'].includes(item.name)) names.push(item.name);
    }
    names.sort();
    for (const name of names) {
      if (files.length > SKILL_LIMITS.resourceFiles) return;
      const target = path.join(directory, name);
      try {
        const real = await fs.realpath(target);
        if (!isWithinSkillRoot(skill.baseDir, real)) continue;
        const stat = await fs.stat(real);
        if (stat.isDirectory()) await walk(target, depth + 1);
        else if (stat.isFile())
          files.push(path.relative(skill.baseDir, target).split(path.sep).join('/'));
      } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
  };
  await walk(skill.baseDir, 0);
  return {
    files: files.slice(0, SKILL_LIMITS.resourceFiles),
    truncated:
      truncated || files.length > SKILL_LIMITS.resourceFiles || entries >= SKILL_LIMITS.entries,
  };
}
