import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  '--loglevel',
  '--prefix',
  '--reporter',
  '--workspace',
  '-C',
  '-F',
  '-w',
]);

/** 会改变包管理器工作目录的选项：目标 `package.json` 必须从切换后的目录解析。 */
const PACKAGE_DIR_FLAGS = new Set(['-C', '--dir', '--prefix']);

/** 会让包管理器在工作区多个子包执行脚本的选项：需一并校验工作区子包的 `package.json`。 */
const PACKAGE_MULTI_MANIFEST_FLAGS = new Set([
  '--filter',
  '-F',
  '--workspace',
  '-w',
  '-r',
  '--recursive',
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

/** 解释器在主脚本前允许放行的纯布尔无参开关；其余未知选项一律保守归 `unknown`。 */
const INTERPRETER_SAFE_BOOLEAN_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  node: new Set(['--no-warnings', '--enable-source-maps', '--expose-gc', '--preserve-symlinks']),
  tsx: new Set(['--no-warnings', '--enable-source-maps']),
  python: new Set(['-u', '-B', '-E', '-s', '-S', '-O', '-OO', '-I', '-q']),
  python3: new Set(['-u', '-B', '-E', '-s', '-S', '-O', '-OO', '-I', '-q']),
  bash: new Set(['-u', '-x']),
  sh: new Set(['-u', '-x']),
  dash: new Set(['-u', '-x']),
  zsh: new Set(['-u', '-x']),
  deno: new Set(['-q', '--quiet', '--no-check', '--no-lock', '--no-npm', '--no-remote']),
};

/** 工作区工具可执行任意外部命令或加载未受检模块的危险开关。 */
const WORKSPACE_UNSAFE_FLAGS = new Set([
  '--plugin',
  '--rulesdir',
  '--require',
  '-r',
  '--import',
  '--onSuccess',
  '--onFailure',
  '--inject',
  '--esbuildOptions',
  '--globalSetup',
  '--setupFiles',
  '--setupFilesAfterEnv',
  '--browser',
  '--environment',
]);

/** vitest 子命令与取值型选项：用于区分位置测试文件参数与普通开关参数。 */
const VITEST_SUBCOMMANDS = new Set([
  'run',
  'watch',
  'dev',
  'related',
  'bench',
  'typecheck',
  'list',
  'init',
]);
const VITEST_VALUE_FLAGS = new Set([
  '-t',
  '--testNamePattern',
  '--reporter',
  '--outputFile',
  '--pool',
  '--shard',
  '--project',
  '--dir',
  '--root',
  '--sequence',
  '--maxConcurrency',
  '--testTimeout',
  '--hookTimeout',
]);

/** 单文件可纳入会话级批准指纹的最大体积（1 MiB）。 */
const MAX_DIGEST_TARGET_BYTES = 1024 * 1024;

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
  interpreter?: string,
): ScriptTrust | undefined {
  const powershell = interpreter === 'pwsh' || interpreter === 'powershell';
  const collected = collectCommandScriptTargets(command, cwd, rootDir, powershell);
  if (collected === 'unknown') return 'unknown';
  if (collected.length === 0) return undefined;
  return gitTrust(collected, path.resolve(rootDir));
}

/**
 * 计算命令涉及的全部脚本、`package.json` 与构建配置的内容摘要，供会话批准缓存与执行前 TOCTOU 复核绑定。
 *
 * 边界：
 * - 命令不涉及任何脚本/清单目标时返回 `undefined`；
 * - 涉及脚本/清单但存在动态参数、未知选项或单文件超 1 MiB 无法完整哈希时返回 `'unhashed'`，
 *   调用方据此禁止 `allow_session` 盲缓存；
 * - 全部目标可静态解析且在体积上限内时返回确定性 SHA-256 十六进制摘要，文件一经篡改摘要立即失配。
 */
export function computeScriptTargetDigest(
  command: string,
  cwd: string,
  rootDir: string,
  interpreter?: string,
): string | 'unhashed' | undefined {
  const powershell = interpreter === 'pwsh' || interpreter === 'powershell';
  const collected = collectCommandScriptTargets(command, cwd, rootDir, powershell);
  if (collected === 'unknown') return 'unhashed';
  if (collected.length === 0) return undefined;
  const sorted = [...new Set(collected)].sort();
  const hash = createHash('sha256');
  for (const target of sorted) {
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size > MAX_DIGEST_TARGET_BYTES) return 'unhashed';
      hash.update(target);
      hash.update('\0');
      hash.update(fs.readFileSync(target));
      hash.update('\0');
    } catch {
      return 'unhashed';
    }
  }
  return hash.digest('hex');
}

function collectCommandScriptTargets(
  command: string,
  cwd: string,
  rootDir: string,
  powershell: boolean,
): readonly string[] | 'unknown' {
  const segments = splitSegments(command, powershell);
  if (segments === undefined) return 'unknown';
  const root = path.resolve(rootDir);
  let effectiveCwd = path.resolve(cwd);
  let cwdUnknown = false;
  const targets = new Set<string>();
  for (const segment of segments) {
    const stripped = stripRedirections(segment, powershell);
    if (stripped === undefined) return 'unknown';
    const rawWords = splitWords(stripped, powershell);
    if (rawWords === undefined) return 'unknown';
    const words = powershell ? expandPowerShellColonArgs(rawWords) : rawWords;
    if (words.length === 0) continue;
    const cdUpdate = trackDirectoryChange(words, effectiveCwd, root, powershell);
    if (cdUpdate !== undefined) {
      if (cdUpdate === 'unknown') cwdUnknown = true;
      else effectiveCwd = cdUpdate;
      continue;
    }
    if (cwdUnknown) return 'unknown';
    const extracted = segmentTargets(words, effectiveCwd, root, powershell);
    if (extracted === 'unknown') return 'unknown';
    for (const target of extracted) targets.add(target);
  }
  return [...targets];
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

function resolveShellPath(cwd: string, target: string, powershell = false): string {
  if (powershell || process.platform === 'win32') {
    const normalizedCwd = cwd.replace(/\\/g, '/');
    const normalizedTarget = target.replace(/\\/g, '/');
    if (process.platform !== 'win32' && /^[A-Za-z]:\//.test(normalizedTarget)) {
      return `/__kpbl_win32_drive__/${normalizedTarget}`;
    }
    return path.resolve(normalizedCwd, normalizedTarget);
  }
  return path.resolve(cwd, target);
}

/** 追踪段间 `cd` / `pushd` / `Set-Location` 的工作目录漂移；非切目录命令返回 undefined。 */
function trackDirectoryChange(
  words: readonly string[],
  currentCwd: string,
  root: string,
  powershell = false,
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
  const resolved = resolveShellPath(currentCwd, target, powershell);
  const relative = path.relative(root, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return 'unknown';
  return resolved;
}

/** 单段内的脚本目标提取；返回 `unknown` 表示该段无法静态判读。 */
function segmentTargets(
  words: readonly string[],
  cwd: string,
  root: string,
  powershell = false,
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
    return resolveTarget(rawProgram, cwd, root, powershell);
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
          const resolvedPreload = resolveAnyFileTarget(preloadValue, cwd, root, powershell);
          if (resolvedPreload === 'unknown') return 'unknown';
          collected.push(...resolvedPreload);
          continue;
        }
        if (word.startsWith('-r') && word.length > 2) {
          const resolvedPreload = resolveAnyFileTarget(word.slice(2), cwd, root, powershell);
          if (resolvedPreload === 'unknown') return 'unknown';
          collected.push(...resolvedPreload);
          continue;
        }
        if (INTERPRETER_SAFE_BOOLEAN_FLAGS[program]?.has(word)) continue;
        // 主脚本前的任何未知解释器选项都可能消费后继文件名参数（如 `node --title clean.mjs -e ...`）或注入配置，保守归 unknown。
        return 'unknown';
      }
      if (mainScript === undefined) {
        mainScript = word;
        // 主脚本之后的参数属于脚本自身的 argv，不再按解释器选项解析。
        break;
      }
    }
    if (mainScript === undefined) return 'unknown';
    // `bun run <name>` 没有脚本扩展名时是 package.json 脚本，与包管理器同一条信任链。
    if (!SCRIPT_EXTENSION.test(mainScript)) {
      if (program !== 'bun') return 'unknown';
      const manifest = nearestPackageJson(cwd, root);
      if (manifest === undefined) return 'unknown';
      collected.push(manifest);
      return collected;
    }
    const resolvedMain = resolveTarget(mainScript, cwd, root, powershell);
    if (resolvedMain === 'unknown') return 'unknown';
    collected.push(...resolvedMain);
    return collected;
  }

  if (program === 'npm' || program === 'pnpm' || program === 'yarn') {
    const parsed = parsePackageManagerArgs(rest);
    if (parsed === 'unknown') return 'unknown';
    let targetCwd = cwd;
    for (const dirTarget of parsed.directories) {
      if (
        dirTarget.includes('$') ||
        dirTarget.includes('`') ||
        dirTarget.startsWith('~') ||
        /[*?[]/.test(dirTarget)
      ) {
        return 'unknown';
      }
      const resolvedDir = resolveShellPath(targetCwd, dirTarget, powershell);
      const rel = path.relative(root, resolvedDir);
      if (rel.startsWith('..') || path.isAbsolute(rel)) return 'unknown';
      targetCwd = resolvedDir;
    }
    const { subcommand } = parsed;
    if (subcommand === undefined) return [];
    if (subcommand === 'dlx' || subcommand === 'exec') return 'unknown';
    if (!PACKAGE_SCRIPT_SUBCOMMANDS.has(subcommand)) return [];
    if (parsed.multiWorkspace) {
      const manifests = collectWorkspacePackageJsons(root);
      return manifests === 'unknown' || manifests.length === 0 ? 'unknown' : manifests;
    }
    const manifest = nearestPackageJson(targetCwd, root);
    return manifest === undefined ? 'unknown' : [manifest];
  }

  if (program in WORKSPACE_CONFIG_CANDIDATES) {
    return resolveWorkspaceProgramConfigs(program, rest, cwd, root, powershell);
  }

  return [];
}

/**
 * 提取构建/检查器（`make` / `eslint` / `vitest` 等）的配置文件与位置测试文件目标：
 * - `make` 必须找到已存在的 Makefile（或 `-f` 指定文件），缺失归 `unknown`；
 * - `vitest` 显式传入位置测试文件路径时一并纳入 git 清洁度检查；
 * - 其余工具显式传 `-c`/`--config` 时必须纳入校验，未传时收集从 `cwd` 到 `root` 已存在的默认配置。
 */
function resolveWorkspaceProgramConfigs(
  program: string,
  rest: readonly string[],
  cwd: string,
  root: string,
  powershell = false,
): readonly string[] | 'unknown' {
  const configFlags = WORKSPACE_CONFIG_FLAGS[program];
  const explicit: string[] = [];
  const positionalTargets: string[] = [];
  let sawSubcommand = false;
  for (let i = 0; i < rest.length; i++) {
    const word = rest[i]!;
    if (word.startsWith('-')) {
      const eq = word.indexOf('=');
      const flag = eq > 0 ? word.slice(0, eq) : word;
      if (WORKSPACE_UNSAFE_FLAGS.has(flag)) {
        return 'unknown';
      }
      if (configFlags?.has(flag)) {
        const val = eq > 0 ? word.slice(eq + 1) : rest[++i];
        if (!val) return 'unknown';
        const resolved = resolveAnyFileTarget(val, cwd, root, powershell);
        if (resolved === 'unknown') return 'unknown';
        explicit.push(...resolved);
        continue;
      }
      if (program === 'vitest' && eq === -1 && VITEST_VALUE_FLAGS.has(flag)) {
        if (rest[i + 1] === undefined) return 'unknown';
        i++;
      }
      continue;
    }
    if (program === 'vitest') {
      if (!sawSubcommand && VITEST_SUBCOMMANDS.has(word.toLowerCase())) {
        sawSubcommand = true;
        continue;
      }
      const resolvedFile = resolveAnyFileTarget(word, cwd, root, powershell);
      if (resolvedFile !== 'unknown') {
        positionalTargets.push(...resolvedFile);
        continue;
      }
      const resolvedDir = resolveDirectoryFiles(word, cwd, root, powershell);
      if (resolvedDir === 'unknown') return 'unknown';
      positionalTargets.push(...resolvedDir);
    }
  }
  const baseConfigs =
    explicit.length > 0
      ? explicit
      : findNearestFiles(cwd, root, WORKSPACE_CONFIG_CANDIDATES[program]!);
  if (program === 'make' && baseConfigs.length === 0) return 'unknown';
  return [...baseConfigs, ...positionalTargets];
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
function resolveTarget(
  script: string,
  cwd: string,
  root: string,
  powershell = false,
): readonly string[] | 'unknown' {
  if (!SCRIPT_EXTENSION.test(script)) return 'unknown';
  return resolveAnyFileTarget(script, cwd, root, powershell);
}

/** 解析任意受检文件（如 `--require` 模块或自定义 `Makefile`）：不限扩展名，但必须在工作区内真实存在。 */
function resolveAnyFileTarget(
  target: string,
  cwd: string,
  root: string,
  powershell = false,
): readonly string[] | 'unknown' {
  if (
    target.includes('$') ||
    target.includes('`') ||
    target.startsWith('~') ||
    /[*?[]/.test(target)
  )
    return 'unknown';
  const resolved = resolveShellPath(cwd, target, powershell);
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

/** 收集工作区内所有非忽略目录的 `package.json`（上限 64 个），供 `--filter`/`-w`/`-r` 多包脚本校验。 */
function collectWorkspacePackageJsons(root: string): readonly string[] | 'unknown' {
  const manifests: string[] = [];
  const queue = [path.resolve(root)];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return 'unknown';
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(full);
      } else if (entry.isFile() && entry.name === 'package.json') {
        manifests.push(full);
        if (manifests.length > 64) return 'unknown';
      }
    }
  }
  return manifests;
}

/** 递归收集工作区内指定测试目录下的脚本文件（上限 256 个），存在越界或超限返回 `unknown`。 */
function resolveDirectoryFiles(
  targetDir: string,
  cwd: string,
  root: string,
  powershell = false,
): readonly string[] | 'unknown' {
  if (
    targetDir.includes('$') ||
    targetDir.includes('`') ||
    targetDir.startsWith('~') ||
    /[*?[]/.test(targetDir)
  ) {
    return 'unknown';
  }
  const resolved = resolveShellPath(cwd, targetDir, powershell);
  const rel = path.relative(root, resolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return 'unknown';
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return 'unknown';
  const files: string[] = [];
  const queue = [resolved];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return 'unknown';
    }
    for (const entry of entries) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) queue.push(full);
      else if (entry.isFile() && SCRIPT_EXTENSION.test(entry.name)) {
        const fileTarget = resolveAnyFileTarget(full, cwd, root);
        if (fileTarget === 'unknown') return 'unknown';
        files.push(...fileTarget);
        if (files.length > 256) return 'unknown';
      }
    }
  }
  return files.length > 0 ? files : 'unknown';
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
  // 目标进入本函数时可能携带两种路径身份：脚本/配置目标已是 native realpath 物理路径
  // （resolveAnyFileTarget / findNearestFiles），而 nearestPackageJson 仍是词法路径；
  // macOS（/var → /private/var）与 Windows 8.3 短名下两种身份混用会让 pathspec 指向
  // 仓库之外、被下方越界守卫整体判为 `unknown`。统一把根与目标都按 native realpath
  // 折到物理身份后再求相对路径；解析失败退回词法路径，由越界守卫兜底。
  const physicalRoot = (() => {
    try {
      return fs.realpathSync.native(root);
    } catch {
      return root;
    }
  })();
  const relatives = targets.map((target) => {
    let physicalTarget = target;
    try {
      physicalTarget = fs.realpathSync.native(target);
    } catch {
      /* 目标不可解析时保留词法路径 */
    }
    return path.relative(physicalRoot, physicalTarget).replace(/\\/g, '/');
  });
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
function stripRedirections(text: string, powershell = false): string | undefined {
  let command = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quote === "'") {
      if (powershell && character === "'" && text[index + 1] === "'") {
        command += "''";
        index++;
        continue;
      }
      if (character === "'") quote = undefined;
      command += character;
      continue;
    }
    if (quote === '"') {
      if ((!powershell && character === '\\') || (powershell && character === '`')) {
        const next = text[index + 1];
        if (next === undefined) return undefined;
        command += character + next;
        index++;
        continue;
      }
      if (powershell && character === '"' && text[index + 1] === '"') {
        command += '""';
        index++;
        continue;
      }
      if (character === '"') quote = undefined;
      command += character;
      continue;
    }
    if ((!powershell && character === '\\') || (powershell && character === '`')) {
      const next = text[index + 1];
      if (next === undefined) return undefined;
      command += character + next;
      index++;
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
      if (targetQuote === "'") {
        if (powershell && next === "'" && text[index + 2] === "'") {
          index += 2;
          continue;
        }
        if (next === "'") targetQuote = undefined;
        index++;
        continue;
      }
      if (targetQuote === '"') {
        if ((!powershell && next === '\\') || (powershell && next === '`')) {
          if (text[index + 2] === undefined) return undefined;
          index += 2;
          continue;
        }
        if (powershell && next === '"' && text[index + 2] === '"') {
          index += 2;
          continue;
        }
        if (next === '"') targetQuote = undefined;
        index++;
        continue;
      }
      if ((!powershell && next === '\\') || (powershell && next === '`')) {
        if (text[index + 2] === undefined) return undefined;
        index += 2;
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
    if (targetQuote !== undefined) return undefined;
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

/** 引号与转义感知分段：只按引号外的 `&&` `||` `;` `|` `&` 与换行拆分；不闭合引号或命令替换返回 undefined。 */
function splitSegments(command: string, powershell = false): string[] | undefined {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (quote === "'") {
      if (powershell && character === "'" && command[index + 1] === "'") {
        current += "''";
        index++;
        continue;
      }
      if (character === "'") quote = undefined;
      current += character;
      continue;
    }
    if (quote === '"') {
      if (!powershell && character === '\\') {
        const next = command[index + 1];
        if (next === undefined) return undefined;
        current += character + next;
        index++;
        continue;
      }
      if (powershell && character === '`') {
        const next = command[index + 1];
        if (next === undefined) return undefined;
        current += character + next;
        index++;
        continue;
      }
      if (powershell && character === '"' && command[index + 1] === '"') {
        current += '""';
        index++;
        continue;
      }
      if (character === '"') {
        quote = undefined;
        current += character;
        continue;
      }
      if (!powershell && character === '`') return undefined;
      if (
        character === '$' &&
        (command[index + 1] === '(' || (!powershell && command[index + 1] === '{'))
      ) {
        return undefined;
      }
      current += character;
      continue;
    }
    if ((!powershell && character === '\\') || (powershell && character === '`')) {
      const next = command[index + 1];
      if (next === undefined) return undefined;
      current += character + next;
      index++;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      continue;
    }
    if (!powershell && character === '`') return undefined;
    if (character === '$' && (command[index + 1] === '(' || command[index + 1] === '{')) {
      return undefined;
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

/** 引号与转义感知分词；引号不闭合返回 undefined，相邻引号段拼接为同一单词。 */
function splitWords(text: string, powershell = false): string[] | undefined {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quote === "'") {
      if (powershell && character === "'" && text[index + 1] === "'") {
        current += "'";
        started = true;
        index++;
        continue;
      }
      if (character === "'") {
        quote = undefined;
      } else {
        current += character;
        started = true;
      }
      continue;
    }
    if (quote === '"') {
      if (!powershell && character === '\\') {
        const next = text[index + 1];
        if (next === undefined) return undefined;
        current += '"\\$`'.includes(next) ? next : `\\${next}`;
        started = true;
        index++;
        continue;
      }
      if (powershell && character === '`') {
        const next = text[index + 1];
        if (next === undefined) return undefined;
        current += next;
        started = true;
        index++;
        continue;
      }
      if (powershell && character === '"' && text[index + 1] === '"') {
        current += '"';
        started = true;
        index++;
        continue;
      }
      if (character === '"') {
        quote = undefined;
      } else {
        current += character;
        started = true;
      }
      continue;
    }
    if (!powershell && character === '\\') {
      const next = text[index + 1];
      if (next === undefined) return undefined;
      current += next;
      started = true;
      index++;
      continue;
    }
    if (powershell && character === '`') {
      const next = text[index + 1];
      if (next === undefined) return undefined;
      current += next;
      started = true;
      index++;
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

/** 展开 PowerShell `-Param:Value` 冒号参数，使目录/路径型选项与空格分隔写法统一受检。 */
function expandPowerShellColonArgs(words: readonly string[]): string[] {
  const expanded: string[] = [];
  for (const word of words) {
    const colonMatch = /^(-[A-Za-z][A-Za-z0-9-]*):([\s\S]+)$/.exec(word);
    if (colonMatch) expanded.push(colonMatch[1]!, colonMatch[2]!);
    else expanded.push(word);
  }
  return expanded;
}

/** 解析包管理器选项、目录切换参数与首个子命令。 */
function parsePackageManagerArgs(
  words: readonly string[],
): { subcommand?: string; directories: string[]; multiWorkspace: boolean } | 'unknown' {
  const directories: string[] = [];
  let multiWorkspace = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word.startsWith('-')) {
      const eq = word.indexOf('=');
      const flag = eq > 0 ? word.slice(0, eq) : word;
      if (PACKAGE_MULTI_MANIFEST_FLAGS.has(flag)) multiWorkspace = true;
      if (PACKAGE_DIR_FLAGS.has(flag)) {
        const val = eq > 0 ? word.slice(eq + 1) : words[++index];
        if (!val) return 'unknown';
        directories.push(val);
        continue;
      }
      if (word.startsWith('-C') && word.length > 2) {
        directories.push(word.slice(2));
        continue;
      }
      if (eq === -1 && PACKAGE_VALUE_FLAGS.has(flag)) {
        if (words[index + 1] === undefined) return 'unknown';
        index++;
      }
      continue;
    }
    return { subcommand: word.toLowerCase(), directories, multiWorkspace };
  }
  return { directories, multiWorkspace };
}

/** 去掉路径前缀取程序名；空词或以 `-` 开头返回 undefined。 */
function baseName(word: string | undefined): string | undefined {
  if (word === undefined || word === '' || word.startsWith('-')) return undefined;
  const normalised = word.replace(/\\/g, '/');
  const name = normalised.slice(normalised.lastIndexOf('/') + 1).toLowerCase();
  return name === '' ? undefined : name;
}
