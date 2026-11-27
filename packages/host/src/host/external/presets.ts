import type { ExternalHarnessDefinition } from './types.js';

/**
 * 官方 ACP Registry 精选静态只读模板条目。
 *
 * 设计取舍：离线零网络请求即可在桌面设置页「从 ACP 目录选择模板」抽屉中一键回填推荐命令、参数与终端安装说明，
 * 不自动代用户执行 `npm install` 或后台下载二进制。
 */
export interface AcpRegistryTemplate {
  readonly registryId: string;
  readonly name: string;
  readonly description: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly envFrom?: readonly string[];
  readonly installHint: string;
  readonly loginHint?: string;
  readonly website?: string;
}

/**
 * 首批内置外部代理预设真源（静态 `enabled: false`，未手动覆写时由 `listResolvedExternalHarnesses` 按本机是否已安装对应命令自动决定默认启停）。
 *
 * 持久化边界（与 `BUILTIN_PROFILES` 同口径）：
 * 内置预设仅由代码侧提供，绝不整份物化写入 `~/.kapibala/external/harnesses.json`；
 * 用户在设置页修改路径或启停开关时只落盘增量 `overrides`，支持一键恢复默认且随版本升级自动保鲜。
 */
export const BUILTIN_EXTERNAL_HARNESSES: readonly ExternalHarnessDefinition[] = [
  {
    id: 'claude-code',
    name: 'Claude Code',
    transport: 'claude-cli',
    command: 'claude',
    args: [],
    envFrom: ['ANTHROPIC_API_KEY'],
    builtin: true,
    enabled: false,
  },
  {
    id: 'codex',
    name: 'Codex',
    transport: 'codex-app-server',
    command: 'codex',
    args: [],
    envFrom: ['OPENAI_API_KEY'],
    builtin: true,
    enabled: false,
  },
  {
    id: 'pi',
    name: 'Pi Coding Agent',
    transport: 'pi-rpc',
    command: 'pi',
    args: [],
    envFrom: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY'],
    builtin: true,
    enabled: false,
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    transport: 'acp',
    flavor: 'antigravity',
    command: 'agy',
    args: ['acp'],
    builtin: true,
    enabled: false,
  },
  {
    id: 'opencode',
    name: 'OpenCode',
    transport: 'acp',
    flavor: 'opencode',
    command: 'opencode',
    args: ['acp'],
    builtin: true,
    enabled: false,
  },
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness',
    transport: 'acp',
    flavor: 'dsh',
    command: 'dsh',
    args: ['--profile', 'acp'],
    envFrom: ['DEEPSEEK_API_KEY'],
    builtin: true,
    enabled: false,
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    transport: 'acp',
    flavor: 'gemini',
    command: 'gemini',
    args: ['--acp'],
    envFrom: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    builtin: true,
    enabled: false,
  },
  {
    id: 'qwen-code',
    name: 'Qwen Code',
    transport: 'acp',
    flavor: 'qwen-code',
    command: 'qwen',
    args: ['--acp'],
    envFrom: ['DASHSCOPE_API_KEY'],
    builtin: true,
    enabled: false,
  },
  {
    id: 'omp',
    name: 'Oh My Pi (OMP)',
    transport: 'acp',
    flavor: 'omp',
    command: 'omp',
    args: ['acp'],
    env: { PI_NO_PTY: '1' },
    envFrom: ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY'],
    builtin: true,
    enabled: false,
  },
  {
    id: 'qoder',
    name: 'Qoder',
    transport: 'acp',
    flavor: 'qoder',
    command: 'qodercli',
    args: ['--acp'],
    builtin: true,
    enabled: false,
  },
  {
    id: 'qoder-cn',
    name: 'Qoder CN',
    transport: 'acp',
    flavor: 'qoder-cn',
    command: 'qoderclicn',
    args: ['--acp'],
    builtin: true,
    enabled: false,
  },
  {
    id: 'trae',
    name: 'TRAE',
    transport: 'acp',
    flavor: 'trae',
    command: 'traecli',
    args: ['acp', 'serve'],
    envFrom: ['TRAECLI_PERSONAL_ACCESS_TOKEN'],
    builtin: true,
    enabled: false,
  },
  {
    id: 'trae-cn',
    name: 'TRAE CN',
    transport: 'acp',
    flavor: 'trae-cn',
    command: 'traecli',
    args: ['acp', 'serve'],
    envFrom: ['TRAECLI_PERSONAL_ACCESS_TOKEN'],
    builtin: true,
    enabled: false,
  },
];

/** 官方 ACP 生态常见第三方代理模板目录。 */
export const ACP_REGISTRY_TEMPLATES: readonly AcpRegistryTemplate[] = [
  {
    registryId: 'copilot',
    name: 'GitHub Copilot CLI',
    description: 'GitHub 官方终端编码代理，通过 --acp 暴露标准 ACP 会话',
    command: 'copilot',
    args: ['--acp'],
    envFrom: ['GITHUB_TOKEN'],
    installHint: 'npm install -g @github/copilot',
    loginHint: 'copilot auth login',
    website: 'https://github.com/features/copilot/cli',
  },
  {
    registryId: 'cursor-agent',
    name: 'Cursor Agent',
    description: 'Cursor 命令行编码代理 ACP 模式',
    command: 'cursor-agent',
    args: ['acp'],
    installHint: '通过 Cursor 客户端 Command Palette 安装 cursor-agent CLI',
    loginHint: 'cursor-agent login',
  },
  {
    registryId: 'cline',
    name: 'Cline CLI',
    description: '开源自主编码代理 Cline 的标准 ACP 通道',
    command: 'cline',
    args: ['--acp'],
    installHint: 'npm install -g cline',
    loginHint: 'cline auth',
  },
  {
    registryId: 'kimi',
    name: 'Kimi Code CLI',
    description: 'Moonshot Kimi 终端编码代理 ACP 模式',
    command: 'kimi',
    args: ['acp'],
    envFrom: ['MOONSHOT_API_KEY'],
    installHint: 'uv tool install kimi-cli',
    loginHint: 'kimi login',
  },
  {
    registryId: 'goose',
    name: 'Goose',
    description: 'Block 开源本地可扩展工程代理 ACP 模式',
    command: 'goose',
    args: ['acp'],
    installHint: '参见 Goose 官方文档安装原生二进制',
  },
  {
    registryId: 'vibe',
    name: 'Mistral Vibe',
    description: 'Mistral 命令行编码代理 ACP 模式',
    command: 'vibe-acp',
    args: [],
    envFrom: ['MISTRAL_API_KEY'],
    installHint: 'uv tool install mistral-vibe',
  },
  {
    registryId: 'auggie',
    name: 'Augment Code (Auggie)',
    description: 'Augment Code 终端代理 ACP 模式',
    command: 'auggie',
    args: ['--acp'],
    installHint: 'npm install -g @augmentcode/auggie',
    loginHint: 'auggie login',
  },
];

/** 按 ID 查找内置外部代理预设；未命中内置清单时返回 `undefined`（用于区分内置增量覆写与用户自定义条目）。 */
export function findBuiltinExternalHarness(id: string): ExternalHarnessDefinition | undefined {
  return BUILTIN_EXTERNAL_HARNESSES.find((item) => item.id === id);
}
