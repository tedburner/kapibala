import path from 'node:path';

/**
 * 单个 ACP 外部代理方言（Flavor）的极薄声明式钩子。
 *
 * 设计取舍（对齐 Orca `AcpDialect` + T3 Code `makeAcpAdapterV2`）：
 * 状态机、行通道与消息投影全量共享，方言层仅承载认证方法偏好、误配诊断、登录/安装提示与持久身份背书。
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
  if (rpcCode === -32000 && /auth|login|credential|token|oauth|api[_ -]?key/i.test(message)) {
    return true;
  }
  return /(?:authentication\s+required|not\s+logged\s+in|please\s+login|oauth.*expired|missing.*api[_ -]?key|unauthorized|invalid\s+api\s+key)/i.test(
    message,
  );
}
