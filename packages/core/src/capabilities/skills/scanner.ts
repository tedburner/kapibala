import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { KapibalaError } from '../../errors/index.js';
import { parseSkillDocument } from './frontmatter.js';
import { SKILL_LIMITS, type SkillDiagnostic, type SkillMetadata, type SkillRoot } from './types.js';

/** 技能错误仅返回受控文案；retryPolicy 不触发工具内部重试。 */
export function skillFailure(code: string, message: string): KapibalaError {
  const immediate = ['SKILL_NOT_COMMITTED', 'SKILL_CURSOR_EXPIRED'].includes(code);
  const userAction = [
    'SKILL_CHANGED',
    'SKILL_UNTRUSTED',
    'SKILL_BODY_BUDGET_EXCEEDED',
    'SKILL_CONTEXT_LOST',
  ].includes(code);
  return new KapibalaError(message, {
    code,
    safeMessage: message,
    retryPolicy: immediate ? 'immediate' : userAction ? 'after_user_action' : 'never',
  });
}

/** 以路径段判断物理边界，允许边界自身但不接受越界或其他盘符。 */
export function isWithinSkillRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Windows 物理身份忽略盘符/路径大小写，其他平台维持文件系统原义。 */
export function skillPathKey(value: string): string {
  return process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
}

/** 按 code point 排序，不使用受语言区域影响的比较器。 */
export function compareSkillPaths(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const difference = a[i]!.codePointAt(0)! - b[i]!.codePointAt(0)!;
    if (difference) return difference;
  }
  return a.length - b.length;
}

/** 有界 UTF-8 读取；先检查文件类型/大小，增长中的文件也不能突破上限。 */
export async function readBoundedSkillText(
  filePath: string,
  maximum: number,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maximum)
      throw skillFailure('SKILL_INVALID_INPUT', '文件不是可读取的有界文本');
    const chunks: Buffer[] = [];
    let size = 0;
    let position = 0;
    while (true) {
      signal?.throwIfAborted();
      const buffer = Buffer.alloc(Math.min(16 * 1024, maximum + 1 - size));
      const result = await handle.read(buffer, 0, buffer.length, position);
      if (!result.bytesRead) break;
      position += result.bytesRead;
      size += result.bytesRead;
      if (size > maximum) throw skillFailure('SKILL_INVALID_INPUT', '文件超过读取上限');
      chunks.push(buffer.subarray(0, result.bytesRead));
    }
    const bytes = Buffer.concat(chunks);
    if (bytes.includes(0)) throw skillFailure('SKILL_INVALID_INPUT', '不支持二进制资源');
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      throw skillFailure('SKILL_INVALID_INPUT', '文件不是有效 UTF-8 文本');
    }
  } finally {
    await handle.close();
  }
}

/** 原文件字节摘要；有效 UTF-8 的重新编码保留 BOM 与换行，不使用规范化正文替代。 */
export function skillDigest(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/** 单根发现结果；诊断可包含无效候选，扫描结束后只保留元数据，不常驻正文。 */
export interface SkillScanResult {
  skills: SkillMetadata[];
  diagnostics: SkillDiagnostic[];
}
interface IgnoreRule {
  directory: string;
  expression: RegExp;
  negated: boolean;
}

/** 编译支持的 ignore 子集，拒绝无法忠实解释的语法而不是扩大匹配。 */
function ignoreExpression(pattern: string): RegExp {
  let regex = '';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') {
      i++;
      if (pattern[i + 1] === '/') {
        i++;
        regex += '(?:.*/)?';
      } else regex += '.*';
    } else if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(regex);
}

/** 扫描单根的技能边界；有界异步遍历，项目未声明信任时实体只供宿主诊断。 */
export async function scanSkillRoot(
  root: SkillRoot,
  signal?: AbortSignal,
): Promise<SkillScanResult> {
  const result: SkillScanResult = { skills: [], diagnostics: [] };
  const diagnose = (code: string, target: string, message: string) =>
    result.diagnostics.push({ code, path: target, level: 'warn', message });
  let realRoot: string;
  let boundary: string;
  try {
    realRoot = await fs.realpath(root.path);
    boundary = root.boundary ? await fs.realpath(root.boundary) : realRoot;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      diagnose('SKILL_SCAN_FAILED', root.path, '无法解析技能扫描根');
    return result;
  }
  if (!isWithinSkillRoot(boundary, realRoot)) {
    diagnose('SKILL_PATH_DENIED', root.path, '技能扫描根位于授权边界外');
    return result;
  }
  const visited = new Set<string>();
  let directories = 0;
  let entries = 0;
  const trusted = root.trusted ?? root.scope !== 'project';
  const priority =
    root.scope === 'project'
      ? root.kind === 'agents'
        ? 1
        : 0
      : root.scope === 'global'
        ? root.kind === 'agents'
          ? 3
          : 2
        : 4;

  const walk = async (directory: string, depth: number, inherited: IgnoreRule[]): Promise<void> => {
    signal?.throwIfAborted();
    if (
      depth > SKILL_LIMITS.depth ||
      directories >= SKILL_LIMITS.directories ||
      entries >= SKILL_LIMITS.entries
    ) {
      diagnose('SKILL_SCAN_LIMIT', directory, '技能扫描达到深度、目录或条目上限');
      return;
    }
    let physical: string;
    try {
      physical = await fs.realpath(directory);
    } catch {
      diagnose('SKILL_SCAN_FAILED', directory, '目录不存在或链接已损坏');
      return;
    }
    if (!isWithinSkillRoot(boundary, physical)) {
      diagnose('SKILL_PATH_DENIED', directory, '技能链接位于授权边界外');
      return;
    }
    const identity = skillPathKey(physical);
    if (visited.has(identity)) return;
    visited.add(identity);
    directories++;
    const rules = [...inherited];
    const ignoreFile = path.join(physical, '.gitignore');
    try {
      const realIgnore = await fs.realpath(ignoreFile);
      if (!isWithinSkillRoot(boundary, realIgnore)) throw new Error('outside');
      const text = await readBoundedSkillText(realIgnore, SKILL_LIMITS.frontmatterBytes, signal);
      for (let line of text.split(/\r?\n/)) {
        line = line.trim();
        if (!line || line.startsWith('#')) continue;
        const negated = line.startsWith('!');
        if (negated) line = line.slice(1);
        if (line.startsWith('\\#') || line.startsWith('\\!')) line = line.slice(1);
        if (/[\[\]{}\\]/.test(line)) {
          diagnose('SKILL_IGNORE_UNSUPPORTED', ignoreFile, '忽略表达式不在支持子集内');
          continue;
        }
        const anchored = line.startsWith('/');
        if (anchored) line = line.slice(1);
        const directoryOnly = line.endsWith('/');
        if (directoryOnly) line = line.slice(0, -1);
        if (!line) continue;
        const compiled = ignoreExpression(line).source;
        rules.push({
          directory,
          negated,
          expression: new RegExp(
            `${anchored || line.includes('/') ? '^' : '(?:^|/)'}${compiled}${directoryOnly ? '(?:/|$)' : '$'}`,
          ),
        });
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        diagnose('SKILL_IGNORE_UNSUPPORTED', ignoreFile, '忽略文件无法安全读取');
    }
    const ignored = (target: string, isDirectory: boolean) => {
      let excluded = false;
      for (const rule of rules) {
        const relative = path.relative(rule.directory, target).split(path.sep).join('/');
        if (relative.startsWith('../')) continue;
        if (rule.expression.test(relative) || (isDirectory && rule.expression.test(`${relative}/`)))
          excluded = !rule.negated;
      }
      return excluded;
    };
    const lexicalFile = path.join(directory, 'SKILL.md');
    try {
      const stat = await fs.lstat(lexicalFile);
      if (stat.isFile() || stat.isSymbolicLink()) {
        if (ignored(lexicalFile, false)) return;
        const actualFile = await fs.realpath(lexicalFile);
        if (!isWithinSkillRoot(boundary, actualFile)) {
          diagnose('SKILL_PATH_DENIED', lexicalFile, '技能文件链接位于授权边界外');
          return;
        }
        const raw = await readBoundedSkillText(actualFile, SKILL_LIMITS.fileBytes, signal);
        const document = parseSkillDocument(raw, actualFile);
        result.diagnostics.push(...document.diagnostics);
        if (!trusted) diagnose('SKILL_UNTRUSTED', lexicalFile, '项目技能尚未获得宿主信任');
        const {
          frontmatter: _frontmatter,
          diagnostics: _diagnostics,
          body: _body,
          ...data
        } = document;
        result.skills.push({
          ...data,
          scope: root.scope,
          sourceRoot: realRoot,
          filePath: actualFile,
          discoveryRoot: path.resolve(root.path),
          discoveryPath: path.resolve(lexicalFile),
          baseDir: path.dirname(actualFile),
          contentDigest: skillDigest(raw),
          priority,
          disabled: false,
          available: document.available && trusted,
          unavailableReason: !trusted ? '项目技能尚未信任' : document.unavailableReason,
        });
        return;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        diagnose('SKILL_INVALID', lexicalFile, '技能文件格式、大小或读取校验失败');
        return;
      }
    }
    const names: string[] = [];
    try {
      const dir = await fs.opendir(directory);
      for await (const item of dir) {
        entries++;
        if (entries > SKILL_LIMITS.entries) {
          diagnose('SKILL_SCAN_LIMIT', directory, '技能目录条目超限，本目录不进行部分随机发现');
          return;
        }
        if (!['.git', 'node_modules', 'dist'].includes(item.name)) names.push(item.name);
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      diagnose('SKILL_SCAN_FAILED', directory, '技能目录无法遍历');
      return;
    }
    names.sort(compareSkillPaths);
    for (const name of names) {
      signal?.throwIfAborted();
      const target = path.join(directory, name);
      try {
        const stat = await fs.stat(target);
        if (stat.isDirectory() && !ignored(target, true)) await walk(target, depth + 1, rules);
      } catch (error) {
        if (signal?.aborted) throw error;
        diagnose('SKILL_SCAN_FAILED', target, '扫描条目无法解析');
      }
    }
  };
  await walk(path.resolve(root.path), 0, []);
  return result;
}
