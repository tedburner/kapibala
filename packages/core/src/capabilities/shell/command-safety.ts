import path from 'node:path';
import type { ShellScope } from '../security/permissions.js';

/**
 * Auto 模式专用的命令安全分级结果：
 * - `safe`：全部子命令命中内置只读表且无可疑结构，可在 Auto 模式自动放行；
 * - `unsafe`：命中危险程序、重定向或执行目标越出工作区，必须询问；
 * - `unknown`：命令结构无法静态判读（命令替换、未收录程序、含变量等），按 fail-closed 询问。
 * 分级只作为 Auto 模式默认值的裁决输入，不覆盖显式规则与会话缓存；目录在 rootDir 之外、
 * 解释器不可判读时一律不允许自动放行。启发式必有误判，宁多问一次，不错放一次。
 */
export type ShellCommandSafety = 'safe' | 'unsafe' | 'unknown';

/** POSIX 无条件只读程序：任意参数（除重定向，分段层已拦截）都只读取状态。 */
const POSIX_SAFE = new Set([
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

/**
 * 明确危险的程序：破坏性、提权、网络出站或任意代码执行。命中即 `unsafe`，
 * 即使它同时出现在其他表中也以 unsafe 优先；未收录程序走 `unknown`（同样询问，
 * 但审计上可区分「已知危险」与「无法判读」）。
 */
const POSIX_UNSAFE = new Set([
  'apt',
  'apt-get',
  'bash',
  'brew',
  'chmod',
  'chown',
  'curl',
  'dd',
  'doas',
  'eval',
  'exec',
  'fdisk',
  'ftp',
  'halt',
  'kill',
  'killall',
  'mkfs',
  'mktemp',
  'mv',
  'nc',
  'netcat',
  'node',
  'perl',
  'php',
  'pkill',
  'poweroff',
  'python',
  'python3',
  'reboot',
  'rm',
  'rsync',
  'ruby',
  'scp',
  'sh',
  'ssh',
  'su',
  'sudo',
  'telnet',
  'wget',
  'zsh',
]);

/** git 只读子命令：任何参数都不改变仓库状态。 */
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

/** git 需按白名单收窄参数的子命令：缺省参数形式只读，其余形式可能写入。 */
const GIT_FLAGGED_SUBCOMMANDS: Record<string, Set<string>> = {
  branch: new Set(['-a', '--list', '-r', '--remotes', '-v', '-vv', '--show-current']),
  config: new Set(['--get', '--get-all', '--get-regexp', '--get-urlmatches', '-l', '--list']),
  remote: new Set(['-v', '--verbose']),
  stash: new Set(['list']),
  tag: new Set(['-l', '-n', '--list']),
};

/** PowerShell 无条件只读 cmdlet（小写；含最常见的 POSIX 别名）。 */
const POWERSHELL_SAFE = new Set([
  'cat',
  'compare-object',
  'echo',
  'get-childitem',
  'get-command',
  'get-content',
  'get-date',
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

/** PowerShell 明确危险的 cmdlet/别名（含被别名的网络命令）。 */
const POWERSHELL_UNSAFE = new Set([
  'add-content',
  'curl',
  'enter-pssession',
  'invoke-command',
  'invoke-expression',
  'invoke-restmethod',
  'invoke-webrequest',
  'irm',
  'iwr',
  'iex',
  'new-item',
  'out-file',
  'remove-item',
  'ri',
  'rm',
  'set-content',
  'set-executionpolicy',
  'start-process',
  'stop-process',
  'wget',
]);

/**
 * 依据 ShellScope 的最终执行目标对整条命令做保守分级。
 *
 * 保证与边界：
 * - cwd 必须物理落在 rootDir 内，否则 `unsafe`（Auto 不自动放行工作区外执行）；
 * - 命令替换（`$( )`、反引号、`<(`、`>(`）与未闭合引号直接 `unknown`；
 * - 变量展开（`$`）视为内容不可知，按 `unknown` 询问；
 * - 分段按引号外运算符（`&&` `||` `;` `|` `&`）拆分，逐段独立分级后取最严结果；
 * - 任何分段命中 `>` 重定向即 `unsafe`（Auto 的文件写入豁免只覆盖 fs:write 工具，
 *   shell 重定向不受 PathSandbox 约束，不能借只读表放行）。
 */
export function classifyShellCommandSafety(shell: ShellScope, rootDir: string): ShellCommandSafety {
  if (!isWithinRoot(shell.cwd, rootDir)) return 'unsafe';
  if (shell.scriptDigest !== undefined) return 'unknown';
  const segments = splitSegments(shell.command);
  if (segments === undefined || segments.length === 0) return 'unknown';
  const verdicts = segments.map((segment) =>
    shell.interpreter === 'pwsh' || shell.interpreter === 'powershell'
      ? classifyPowerShellSegment(segment)
      : classifyPosixSegment(segment, shell.cwd, rootDir),
  );
  if (verdicts.some((verdict) => verdict === 'unsafe')) return 'unsafe';
  if (verdicts.some((verdict) => verdict === 'unknown')) return 'unknown';
  return 'safe';
}

/** 工作区包含判定；path.relative 在 win32 上本身按大小写不敏感比较，越界一律拒绝。 */
function isWithinRoot(candidate: string, rootDir: string): boolean {
  const relative = path.relative(path.resolve(rootDir), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

type Segment = { text: string; hadSubstitution: boolean; hadDollar: boolean };

/**
 * 引号感知的分段：按引号外的 `&&` `||` `;` `|` `&` 拆分，并检测命令替换与变量展开。
 * 引号不闭合、出现 `$(`、反引号、`<(`、`>(` 返回 `undefined`；`$VAR` 记入标记由调用方定级。
 */
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
      if (next === '(' || next === '{') return undefined; // 命令/参数替换，内容不可判读
      hadDollar = true;
      current += character;
      hasContent = true;
      continue;
    }
    if (character === '`' || (character === '<' && command[index + 1] === '(')) return undefined;
    if (character === '>' || character === '<') {
      // 重定向目标未知；一律按 unsafe 处理（不含子命令替换场景，后者已提前返回）。
      current += character;
      hasContent = true;
      // 跳过重定向操作符（>>、2>、&> 的字符部分），目标作为普通词留在段内。
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
  if (quote !== undefined) return undefined; // 未闭合引号
  flush();
  return segments;
}

/** POSIX 段分级：剥离环境变量赋值与 time 前缀后按首程序查表。 */
function classifyPosixSegment(segment: Segment, cwd: string, rootDir: string): ShellCommandSafety {
  if (segment.text.includes('>')) return 'unsafe'; // 含 >>、2>、&>；重定向目标不受 PathSandbox 约束
  if (segment.text.includes('<<')) return 'unknown'; // heredoc 内容不可判读
  if (segment.hadDollar) return 'unknown';
  const words = splitWords(segment.text);
  if (words === undefined || words.length === 0) return 'unknown';
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index++;
  if (words[index] === 'time') index++;
  if (words[index] === 'command') index++;
  const program = baseName(words[index]);
  if (program === undefined) return 'unknown';
  const rest = words.slice(index + 1);
  if (POSIX_UNSAFE.has(program)) return 'unsafe';
  if (program === 'cd') return classifyChangeDirectory(rest, cwd, rootDir);
  if (program === 'git') return classifyGit(rest);
  if (program === 'find') {
    return rest.some((word) => /^(-delete|-exec|-execdir|-ok|-okdir|-fprint\w*)$/.test(word))
      ? 'unsafe'
      : 'safe';
  }
  if (POSIX_SAFE.has(program)) return 'safe';
  return 'unknown';
}

/** PowerShell 段分级：cmdlet 与别名统一小写后查表。 */
function classifyPowerShellSegment(segment: Segment): ShellCommandSafety {
  if (segment.text.includes('>')) return 'unsafe';
  if (segment.hadDollar) return 'unknown';
  const words = splitWords(segment.text);
  if (words === undefined || words.length === 0) return 'unknown';
  const program = words[0].toLowerCase();
  if (POWERSHELL_UNSAFE.has(program)) return 'unsafe';
  if (POWERSHELL_SAFE.has(program)) return 'safe';
  return 'unknown';
}

/** git 子命令分级：只读子命令直接放行；带参受限子命令按白名单收窄。 */
function classifyGit(rest: string[]): ShellCommandSafety {
  const subcommand = rest[0]?.toLowerCase();
  if (subcommand === undefined) return 'unknown';
  if (GIT_READ_SUBCOMMANDS.has(subcommand)) {
    // log/diff/show 等可经 -o/--output 写文件，出现即按写入处理。
    return rest
      .slice(1)
      .some((word) => word === '-o' || word === '--output' || word.startsWith('--output='))
      ? 'unsafe'
      : 'safe';
  }
  const whitelist = GIT_FLAGGED_SUBCOMMANDS[subcommand];
  if (whitelist) {
    const arguments_ = rest.slice(1);
    return arguments_.every((word) => whitelist.has(word.toLowerCase())) ? 'safe' : 'unknown';
  }
  return 'unknown';
}

/** cd 目标必须是 rootDir 内的静态路径；含变量或越界一律不允许自动放行。 */
function classifyChangeDirectory(rest: string[], cwd: string, rootDir: string): ShellCommandSafety {
  if (rest.length === 0 || rest.length > 1) return 'unknown';
  const target = rest[0];
  if (target.includes('$') || target.startsWith('-')) return 'unknown';
  const resolved = path.resolve(cwd, target);
  return isWithinRoot(resolved, rootDir) ? 'safe' : 'unsafe';
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
