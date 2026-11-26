import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 受支持的解释器家族；wsl 是 Windows 上的 WSL bash launcher，路径与输出语义与 native bash 不同。 */
export type ShellKind = 'bash' | 'wsl' | 'pwsh' | 'powershell';
/** auto / 具名解释器，或用户显式提供的解释器可执行文件全路径。 */
export type ShellPreference = 'auto' | ShellKind | (string & {});

/** 探测成功后固定的解释器身份；executableDigest 参与命令审批指纹，解释器被替换即失配。 */
export interface ShellEnvironment {
  kind: ShellKind;
  executable: string;
  executableDigest: string;
  cwd: string;
}

export interface ShellDetectOptions {
  /** 'auto'、具名解释器，或解释器可执行文件全路径；含路径分隔符或 .exe 后缀按显式路径处理。 */
  preference?: ShellPreference;
  /** 探测与后续执行的基准目录；探测前先取 realpath，符号链接会被展开。 */
  cwd: string;
  /** 以下两项供测试注入平台与 PATH；缺省取当前进程的值。 */
  platform?: NodeJS.Platform;
  pathEnv?: string;
}

interface BashProbe {
  ok: boolean;
  kind?: ShellKind;
}

/**
 * 进程内探针结果缓存：以解释器物理路径、二进制体积/mtime 与工作目录盘符根为复合键。
 *
 * 设计取舍：
 * - Windows 冷启动一次 PowerShell 或 WSL 探针耗费 1.5s~6s，每次新建会话同步重探会直接卡住首轮发送；
 * - 命中缓存前仍先校验 `cwd` 真实存在且重读可执行文件 `statSync`，二进制被替换或删除时自动失效重探，
 *   不削弱审批指纹的 TOCTOU 边界。
 */
const MAX_PROBE_CACHE = 64;
const bashProbeCache = new Map<string, BashProbe>();
const pwshProbeCache = new Map<string, boolean>();

function setBoundedCache<V>(cache: Map<string, V>, key: string, value: V): V {
  if (cache.size >= MAX_PROBE_CACHE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

function probeCacheKey(
  tag: string,
  platform: NodeJS.Platform,
  executable: string,
  stat: fs.Stats,
  cwd: string,
): string {
  const driveRoot = path.parse(cwd).root.toLowerCase();
  return `${tag}\0${platform}\0${platform === 'win32' ? executable.toLowerCase() : executable}\0${stat.size}\0${stat.mtimeMs}\0${driveRoot}`;
}

/**
 * 识别 Windows 系统目录下的遗留 WSL1 `bash.exe` 转发器：
 * 它绝不可能是原生 MSYS/Git Bash/Cygwin，在探测 native bash 阶段直接跳过可避免无意义的数秒 WSL 冷启动阻塞。
 */
function isLegacyWindowsWslBashShim(executable: string, platform: NodeJS.Platform): boolean {
  if (platform !== 'win32') return false;
  const normalized = executable.replaceAll('/', '\\').toLowerCase();
  return (
    normalized.endsWith('\\system32\\bash.exe') || normalized.endsWith('\\sysnative\\bash.exe')
  );
}

function isWslCliExecutable(executable: string): boolean {
  const base = path.basename(executable).toLowerCase();
  return base === 'wsl' || base === 'wsl.exe';
}

/**
 * 按 uname 输出分类 bash 家族：Git Bash/MSYS2/Cygwin 归 native bash，
 * Windows 上报告 Linux 的是 WSL launcher（独立 kind，路径语义不同）。
 */
export function classifyBashOutput(
  unameOutput: string,
  platform: NodeJS.Platform,
): ShellKind | undefined {
  const uname = unameOutput.trim().split(/\r?\n/)[0]?.toLowerCase() ?? '';
  if (platform === 'win32') {
    if (uname.startsWith('mingw') || uname.startsWith('msys') || uname.startsWith('cygwin')) {
      return 'bash';
    }
    return uname === 'linux' ? 'wsl' : undefined;
  }
  return uname ? 'bash' : undefined;
}

/** 返回 PATH 上所有同名可执行文件（按真实路径去重），不写死任何安装目录。 */
function findExecutables(name: string, pathEnv: string, platform: NodeJS.Platform): string[] {
  const extension = platform === 'win32' && !name.toLowerCase().endsWith('.exe') ? '.exe' : '';
  const found: string[] = [];
  const seen = new Set<string>();
  for (const directory of pathEnv.split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, name + extension);
    try {
      if (!fs.statSync(candidate).isFile()) continue;
      const real = fs.realpathSync(candidate);
      const key = platform === 'win32' ? real.toLowerCase() : real;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push(real);
    } catch {
      /* Try next PATH directory. */
    }
  }
  return found;
}

function probeBash(executable: string, cwd: string, platform: NodeJS.Platform): BashProbe {
  const stat = fs.statSync(executable);
  const wslCli = isWslCliExecutable(executable);
  const key = probeCacheKey(wslCli ? 'wsl' : 'bash', platform, executable, stat, cwd);
  const cached = bashProbeCache.get(key);
  if (cached !== undefined) return cached;

  const args = wslCli
    ? ['--exec', 'bash', '--noprofile', '--norc', '-c', 'uname -s; pwd']
    : ['--noprofile', '--norc', '-c', 'uname -s; pwd'];
  const result = spawnSync(executable, args, {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
    ...(wslCli ? { env: { ...process.env, WSL_UTF8: '1' } } : {}),
  });
  const outcome: BashProbe =
    result.status !== 0 || !result.stdout?.trim()
      ? { ok: false }
      : { ok: true, kind: classifyBashOutput(result.stdout, platform) };
  return setBoundedCache(bashProbeCache, key, outcome);
}

function probePowerShell(executable: string, cwd: string, platform: NodeJS.Platform): boolean {
  const stat = fs.statSync(executable);
  const key = probeCacheKey('pwsh', platform, executable, stat, cwd);
  const cached = pwshProbeCache.get(key);
  if (cached !== undefined) return cached;

  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', '$PWD.Path'], {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  const ok = result.status === 0 && Boolean(result.stdout?.trim());
  return setBoundedCache(pwshProbeCache, key, ok);
}

function buildEnvironment(executable: string, kind: ShellKind, cwd: string): ShellEnvironment {
  const stat = fs.statSync(executable);
  return {
    kind,
    executable,
    cwd,
    executableDigest: createHash('sha256')
      .update(JSON.stringify([executable, stat.size, stat.mtimeMs]))
      .digest('hex'),
  };
}

function candidatesFor(kind: ShellKind, platform: NodeJS.Platform, pathEnv: string): string[] {
  if (kind === 'bash') {
    return findExecutables('bash', pathEnv, platform).filter(
      (candidate) => !isLegacyWindowsWslBashShim(candidate, platform),
    );
  }
  if (kind === 'wsl') {
    if (platform !== 'win32') return [];
    // 优先使用现代 wsl.exe（支持 --exec 直接 execve，避免旧版 System32\bash.exe 外层二次展开吞掉 $var）。
    const wslBins = findExecutables('wsl', pathEnv, platform);
    const bashBins = findExecutables('bash', pathEnv, platform);
    return [...wslBins, ...bashBins];
  }
  if (platform !== 'win32' && kind === 'powershell') return [];
  return findExecutables(kind, pathEnv, platform);
}

/** 依次探测 PATH 候选；bash 家族以运行时 uname 分类，结果必须匹配请求的 kind。 */
function tryKind(
  kind: ShellKind,
  platform: NodeJS.Platform,
  pathEnv: string,
  cwd: string,
): ShellEnvironment | undefined {
  for (const executable of candidatesFor(kind, platform, pathEnv)) {
    try {
      if (kind === 'bash' || kind === 'wsl') {
        const probe = probeBash(executable, cwd, platform);
        if (probe.ok && probe.kind === kind) return buildEnvironment(executable, kind, cwd);
      } else if (probePowerShell(executable, cwd, platform)) {
        return buildEnvironment(executable, kind, cwd);
      }
    } catch {
      /* Try next candidate. */
    }
  }
  return undefined;
}

/** 用户显式提供的解释器全路径：按文件名选族，bash/wsl 再以 uname 精确分类。 */
function detectExplicitPath(preference: string, cwd: string, platform: NodeJS.Platform) {
  const executable = fs.realpathSync(preference);
  if (!fs.statSync(executable).isFile()) {
    throw new Error(`Requested interpreter path is not a file: ${preference}`);
  }
  const base = path.basename(executable).toLowerCase();
  if (/^pwsh(\.exe)?$/.test(base) || /^powershell(_ise)?(\.exe)?$/.test(base)) {
    const kind: ShellKind = base.startsWith('pwsh') ? 'pwsh' : 'powershell';
    if (platform !== 'win32' && kind === 'powershell') {
      throw new Error(`Requested ${kind} interpreter is unavailable on this platform`);
    }
    if (!probePowerShell(executable, cwd, platform)) {
      throw new Error(
        `Requested ${kind} interpreter is unavailable or incompatible with this working directory`,
      );
    }
    return buildEnvironment(executable, kind, cwd);
  }
  const probe = probeBash(executable, cwd, platform);
  if (!probe.ok || !probe.kind) {
    throw new Error(
      `Requested interpreter is unavailable or incompatible with this working directory: ${preference}`,
    );
  }
  return buildEnvironment(executable, probe.kind, cwd);
}

/**
 * 发现并固定实际解释器：只用 PATH 与用户显式给出的路径，不写死任何安装目录。
 * auto 在 Windows 上按 native Bash → pwsh → powershell → WSL 依次兜底：
 * 原生 Windows 进程共享宿主网络代理与 NTFS 文件系统性能，避免默认退化进 WSL 触发 NAT 代理告警与 `/mnt` 跨盘超时。
 */
export function detectShell(options: ShellDetectOptions): ShellEnvironment {
  const platform = options.platform ?? os.platform();
  const cwd = fs.realpathSync(options.cwd);
  if (!fs.statSync(cwd).isDirectory()) {
    throw new Error(`Shell working directory is not a directory: ${options.cwd}`);
  }
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const preference = options.preference ?? 'auto';
  if (/[\\/]/.test(preference) || preference.toLowerCase().endsWith('.exe')) {
    return detectExplicitPath(preference, cwd, platform);
  }
  const kinds: ShellKind[] =
    preference === 'auto'
      ? platform === 'win32'
        ? ['bash', 'pwsh', 'powershell', 'wsl']
        : ['bash']
      : [preference as ShellKind];
  for (const kind of kinds) {
    const environment = tryKind(kind, platform, pathEnv, cwd);
    if (environment) return environment;
  }
  throw new Error(
    preference === 'auto'
      ? 'No usable Bash or PowerShell interpreter found'
      : `Requested ${preference} interpreter is unavailable or incompatible with this working directory`,
  );
}
