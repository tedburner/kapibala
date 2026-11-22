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

/**
 * 会执行仓库内构建配置或规则脚本的工作区工具：主配置文件本身构成代码执行面，
 * 若为未跟踪 / gitignored / 已修改状态，Auto 不得免审放行。
 */
const WORKSPACE_CONFIG_CANDIDATES: Readonly<Record<string, readonly string[]>> = {
  make: ['GNUmakefile', 'makefile', 'Makefile'],
  eslint: [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    'eslint.config.mts',
    'eslint.config.cts',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.yaml',
    '.eslintrc.yml',
    '.eslintrc.json',
    '.eslintrc',
  ],
  vitest: [
    'vitest.config.ts',
    'vitest.config.mts',
    'vitest.config.cts',
    'vitest.config.js',
    'vitest.config.mjs',
    'vitest.config.cjs',
    'vite.config.ts',
    'vite.config.mts',
    'vite.config.js',
    'vite.config.mjs',
  ],
  tsup: [
    'tsup.config.ts',
    'tsup.config.mts',
    'tsup.config.cts',
    'tsup.config.js',
    'tsup.config.mjs',
    'tsup.config.cjs',
    'tsup.config.json',
  ],
  prettier: [
    'prettier.config.js',
    'prettier.config.mjs',
    'prettier.config.cjs',
    'prettier.config.ts',
    '.prettierrc.js',
    '.prettierrc.mjs',
    '.prettierrc.cjs',
    '.prettierrc.json',
    '.prettierrc.yaml',
    '.prettierrc.yml',
    '.prettierrc',
  ],
  biome: ['biome.json', 'biome.jsonc'],
  tsc: ['tsconfig.json'],
};

/** 工具自定义配置文件的选项名：显式指定配置时必须将该文件一并纳入 git 清洁度检查。 */
const WORKSPACE_CONFIG_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  make: new Set(['-f', '--file', '--makefile']),
  eslint: new Set(['-c', '--config']),
  vitest: new Set(['-c', '--config']),
  tsup: new Set(['--config']),
  prettier: new Set(['--config']),
  biome: new Set(['--config-path']),
  tsc: new Set(['-p', '--project']),
};

/** 解释器预加载/钩子选项：取值脚本先于主脚本执行，必须同样纳入信任校验。 */
const INTERPRETER_PRELOAD_FLAGS = new Set([
  '-r',
  '--require',
  '--import',
  '--loader',
  '--experimental-loader',
  '--env-file',
  '--import-map',
]);

/** 前导环境变量中可直接劫持执行入口或加载器的高危键名。 */
const DANGEROUS_ENV_KEYS = new Set([
  'PATH',
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'PYTHONHOME',
  'RUBYOPT',
  'RUBYLIB',
  'PERL5OPT',
  'PERL5LIB',
  'BASH_ENV',
  'ENV',
  'ZDOTDIR',
  'IFS',
  'CDPATH',
  'PROMPT_COMMAND',
  'SHELLOPTS',
  'BASHOPTS',
]);

/**
 * git 状态查询上限；超时或失败一律 `unknown`，不阻塞审批。
 *
 * 取 500ms 而非更宽裕的 2s：`assessScriptTrust` 在 `approvalScope`（同步接口）内执行，
 * git 子进程会阻塞守护进程事件循环；配合下方 TTL 缓存，重复裁决不再重复拉起进程。
 */
const GIT_TIMEOUT_MS = 500;

/** 信任结果缓存的存活时间；覆盖同一条命令在裁决链路里的两次同步调用即可，不追求更长。 */
const TRUST_CACHE_TTL_MS = 1000;

/** 缓存条目上限；超出时按插入序淘汰最旧条目，避免长会话无界增长。 */
const TRUST_CACHE_LIMIT = 64;

interface TrustCacheEntry {
  /** git 判定结果（含失败时的 `unknown`——失败同样缓存，避免 git 缺失时反复拉起进程）。 */
  readonly value: ScriptTrust;
  /** 过期时刻（`Date.now()` 口径）。 */
  readonly expiresAt: number;
}

/**
 * git 判定结果的进程内 TTL 缓存。
 *
 * 键含目标文件的 stat 签名（size + mtimeMs）：文件被改写即缓存失效，保证「模型刚写入 → dirty」
 * 这类安全关键状态变化不会被 TTL 窗口掩盖；仅 stat 未变的重复裁决命中缓存。向更严格方向
 * 的漂移（如 git add 后 porcelain 输出变化）只会把 `dirty` 缓存得更久，不会把 `dirty` 漂成 `clean`。
 */
const trustCache = new Map<string, TrustCacheEntry>();

/** 目标文件的 stat 签名；任一目标无法 stat（已被上游排除）按 missing 计。 */
function statSignature(targets: readonly string[]): string {
  const parts: string[] = [];
  for (const target of targets) {
    try {
      const stat = fs.statSync(target);
      parts.push(`${stat.size}:${stat.mtimeMs}`);
    } catch {
      parts.push('missing');
    }
  }
  return parts.join('|');
}

/**
 * 计算命令将执行的脚本 / `package.json` / 构建配置的 git 可信度。
 *
 * 返回 `undefined` 表示命令没有可静态识别的脚本目标（如 `ls`、`git status`），此时分类器
 * 本来就不会走脚本分支。任一目标未入 git 索引（未跟踪或被 `.gitignore` 忽略）或有未提交改动 → `dirty`；
 * 目标全部已跟踪且干净 → `clean`；无 `.git`、路径越界、高危环境注入、解析失败或 git 超时 → `unknown`。
 *
 * 只读：不修改仓库、不执行脚本；git 调用使用 500ms 超时与最小环境变量集。
 */
export function assessScriptTrust(
  command: string,
  cwd: string,
  rootDir: string,
): ScriptTrust | undefined {
  const segments = splitSegments(command);
  if (segments === undefined) return 'unknown';
  const root = path.resolve(rootDir);
  let effectiveCwd = path.resolve(cwd);
  let cwdUnknown = false;
  const targets = new Set<string>();
  for (const segment of segments) {
    const stripped = stripRedirections(segment);
    if (stripped === undefined) return 'unknown';
    const words = splitWords(stripped);
    if (words === undefined || words.length === 0) continue;
    const cdUpdate = trackDirectoryChange(words, effectiveCwd, root);
    if (cdUpdate !== undefined) {
      if (cdUpdate === 'unknown') cwdUnknown = true;
      else effectiveCwd = cdUpdate;
      continue;
    }
    if (cwdUnknown) return 'unknown';
    const extracted = segmentTargets(words, effectiveCwd, root);
    if (extracted === 'unknown') return 'unknown';
    for (const target of extracted) targets.add(target);
  }
  if (targets.size === 0) return undefined;
  return gitTrust([...targets], root);
}

/** 校验前导 `KEY=VALUE` 赋值：禁止加载器注入键与含路径/命令分隔符的取值静默放行。 */
function isSafeEnvAssignment(assignment: string): boolean {
  const eq = assignment.indexOf('=');
  if (eq <= 0) return false;
  const key = assignment.slice(0, eq);
  const upper = key.toUpperCase();
  const value = assignment.slice(eq + 1);
  if (
    DANGEROUS_ENV_KEYS.has(upper) ||
    upper.startsWith('GIT_') ||
    upper.startsWith('NPM_CONFIG_') ||
    upper.startsWith('YARN_') ||
    upper.startsWith('PNPM_')
  ) {
    return false;
  }
  if (/[\\/~$`{};:<>|&()\s]/.test(value)) return false;
  return true;
}

/** 追踪段间 `cd` / `pushd` / `Set-Location` 的工作目录漂移；非切目录命令返回 undefined。 */
function trackDirectoryChange(
  words: readonly string[],
  currentCwd: string,
  root: string,
): string | 'unknown' | undefined {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) {
    index++;
  }
  const raw = words[index];
  if (!raw || raw.includes('/') || raw.includes('\\')) return undefined;
  const program = baseName(raw);
  if (program === 'popd') return 'unknown';
  if (program !== 'cd' && program !== 'pushd' && program !== 'set-location' && program !== 'sl')
    return undefined;
  for (let i = 0; i < index; i++) {
    if (!isSafeEnvAssignment(words[i]!)) return 'unknown';
  }
  const rest = words.slice(index + 1);
  if (rest.length !== 1) return 'unknown';
  const target = rest[0]!;
  if (
    target === '' ||
    target.startsWith('-') ||
    target.startsWith('~') ||
    target.includes('$') ||
    target.includes('`') ||
    /[*?[]/.test(target)
  ) {
    return 'unknown';
  }
  const resolved = path.resolve(currentCwd, target);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return 'unknown';
  return resolved;
}

/** 单段内的脚本目标提取；返回 `unknown` 表示该段无法静态判读。 */
function segmentTargets(
  words: readonly string[],
  cwd: string,
  root: string,
): readonly string[] | 'unknown' {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) {
    if (!isSafeEnvAssignment(words[index]!)) return 'unknown';
    index++;
  }
  if (words[index] === 'time' || words[index] === 'command') index++;
  const rawProgram = words[index];
  if (rawProgram === undefined) return 'unknown';
  // 直引路径程序（含 `./`、`/`、`\`）：不得按 basename 伪装成内置程序；按脚本路径校验。
  if (rawProgram.includes('/') || rawProgram.includes('\\')) {
    return resolveTarget(rawProgram, cwd, root);
  }
  const program = baseName(rawProgram);
  if (program === undefined) return 'unknown';
  let rest = words.slice(index + 1);

  if (INTERPRETERS.has(program)) {
    // `bun run` / `deno run` 后跟的才是脚本或 package.json 脚本名。
    if ((program === 'bun' || program === 'deno') && rest[0] === 'run') rest = rest.slice(1);
    const collected: string[] = [];
    let mainScript: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      const word = rest[i]!;
      if (word === '-' || word === '--') return 'unknown';
      // `-c` / `-e` / `-p` / `-m`（含紧邻或 `=` 形态）的内容不在受检文件里，一律归 unknown。
      if (
        word === '-c' ||
        word.startsWith('-c') ||
        word === '-e' ||
        word.startsWith('-e') ||
        word === '--eval' ||
        word.startsWith('--eval=') ||
        word === '-p' ||
        word.startsWith('-p') ||
        word === '--print' ||
        word.startsWith('--print=') ||
        word === '-m' ||
        word.startsWith('-m')
      ) {
        return 'unknown';
      }
      if (word.startsWith('-')) {
        const eq = word.indexOf('=');
        const flagName = eq > 0 ? word.slice(0, eq) : word;
        if (INTERPRETER_PRELOAD_FLAGS.has(flagName)) {
          const preloadValue = eq > 0 ? word.slice(eq + 1) : rest[++i];
          if (!preloadValue) return 'unknown';
          const resolvedPreload = resolveAnyFileTarget(preloadValue, cwd, root);
          if (resolvedPreload === 'unknown') return 'unknown';
          collected.push(...resolvedPreload);
          continue;
        }
        if (word.startsWith('-r') && word.length > 2) {
          const resolvedPreload = resolveAnyFileTarget(word.slice(2), cwd, root);
          if (resolvedPreload === 'unknown') return 'unknown';
          collected.push(...resolvedPreload);
          continue;
        }
        // 其它未知 `--flag=路径` 形态可能向运行时注入模块或配置，保守归 unknown。
        if (eq > 0 && /[\\/]/.test(word.slice(eq + 1))) return 'unknown';
        continue;
      }
      if (mainScript === undefined) {
        mainScript = word;
        // 主脚本之后的参数属于脚本自身的 argv，不再按解释器选项解析。
        break;
      }
    }
    if (mainScript === undefined) return collected.length > 0 ? 'unknown' : [];
    // `bun run <name>` 没有脚本扩展名时是 package.json 脚本，与包管理器同一条信任链。
    if (!SCRIPT_EXTENSION.test(mainScript)) {
      if (program !== 'bun') return 'unknown';
      const manifest = nearestPackageJson(cwd, root);
      if (manifest === undefined) return 'unknown';
      collected.push(manifest);
      return collected;
    }
    const resolvedMain = resolveTarget(mainScript, cwd, root);
    if (resolvedMain === 'unknown') return 'unknown';
    collected.push(...resolvedMain);
    return collected;
  }

  if (program === 'npm' || program === 'pnpm' || program === 'yarn') {
    const subcommand = firstSubcommand(rest);
    if (subcommand === undefined) return [];
    if (!PACKAGE_SCRIPT_SUBCOMMANDS.has(subcommand)) return [];
    const manifest = nearestPackageJson(cwd, root);
    return manifest === undefined ? 'unknown' : [manifest];
  }

  if (program in WORKSPACE_CONFIG_CANDIDATES) {
    return resolveWorkspaceProgramConfigs(program, rest, cwd, root);
  }

  return [];
}

/**
 * 提取构建/检查器（`make` / `eslint` / `vitest` 等）的配置文件目标：
 * - `make` 必须找到已存在的 Makefile（或 `-f` 指定文件），缺失归 `unknown`；
 * - 其余工具显式传 `-c`/`--config` 时必须纳入校验，未传时收集从 `cwd` 到 `root` 已存在的默认配置。
 */
function resolveWorkspaceProgramConfigs(
  program: string,
  rest: readonly string[],
  cwd: string,
  root: string,
): readonly string[] | 'unknown' {
  const configFlags = WORKSPACE_CONFIG_FLAGS[program];
  const explicit: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    if (!word.startsWith('-')) continue;
    const eq = word.indexOf('=');
    const flag = eq > 0 ? word.slice(0, eq) : word;
    if (
      flag === '--plugin' ||
      flag === '--rulesdir' ||
      flag === '--require' ||
      flag === '-r' ||
      flag === '--import'
    ) {
      return 'unknown';
    }
    if (configFlags?.has(flag)) {
      const val = eq > 0 ? word.slice(eq + 1) : rest[++i];
      if (!val) return 'unknown';
      const resolved = resolveAnyFileTarget(val, cwd, root);
      if (resolved === 'unknown') return 'unknown';
      explicit.push(...resolved);
    }
  }
  if (explicit.length > 0) return explicit;
  const found = findNearestFiles(cwd, root, WORKSPACE_CONFIG_CANDIDATES[program]!);
  if (program === 'make' && found.length === 0) return 'unknown';
  return found;
}

/** 从 `cwd` 向上到 `root` 查找候选配置文件；经 native realpath 还原真实大小写并去重，兼容 Windows/macOS 大小写不敏感文件系统与 git 索引大小写敏感语义。 */
function findNearestFiles(cwd: string, root: string, names: readonly string[]): string[] {
  const found = new Set<string>();
  let current = path.resolve(cwd);
  for (;;) {
    for (const name of names) {
      const candidate = path.join(current, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        try {
          found.add(fs.realpathSync.native(candidate));
        } catch {
          found.add(candidate);
        }
      }
    }
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return [...found];
}

/**
 * 解析脚本路径：变量 / `~` / 越界 / 无脚本扩展名 / 文件不存在都不可信。
 *
 * 不存在的路径在 `git status -- <path>` 下输出为空，若不在这里拦下会被误判成 `clean`，
 * 因此必须显式要求文件存在。
 */
function resolveTarget(script: string, cwd: string, root: string): readonly string[] | 'unknown' {
  if (!SCRIPT_EXTENSION.test(script)) return 'unknown';
  return resolveAnyFileTarget(script, cwd, root);
}

/** 解析任意受检文件（如 `--require` 模块或自定义 `Makefile`）：不限扩展名，但必须在工作区内真实存在。 */
function resolveAnyFileTarget(
  target: string,
  cwd: string,
  root: string,
): readonly string[] | 'unknown' {
  if (
    target.includes('$') ||
    target.includes('`') ||
    target.startsWith('~') ||
    /[*?[]/.test(target)
  )
    return 'unknown';
  const resolved = path.resolve(cwd, target);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return 'unknown';
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return 'unknown';
  try {
    const physical = fs.realpathSync.native(resolved);
    const physicalRoot = fs.realpathSync.native(root);
    const physicalRel = path.relative(physicalRoot, physical);
    if (physicalRel.startsWith('..') || path.isAbsolute(physicalRel)) return 'unknown';
    return [physical];
  } catch {
    return [resolved];
  }
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

/**
 * 判断目标在 git 中是否已跟踪且无未提交改动；TTL 内同签名直接复用上次结果。
 *
 * 必须先跑 `git ls-files --error-unmatch` 再跑 `git status --porcelain --ignored`：
 * 单独 `git status --porcelain` 对 `.gitignore` 命中的文件（如 `node_modules/evil.js`）输出为空，
 * 会把模型刚写进忽略目录的载荷误判为 `clean`。
 */
function gitTrust(targets: readonly string[], root: string): ScriptTrust {
  if (!fs.existsSync(path.join(root, '.git'))) return 'unknown';
  const relatives = targets.map((target) => path.relative(root, target).replace(/\\/g, '/'));
  if (relatives.some((relative) => relative === '' || relative.startsWith('..'))) return 'unknown';
  const cacheKey = `${root}\u0000${relatives.join('\u0000')}\u0000${statSignature(targets)}`;
  const cached = trustCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  const execOptions = {
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf8' as const,
    stdio: ['ignore', 'pipe', 'ignore'] as ['ignore', 'pipe', 'ignore'],
    env: gitEnvironment(),
  };
  let value: ScriptTrust;
  try {
    execFileSync(
      'git',
      ['-C', root, 'ls-files', '--error-unmatch', '--', ...relatives],
      execOptions,
    );
    const output = execFileSync(
      'git',
      ['-C', root, 'status', '--porcelain', '--ignored', '--', ...relatives],
      execOptions,
    );
    value = output.trim() === '' ? 'clean' : 'dirty';
  } catch (error) {
    const status = (error as { status?: number } | undefined)?.status;
    // exit code 1 来自 `ls-files --error-unmatch`：说明目标未入 git 索引（未跟踪或被 gitignore）。
    value = status === 1 ? 'dirty' : 'unknown';
  }
  trustCache.set(cacheKey, { value, expiresAt: now + TRUST_CACHE_TTL_MS });
  if (trustCache.size > TRUST_CACHE_LIMIT) {
    const oldest = trustCache.keys().next().value;
    if (oldest !== undefined) trustCache.delete(oldest);
  }
  return value;
}

/** 剥离段内引号外的重定向操作符与目标；遇到 heredoc 或进程替换返回 undefined。 */
function stripRedirections(text: string): string | undefined {
  let command = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quote) {
      if (character === quote) quote = undefined;
      command += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      command += character;
      continue;
    }
    if (character !== '>' && character !== '<') {
      command += character;
      continue;
    }
    if (text[index + 1] === '(' || (character === '<' && text[index + 1] === '<')) return undefined;
    while (index + 1 < text.length && /[>&|]/.test(text[index + 1]!)) index++;
    if (/\d$/.test(command) && (command.length === 1 || /\s/.test(command[command.length - 2]!))) {
      command = command.slice(0, -1);
    }
    while (index + 1 < text.length && (text[index + 1] === ' ' || text[index + 1] === '\t'))
      index++;
    let targetQuote: '"' | "'" | undefined;
    if (text[index + 1] === '(') return undefined;
    while (index + 1 < text.length) {
      const next = text[index + 1]!;
      if (targetQuote) {
        if (next === targetQuote) targetQuote = undefined;
        index++;
        continue;
      }
      if (next === '"' || next === "'") {
        targetQuote = next;
        index++;
        continue;
      }
      if (/[\s|&;<>]/.test(next)) break;
      index++;
    }
    command += ' ';
  }
  return command;
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
