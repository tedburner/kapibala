/**
 * @fileoverview `.worktreeinclude` 规则解析与被忽略常规文件安全拷贝器。
 *
 * 安全与性能边界：
 * - 仅拷贝同时满足「命中 `.worktreeinclude` 规则」且「在主仓被 Git 忽略（`git check-ignore` 确认）」的常规文件；
 * - 严禁跟随或拷贝任何符号链接（`lstatSync().isFile()`），防止通过软链把主仓外敏感文件带入工作树；
 * - 严格执行单文件 ≤ 8 MiB、总计 ≤ 32 MiB 硬预算，且使用 `COPYFILE_EXCL | COPYFILE_FICLONE` 零覆盖写时复制；
 * - 默认跳过 `.git`、`.kapibala` 以及未在 `.worktreeinclude` 中显式提及的 `node_modules` 子树，避免遍历数万依赖文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { isPathInside } from '@kiturone/kapibala';
import { runWorktreeGit, splitNulStrings } from './git-exec.js';
import {
  MAX_GIT_LINK_READ_BYTES,
  MAX_WORKTREE_INCLUDE_FILE_BYTES,
  MAX_WORKTREE_INCLUDE_TOTAL_BYTES,
} from './types.js';

interface CompiledIncludeRule {
  readonly negated: boolean;
  readonly dirOnly: boolean;
  readonly regex: RegExp;
  readonly basenameOnly: boolean;
}

/**
 * 若 `<projectRoot>/.worktreeinclude` 存在且为常规文件，按规则将主仓中被 Git 忽略的匹配常规文件拷贝到新建工作树。
 *
 * @returns 实际成功拷贝的相对路径（正斜杠）有序列表。
 */
export async function copyWorktreeIncludeFiles(options: {
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly baseEnv?: Readonly<Record<string, string | undefined>>;
}): Promise<string[]> {
  const includeFilePath = path.join(options.projectRoot, '.worktreeinclude');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(includeFilePath);
  } catch {
    return [];
  }
  if (!stat.isFile() || stat.size === 0 || stat.size > MAX_GIT_LINK_READ_BYTES) {
    return [];
  }

  const rawText = fs.readFileSync(includeFilePath, 'utf8');
  const { rules, mentionsNodeModules } = parseWorktreeInclude(rawText);
  if (rules.length === 0) {
    return [];
  }

  const candidateRelPaths: string[] = [];
  walkMatchingRegularFiles({
    rootDir: options.projectRoot,
    relDir: '',
    rules,
    skipNodeModules: !mentionsNodeModules,
    out: candidateRelPaths,
  });

  if (candidateRelPaths.length === 0) {
    return [];
  }

  // 经主仓 `git check-ignore` 精确筛出真正被 Git 忽略且未跟踪的路径。
  const checkRes = await runWorktreeGit({
    cwd: options.projectRoot,
    args: ['check-ignore', '-z', '--stdin'],
    input: Buffer.from(`${candidateRelPaths.join('\0')}\0`, 'utf8'),
    baseEnv: options.baseEnv,
    allowedExitCodes: [0, 1],
  });
  if (checkRes.exitCode !== 0 || checkRes.stdout.length === 0) {
    return [];
  }

  const ignoredConfirmed = Array.from(new Set(splitNulStrings(checkRes.stdout))).sort();
  const copied: string[] = [];
  let totalCopiedBytes = 0;
  const copyFlags = fs.constants.COPYFILE_EXCL | fs.constants.COPYFILE_FICLONE;

  for (const relPath of ignoredConfirmed) {
    if (!relPath || relPath.startsWith('..') || path.isAbsolute(relPath)) continue;
    const segments = relPath.split('/').filter(Boolean);
    if (
      segments.length === 0 ||
      segments.some((seg) => {
        const cleanedLower = seg.replace(/[. ]+$/, '').toLowerCase();
        return (
          seg === '.' || seg === '..' || cleanedLower === '.git' || cleanedLower === '.kapibala'
        );
      })
    ) {
      continue;
    }

    const srcFull = path.join(options.projectRoot, ...segments);
    let srcStat: fs.Stats;
    try {
      srcStat = fs.lstatSync(srcFull);
    } catch {
      continue;
    }
    if (!srcStat.isFile()) continue;
    if (srcStat.size > MAX_WORKTREE_INCLUDE_FILE_BYTES) continue;
    if (totalCopiedBytes + srcStat.size > MAX_WORKTREE_INCLUDE_TOTAL_BYTES) continue;

    const destFull = path.join(options.worktreePath, ...segments);
    if (!isPathInside(options.worktreePath, destFull)) continue;
    if (hasSymlinkParentInWorktree(options.worktreePath, segments)) continue;

    // 显式使用 lstatSync 检测目标是否已存在（含指向不存在目标的悬空符号链接：existsSync 为 false 但 lstatSync 成功），避免穿透写入或异常中止。
    try {
      fs.lstatSync(destFull);
      continue;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        continue;
      }
    }

    fs.mkdirSync(path.dirname(destFull), { recursive: true });
    try {
      fs.copyFileSync(srcFull, destFull, copyFlags);
      totalCopiedBytes += srcStat.size;
      copied.push(segments.join('/'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
        continue;
      }
      throw err;
    }
  }

  return copied;
}

function hasSymlinkParentInWorktree(worktreePath: string, segments: readonly string[]): boolean {
  let current = worktreePath;
  for (let i = 0; i < segments.length - 1; i++) {
    current = path.join(current, segments[i]!);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      return true;
    }
  }
  return false;
}

function walkMatchingRegularFiles(options: {
  readonly rootDir: string;
  readonly relDir: string;
  readonly rules: readonly CompiledIncludeRule[];
  readonly skipNodeModules: boolean;
  readonly out: string[];
}): void {
  const currentFull = options.relDir ? path.join(options.rootDir, options.relDir) : options.rootDir;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentFull, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const lowerName = entry.name.replace(/[. ]+$/, '').toLowerCase();
    if (lowerName === '.git' || lowerName === '.kapibala') continue;
    if (options.skipNodeModules && lowerName === 'node_modules') continue;
    if (entry.isSymbolicLink()) continue;

    const relPosix = options.relDir ? `${options.relDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      walkMatchingRegularFiles({
        rootDir: options.rootDir,
        relDir: relPosix,
        rules: options.rules,
        skipNodeModules: options.skipNodeModules,
        out: options.out,
      });
    } else if (entry.isFile()) {
      if (matchesIncludeRules(relPosix, options.rules)) {
        options.out.push(relPosix);
      }
    }
  }
}

function matchesIncludeRules(relPosix: string, rules: readonly CompiledIncludeRule[]): boolean {
  const basename = path.posix.basename(relPosix);
  const ancestorDirs: string[] = [];
  const parts = relPosix.split('/');
  for (let i = 1; i < parts.length; i++) {
    ancestorDirs.push(parts.slice(0, i).join('/'));
  }

  let included = false;
  for (const rule of rules) {
    let matched = false;
    if (rule.dirOnly) {
      matched = ancestorDirs.some((dir) =>
        rule.basenameOnly ? rule.regex.test(path.posix.basename(dir)) : rule.regex.test(dir),
      );
    } else if (rule.basenameOnly) {
      matched =
        rule.regex.test(basename) ||
        ancestorDirs.some((dir) => rule.regex.test(path.posix.basename(dir)));
    } else {
      matched = rule.regex.test(relPosix) || ancestorDirs.some((dir) => rule.regex.test(dir));
    }

    if (matched) {
      included = !rule.negated;
    }
  }
  return included;
}

function parseWorktreeInclude(raw: string): {
  readonly rules: CompiledIncludeRule[];
  readonly mentionsNodeModules: boolean;
} {
  const rules: CompiledIncludeRule[] = [];
  let mentionsNodeModules = false;

  for (const rawLine of raw.split(/\r?\n/)) {
    let line = rawLine.replace(/(?<!\\)\s+$/, '').replace(/\\ /g, ' ');
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('\\#') || line.startsWith('\\!')) {
      line = line.slice(1);
    }

    let negated = false;
    if (line.startsWith('!')) {
      negated = true;
      line = line.slice(1);
    }
    if (!line) continue;

    if (line.toLowerCase().includes('node_modules')) {
      mentionsNodeModules = true;
    }

    let dirOnly = false;
    if (line.endsWith('/')) {
      dirOnly = true;
      line = line.replace(/\/+$/, '');
    }
    if (!line) continue;

    const anchored = line.startsWith('/');
    if (anchored) {
      line = line.replace(/^\/+/, '');
    }

    const hasInternalSlash = line.includes('/');
    const basenameOnly = !anchored && !hasInternalSlash;
    const regex = globToRegExp(line, anchored || hasInternalSlash);
    rules.push({ negated, dirOnly, regex, basenameOnly });
  }

  return { rules, mentionsNodeModules };
}

function globToRegExp(pattern: string, anchoredToRoot: boolean): RegExp {
  let expr = anchoredToRoot ? '^' : '(?:^|/)';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          expr += '(?:.*/)?';
          i += 3;
          continue;
        }
        expr += '.*';
        i += 2;
        continue;
      }
      expr += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      expr += '[^/]';
      i += 1;
      continue;
    }
    if (ch === '[') {
      const close = pattern.indexOf(']', i + 1);
      if (close > i + 1) {
        const inner = pattern.slice(i + 1, close).replace(/^!/, '^');
        expr += `[${inner}]`;
        i = close + 1;
        continue;
      }
    }
    expr += ch.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
    i += 1;
  }
  expr += '$';
  return new RegExp(expr);
}
