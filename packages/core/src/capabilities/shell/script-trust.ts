import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 脚本来源可信度的三值结果；`unknown` 是 fail-closed 的默认值，不是「大概率安全」。
 *
 * 为什么需要这一层：`run_command` 可以执行模型刚写出的脚本，单看命令形状（解释器 + 工作区内
 * 路径）无法区分「仓库里已提交、用户审阅过的脚本」与「本会话刚生成的脚本」。Auto 模式只应
 * 自动放行前者，因此用 git 工作区状态作为「用户是否审阅过」的近似证据。
 */
export type ScriptTrust = 'clean' | 'dirty' | 'unknown';

/** 解释器程序；其首个非选项参数视为将被执行的脚本。 */
const INTERPRETERS = new Set([
  'bash',
  'bun',
  'dash',
  'deno',
  'node',
  'powershell',
  'pwsh',
  'python',
  'python3',
  'sh',
  'tsx',
  'zsh',
]);

/** 会执行 `package.json` 脚本的包管理器子命令。 */
const PACKAGE_SCRIPT_SUBCOMMANDS = new Set([
  'build',
  'dev',
  'format',
  'lint',
  'run',
  'run-script',
  'start',
  'test',
  'typecheck',
]);

/** 取值型包管理器选项：跳过它和它的值，避免把选项值误认成子命令。 */
const PACKAGE_VALUE_FLAGS = new Set([
  '--dir',
  '--filter',
  '--prefix',
  '--reporter',
  '--workspace',
  '-C',
  '-F',
]);

/** 看起来像可执行脚本的扩展名；只用于识别 `./x.sh` 形式。 */
const SCRIPT_EXTENSION = /\.(?:bash|cjs|cts|js|jsx|ksh|mjs|mts|php|pl|ps1|py|rb|sh|ts|tsx|zsh)$/i;

/** git 状态查询上限；超时或失败一律 `unknown`，不阻塞审批。 */
const GIT_TIMEOUT_MS = 2000;

/**
 * 计算命令将执行的脚本 / `package.json` 的 git 可信度。
 *
 * 返回 `undefined` 表示命令没有可静态识别的脚本目标（如 `ls`、`git status`），此时分类器
 * 本来就不会走脚本分支。任一目标有未提交改动（含未跟踪文件，即模型刚写入的脚本）→ `dirty`；
 * 目标全部干净 → `clean`；无 `.git`、路径越界、解析失败或 git 超时 → `unknown`。
 *
 * 只读：不修改仓库、不执行脚本；git 调用使用 2s 超时与最小环境变量集。
 */
export function assessScriptTrust(
  command: string,
  cwd: string,
  rootDir: string,
): ScriptTrust | undefined {
  const segments = splitSegments(command);
  if (segments === undefined) return 'unknown';
  const root = path.resolve(rootDir);
  const targets = new Set<string>();
  for (const segment of segments) {
    const words = splitWords(segment);
    if (words === undefined || words.length === 0) return 'unknown';
    const extracted = segmentTargets(words, cwd, root);
    if (extracted === 'unknown') return 'unknown';
    for (const target of extracted) targets.add(target);
  }
  if (targets.size === 0) return undefined;
  return gitTrust([...targets], root);
}

/** 单段内的脚本目标提取；返回 `unknown` 表示该段无法静态判读。 */
function segmentTargets(
  words: readonly string[],
  cwd: string,
  root: string,
): readonly string[] | 'unknown' {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
  if (words[index] === 'time' || words[index] === 'command') index++;
  const rawProgram = words[index];
  const program = baseName(rawProgram);
  if (program === undefined) return 'unknown';
  let rest = words.slice(index + 1);

  if (INTERPRETERS.has(program)) {
    // `bun run` / `deno run` 后跟的才是脚本或 package.json 脚本名。
    if ((program === 'bun' || program === 'deno') && rest[0] === 'run') rest = rest.slice(1);
    // `-c` / `-e` / 标准输入的内容不在文件里，无法用 git 判断，交给分类器归 unknown。
    if (
      rest.some(
        (word) =>
          word === '-c' || word === '-e' || word === '--eval' || word === '-p' || word === '-m',
      )
    )
      return 'unknown';
    if (rest.includes('-') || rest.includes('--')) return 'unknown';
    const script = rest.find((word) => !word.startsWith('-'));
    if (script === undefined) return [];
    // `bun run <name>` 没有脚本扩展名时是 package.json 脚本，与包管理器同一条信任链。
    if (!SCRIPT_EXTENSION.test(script)) {
      if (program !== 'bun') return 'unknown';
      const manifest = nearestPackageJson(cwd, root);
      return manifest === undefined ? 'unknown' : [manifest];
    }
    return resolveTarget(script, cwd, root);
  }

  if (program === 'npm' || program === 'pnpm' || program === 'yarn') {
    const subcommand = firstSubcommand(rest);
    if (subcommand === undefined) return [];
    if (!PACKAGE_SCRIPT_SUBCOMMANDS.has(subcommand)) return [];
    const manifest = nearestPackageJson(cwd, root);
    return manifest === undefined ? 'unknown' : [manifest];
  }

  if (rawProgram !== undefined && looksLikeScriptPath(rawProgram))
    return resolveTarget(rawProgram, cwd, root);

  return [];
}

/** 形如 `./x.sh`、`/abs/x.py` 或 `C:\\x.ps1` 的直引脚本。 */
function looksLikeScriptPath(word: string): boolean {
  if (!SCRIPT_EXTENSION.test(word)) return false;
  return (
    word.startsWith('./') ||
    word.startsWith('.\\') ||
    word.startsWith('/') ||
    word.startsWith('~') ||
    /^[A-Za-z]:[\\/]/.test(word)
  );
}

/**
 * 解析脚本路径：变量 / `~` / 越界 / 无脚本扩展名 / 文件不存在都不可信。
 *
 * 不存在的路径在 `git status -- <path>` 下输出为空，若不在这里拦下会被误判成 `clean`，
 * 因此必须显式要求文件存在。
 */
function resolveTarget(script: string, cwd: string, root: string): readonly string[] | 'unknown' {
  if (!SCRIPT_EXTENSION.test(script)) return 'unknown';
  if (script.includes('$') || script.includes('`') || script.startsWith('~')) return 'unknown';
  const resolved = path.resolve(cwd, script);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return 'unknown';
  if (!fs.existsSync(resolved)) return 'unknown';
  return [resolved];
}

/** 从 cwd 向上找到最近的 `package.json`，不越过工作区根。 */
function nearestPackageJson(cwd: string, root: string): string | undefined {
  let current = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(current, 'package.json');
    if (fs.existsSync(candidate)) return candidate;
    if (current === root) return undefined;
    const parent = path.dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** 用 `git status --porcelain -- <paths>` 判断目标是否有未提交改动。 */
function gitTrust(targets: readonly string[], root: string): ScriptTrust {
  if (!fs.existsSync(path.join(root, '.git'))) return 'unknown';
  const relatives = targets.map((target) => path.relative(root, target).replace(/\\/g, '/'));
  if (relatives.some((relative) => relative === '' || relative.startsWith('..'))) return 'unknown';
  try {
    const output = execFileSync('git', ['-C', root, 'status', '--porcelain', '--', ...relatives], {
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      env: gitEnvironment(),
    });
    return output.trim() === '' ? 'clean' : 'dirty';
  } catch {
    return 'unknown';
  }
}

/** git 只需要定位可执行文件与用户配置；不继承任意业务变量或凭据。 */
function gitEnvironment(): NodeJS.ProcessEnv {
  const allowed = [
    'PATH',
    'Path',
    'PATHEXT',
    'SystemRoot',
    'ComSpec',
    'TEMP',
    'TMP',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'LANG',
    'LC_ALL',
  ];
  return Object.fromEntries(
    allowed.filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
}

/** 引号感知分段：只按引号外的 `&&` `||` `;` `|` 与换行拆分；不闭合引号返回 undefined。 */
function splitSegments(command: string): string[] | undefined {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (
      (character === '&' && command[index + 1] === '&') ||
      (character === '|' && command[index + 1] === '|')
    ) {
      segments.push(current);
      current = '';
      index++;
      continue;
    }
    if (character === ';' || character === '|' || character === '&' || character === '\n') {
      segments.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (quote !== undefined) return undefined;
  segments.push(current);
  return segments.filter((segment) => segment.trim() !== '');
}

/** 引号感知分词；引号不闭合返回 undefined，成对引号剥离后作为单词。 */
function splitWords(text: string): string[] | undefined {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const character of text) {
    if (quote) {
      if (character === quote) {
        quote = undefined;
        words.push(current);
        current = '';
        started = false;
      } else {
        current += character;
      }
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      started = true;
      continue;
    }
    if (character === ' ' || character === '\t') {
      if (started) words.push(current);
      current = '';
      started = false;
      continue;
    }
    current += character;
    started = true;
  }
  if (quote !== undefined) return undefined;
  if (started) words.push(current);
  return words;
}

/** 跳过选项与取值，取第一个真正的子命令（小写）。 */
function firstSubcommand(words: readonly string[]): string | undefined {
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word.startsWith('-')) {
      if (PACKAGE_VALUE_FLAGS.has(word)) index++;
      continue;
    }
    return word.toLowerCase();
  }
  return undefined;
}

/** 去掉路径前缀取程序名；空词或以 `-` 开头返回 undefined。 */
function baseName(word: string | undefined): string | undefined {
  if (word === undefined || word === '' || word.startsWith('-')) return undefined;
  const normalised = word.replace(/\\/g, '/');
  const name = normalised.slice(normalised.lastIndexOf('/') + 1).toLowerCase();
  return name === '' ? undefined : name;
}
