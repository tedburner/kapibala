import path from 'node:path';
import { ExternalHarnessError } from './types.js';

/** Windows 子进程运行与本地登录态定位所需的最小基础环境键名集合。 */
const WIN32_BASE_ENV_KEYS = [
  'PATH',
  'SystemRoot',
  'SystemDrive',
  'TEMP',
  'TMP',
  'COMSPEC',
  'PATHEXT',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'PROGRAMDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
] as const;

/** POSIX 子进程运行、XDG 配置读取与终端编码所需的最小基础环境键名集合。 */
const POSIX_BASE_ENV_KEYS = [
  'PATH',
  'HOME',
  'TEMP',
  'TMPDIR',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LC_ALL',
  'TERM',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME',
] as const;

/** 网络代理、企业自签证书与非交互 SSH 鉴权白名单变量（绝不含 NODE_OPTIONS 或模型密钥）。 */
const NETWORK_AND_TLS_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SSH_AUTH_SOCK',
  'GIT_SSH_COMMAND',
] as const;

/** 任何路径（含静态 `env` 与 `envFrom`）均禁止向子进程注入的宿主污染变量。 */
export const FORBIDDEN_EXTERNAL_ENV_KEYS = new Set([
  'NODE_OPTIONS',
  'ELECTRON_RUN_AS_NODE',
  'ELECTRON_NO_ATTACH_CONSOLE',
]);

/** 环境变量名合法标识符正则（POSIX / Windows 通用安全子集）。 */
export const ENV_VAR_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 检测字符串是否包含 ASCII C0 控制字符或 DEL（0x00–0x1F、0x7F）。 */
export function hasAsciiControlCharacter(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** `buildExternalLaunchEnv` 入参。 */
export interface BuildExternalLaunchEnvOptions {
  /** 宿主环境变量表；缺省读取 `process.env`。 */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>;
  /** 代理定义中的非敏感静态环境变量。 */
  readonly env?: Readonly<Record<string, string>>;
  /** 允许从宿主环境按名透传的变量名白名单（如 `DEEPSEEK_API_KEY`）。 */
  readonly envFrom?: readonly string[];
  /** 解析到 GUI 兜底目录或本地 node 目录时追加到子进程 `PATH` 尾部的目录列表。 */
  readonly extraPathDirs?: readonly string[];
  /** 目标运行平台；默认 `process.platform`，支持单测跨平台注入。 */
  readonly platform?: NodeJS.Platform;
}

/** 清洗后的子进程环境及 `envFrom` 命中明细（供连接失败时提示缺失变量名，不含任何变量值）。 */
export interface ExternalLaunchEnvResult {
  readonly env: Record<string, string>;
  readonly forwardedVars: readonly string[];
  readonly missingEnvFromVars: readonly string[];
}

/**
 * 构造外部代理子进程的隔离启动环境。
 *
 * 安全与兼容边界：
 * - 严禁展开 `{ ...process.env }`：彻底剥离宿主注入的 `NODE_OPTIONS`、`ELECTRON_RUN_AS_NODE` 以及未授权厂商 API Key；
 * - Windows 宿主环境键名大小写不敏感（如 `Path`），统一归一为标准键名写出，避免同一对象出现双份 `Path`/`PATH`；
 * - `envFrom` 在宿主未设置对应变量时记录到 `missingEnvFromVars` 而不抛错，保证用户已通过 `claude auth login` 等自有登录态完成鉴权时仍可零环境变量启动。
 */
export function buildExternalLaunchEnv(
  options: BuildExternalLaunchEnvOptions = {},
): ExternalLaunchEnvResult {
  const platform = options.platform ?? process.platform;
  const hostEnv = options.hostEnv ?? process.env;
  const isWin = platform === 'win32';
  const pathDelimiter = isWin ? path.win32.delimiter : path.posix.delimiter;

  const caseInsensitiveLookup = new Map<string, string>();
  if (isWin) {
    for (const [key, value] of Object.entries(hostEnv)) {
      if (value !== undefined) {
        caseInsensitiveLookup.set(key.toUpperCase(), value);
      }
    }
  }

  const readHostVar = (name: string): string | undefined =>
    isWin ? caseInsensitiveLookup.get(name.toUpperCase()) : hostEnv[name];

  const env: Record<string, string> = {
    // 禁用子进程内 git 交互式密码弹窗，避免无终端管道下无限挂起。
    GIT_TERMINAL_PROMPT: '0',
  };

  const baseKeys = isWin ? WIN32_BASE_ENV_KEYS : POSIX_BASE_ENV_KEYS;
  for (const key of [...baseKeys, ...NETWORK_AND_TLS_ENV_KEYS]) {
    const val = readHostVar(key);
    if (val !== undefined) {
      env[key] = val;
    }
  }

  if (options.extraPathDirs && options.extraPathDirs.length > 0) {
    const existing = (env.PATH ?? '').split(pathDelimiter).filter(Boolean);
    const seen = new Set(existing.map((dir) => (isWin ? dir.toLowerCase() : dir)));
    for (const extra of options.extraPathDirs) {
      const trimmed = extra.trim();
      if (!trimmed) continue;
      const norm = isWin ? trimmed.toLowerCase() : trimmed;
      if (!seen.has(norm)) {
        seen.add(norm);
        existing.push(trimmed);
      }
    }
    env.PATH = existing.join(pathDelimiter);
  }

  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (!ENV_VAR_NAME_PATTERN.test(key) || FORBIDDEN_EXTERNAL_ENV_KEYS.has(key.toUpperCase())) {
        throw new ExternalHarnessError(
          'EXTERNAL_CONFIG_INVALID',
          `外部代理环境变量名非法或受禁：${key}`,
        );
      }
      if (hasAsciiControlCharacter(value)) {
        throw new ExternalHarnessError(
          'EXTERNAL_CONFIG_INVALID',
          `外部代理环境变量 ${key} 包含非法控制字符`,
        );
      }
      env[key] = value;
    }
  }

  const forwardedVars: string[] = [];
  const missingEnvFromVars: string[] = [];
  if (options.envFrom) {
    for (const rawName of options.envFrom) {
      const name = rawName.trim();
      if (!name) continue;
      if (!ENV_VAR_NAME_PATTERN.test(name) || FORBIDDEN_EXTERNAL_ENV_KEYS.has(name.toUpperCase())) {
        throw new ExternalHarnessError(
          'EXTERNAL_CONFIG_INVALID',
          `envFrom 包含非法或受禁的变量名：${name}`,
        );
      }
      const value = readHostVar(name);
      if (value !== undefined && value !== '') {
        env[name] = value;
        forwardedVars.push(name);
      } else {
        missingEnvFromVars.push(name);
      }
    }
  }

  return {
    env,
    forwardedVars,
    missingEnvFromVars,
  };
}
