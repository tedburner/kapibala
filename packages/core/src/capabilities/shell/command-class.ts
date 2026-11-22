import path from 'node:path';
import { isEscapeClassPath } from '../security/escape-paths.js';
import type { ShellScope } from '../security/permissions.js';
import { isProtectedWorkspacePath } from '../security/sandbox.js';
import type { ShellCommandSafety } from './command-safety.js';

/**
 * 内部风险类别：替代「程序是否在只读表」的粗粒度判断，供权限策略按「能力上限 × 询问策略」
 * 两轴裁决。七值只在本层使用，公开的 `ShellCommandSafety` 仍保持三值（见 `toShellCommandSafety`）。
 *
 * 边界：
 * - 纯函数、不做 IO；`rootDir` 只用于词法越界判定，路径存在性与脚本清洁度由宿主在执行前另行确认。
 * - 类别是启发式结果，不是安全边界；无法静态判读一律 `unknown`，由上层 fail-closed 询问。
 */
export type ShellCommandClass =
  | 'read'
  | 'workspace-write'
  | 'vcs-write'
  | 'network'
  | 'destructive'
  | 'escape'
  | 'unknown';

/** 只读且会读取文件参数的程序；只有这些程序需要做参数路径越界检查。 */
const READ_PATH_PROGRAMS = new Set([
  'cat',
  'cmp',
  'column',
  'comm',
  'cut',
  'diff',
  'du',
  'file',
  'find',
  'grep',
  'head',
  'ls',
  'md5sum',
  'nl',
  'od',
  'paste',
  'readlink',
  'realpath',
  'rg',
  'sha1sum',
  'sha256sum',
  'sort',
  'stat',
  'strings',
  'tail',
  'tree',
  'uniq',
  'wc',
]);

/** 无条件只读程序：不会写入、不会联网、不会执行仓库内代码。 */
const READ_PROGRAMS = new Set([
  'basename',
  'cat',
  'cmp',
  'column',
  'comm',
  'cut',
  'date',
  'df',
  'diff',
  'dirname',
  'du',
  'echo',
  'false',
  'file',
  'grep',
  'groups',
  'head',
  'hostname',
  'id',
  'locale',
  'ls',
  'md5sum',
  'nl',
  'od',
  'paste',
  'printenv',
  'printf',
  'pwd',
  'readlink',
  'realpath',
  'rg',
  'seq',
  'sha1sum',
  'sha256sum',
  'sleep',
  'sort',
  'stat',
  'strings',
  'tail',
  'test',
  'tr',
  'tree',
  'true',
  'tty',
  'uname',
  'uniq',
  'wc',
  'which',
  'whoami',
]);

/** 在 workspace 内构建 / 测试 / 格式化的程序：执行的是仓库内代码，不涉及外部下载。 */
const WORKSPACE_PROGRAMS = new Set([
  'biome',
  'eslint',
  'make',
  'prettier',
  'tsc',
  'tsup',
  'vitest',
]);

/** 明确破坏性、提权或不可逆的程序。 */
const DESTRUCTIVE_PROGRAMS = new Set([
  'chmod',
  'chown',
  'dd',
  'doas',
  'fdisk',
  'halt',
  'kill',
  'killall',
  'mkfs',
  'mv',
  'pkill',
  'poweroff',
  'reboot',
  'rm',
  'rmdir',
  'su',
  'sudo',
]);

/** 出站连接或执行外部代码的程序。 */
const NETWORK_PROGRAMS = new Set([
  'apt',
  'apt-get',
  'brew',
  'curl',
  'ftp',
  'nc',
  'netcat',
  'rsync',
  'scp',
  'ssh',
  'telnet',
  'wget',
]);

/** 解释器：目标脚本在 workspace 内为 `workspace-write`，`-c` / `-e` / 标准输入无法判读。 */
const INTERPRETER_PROGRAMS = new Set([
  'bash',
  'deno',
  'node',
  'python',
  'python3',
  'sh',
  'tsx',
  'zsh',
]);

/** 包管理器的本地执行类子命令。 */
const PACKAGE_WORKSPACE_SUBCOMMANDS = new Set([
  'build',
  'format',
  'lint',
  'run',
  'test',
  'typecheck',
]);

/** 包管理器的下载 / 发布类子命令。 */
const PACKAGE_NETWORK_SUBCOMMANDS = new Set([
  'add',
  'ci',
  'install',
  'link',
  'publish',
  'remove',
  'uninstall',
  'update',
  'upgrade',
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

/** git 只读子命令。 */
const GIT_READ_SUBCOMMANDS = new Set([
  'blame',
  'cat-file',
  'describe',
  'diff',
  'grep',
  'ls-files',
  'log',
  'merge-base',
  'range-diff',
  'reflog',
  'rev-parse',
  'shortlog',
  'show',
  'status',
]);

/** 需要按参数区分读写的 git 子命令；其余子命令按写或未知处理。 */
const GIT_READ_FLAGS: Record<string, ReadonlySet<string>> = {
  branch: new Set(['-a', '--all', '-r', '--remotes', '-v', '-vv', '--show-current', '--list']),
  config: new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatches', '-l', '--list']),
  remote: new Set(['-v', '--verbose']),
  stash: new Set(['list', 'show']),
  tag: new Set(['-l', '-n', '--list']),
};

/** git 网络子命令。 */
const GIT_NETWORK_SUBCOMMANDS = new Set(['clone', 'fetch', 'pull', 'push', 'submodule']);

/** PowerShell 只读 cmdlet（小写，含常用别名）。 */
const POWERSHELL_READ = new Set([
  'cat',
  'compare-object',
  'echo',
  'get-childitem',
  'get-command',
  'get-content',
  'get-date',
  'get-filehash',
  'get-help',
  'get-host',
  'get-item',
  'get-itemproperty',
  'get-location',
  'get-member',
  'get-process',
  'get-psdrive',
  'get-service',
  'get-variable',
  'gci',
  'gi',
  'gl',
  'ls',
  'measure-object',
  'out-string',
  'pwd',
  'select-string',
  'sls',
  'test-path',
  'write-host',
  'write-output',
]);

/**
 * PowerShell 路径型读 cmdlet（小写，含常用别名）：与 POSIX 侧 `READ_PATH_PROGRAMS` 同款，
 * 显式路径参数解析到 workspace 外时升为 `escape`（016 §13.1 决议 1 的 PowerShell 侧对齐）。
 */
const POWERSHELL_READ_PATH = new Set([
  'get-content',
  'get-childitem',
  'get-item',
  'get-itemproperty',
  'select-string',
  'get-filehash',
  'gc',
  'gci',
  'gi',
  'gp',
  'sls',
]);

/** PowerShell 出站网络 cmdlet 与别名。 */
const POWERSHELL_NETWORK = new Set([
  'curl',
  'invoke-restmethod',
  'invoke-webrequest',
  'irm',
  'iwr',
  'wget',
]);

/** PowerShell 破坏性 cmdlet 与别名。 */
const POWERSHELL_DESTRUCTIVE = new Set([
  'enter-pssession',
  'invoke-command',
  'remove-item',
  'ri',
  'rm',
  'set-executionpolicy',
  'start-process',
  'stop-process',
]);

/** PowerShell 写文件 cmdlet：参数路径越界升级为 `escape`。 */
const POWERSHELL_WRITE = new Set(['add-content', 'new-item', 'out-file', 'set-content']);

/** PowerShell 无法静态判读的 cmdlet。 */
const POWERSHELL_UNKNOWN = new Set(['iex', 'invoke-expression']);

/**
 * 判断命令的风险类别。
 *
 * 判定顺序：cwd 越界 → 单脚本摘要 → 逐段分类（escape → destructive → network →
 * workspace-write / vcs-write → read → unknown），多段取最严。含变量、命令替换、
 * heredoc 与未闭合引号时返回 `unknown`，由上层询问；不读取文件系统，也不修改任何状态。
 *
 * 脚本类命令（直引脚本 / 解释器脚本参数 / package.json 脚本）额外受 `shell.scriptTrust`
 * 约束：只有 `clean` 才保持 `workspace-write`，`dirty` / `unknown` / 缺省一律降为 `unknown`，
 * 以免 Auto 自动执行模型刚写出、用户尚未审阅的脚本。
 */
export function classifyShellCommandClass(shell: ShellScope, rootDir: string): ShellCommandClass {
  if (!isWithinRoot(shell.cwd, rootDir)) return 'escape';
  if (shell.scriptDigest !== undefined)
    return shell.scriptTrust === 'clean' ? 'workspace-write' : 'unknown';
  const segments = splitSegments(shell.command);
  if (segments === undefined || segments.length === 0) return 'unknown';
  const classes = segments.map((segment) =>
    shell.interpreter === 'pwsh' || shell.interpreter === 'powershell'
      ? classifyPowerShellSegment(segment, shell.cwd, rootDir)
      : classifyPosixSegment(segment, shell.cwd, rootDir, shell.scriptTrust),
  );
  return aggregate(classes);
}

/** 类别到公开三值的单向映射；`workspace-write` / `vcs-write` 在 Auto 下等价于放行。 */
export function toShellCommandSafety(cls: ShellCommandClass): ShellCommandSafety {
  switch (cls) {
    case 'read':
    case 'workspace-write':
    case 'vcs-write':
      return 'safe';
    case 'unknown':
      return 'unknown';
    default:
      return 'unsafe';
  }
}

/**
 * 找出命令中可静态识别、且命中硬禁区的写入目标（workspace 相对路径）。
 *
 * 用途：`run_command` 不经过 PathSandbox，必须由权限层把可识别的 shell 写入
 * （重定向 / `tee` / `cp` / `mv` / `sed -i` / `find -delete` / PowerShell 写 cmdlet）
 * 接回同一份硬禁区清单，命中即 `PERMISSION_DENIED`，不进入审批。
 *
 * 边界：只做词法与静态解析；变量、命令替换、`eval` 等不可解析写法返回空数组，
 * 由类别判定归 `unknown` 并询问。返回空数组不代表命令安全。
 */
export function findProtectedShellTargets(shell: ShellScope, rootDir: string): readonly string[] {
  if (!isWithinRoot(shell.cwd, rootDir)) return [];
  const segments = splitSegments(shell.command);
  if (segments === undefined) return [];
  const root = path.resolve(rootDir);
  const found = new Set<string>();
  for (const segment of segments) {
    const scan = scanRedirections(segment.text);
    // 进程替换的目标可以是任意命令，无法静态归因；分类器侧已按 unknown 询问。
    if (scan.processSubstitution) continue;
    const words = splitWords(scan.command);
    if (words === undefined) continue;
    const candidates = scan.hasOutput ? [...scan.targets] : [];
    const program = baseName(words[0]);
    const args = words.slice(1).filter((word) => !word.startsWith('-'));
    if (program === 'tee' || program === 'touch' || program === 'mkdir') candidates.push(...args);
    if (program === 'cp' || program === 'mv' || program === 'install') {
      // GNU `-t DIR` 的取值才是写入目标（位置参数是源）；无值配对无法归因，跳过该段。
      const targetDirectory = gnuTargetDirectory(words);
      if (targetDirectory.present && targetDirectory.value === undefined) continue;
      const destination = targetDirectory.present ? targetDirectory.value! : args[args.length - 1];
      if (destination !== undefined) candidates.push(destination);
    }
    // `-i` 必须按前缀匹配：GNU/BSD 的后缀形态 `-i.bak`（甚至 BSD 的独立 `-i ''`）同样是原地改写。
    if (
      program === 'sed' &&
      words.some((word) => word.startsWith('-i') || word.startsWith('--in-place'))
    ) {
      const file = args[args.length - 1];
      if (file !== undefined) candidates.push(file);
    }
    if (program === 'find' && words.includes('-delete')) candidates.push(...args);
    if (
      program === 'set-content' ||
      program === 'add-content' ||
      program === 'out-file' ||
      program === 'new-item'
    )
      candidates.push(...args);
    for (const candidate of candidates) {
      if (candidate.includes('$') || candidate.includes('`') || candidate.startsWith('~')) continue;
      // glob 元字符会让 bash 先展开再写入，字面路径不代表真实目标，无法静态归因（分类器侧归 unknown）。
      if (containsGlobMeta(candidate)) continue;
      const resolved = path.resolve(shell.cwd, candidate);
      if (!isWithinRoot(resolved, root)) continue;
      const relative = path.relative(root, resolved).replace(/\\/g, '/');
      if (isProtectedWorkspacePath(relative)) found.add(relative);
    }
  }
  return [...found];
}

/** 多段聚合：先取明确高危，再让 `unknown` 压过所有可判读的放行类。 */
function aggregate(classes: readonly ShellCommandClass[]): ShellCommandClass {
  if (classes.includes('escape')) return 'escape';
  if (classes.includes('destructive')) return 'destructive';
  if (classes.includes('network')) return 'network';
  if (classes.includes('unknown')) return 'unknown';
  if (classes.includes('workspace-write')) return 'workspace-write';
  if (classes.includes('vcs-write')) return 'vcs-write';
  return 'read';
}

/** 工作区包含判定；`path.relative` 在 win32 上按大小写不敏感比较，越界一律拒绝。 */
function isWithinRoot(candidate: string, rootDir: string): boolean {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/** 解析后的绝对路径转 workspace 相对 POSIX 路径，供硬禁区与 escape 清单匹配。 */
function toRelativePosix(resolved: string, rootDir: string): string {
  return path.relative(path.resolve(rootDir), resolved).replace(/\\/g, '/');
}

/**
 * 目标含 glob 元字符（`*` `?` `[`）时 bash 会先展开再重定向/写入，
 * 字面路径比对结果不代表真实写入目标，只能视为无法静态归因。
 */
function containsGlobMeta(word: string): boolean {
  return /[*?[]/.test(word);
}

interface TargetDirectoryOption {
  /** 是否出现 `-t` / `--target-directory` 选项。 */
  present: boolean;
  /** 选项取值；缺省、空串或以 `-` 开头（无法与后续选项区分）视为未提供。 */
  value?: string;
}

/**
 * 解析 GNU `cp` / `mv` / `install` 的目标目录选项：`-t 值`、`--target-directory 值`、
 * `--target-directory=值` 三态；重复出现取最后一次（与 GNU 语义一致）。
 */
function gnuTargetDirectory(words: readonly string[]): TargetDirectoryOption {
  let result: TargetDirectoryOption = { present: false };
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word === '-t' || word === '--target-directory') {
      const value = words[index + 1];
      result =
        value === undefined || value === '' || value.startsWith('-')
          ? { present: true }
          : { present: true, value };
      if (result.value !== undefined) index++;
    } else if (word.startsWith('--target-directory=')) {
      const value = word.slice('--target-directory='.length);
      result = value === '' ? { present: true } : { present: true, value };
    }
  }
  return result;
}

/** 取最后一个非选项词（GNU cp/mv 目标参数惯例；`-t` 存在时不适用）。 */
function lastNonOptionWord(words: readonly string[]): string | undefined {
  for (let index = words.length - 1; index >= 0; index--) {
    const word = words[index]!;
    if (!word.startsWith('-')) return word;
  }
  return undefined;
}

type Segment = { text: string; hadSubstitution: boolean; hadDollar: boolean };

/** 引号感知分段：按引号外的 `&&` `||` `;` `|` `&` 拆分，并检测命令替换与变量展开。 */
function splitSegments(command: string): Segment[] | undefined {
  const segments: Segment[] = [];
  let current = '';
  let hadDollar = false;
  let quote: '"' | "'" | undefined;
  let hasContent = false;
  const flush = (): void => {
    if (!hasContent && current.trim() === '' && !hadDollar) return;
    segments.push({ text: current, hadSubstitution: false, hadDollar });
    current = '';
    hadDollar = false;
    hasContent = false;
  };
  for (let index = 0; index < command.length; index++) {
    const character = command[index];
    if (quote) {
      if (character === quote) quote = undefined;
      else if (quote === '"' && character === '$') hadDollar = true;
      current += character;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      current += character;
      hasContent = true;
      continue;
    }
    if (character === '$') {
      const next = command[index + 1];
      if (next === '(' || next === '{') return undefined;
      hadDollar = true;
      current += character;
      hasContent = true;
      continue;
    }
    // 进程替换 `<(` / `>(` 的内容不在本进程词法可判读范围（写端可以是任意命令），按 unknown 询问。
    if (
      character === '`' ||
      (character === '<' && command[index + 1] === '(') ||
      (character === '>' && command[index + 1] === '(')
    )
      return undefined;
    if (character === '>' || character === '<') {
      current += character;
      hasContent = true;
      while (index + 1 < command.length && /[<>&0-9]/.test(command[index + 1]))
        current += command[++index];
      continue;
    }
    if (character === '&' && command[index + 1] === '&') {
      flush();
      index++;
      continue;
    }
    if (character === '|' && command[index + 1] === '|') {
      flush();
      index++;
      continue;
    }
    if (character === ';' || character === '|' || character === '&' || character === '\n') {
      flush();
      continue;
    }
    if (character !== ' ' && character !== '\t') hasContent = true;
    current += character;
  }
  if (quote !== undefined) return undefined;
  flush();
  return segments;
}

interface RedirectScan {
  /** 去掉重定向操作符与目标后的命令正文。 */
  readonly command: string;
  /** 重定向目标（不含 fd 复制与空设备）。 */
  readonly targets: readonly string[];
  /** 是否出现 heredoc；内容不可判读。 */
  readonly heredoc: boolean;
  /** 是否出现文件输出重定向；出现时该段至少是 `workspace-write`。 */
  readonly hasOutput: boolean;
  /** 重定向目标是否为进程替换 `>(` / `<(`；写端可以是任意命令，无法静态归因。 */
  readonly processSubstitution: boolean;
}

/**
 * 扫描引号外的重定向，返回命令正文与目标。
 * 目标里的变量、`~`、命令替换由调用方按 `unknown` 处理；这里只做词法提取。
 */
function scanRedirections(text: string): RedirectScan {
  let command = '';
  const targets: string[] = [];
  let heredoc = false;
  let hasOutput = false;
  let processSubstitution = false;
  let quote: '"' | "'" | undefined;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
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
    if (character === '<' && text[index + 1] === '<') {
      heredoc = true;
      index++;
      continue;
    }
    // 吃掉 `>>`、`2>`、`&>`、`>|`，以及 fd 复制 `2>&1` 的操作符部分。
    while (index + 1 < text.length && /[>&|]/.test(text[index + 1])) index++;
    // 去掉紧邻操作符的 fd 数字（如 `2>` 的 2）。
    if (/\d$/.test(command) && (command.length === 1 || /\s/.test(command[command.length - 2])))
      command = command.slice(0, -1);
    // 操作符与目标之间可以有空白（`> out.txt`）。
    while (index + 1 < text.length && (text[index + 1] === ' ' || text[index + 1] === '\t'))
      index++;
    let target = '';
    let targetQuote: '"' | "'" | undefined;
    while (index + 1 < text.length) {
      const next = text[index + 1];
      if (targetQuote) {
        if (next === targetQuote) targetQuote = undefined;
        else target += next;
        index++;
        continue;
      }
      if (next === '"' || next === "'") {
        targetQuote = next;
        index++;
        continue;
      }
      if (/[\s|&;<>]/.test(next)) break;
      target += next;
      index++;
    }
    // `2>&1` / `>&2` 是 fd 复制，`/dev/null` 与 `$null` 是空设备，都不构成文件写入。
    const sink = /^(?:>|>>)?(?:nul|\$null|\/dev\/null)$/i.test(target);
    if (target.startsWith('(')) processSubstitution = true;
    if (target !== '' && !target.startsWith('&') && !/^\d+$/.test(target) && !sink) {
      targets.push(target);
      if (character === '>') hasOutput = true;
    }
    command += ' ';
  }
  return { command, targets, heredoc, hasOutput, processSubstitution };
}

/**
 * 校验重定向目标：变量与 `~` 不可判读；glob 元字符与进程替换无法静态归因按 `unknown`；
 * 越界与 escape 类敏感路径按 `escape`；返回 undefined 表示继续分类命令。
 */
function classifyRedirectTargets(
  scan: RedirectScan,
  cwd: string,
  rootDir: string,
): ShellCommandClass | undefined {
  if (scan.heredoc || scan.processSubstitution) return 'unknown';
  for (const target of scan.targets) {
    if (target.includes('$') || target.includes('`') || target.startsWith('~')) return 'unknown';
    if (containsGlobMeta(target)) return 'unknown';
    const resolved = path.resolve(cwd, target);
    if (!isWithinRoot(resolved, rootDir)) return 'escape';
    if (isEscapeClassPath(toRelativePosix(resolved, rootDir))) return 'escape';
  }
  return undefined;
}

/** POSIX 段分级：先校验重定向边界，文件输出至少升到 `workspace-write`。 */
function classifyPosixSegment(
  segment: Segment,
  cwd: string,
  rootDir: string,
  scriptTrust: ShellScope['scriptTrust'],
): ShellCommandClass {
  const scan = scanRedirections(segment.text);
  const redirect = classifyRedirectTargets(scan, cwd, rootDir);
  if (redirect !== undefined) return redirect;
  if (segment.hadDollar) return 'unknown';
  const words = splitWords(scan.command);
  if (words === undefined || words.length === 0) return 'unknown';
  const result = classifyPosixWords(words, cwd, rootDir, scriptTrust);
  return scan.hasOutput && result === 'read' ? 'workspace-write' : result;
}

/** 按首程序分派 POSIX 命令；调用方已完成重定向与变量检查。 */
function classifyPosixWords(
  words: readonly string[],
  cwd: string,
  rootDir: string,
  scriptTrust: ShellScope['scriptTrust'],
): ShellCommandClass {
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index]!)) index++;
  if (words[index] === 'time') index++;
  if (words[index] === 'command') index++;
  const program = baseName(words[index]);
  if (program === undefined) return 'unknown';
  const rest = words.slice(index + 1);

  if (program === 'cd') return classifyChangeDirectory(rest, cwd, rootDir);
  if (program === 'git') return classifyGit(rest);
  if (program === 'find') return classifyFind(rest, cwd, rootDir);
  if (program === 'sed')
    // `-i.bak` 这类带后缀的原地改写同样不可判读，必须按前缀识别；sed 无其它 `-i` 开头选项。
    return rest.some((word) => word.startsWith('-i') || word.startsWith('--in-place'))
      ? 'unknown'
      : 'read';
  if (program === 'tee') return classifyWriteTargets(rest, cwd, rootDir);
  if (program === 'cp') return classifyCopy(rest, cwd, rootDir);
  if (program === 'pnpm' || program === 'npm' || program === 'yarn')
    return classifyPackageManager(rest, scriptTrust);
  if (program === 'npx') return 'network';
  if (program === 'docker') return classifyDocker(rest);
  if (program === 'gh') return 'network';
  if (program === 'eval' || program === 'exec' || program === 'xargs') return 'unknown';
  if (INTERPRETER_PROGRAMS.has(program))
    return classifyInterpreter(program, rest, cwd, rootDir, scriptTrust);
  if (WORKSPACE_PROGRAMS.has(program)) return 'workspace-write';
  if (DESTRUCTIVE_PROGRAMS.has(program)) return 'destructive';
  if (NETWORK_PROGRAMS.has(program)) return 'network';
  if (READ_PROGRAMS.has(program)) {
    return READ_PATH_PROGRAMS.has(program) ? classifyReadArguments(rest, cwd, rootDir) : 'read';
  }
  return 'unknown';
}

/** PowerShell 段分级；变量展开与无法判读的 cmdlet 一律 `unknown`。 */
function classifyPowerShellSegment(
  segment: Segment,
  cwd: string,
  rootDir: string,
): ShellCommandClass {
  const scan = scanRedirections(segment.text);
  const redirect = classifyRedirectTargets(scan, cwd, rootDir);
  if (redirect !== undefined) return redirect;
  if (segment.hadDollar) return 'unknown';
  const words = splitWords(scan.command);
  if (words === undefined || words.length === 0) return 'unknown';
  const result = classifyPowerShellWords(words, cwd, rootDir);
  return scan.hasOutput && result === 'read' ? 'workspace-write' : result;
}

/** 按 cmdlet 分派 PowerShell 命令；调用方已完成重定向与变量检查。 */
function classifyPowerShellWords(
  words: readonly string[],
  cwd: string,
  rootDir: string,
): ShellCommandClass {
  const program = baseName(words[0]);
  if (program === undefined) return 'unknown';
  const rest = words.slice(1);
  if (POWERSHELL_NETWORK.has(program)) return 'network';
  if (POWERSHELL_DESTRUCTIVE.has(program)) return 'destructive';
  if (POWERSHELL_WRITE.has(program)) return classifyWriteTargets(rest, cwd, rootDir);
  if (POWERSHELL_UNKNOWN.has(program)) return 'unknown';
  if (POWERSHELL_READ.has(program)) {
    // PowerShell 自有的路径型读 cmdlet 不在 POSIX 的 READ_PATH_PROGRAMS 内，需单独集合；
    // 两者取并集保证 `cat` / `ls` 等跨解释器别名同样受路径越界检查。
    return READ_PATH_PROGRAMS.has(program) || POWERSHELL_READ_PATH.has(program)
      ? classifyReadArguments(rest, cwd, rootDir)
      : 'read';
  }
  return 'unknown';
}

/** 只读程序的文件参数越界检查；非路径参数（模式串、选项值）不参与判定。 */
function classifyReadArguments(
  words: readonly string[],
  cwd: string,
  rootDir: string,
): ShellCommandClass {
  for (const word of words) {
    if (!looksLikePath(word)) continue;
    if (word.includes('$') || word.includes('`') || word.startsWith('~')) return 'unknown';
    if (!isWithinRoot(path.resolve(cwd, word), rootDir)) return 'escape';
  }
  return 'read';
}

/** 词法路径判定：只用于把明显像路径的参数送去越界检查，避免误伤普通模式串。 */
function looksLikePath(word: string): boolean {
  if (word === '' || word.startsWith('-')) return false;
  if (word === '..' || word.startsWith('../') || word.startsWith('..\\')) return true;
  if (word.startsWith('~')) return true;
  if (word.startsWith('/') || word.startsWith('./') || word.startsWith('.\\')) return true;
  if (/^[A-Za-z]:[\\/]/.test(word)) return true;
  return word.includes('/') && !/^[a-z][a-z0-9+.-]*:\/\//i.test(word);
}

/**
 * 写目标校验：`tee` 与 PowerShell 写 cmdlet 共用；目标含 glob 或变量按 `unknown` 询问，
 * 越界与命中 escape 类敏感路径 → `escape`，否则 `workspace-write`。
 */
function classifyWriteTargets(
  words: readonly string[],
  cwd: string,
  rootDir: string,
): ShellCommandClass {
  let sawTarget = false;
  for (const word of words) {
    if (word.startsWith('-')) continue;
    sawTarget = true;
    if (word.includes('$') || word.includes('`') || word.startsWith('~')) return 'unknown';
    if (containsGlobMeta(word)) return 'unknown';
    const resolved = path.resolve(cwd, word);
    if (!isWithinRoot(resolved, rootDir)) return 'escape';
    if (isEscapeClassPath(toRelativePosix(resolved, rootDir))) return 'escape';
  }
  return sawTarget ? 'workspace-write' : 'unknown';
}

/**
 * `cp` / `mv` / `install`：源或目标越界都按 `escape`，否则视为工作区内写入。
 * GNU `-t DIR` 的取值才是真实写入目标（最后一个位置参数是源）；选项无值配对无法判读；
 * 目标含 glob 元字符按 `unknown`，命中 escape 类敏感路径按 `escape`。
 */
function classifyCopy(words: readonly string[], cwd: string, rootDir: string): ShellCommandClass {
  const targetDirectory = gnuTargetDirectory(words);
  if (targetDirectory.present && targetDirectory.value === undefined) return 'unknown';
  for (const word of words) {
    if (word.startsWith('-')) continue;
    if (word.includes('$') || word.includes('`') || word.startsWith('~')) return 'unknown';
    if (!isWithinRoot(path.resolve(cwd, word), rootDir)) return 'escape';
  }
  const destination = targetDirectory.present ? targetDirectory.value! : lastNonOptionWord(words);
  if (destination === undefined) return 'unknown';
  if (containsGlobMeta(destination)) return 'unknown';
  const resolved = path.resolve(cwd, destination);
  if (!isWithinRoot(resolved, rootDir)) return 'escape';
  if (isEscapeClassPath(toRelativePosix(resolved, rootDir))) return 'escape';
  return 'workspace-write';
}

/** `find`：删除与执行参数按高危处理；位置参数越界按 `escape`。 */
function classifyFind(words: readonly string[], cwd: string, rootDir: string): ShellCommandClass {
  if (words.some((word) => word === '-delete')) return 'destructive';
  if (words.some((word) => /^(-exec|-execdir|-ok|-okdir)$/.test(word))) return 'unknown';
  for (const word of words) {
    if (!looksLikePath(word)) continue;
    if (word.includes('$') || word.includes('`') || word.startsWith('~')) return 'unknown';
    if (!isWithinRoot(path.resolve(cwd, word), rootDir)) return 'escape';
  }
  return 'read';
}

/** `cd` 目标必须是 rootDir 内的静态路径；越界按 `escape`。 */
function classifyChangeDirectory(
  rest: readonly string[],
  cwd: string,
  rootDir: string,
): ShellCommandClass {
  if (rest.length === 0 || rest.length > 1) return 'unknown';
  const target = rest[0]!;
  if (target.includes('$') || target.startsWith('-')) return 'unknown';
  if (target.startsWith('~')) return 'escape';
  return isWithinRoot(path.resolve(cwd, target), rootDir) ? 'read' : 'escape';
}

/** 包管理器：只认第一个子命令；选项值不会被误当子命令。 */
function classifyPackageManager(
  rest: readonly string[],
  scriptTrust: ShellScope['scriptTrust'],
): ShellCommandClass {
  const subcommand = firstSubcommand(rest);
  if (subcommand === undefined) return 'unknown';
  if (subcommand === 'dlx') return 'network';
  if (subcommand === 'exec') return 'workspace-write';
  if (PACKAGE_NETWORK_SUBCOMMANDS.has(subcommand)) return 'network';
  if (PACKAGE_WORKSPACE_SUBCOMMANDS.has(subcommand))
    return scriptTrust === 'clean' ? 'workspace-write' : 'unknown';
  return 'unknown';
}

/** 跳过选项及其取值，取第一个真正的子命令（小写）。 */
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

/** `docker`：只读子命令放行，涉及构建 / 运行 / 仓库的子命令按网络处理。 */
function classifyDocker(rest: readonly string[]): ShellCommandClass {
  const subcommand = rest[0]?.toLowerCase();
  if (subcommand === undefined) return 'unknown';
  if (subcommand === 'ps' || subcommand === 'logs' || subcommand === 'images') return 'read';
  if (
    subcommand === 'build' ||
    subcommand === 'pull' ||
    subcommand === 'push' ||
    subcommand === 'login' ||
    subcommand === 'run' ||
    subcommand === 'compose'
  )
    return 'network';
  return 'unknown';
}

/** 解释器：`-c` / `-e` / 标准输入不可判读；脚本路径越界按 `escape`，脚本不受信按 `unknown`。 */
function classifyInterpreter(
  program: string,
  rest: readonly string[],
  cwd: string,
  rootDir: string,
  scriptTrust: ShellScope['scriptTrust'],
): ShellCommandClass {
  if (program === 'node' || program === 'deno' || program === 'python' || program === 'python3') {
    if (rest.some((word) => word === '-e' || word === '--eval' || word === '-c' || word === '-p'))
      return 'unknown';
    if (rest.some((word) => word === '-' || word === '--')) return 'unknown';
  }
  if ((program === 'bash' || program === 'sh' || program === 'zsh') && rest.includes('-c'))
    return 'unknown';
  const script = rest.find((word) => !word.startsWith('-'));
  if (script === undefined) return 'unknown';
  if (script.includes('$') || script.includes('`') || script.startsWith('~')) return 'unknown';
  if (!isWithinRoot(path.resolve(cwd, script), rootDir)) return 'escape';
  return scriptTrust === 'clean' ? 'workspace-write' : 'unknown';
}

/** git 子命令分级；破坏性写法优先于普通写操作。 */
function classifyGit(rest: readonly string[]): ShellCommandClass {
  const subcommand = rest[0]?.toLowerCase();
  if (subcommand === undefined) return 'unknown';
  const args = rest.slice(1);
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    return args.some((word) => word === '-o' || word === '--output' || word.startsWith('--output='))
      ? 'workspace-write'
      : 'read';
  }
  const readFlags = GIT_READ_FLAGS[subcommand];
  if (readFlags && args.every((word) => readFlags.has(word.toLowerCase()))) return 'read';
  if (GIT_NETWORK_SUBCOMMANDS.has(subcommand)) {
    return args.some((word) => word === '--force' || word === '-f') ? 'destructive' : 'network';
  }
  if (subcommand === 'reset') return args.includes('--hard') ? 'destructive' : 'vcs-write';
  if (subcommand === 'clean') return 'destructive';
  if (subcommand === 'restore') return 'destructive';
  if (subcommand === 'checkout') {
    if (args.includes('--') || args.includes('-f')) return 'destructive';
    return 'vcs-write';
  }
  if (subcommand === 'stash') {
    if (args.includes('drop') || args.includes('clear')) return 'destructive';
    return 'vcs-write';
  }
  if (subcommand === 'branch') {
    if (args.some((word) => word === '-D' || word === '-d')) return 'destructive';
    return 'vcs-write';
  }
  if (subcommand === 'tag') return args.some((word) => word === '-d') ? 'destructive' : 'vcs-write';
  if (subcommand === 'config' || subcommand === 'remote') return 'destructive';
  if (subcommand === 'add' || subcommand === 'commit' || subcommand === 'switch')
    return 'vcs-write';
  if (subcommand === 'rm' || subcommand === 'mv') return 'destructive';
  return 'unknown';
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
        started = true;
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

/** 去掉路径前缀取程序名；空词或以 `-` 开头（缺程序名）返回 undefined。 */
function baseName(word: string | undefined): string | undefined {
  if (word === undefined || word === '' || word.startsWith('-')) return undefined;
  const normalised = word.replace(/\\/g, '/');
  const name = normalised.slice(normalised.lastIndexOf('/') + 1).toLowerCase();
  return name === '' ? undefined : name;
}
