import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export type ShellKind = 'bash' | 'wsl' | 'pwsh' | 'powershell';
/** auto / 具名解释器，或用户显式提供的解释器可执行文件全路径。 */
export type ShellPreference = 'auto' | ShellKind | (string & {});

export interface ShellEnvironment {
  kind: ShellKind;
  executable: string;
  executableDigest: string;
  cwd: string;
}

export interface ShellDetectOptions {
  preference?: ShellPreference;
  cwd: string;
  platform?: NodeJS.Platform;
  pathEnv?: string;
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

interface BashProbe {
  ok: boolean;
  kind?: ShellKind;
}

function probeBash(executable: string, cwd: string, platform: NodeJS.Platform): BashProbe {
  const result = spawnSync(executable, ['--noprofile', '--norc', '-c', 'uname -s; pwd'], {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  if (result.status !== 0 || !result.stdout?.trim()) return { ok: false };
  return { ok: true, kind: classifyBashOutput(result.stdout, platform) };
}

function probePowerShell(executable: string, cwd: string): boolean {
  const result = spawnSync(executable, ['-NoProfile', '-NonInteractive', '-Command', '$PWD.Path'], {
    cwd,
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });
  return result.status === 0 && Boolean(result.stdout?.trim());
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
  if (kind === 'bash' || kind === 'wsl') {
    return findExecutables('bash', pathEnv, platform);
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
      } else if (probePowerShell(executable, cwd)) {
        return buildEnvironment(executable, kind, cwd);
      }
    } catch {
      /* Try next candidate. */
    }
  }
  return undefined;
}

/** 用户显式提供的解释器全路径：按文件名选族，bash 再以 uname 精确分类。 */
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
    if (!probePowerShell(executable, cwd)) {
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
 * auto 在 Windows 上按 native Bash → WSL → pwsh → powershell 依次兜底，
 * bash 家族用运行时 uname 探针区分 Git Bash 与 WSL launcher。
 */
export function detectShell(options: ShellDetectOptions): ShellEnvironment {
  const platform = options.platform ?? os.platform();
  const cwd = fs.realpathSync(options.cwd);
  const pathEnv = options.pathEnv ?? process.env.PATH ?? '';
  const preference = options.preference ?? 'auto';
  if (/[\\/]/.test(preference) || preference.toLowerCase().endsWith('.exe')) {
    return detectExplicitPath(preference, cwd, platform);
  }
  const kinds: ShellKind[] =
    preference === 'auto'
      ? platform === 'win32'
        ? ['bash', 'wsl', 'pwsh', 'powershell']
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
