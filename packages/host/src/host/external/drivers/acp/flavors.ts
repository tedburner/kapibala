import fs from 'node:fs';
import path from 'node:path';

/** `session/new` 之后按方言同步初始配置项的上下文。 */
export interface AcpInitialConfigContext {
  readonly workspaceRoot: string;
  readonly homeDir: string;
  readonly env: Readonly<Record<string, string>>;
  readonly platform: NodeJS.Platform;
}

/** 单条待经由标准 ACP `session/set_config_option` 同步的初始配置期望。 */
export interface AcpInitialConfigOverride {
  readonly category: 'model' | 'thought_level';
  readonly value: string;
}

/**
 * 单个 ACP 外部代理方言（Flavor）的极薄声明式钩子。
 *
 * 设计取舍（对齐 Orca `AcpDialect` + T3 Code `makeAcpAdapterV2`）：
 * 状态机、行通道与消息投影全量共享，方言层仅承载认证方法偏好、误配诊断、登录/安装提示、
 * 初始配置对齐（如 OpenCode TUI 模型状态同步）与持久身份背书。
 */
export interface AcpHarnessFlavor {
  readonly id: string;
  readonly displayName: string;
  /** 是否已通过持久会话身份四项门禁实测背书；未背书的通用自定义命令默认 `false`（仅保留只读展示快照）。 */
  readonly verifiedResumable: boolean;
  /** 当 `initialize` 返回 `authMethods` 时优先自动调用 `authenticate` 的方法 ID 列表。 */
  readonly preferredAuthMethodIds?: readonly string[];
  readonly loginHint?: string;
  readonly installHint?: string;
  /** 识别用户漏传子命令（如裸填 `opencode` 漏 `acp`）时的针对性中文修复提示。 */
  readonly misconfiguredCommandHint?: (
    command: string,
    args: readonly string[],
  ) => string | undefined;
  /**
   * 仅在新建会话（`session/new`）完成后触发的可选配置同步钩子。
   * 驱动会逐项核验期望值确实存在于对端 `configOptions` 候选中，再调用 `session/set_config_option` 生效。
   */
  readonly resolveInitialConfigOverrides?: (
    context: AcpInitialConfigContext,
  ) => readonly AcpInitialConfigOverride[] | undefined;
}

/** 解析 JSON / JSONC 文本（跳过字符串字面量内的 `//` 与 `/*`，并容忍尾随逗号）；失败返回 `undefined`。 */
function parseJsoncLoose(raw: string): Record<string, unknown> | undefined {
  let stripped = '';
  let inString = false;
  let escaped = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!;
    const next = raw[i + 1];
    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        stripped += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      stripped += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      stripped += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      i += 1;
      continue;
    }
    stripped += ch;
  }

  const withoutTrailingCommas = stripped.replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed: unknown = JSON.parse(withoutTrailingCommas);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function hasExplicitOpenCodeConfigModel(context: AcpInitialConfigContext): boolean {
  if (context.env.OPENCODE_CONFIG_CONTENT) {
    const inlineCfg = parseJsoncLoose(context.env.OPENCODE_CONFIG_CONTENT);
    if (typeof inlineCfg?.model === 'string' && inlineCfg.model.trim()) {
      return true;
    }
  }
  const xdgConfigHome = context.env.XDG_CONFIG_HOME?.trim();
  const globalConfigDir = xdgConfigHome
    ? path.join(xdgConfigHome, 'opencode')
    : path.join(context.homeDir, '.config', 'opencode');
  const candidates = [
    context.env.OPENCODE_CONFIG?.trim() || undefined,
    path.join(context.workspaceRoot, 'opencode.json'),
    path.join(context.workspaceRoot, 'opencode.jsonc'),
    path.join(context.workspaceRoot, '.opencode', 'opencode.json'),
    path.join(context.workspaceRoot, '.opencode', 'opencode.jsonc'),
    path.join(globalConfigDir, 'opencode.json'),
    path.join(globalConfigDir, 'opencode.jsonc'),
  ].filter((p): p is string => Boolean(p));

  for (const filePath of candidates) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const parsed = parseJsoncLoose(content);
      if (typeof parsed?.model === 'string' && parsed.model.trim()) {
        return true;
      }
    } catch {
      /* 配置文件不存在或不可读时继续检查下一候选 */
    }
  }
  return false;
}

/**
 * 读取 OpenCode TUI 最近选用的模型与推理档位（`model.json`）。
 *
 * 背景与边界：
 * - OpenCode TUI 切换模型时只写 `$XDG_STATE_HOME/opencode/model.json`（默认 `~/.local/state/opencode/model.json`），
 *   不写 `opencode.json`；而 `opencode acp` 的 `session/new` 只读 `opencode.json` 的 `model` 字段，缺省时退回到任意默认模型（如 `opencode/big-pickle`）；
 * - 若工作区或全局 `opencode.json(c)` / `OPENCODE_CONFIG_CONTENT` 已显式指定 `model`，此处返回 `undefined`，完全尊重配置文件优先；
 * - 文件缺失、损坏或无有效 `recent[0]` 时静默返回 `undefined`，不阻断会话启动。
 */
export function resolveOpenCodePreferredConfig(
  context: AcpInitialConfigContext,
): readonly AcpInitialConfigOverride[] | undefined {
  if (hasExplicitOpenCodeConfigModel(context)) return undefined;

  const xdgStateHome = context.env.XDG_STATE_HOME?.trim();
  const localAppData =
    context.platform === 'win32'
      ? (context.env.LOCALAPPDATA ?? context.env.LocalAppData)?.trim()
      : undefined;
  const statePaths = [
    xdgStateHome ? path.join(xdgStateHome, 'opencode', 'model.json') : undefined,
    path.join(context.homeDir, '.local', 'state', 'opencode', 'model.json'),
    localAppData ? path.join(localAppData, 'opencode', 'model.json') : undefined,
  ].filter((p): p is string => Boolean(p));

  for (const statePath of statePaths) {
    try {
      const parsed = parseJsoncLoose(fs.readFileSync(statePath, 'utf8'));
      if (!parsed || !Array.isArray(parsed.recent) || parsed.recent.length === 0) continue;
      const top = parsed.recent[0];
      if (!top || typeof top !== 'object' || Array.isArray(top)) continue;
      const rec = top as Record<string, unknown>;
      const providerID = typeof rec.providerID === 'string' ? rec.providerID.trim() : '';
      const modelID = typeof rec.modelID === 'string' ? rec.modelID.trim() : '';
      if (!providerID || !modelID) continue;

      const model = `${providerID}/${modelID}`;
      const overrides: AcpInitialConfigOverride[] = [{ category: 'model', value: model }];
      const variants =
        parsed.variant && typeof parsed.variant === 'object' && !Array.isArray(parsed.variant)
          ? (parsed.variant as Record<string, unknown>)
          : undefined;
      const variant = variants?.[model];
      if (typeof variant === 'string' && variant.trim()) {
        overrides.push({ category: 'thought_level', value: variant.trim() });
      }
      return overrides;
    } catch {
      /* 状态文件不存在或损坏时静默回退下一候选 */
    }
  }
  return undefined;
}

const FLAVORS: Readonly<Record<string, AcpHarnessFlavor>> = {
  antigravity: {
    id: 'antigravity',
    displayName: 'Antigravity',
    verifiedResumable: true,
    preferredAuthMethodIds: ['oauth-personal', 'google-login', 'antigravity'],
    loginHint: 'agy acp --login',
    installHint: '请安装 Antigravity CLI（建议 >= 1.5.1）并确保 agy 在 PATH 中',
    misconfiguredCommandHint: (_cmd, args) =>
      args.includes('acp') ? undefined : 'Antigravity 启动参数需包含子命令 "acp"（即 agy acp）',
  },
  opencode: {
    id: 'opencode',
    displayName: 'OpenCode',
    verifiedResumable: true,
    loginHint: 'opencode auth login',
    installHint: 'npm install -g opencode-ai',
    misconfiguredCommandHint: (_cmd, args) =>
      args.includes('acp') ? undefined : 'OpenCode 需传入子命令 "acp"（即 opencode acp）',
    resolveInitialConfigOverrides: resolveOpenCodePreferredConfig,
  },
  dsh: {
    id: 'dsh',
    displayName: 'DeepSeek Harness',
    verifiedResumable: true,
    loginHint: '在终端配置 dsh 凭据，或在「转发环境变量名」中填入 DEEPSEEK_API_KEY',
    installHint: 'npm install -g @deepseek-ai/dsh',
    misconfiguredCommandHint: (_cmd, args) =>
      args.includes('acp')
        ? undefined
        : 'DeepSeek Harness 需传入 "--profile acp"（即 dsh --profile acp）',
  },
  gemini: {
    id: 'gemini',
    displayName: 'Gemini CLI',
    verifiedResumable: true,
    preferredAuthMethodIds: ['oauth-personal', 'gemini-api-key', 'vertex-ai'],
    loginHint: '在终端运行 gemini 完成登录，或转发 GEMINI_API_KEY',
    installHint: 'npm install -g @google/gemini-cli',
    misconfiguredCommandHint: (_cmd, args) =>
      args.some((a) => a === '--acp' || a === '--experimental-acp')
        ? undefined
        : 'Gemini CLI 需传入 "--acp" 参数',
  },
  'qwen-code': {
    id: 'qwen-code',
    displayName: 'Qwen Code',
    verifiedResumable: true,
    loginHint: '在终端运行 qwen 完成登录，或转发 DASHSCOPE_API_KEY',
    installHint: 'npm install -g @qwen-code/qwen-code',
    misconfiguredCommandHint: (_cmd, args) =>
      args.some((a) => a === '--acp' || a === '--experimental-acp')
        ? undefined
        : 'Qwen Code 需传入 "--acp" 参数',
  },
  omp: {
    id: 'omp',
    displayName: 'Oh My Pi (OMP)',
    verifiedResumable: true,
    loginHint: '在终端运行 omp 后输入 /login，或转发对应模型厂商 API_KEY',
    installHint:
      'bun install -g @oh-my-pi/pi-coding-agent（或 npm install -g @oh-my-pi/pi-coding-agent）',
    misconfiguredCommandHint: (_cmd, args) =>
      args.includes('acp') ? undefined : 'Oh My Pi 需传入子命令 "acp"（即 omp acp）',
  },
  qoder: {
    id: 'qoder',
    displayName: 'Qoder',
    verifiedResumable: true,
    loginHint: 'qodercli login',
    installHint: 'npm install -g @qoder-ai/qodercli（或通过 Qoder 国际版客户端安装 CLI）',
    misconfiguredCommandHint: (_cmd, args) =>
      args.some((a) => a === '--acp' || a === 'acp')
        ? undefined
        : 'Qoder CLI 需传入 "--acp" 参数（即 qodercli --acp）',
  },
  'qoder-cn': {
    id: 'qoder-cn',
    displayName: 'Qoder CN',
    verifiedResumable: true,
    loginHint: 'qoderclicn login',
    installHint: '通过 Qoder 国内版客户端安装 CLI（~/.qoder-cn/bin/qoderclicn）',
    misconfiguredCommandHint: (_cmd, args) =>
      args.some((a) => a === '--acp' || a === 'acp')
        ? undefined
        : 'Qoder CN CLI 需传入 "--acp" 参数（即 qoderclicn --acp）',
  },
  trae: {
    id: 'trae',
    displayName: 'TRAE',
    verifiedResumable: true,
    loginHint: 'traecli login',
    installHint: '通过 TRAE 国际版（trae.ai）安装官方 traecli 命令行工具',
    misconfiguredCommandHint: (_cmd, args) =>
      args.includes('acp') || args.includes('--acp')
        ? undefined
        : 'TRAE CLI 需传入 "acp serve"（即 traecli acp serve）',
  },
  'trae-cn': {
    id: 'trae-cn',
    displayName: 'TRAE CN',
    verifiedResumable: true,
    loginHint: 'traecli login',
    installHint:
      'Windows: irm https://trae.cn/trae-cli/install_v2.ps1 | iex · macOS/Linux: sh -c "$(curl -fsSL https://trae.cn/trae-cli/install_v2.sh)"',
    misconfiguredCommandHint: (_cmd, args) =>
      args.includes('acp') || args.includes('--acp')
        ? undefined
        : 'TRAE CN CLI 需传入 "acp serve"（即 traecli acp serve）',
  },
  generic: {
    id: 'generic',
    displayName: 'Custom ACP Agent',
    verifiedResumable: false,
    misconfiguredCommandHint: (cmd) => {
      const stem = normalizeBinaryStem(cmd);
      if (stem === 'claude' || stem === 'codex' || stem === 'pi') {
        return `检测到在 ACP 模式下直接填写了 '${stem}'；请改用内置的 Claude Code / Codex / Pi Coding Agent 原生直连预设`;
      }
      return undefined;
    },
  },
};

function normalizeBinaryStem(command: string): string {
  const normalized = command.trim().replace(/\\/g, '/');
  const base = path.posix.basename(normalized).toLowerCase();
  return base.replace(/\.(?:exe|cmd|bat|js|mjs|cjs)$/i, '');
}

function matchFlavorKey(token: string | undefined): string | undefined {
  if (!token) return undefined;
  const lower = token.trim().toLowerCase();
  if (!lower) return undefined;
  if (FLAVORS[lower]) return lower;
  if (lower === 'agy' || lower.includes('antigravity')) return 'antigravity';
  if (lower.includes('opencode')) return 'opencode';
  if (lower === 'dsh' || lower.includes('deepseek')) return 'dsh';
  if (lower.includes('gemini')) return 'gemini';
  if (lower === 'qwen' || lower.includes('qwen-code')) return 'qwen-code';
  if (lower === 'omp' || lower.includes('oh-my-pi')) return 'omp';
  if (
    lower === 'qoderclicn' ||
    lower === 'qodercn' ||
    lower.includes('qoder-cli-cn') ||
    lower.includes('qoder-cn')
  ) {
    return 'qoder-cn';
  }
  if (lower === 'qodercli' || lower.includes('qoder')) return 'qoder';
  if (lower.includes('trae-cn') || lower.includes('traecn')) return 'trae-cn';
  if (lower === 'traecli' || lower.includes('trae')) return 'trae';
  return undefined;
}

/**
 * 三级解析 ACP 代理方言：显式 `flavor` → 可执行文件基名 → 握手返回的 `agentInfo.name` → `generic`。
 *
 * 保证用户在「自定义 ACP 代理」里手工填入本地路径（如 `D:\tools\agy.exe acp`）时仍能自动获得同等的认证与诊断体验。
 */
export function resolveAcpFlavor(input: {
  readonly flavor?: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly agentInfoName?: string;
}): AcpHarnessFlavor {
  const byExplicit = matchFlavorKey(input.flavor);
  if (byExplicit) return FLAVORS[byExplicit]!;

  const byCommand = matchFlavorKey(normalizeBinaryStem(input.command));
  if (byCommand) return FLAVORS[byCommand]!;

  const byAgentInfo = matchFlavorKey(input.agentInfoName);
  if (byAgentInfo) return FLAVORS[byAgentInfo]!;

  return FLAVORS.generic!;
}

/**
 * 判定 JSON-RPC 错误或标准错误尾部是否属于外部 CLI 未登录 / 缺凭据故障。
 */
export function isAcpAuthRequiredError(message: string, rpcCode?: number): boolean {
  if (
    rpcCode === -32000 &&
    /auth|login|credential|token|oauth|api[_ -]?key|登录|鉴权|认证|凭据|密钥/i.test(message)
  ) {
    return true;
  }
  return /(?:authentication\s+required|not\s+logged\s+in|please\s+login|use\s+\/login|no\s+model\s+selected|oauth.*expired|missing.*api[_ -]?key|no\s+api\s+key\s+(?:found\s+)?for(?:\s+provider)?|unauthorized|invalid\s+api\s+key|未登录|请先登录|需要登录|登录已过期|缺少.*(?:密钥|凭据)|鉴权失败|认证失败)/i.test(
    message,
  );
}
