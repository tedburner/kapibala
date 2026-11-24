import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { redactCommonSecrets } from '../redaction.js';
import { sanitizeUntrustedOutput } from '../ui/text-safety.js';
import { hasAsciiControlCharacter } from './env.js';
import { ExternalHarnessError } from './types.js';

/** Windows 保留设备名集合（裸名或带扩展名均禁止作为命令或目录分量打开，防内核句柄死锁）。 */
const WINDOWS_RESERVED_DEVICES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
]);

/** `.cmd` 垫片读取字节上限（64 KiB），防止误指超大二进制文件耗尽内存。 */
const MAX_SHIM_BYTES = 64 * 1024;
/** 无后缀脚本文件头 shebang 探测字节数。 */
const SHEBANG_PROBE_BYTES = 256;
/** 子进程 stderr 环形缓冲上限（16 KiB），兼顾防管道阻塞与崩溃诊断上下文。 */
const MAX_STDERR_TAIL_BYTES = 16 * 1024;

/** 命令静态解包方式：直启二进制、`.cmd` 解包 `.exe`、`.cmd` 解包 JS 脚本、`.cmd` 解包 node shebang 或直接 node 脚本。 */
export type ExternalCommandUnwrapKind =
  | 'direct'
  | 'node-script'
  | 'cmd-exe'
  | 'cmd-node-script'
  | 'cmd-shebang-node';

/** `resolveExternalCommand` 解析结果；可直接喂给 `spawn(executable, args, { shell: false })`。 */
export interface ResolvedExternalCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly unwrapKind: ExternalCommandUnwrapKind;
  readonly usedFallbackDir: boolean;
  /** 供 `buildExternalLaunchEnv` 补齐 `PATH` 的目录（如命中的 GUI 兜底目录或解包所用 node 目录）。 */
  readonly extraPathDirs: readonly string[];
}

/** `resolveExternalCommand` 选项；所有宿主环境依赖均可显式注入以便跨平台确定性单测。 */
export interface ResolveExternalCommandOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly envPath?: string;
  readonly homeDir?: string;
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
}

function hasWindowsReservedSegment(input: string): boolean {
  const segments = input
    .replace(/[\\/]+/g, '/')
    .split('/')
    .filter(Boolean);
  for (const seg of segments) {
    const cleaned = seg.replace(/^[A-Za-z]:$/, '');
    if (!cleaned) continue;
    const lower = cleaned.toLowerCase();
    const stem = lower.includes('.') ? lower.slice(0, lower.indexOf('.')) : lower;
    if (WINDOWS_RESERVED_DEVICES.has(lower) || (stem && WINDOWS_RESERVED_DEVICES.has(stem))) {
      return true;
    }
  }
  return false;
}

function toPhysicalFileIfExists(candidate: string): string | undefined {
  try {
    const real = fs.realpathSync.native(candidate);
    return fs.statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

function isStrictAbsolutePath(target: string, platform: NodeJS.Platform): boolean {
  if (platform === 'win32') {
    // 排除 `\foo`（无盘符根相对路径）与 `C:foo`（盘符当前目录相对路径），只接受完整盘符或 UNC 路径。
    return /^[A-Za-z]:[\\/]/.test(target) || /^\\\\[^\\]+\\[^\\]+/.test(target);
  }
  return path.posix.isAbsolute(target);
}

/**
 * 计算桌面 GUI 受限 `PATH` 下的标准安装目录只读兜底列表。
 *
 * 优先级原则：始终排在用户显式 `PATH` 之后（"The user's own program wins"），仅在 `PATH` 未命中时兜底。
 */
export function getStandardCliFallbackDirs(options: {
  platform: NodeJS.Platform;
  homeDir: string;
  hostEnv: Readonly<Record<string, string | undefined>>;
}): string[] {
  const { platform, homeDir, hostEnv } = options;
  if (platform === 'win32') {
    const appData =
      hostEnv.APPDATA ?? hostEnv.appdata ?? path.win32.join(homeDir, 'AppData', 'Roaming');
    const localAppData =
      hostEnv.LOCALAPPDATA ?? hostEnv.localappdata ?? path.win32.join(homeDir, 'AppData', 'Local');
    const programFiles = hostEnv.ProgramFiles ?? 'C:\\Program Files';
    return [
      path.win32.join(homeDir, '.local', 'bin'),
      path.win32.join(appData, 'npm'),
      path.win32.join(localAppData, 'pnpm'),
      path.win32.join(localAppData, 'agy', 'bin'),
      path.win32.join(localAppData, 'Programs', 'Antigravity', 'bin'),
      path.win32.join(localAppData, 'Programs', 'OpenAI', 'Codex', 'bin'),
      path.win32.join(localAppData, 'qwen-code', 'bin'),
      path.win32.join(homeDir, '.bun', 'bin'),
      path.win32.join(homeDir, '.volta', 'bin'),
      path.win32.join(homeDir, '.cargo', 'bin'),
      path.win32.join(programFiles, 'nodejs'),
    ];
  }
  return [
    path.posix.join(homeDir, '.local', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.posix.join(homeDir, 'Library', 'pnpm'),
    path.posix.join(homeDir, '.local', 'share', 'pnpm'),
    path.posix.join(homeDir, '.npm-global', 'bin'),
    path.posix.join(homeDir, '.bun', 'bin'),
    path.posix.join(homeDir, '.volta', 'bin'),
    path.posix.join(homeDir, '.cargo', 'bin'),
  ];
}

function isContainedIn(childPath: string, parentDir: string, platform: NodeJS.Platform): boolean {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalizedChild = platform === 'win32' ? childPath.toLowerCase() : childPath;
  const normalizedParent = platform === 'win32' ? parentDir.toLowerCase() : parentDir;
  const rel = pathApi.relative(normalizedParent, normalizedChild);
  return (
    rel !== '' && rel !== '..' && !rel.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(rel)
  );
}

function hasNodeShebang(filePath: string): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(SHEBANG_PROBE_BYTES);
    const bytesRead = fs.readSync(fd, buf, 0, SHEBANG_PROBE_BYTES, 0);
    const head = buf.subarray(0, bytesRead).toString('utf8');
    const firstLine = head.split(/\r?\n/, 1)[0] ?? '';
    return /^#!\s*(?:\/usr\/bin\/env\s+(?:-S\s+)?node\b|\/.*\/node(?:\.exe)?\b)/i.test(firstLine);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function resolveNodeExecutable(options: {
  shimDir?: string;
  searchDirs: readonly string[];
  platform: NodeJS.Platform;
}): string {
  const isWin = options.platform === 'win32';
  const nodeName = isWin ? 'node.exe' : 'node';
  if (options.shimDir) {
    const localNode = toPhysicalFileIfExists(path.join(options.shimDir, nodeName));
    if (localNode) return localNode;
  }
  for (const dir of options.searchDirs) {
    const found = toPhysicalFileIfExists(path.join(dir, nodeName));
    if (found) return found;
  }
  // 仅当当前宿主确系纯 Node 进程（非 Electron 主进程）时才允许回退到 process.execPath，
  // 防止桌面端在禁设 ELECTRON_RUN_AS_NODE 的前提下把脚本误喂给 Electron 二进制拉起新窗口。
  if (
    !process.versions.electron &&
    options.platform === process.platform &&
    path.basename(process.execPath).toLowerCase().startsWith('node')
  ) {
    const selfNode = toPhysicalFileIfExists(process.execPath);
    if (selfNode) return selfNode;
  }
  throw new ExternalHarnessError(
    'EXTERNAL_NODE_NOT_FOUND',
    '外部代理垫片指向 Node 脚本，但未在系统 PATH 或标准安装目录中找到 node 可执行文件',
  );
}

/**
 * 静态解包标准 npm / pnpm `.cmd` 垫片，确保全程 `shell: false`。
 *
 * 三形态分流（已于 Windows `opencode.cmd` 与 `dsh.cmd` 实测）：
 * 1. 仅解析带 `%*` 的执行行（避开 `npm 12+` 前置变量行）；
 * 2. 词法路径与 `fs.realpathSync.native` 物理路径均须落在受管 `node_modules` 边界内，拦截 `..\..\` 目录穿越；
 * 3. 目标后缀 `.exe` 直启二进制；`.js/.mjs/.cjs` 或首 256B 含 `#!...node` 走独立 `node.exe` 启动；其余脚本一律拒绝。
 */
function unwrapWindowsCmdShim(
  shimPhysicalPath: string,
  userArgs: readonly string[],
  searchDirs: readonly string[],
): {
  executable: string;
  args: readonly string[];
  unwrapKind: 'cmd-exe' | 'cmd-node-script' | 'cmd-shebang-node';
  extraPathDirs: string[];
} {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(shimPhysicalPath);
  } catch (cause) {
    throw new ExternalHarnessError(
      'EXTERNAL_UNSUPPORTED_SHIM',
      `无法读取垫片文件：${shimPhysicalPath}`,
      {
        cause,
      },
    );
  }
  if (stat.size > MAX_SHIM_BYTES) {
    throw new ExternalHarnessError(
      'EXTERNAL_UNSUPPORTED_SHIM',
      `垫片文件超过安全解析上限（64KiB）：${shimPhysicalPath}`,
    );
  }

  const content = fs.readFileSync(shimPhysicalPath, 'utf8');
  const shimDir = path.dirname(shimPhysicalPath);
  const lines = content.split(/\r?\n/);

  let rawTargetToken: string | undefined;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || /^(?:rem\b|::)/i.test(trimmed)) continue;
    if (!trimmed.includes('%*')) continue;

    // 截取 `%*` 之前的片段，提取所有双引号包裹的参数，取最后一个非 node 解释器令牌作为脚本/二进制目标。
    const beforeArgs = trimmed.slice(0, trimmed.indexOf('%*'));
    const quotedMatches = [...beforeArgs.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const candidates =
      quotedMatches.length > 0 ? quotedMatches : beforeArgs.split(/\s+/).filter(Boolean);

    for (const token of candidates) {
      const lower = token.toLowerCase().replace(/\//g, '\\');
      if (
        lower === '%_prog%' ||
        lower === 'node' ||
        lower === 'node.exe' ||
        lower === '%dp0%\\node.exe' ||
        lower === '%~dp0\\node.exe' ||
        lower === '%dp0%node.exe' ||
        lower === '%~dp0node.exe'
      ) {
        continue;
      }
      if (lower.includes('dp0') || lower.includes('node_modules')) {
        rawTargetToken = token;
      }
    }
    if (rawTargetToken) break;
  }

  if (!rawTargetToken) {
    throw new ExternalHarnessError(
      'EXTERNAL_UNSUPPORTED_SHIM',
      `不支持执行非标准批处理脚本 '${path.basename(shimPhysicalPath)}'；请直接填写原生 .exe 路径或标准 npm/pnpm 安装的命令`,
    );
  }

  const expanded = rawTargetToken.replace(/(?:%~dp0|%dp0%)[\\/]?/gi, `${shimDir}${path.win32.sep}`);
  const lexicalTarget = path.win32.resolve(shimDir, expanded);

  // 允许两类合法受管根：<shimDir>\node_modules\（全局 npm）与 <root>\node_modules\（当 shim 位于 node_modules\.bin）。
  const isDotBin =
    path.win32.basename(shimDir).toLowerCase() === '.bin' &&
    path.win32.basename(path.win32.dirname(shimDir)).toLowerCase() === 'node_modules';
  const managedNodeModulesRoot = isDotBin
    ? path.win32.dirname(shimDir)
    : path.win32.join(shimDir, 'node_modules');
  const pnpmGlobalRoot = path.win32.join(shimDir, 'global');

  const lexicallyValid =
    isContainedIn(lexicalTarget, managedNodeModulesRoot, 'win32') ||
    (isContainedIn(lexicalTarget, pnpmGlobalRoot, 'win32') &&
      lexicalTarget.toLowerCase().includes('\\node_modules\\'));

  if (!lexicallyValid) {
    throw new ExternalHarnessError(
      'EXTERNAL_UNSUPPORTED_SHIM',
      `拒绝执行越出受管 node_modules 目录的垫片目标：${path.basename(shimPhysicalPath)}`,
    );
  }

  const physicalTarget = toPhysicalFileIfExists(lexicalTarget);
  if (!physicalTarget) {
    throw new ExternalHarnessError(
      'EXTERNAL_UNSUPPORTED_SHIM',
      `垫片 '${path.basename(shimPhysicalPath)}' 指向的目标文件不存在`,
    );
  }

  // 二次物理边界核验：若非 pnpm 全局 store 软链场景，拦截指向父目录任意二进制的恶意符号链接。
  const allowedPhysicalParent = isDotBin ? path.dirname(shimDir) : shimDir;
  if (
    !isContainedIn(physicalTarget, allowedPhysicalParent, 'win32') &&
    !physicalTarget.toLowerCase().includes('\\node_modules\\')
  ) {
    throw new ExternalHarnessError(
      'EXTERNAL_UNSUPPORTED_SHIM',
      `垫片 '${path.basename(shimPhysicalPath)}' 的物理目标越出受管目录边界`,
    );
  }

  const ext = path.extname(physicalTarget).toLowerCase();
  if (ext === '.exe') {
    return {
      executable: physicalTarget,
      args: [...userArgs],
      unwrapKind: 'cmd-exe',
      extraPathDirs: [shimDir, path.dirname(physicalTarget)],
    };
  }

  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    const nodeExe = resolveNodeExecutable({ shimDir, searchDirs, platform: 'win32' });
    return {
      executable: nodeExe,
      args: [physicalTarget, ...userArgs],
      unwrapKind: 'cmd-node-script',
      extraPathDirs: [shimDir, path.dirname(nodeExe)],
    };
  }

  if (ext === '' && hasNodeShebang(physicalTarget)) {
    const nodeExe = resolveNodeExecutable({ shimDir, searchDirs, platform: 'win32' });
    return {
      executable: nodeExe,
      args: [physicalTarget, ...userArgs],
      unwrapKind: 'cmd-shebang-node',
      extraPathDirs: [shimDir, path.dirname(nodeExe)],
    };
  }

  throw new ExternalHarnessError(
    'EXTERNAL_UNSUPPORTED_SHIM',
    `垫片 '${path.basename(shimPhysicalPath)}' 指向不受支持的目标类型 '${ext || '无扩展名'}'`,
  );
}

/**
 * 解析并静态校验外部代理启动命令，输出可直接以 `shell: false` 执行的物理路径与参数数组。
 *
 * 前置约束与失败边界：
 * - 含 `/` 或 `\` 但非严格绝对路径（展开 `~/` 后）直接报 `EXTERNAL_INVALID_COMMAND`，杜绝执行工作区同名恶意脚本；
 * - Windows 裸命令固定按 `[".exe", ".cmd"]` 顺序探测（同目录原生 `.exe` 优先于 `.cmd` 垫片）；
 * - 自定义 `.bat` / `.ps1` 或逃出 `node_modules` 的 `.cmd` 报 `EXTERNAL_UNSUPPORTED_SHIM`。
 */
export function resolveExternalCommand(
  options: ResolveExternalCommandOptions,
): ResolvedExternalCommand {
  const platform = options.platform ?? process.platform;
  const isWin = platform === 'win32';
  const pathApi = isWin ? path.win32 : path.posix;
  const hostEnv = options.hostEnv ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const rawCommand = options.command.trim();

  if (!rawCommand || hasAsciiControlCharacter(rawCommand)) {
    throw new ExternalHarnessError(
      'EXTERNAL_INVALID_COMMAND',
      '外部代理命令不能为空或包含控制字符',
    );
  }
  for (const arg of options.args) {
    if (arg.includes('\0')) {
      throw new ExternalHarnessError('EXTERNAL_INVALID_COMMAND', '外部代理启动参数不能包含空字节');
    }
  }

  const expandedCommand =
    rawCommand === '~'
      ? homeDir
      : rawCommand.startsWith('~/') || rawCommand.startsWith('~\\')
        ? pathApi.join(homeDir, rawCommand.slice(2))
        : rawCommand;

  if (hasWindowsReservedSegment(expandedCommand)) {
    throw new ExternalHarnessError(
      'EXTERNAL_INVALID_COMMAND',
      `外部代理命令命中系统保留设备名：${rawCommand}`,
    );
  }

  const envPath =
    options.envPath ?? (isWin ? (hostEnv.PATH ?? hostEnv.Path ?? '') : (hostEnv.PATH ?? ''));
  const explicitDirs = envPath.split(pathApi.delimiter).filter(Boolean);
  const fallbackDirs = getStandardCliFallbackDirs({ platform, homeDir, hostEnv });
  const allSearchDirs = [...explicitDirs, ...fallbackDirs];

  let matchedPath: string | undefined;
  let usedFallbackDir = false;

  const hasSeparator = expandedCommand.includes('/') || expandedCommand.includes('\\');
  if (hasSeparator) {
    if (!isStrictAbsolutePath(expandedCommand, platform)) {
      throw new ExternalHarnessError(
        'EXTERNAL_INVALID_COMMAND',
        `禁止使用相对路径启动外部代理：'${rawCommand}'（请使用裸命令名或绝对路径）`,
      );
    }
    const ext = pathApi.extname(expandedCommand).toLowerCase();
    if (isWin && !ext) {
      for (const candidateExt of ['.exe', '.cmd']) {
        matchedPath = toPhysicalFileIfExists(expandedCommand + candidateExt);
        if (matchedPath) break;
      }
    } else {
      matchedPath = toPhysicalFileIfExists(expandedCommand);
    }
  } else {
    const explicitExt = pathApi.extname(expandedCommand).toLowerCase();
    const probeExts = isWin ? (explicitExt ? [''] : ['.exe', '.cmd']) : [''];

    for (const dir of explicitDirs) {
      for (const ext of probeExts) {
        const candidate = pathApi.join(dir, expandedCommand + ext);
        if (hasWindowsReservedSegment(candidate)) continue;
        matchedPath = toPhysicalFileIfExists(candidate);
        if (matchedPath) break;
      }
      if (matchedPath) break;
    }

    if (!matchedPath) {
      for (const dir of fallbackDirs) {
        for (const ext of probeExts) {
          const candidate = pathApi.join(dir, expandedCommand + ext);
          if (hasWindowsReservedSegment(candidate)) continue;
          matchedPath = toPhysicalFileIfExists(candidate);
          if (matchedPath) {
            usedFallbackDir = true;
            break;
          }
        }
        if (matchedPath) break;
      }
    }

    // 若用户在 Windows 显式填写了 `foo.bat` / `foo.ps1` 且存在于目录中，给出明确的垫片拒绝码而非未找到。
    if (!matchedPath && isWin && explicitExt && explicitExt !== '.exe' && explicitExt !== '.cmd') {
      throw new ExternalHarnessError(
        'EXTERNAL_UNSUPPORTED_SHIM',
        `不支持启动 '${explicitExt}' 脚本；请使用原生 .exe 或标准 npm/pnpm 命令`,
      );
    }
  }

  if (!matchedPath) {
    throw new ExternalHarnessError(
      'EXTERNAL_COMMAND_NOT_FOUND',
      `未在系统 PATH 或常见安装目录中找到可执行程序 '${rawCommand}'`,
    );
  }

  const finalExt = path.extname(matchedPath).toLowerCase();
  if (isWin) {
    if (finalExt === '.cmd') {
      const unwrapped = unwrapWindowsCmdShim(matchedPath, options.args, allSearchDirs);
      return {
        ...unwrapped,
        usedFallbackDir,
      };
    }
    if (finalExt === '.js' || finalExt === '.mjs' || finalExt === '.cjs') {
      const nodeExe = resolveNodeExecutable({ searchDirs: allSearchDirs, platform });
      return {
        executable: nodeExe,
        args: [matchedPath, ...options.args],
        unwrapKind: 'node-script',
        usedFallbackDir,
        extraPathDirs: [path.dirname(matchedPath), path.dirname(nodeExe)],
      };
    }
    if (finalExt !== '.exe') {
      throw new ExternalHarnessError(
        'EXTERNAL_UNSUPPORTED_SHIM',
        `Windows 下不支持直接以无 Shell 模式启动 '${path.basename(matchedPath)}'（仅支持 .exe 与标准 npm/pnpm .cmd）`,
      );
    }
  } else if (finalExt === '.js' || finalExt === '.mjs' || finalExt === '.cjs') {
    const nodeExe = resolveNodeExecutable({ searchDirs: allSearchDirs, platform });
    return {
      executable: nodeExe,
      args: [matchedPath, ...options.args],
      unwrapKind: 'node-script',
      usedFallbackDir,
      extraPathDirs: [path.dirname(matchedPath), path.dirname(nodeExe)],
    };
  }

  return {
    executable: matchedPath,
    args: [...options.args],
    unwrapKind: 'direct',
    usedFallbackDir,
    extraPathDirs: [path.dirname(matchedPath)],
  };
}

/** 子进程收口结果：区分优雅退出与升级进程树强杀。 */
export interface ExternalProcessCloseResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly forcedKill: boolean;
  readonly stderrTail: string;
}

/** `ExternalProcessSupervisor.spawn` 启动参数。 */
export interface SpawnExternalProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly onClose?: (result: ExternalProcessCloseResult) => void;
}

function getWindowsTaskkillExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows';
  const full = path.join(systemRoot, 'System32', 'taskkill.exe');
  try {
    if (fs.existsSync(full)) return full;
  } catch {
    /* ignore */
  }
  return 'taskkill.exe';
}

function terminateWindowsProcessTreeAsync(pid: number, fallbackKill: () => void): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      resolve();
    };
    try {
      const killer = spawn(getWindowsTaskkillExecutable(), ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
      killer.once('error', () => {
        fallbackKill();
        finish();
      });
      killer.once('close', () => finish());
    } catch {
      fallbackKill();
      finish();
    }
  });
}

/**
 * 外部代理子进程生命周期监管器。
 *
 * 核心不变量：
 * - 监听 `close` 而非 `exit`，保证子进程临终刷出的 stdout/stderr 尾帧全部进管道后再结算；
 * - 持续排空 `stderr` 至 16KiB 脱敏环形尾部，既防大日志写满内核缓冲区死锁，又保留握手失败现场；
 * - 两段式回收：先 `stdin.end()` 给外部 CLI 默认 `1500ms` 清理临时目录与刷盘窗口，超时后升级进程树强杀（Windows `taskkill /T /F`，POSIX `-pgid` `SIGTERM → SIGKILL`）。
 */
export class ExternalProcessSupervisor {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  private readonly child: ChildProcessWithoutNullStreams;
  private stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private closedResult?: ExternalProcessCloseResult;
  private forcedKill = false;
  private readonly closePromise: Promise<ExternalProcessCloseResult>;
  private closingPromise?: Promise<ExternalProcessCloseResult>;

  private constructor(
    child: ChildProcessWithoutNullStreams,
    onClose?: (result: ExternalProcessCloseResult) => void,
  ) {
    this.child = child;
    this.pid = child.pid;
    this.stdin = child.stdin;
    this.stdout = child.stdout;

    // 吸收 stdin EPIPE（子进程秒退时宿主写帧可能竞争管道闭合），避免冒泡为未捕获异常。
    this.stdin.on('error', () => {});

    child.stderr.on('data', (chunk: Buffer) => {
      this.appendStderr(chunk);
    });

    this.closePromise = new Promise<ExternalProcessCloseResult>((resolve) => {
      const finalize = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (this.closedResult) return;
        const result: ExternalProcessCloseResult = {
          code,
          signal,
          forcedKill: this.forcedKill,
          stderrTail: this.getStderrTail(),
        };
        this.closedResult = result;
        onClose?.(result);
        resolve(result);
      };

      child.once('close', (code, signal) => finalize(code, signal));
      child.once('error', (err) => {
        this.appendStderr(Buffer.from(`\n[spawn error] ${err.message}`, 'utf8'));
        finalize(null, null);
      });
    });
  }

  /** 以严格 `shell: false, windowsHide: true` 启动受监管的外部代理子进程。 */
  static spawn(options: SpawnExternalProcessOptions): ExternalProcessSupervisor {
    const nativeCwd = (() => {
      try {
        return fs.realpathSync.native(options.cwd);
      } catch {
        return path.resolve(options.cwd);
      }
    })();

    const child = spawn(options.executable, [...options.args], {
      cwd: nativeCwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });

    return new ExternalProcessSupervisor(child, options.onClose);
  }

  /** 子进程是否已完成退出与标准流闭合。 */
  get isClosed(): boolean {
    return this.closedResult !== undefined;
  }

  /** 等待子进程自然或被动闭合的 Promise。 */
  waitForClose(): Promise<ExternalProcessCloseResult> {
    return this.closePromise;
  }

  /** 读取经 ANSI 净化与常见凭据脱敏后的 `stderr` 尾部文本。 */
  getStderrTail(): string {
    if (this.stderrBytes === 0) return '';
    const raw = Buffer.concat(this.stderrChunks, this.stderrBytes).toString('utf8');
    return redactCommonSecrets(sanitizeUntrustedOutput(raw)).trim();
  }

  /**
   * 幂等执行两段式优雅关闭与进程树强杀兜底。
   *
   * @param graceMs `stdin.end()` 后等待优雅退出的毫秒数，默认 `1500ms`。
   */
  close(graceMs = 1_500): Promise<ExternalProcessCloseResult> {
    if (this.closedResult) return Promise.resolve(this.closedResult);
    if (this.closingPromise) return this.closingPromise;

    this.closingPromise = this.performClose(graceMs);
    return this.closingPromise;
  }

  private async performClose(graceMs: number): Promise<ExternalProcessCloseResult> {
    try {
      this.child.stdin.end();
    } catch {
      /* ignore closed stdin */
    }

    const graceful = await this.raceClose(graceMs);
    if (graceful) return graceful;

    this.forcedKill = true;
    const pid = this.child.pid;

    if (pid && pid > 0) {
      if (process.platform === 'win32') {
        await terminateWindowsProcessTreeAsync(pid, () => {
          try {
            this.child.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        });
      } else {
        this.signalPosixGroup(pid, 'SIGTERM');
        const afterTerm = await this.raceClose(500);
        if (afterTerm) return afterTerm;
        this.signalPosixGroup(pid, 'SIGKILL');
      }
    } else {
      try {
        this.child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }

    const forced = await this.raceClose(1_500);
    if (forced) return forced;

    // 若孙进程继承了未关闭的管道句柄导致 close 事件迟滞，主动销毁宿主持有的流引用保底收口。
    this.destroyStreams();
    return this.closePromise;
  }

  private signalPosixGroup(pid: number, sig: NodeJS.Signals): void {
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        this.child.kill(sig);
      } catch {
        /* ignore */
      }
    }
  }

  private destroyStreams(): void {
    try {
      this.child.stdout.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.child.stderr.destroy();
    } catch {
      /* ignore */
    }
    try {
      this.child.stdin.destroy();
    } catch {
      /* ignore */
    }
  }

  private raceClose(timeoutMs: number): Promise<ExternalProcessCloseResult | undefined> {
    if (this.closedResult) return Promise.resolve(this.closedResult);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(undefined), Math.max(0, timeoutMs));
      timer.unref?.();
      void this.closePromise.then((res) => {
        clearTimeout(timer);
        resolve(res);
      });
    });
  }

  private appendStderr(chunk: Buffer): void {
    if (chunk.length === 0) return;
    if (chunk.length >= MAX_STDERR_TAIL_BYTES) {
      this.stderrChunks = [chunk.subarray(chunk.length - MAX_STDERR_TAIL_BYTES)];
      this.stderrBytes = MAX_STDERR_TAIL_BYTES;
      return;
    }
    this.stderrChunks.push(Buffer.from(chunk));
    this.stderrBytes += chunk.length;
    while (this.stderrBytes > MAX_STDERR_TAIL_BYTES && this.stderrChunks.length > 0) {
      const head = this.stderrChunks[0]!;
      const overflow = this.stderrBytes - MAX_STDERR_TAIL_BYTES;
      if (head.length <= overflow) {
        this.stderrChunks.shift();
        this.stderrBytes -= head.length;
      } else {
        this.stderrChunks[0] = head.subarray(overflow);
        this.stderrBytes -= overflow;
      }
    }
  }
}
