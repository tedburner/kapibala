/**
 * @fileoverview MCP 环境变量插值、基础变量白名单继承与项目敏感凭据外发告警 (Credential Alert)
 *
 * 约束、边界与为什么：
 * 1. 严格变量插值：仅支持 `${NAME}` 形式；严禁执行命令替换（`$(...)`、反引号、`!...`）。
 * 2. 缺变量严格拒绝：配置引用的环境变量若在宿主中缺失或为空，必须报错拒绝，严禁使用空字符串兜底继续执行。
 * 3. 环境变量最小化继承：Stdio 进程严禁继承整份 `process.env`，仅继承平台最小基础白名单与配置显式列出的键，
 *    防止无关宿主密钥（如云凭据、本地开发数据库密码等）向外部 MCP 服务静默泄露。
 * 4. 项目级高危凭据外发预警（Credential Alert）：
 *    项目配置若插值了敏感变量（如 `*_KEY`, `*_TOKEN`, `OPENAI_*` 等），必须标记预警并列出变量名，
 *    供启动审批阶段向用户显式告警，彻底防御恶意仓库钓鱼窃取宿主核心 API 密钥。
 */

/**
 * 平台运行必需的最小基础环境变量白名单集合。
 */
export const PLATFORM_BASE_ENV_WHITELIST: readonly string[] =
  process.platform === 'win32'
    ? [
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
      ]
    : ['PATH', 'HOME', 'TEMP', 'TMPDIR', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'TERM'];

/** 敏感环境变量命名模式 */
const SENSITIVE_VAR_PATTERNS: RegExp[] = [
  /_(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL)$/i,
  /^(?:OPENAI|ANTHROPIC|GEMINI|DEEPSEEK|GROQ|MISTRAL|AWS|GITHUB|GH|GITLAB)_[A-Z0-9_]+$/i,
  /^(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|PRIVATE_KEY)$/i,
];

/**
 * 判断环境变量名是否属于敏感密钥/凭据。
 */
export function isSensitiveEnvVarName(varName: string): boolean {
  if (!varName || typeof varName !== 'string') return false;
  return SENSITIVE_VAR_PATTERNS.some((pattern) => pattern.test(varName));
}

/**
 * 环境变量插值解析结果。
 */
export interface InterpolationResult {
  /** 插值后的最终字符串；若存在缺失变量则为 undefined。 */
  value?: string;
  /** 引用的所有环境变量名列表。 */
  referencedVars: string[];
  /** 宿主环境中未提供或为空的变量名列表。 */
  missingVars: string[];
}

/**
 * 对配置字符串进行 `${NAME}` 环境变量插值。
 *
 * 保证：
 * - 仅匹配 `${[A-Za-z_][A-Za-z0-9_]*}` 模式；
 * - 不执行反引号、`$()` 等任何外部命令；
 * - 若引用的变量在提供环境中缺失或为空，记录在 `missingVars` 中。
 */
export function interpolateEnvString(
  template: string,
  hostEnv: Record<string, string | undefined> = process.env,
): InterpolationResult {
  const referencedVars: string[] = [];
  const missingVars: string[] = [];

  const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  let hasMissing = false;

  const value = template.replace(VAR_PATTERN, (_, varName: string) => {
    referencedVars.push(varName);
    const val = hostEnv[varName];
    if (val === undefined || val === '') {
      missingVars.push(varName);
      hasMissing = true;
      return '';
    }
    return val;
  });

  return {
    value: hasMissing ? undefined : value,
    referencedVars: Array.from(new Set(referencedVars)),
    missingVars: Array.from(new Set(missingVars)),
  };
}

/**
 * 敏感凭据告警检测结果。
 */
export interface CredentialAlertResult {
  /** 是否触发高危凭据告警。 */
  hasAlert: boolean;
  /** 引用的敏感变量名列表（去重）。 */
  sensitiveVars: string[];
}

/**
 * 从字典对象的字符串值中提取所有引用的 ${VAR} 变量名。
 */
export function extractReferencedEnvVars(map: Record<string, string>): string[] {
  const vars: string[] = [];
  const VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
  for (const str of Object.values(map)) {
    if (typeof str !== 'string') continue;
    for (const match of str.matchAll(VAR_PATTERN)) {
      vars.push(match[1]);
    }
  }
  return Array.from(new Set(vars));
}

/**
 * 检测来自项目配置的字符串/键值对集合是否引言了全局敏感环境变量。
 */
export function detectCredentialAlerts(
  referencedVars: string[],
  source: 'global' | 'project',
): CredentialAlertResult {
  if (source !== 'project') {
    return { hasAlert: false, sensitiveVars: [] };
  }
  const sensitiveVars = referencedVars.filter(isSensitiveEnvVarName);
  return {
    hasAlert: sensitiveVars.length > 0,
    sensitiveVars: Array.from(new Set(sensitiveVars)),
  };
}

/**
 * Stdio 进程环境变量装配选项。
 */
export interface BuildStdioEnvOptions {
  /** 配置文件中显式配置的 env 键值对字典。 */
  configuredEnv?: Record<string, string>;
  /** 宿主系统环境变量；默认读取 process.env。 */
  hostEnv?: Record<string, string | undefined>;
  /** 配置来源（'global' | 'project'）。 */
  source: 'global' | 'project';
}

/**
 * Stdio 进程环境变量装配结果。
 */
export interface BuildStdioEnvResult {
  /** 最终传递给子进程的纯净环境变量字典。 */
  env?: Record<string, string>;
  /** 缺失的环境变量列表。 */
  missingVars: string[];
  /** 凭据告警检测结果。 */
  credentialAlert: CredentialAlertResult;
  /** 是否存在阻断错误（如缺少引用的变量）。 */
  error?: string;
}

/**
 * 为 Stdio 服务子进程装配安全隔离的环境变量。
 *
 * 保证：
 * - 仅继承平台必需的基础白名单变量；
 * - 显式配置的键经过 `${NAME}` 插值后覆盖/注入；
 * - 缺失变量立即阻断并报告 `missingVars`；
 * - 检测项目配置引用敏感变量并形成 `credentialAlert`。
 */
export function buildStdioProcessEnv(options: BuildStdioEnvOptions): BuildStdioEnvResult {
  const hostEnv = options.hostEnv ?? process.env;
  const configuredEnv = options.configuredEnv ?? {};
  const finalEnv: Record<string, string> = {};
  const allReferencedVars: string[] = [];
  const allMissingVars: string[] = [];

  // 1. 注入平台最小基础白名单（不区分大小写查找以兼容 Windows）
  const whitelistLookup = new Map<string, string>();
  for (const [k, v] of Object.entries(hostEnv)) {
    if (v !== undefined) {
      whitelistLookup.set(k.toUpperCase(), v);
    }
  }

  for (const key of PLATFORM_BASE_ENV_WHITELIST) {
    const val = whitelistLookup.get(key.toUpperCase());
    if (val !== undefined) {
      finalEnv[key] = val;
    }
  }

  // 2. 解析并注入显式配置的环境变量
  for (const [key, rawVal] of Object.entries(configuredEnv)) {
    const interpolation = interpolateEnvString(rawVal, hostEnv);
    allReferencedVars.push(...interpolation.referencedVars);
    if (interpolation.missingVars.length > 0) {
      allMissingVars.push(...interpolation.missingVars);
    } else if (interpolation.value !== undefined) {
      finalEnv[key] = interpolation.value;
    }
  }

  const credentialAlert = detectCredentialAlerts(allReferencedVars, options.source);

  if (allMissingVars.length > 0) {
    const uniqueMissing = Array.from(new Set(allMissingVars));
    return {
      missingVars: uniqueMissing,
      credentialAlert,
      error: `Missing required environment variables referenced in configuration: ${uniqueMissing.join(', ')}`,
    };
  }

  return {
    env: finalEnv,
    missingVars: [],
    credentialAlert,
  };
}

/**
 * 解析并插值 HTTP 请求头中的环境变量凭据。
 */
export function resolveHttpHeaders(
  rawHeaders: Record<string, string> | undefined,
  source: 'global' | 'project',
  hostEnv: Record<string, string | undefined> = process.env,
): {
  headers?: Record<string, string>;
  missingVars: string[];
  credentialAlert: CredentialAlertResult;
  error?: string;
} {
  if (!rawHeaders) {
    return {
      headers: undefined,
      missingVars: [],
      credentialAlert: { hasAlert: false, sensitiveVars: [] },
    };
  }

  const headers: Record<string, string> = {};
  const allReferencedVars: string[] = [];
  const allMissingVars: string[] = [];

  for (const [k, v] of Object.entries(rawHeaders)) {
    const interpolation = interpolateEnvString(v, hostEnv);
    allReferencedVars.push(...interpolation.referencedVars);
    if (interpolation.missingVars.length > 0) {
      allMissingVars.push(...interpolation.missingVars);
    } else if (interpolation.value !== undefined) {
      headers[k] = interpolation.value;
    }
  }

  const credentialAlert = detectCredentialAlerts(allReferencedVars, source);

  if (allMissingVars.length > 0) {
    const uniqueMissing = Array.from(new Set(allMissingVars));
    return {
      missingVars: uniqueMissing,
      credentialAlert,
      error: `Missing required environment variables referenced in HTTP headers: ${uniqueMissing.join(', ')}`,
    };
  }

  return {
    headers,
    missingVars: [],
    credentialAlert,
  };
}
