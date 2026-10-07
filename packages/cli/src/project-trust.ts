import {
  type LoadSettingsOptions,
  type LoadedSettings,
  loadSettings,
  trustProject,
} from './settings.js';
import { select } from './ui/select.js';

/** 用户对项目配置的选择：trust 永久信任并应用，reject 退出且不读取。 */
export type ProjectTrustDecision = 'trust' | 'reject';

/**
 * 信任解析结果：
 * - `ready` 无待确认项目，配置直接可用；
 * - `trusted` 用户确认信任，已按含项目配置的结果重载；
 * - `rejected` 用户拒绝，宿主不得应用项目配置；
 * - `non_interactive` 非交互终端无法确认，同样不得应用，由调用方按失败退出。
 */
export type ProjectTrustResult =
  | { status: 'ready'; loaded: LoadedSettings }
  | { status: 'trusted'; loaded: LoadedSettings }
  | { status: 'rejected' }
  | { status: 'non_interactive' };

/** 注入项：interactive 与 choose 供测试或图形宿主替换终端菜单；其余继承 {@link LoadSettingsOptions}。 */
export interface ResolveProjectTrustOptions extends LoadSettingsOptions {
  interactive?: boolean;
  choose?: (projectPath: string) => Promise<ProjectTrustDecision | null>;
}

/**
 * 在 CLI 边界确认项目配置的永久信任。
 * 未信任或无法交互时绝不应用项目配置，由调用方按失败状态退出。
 */
export async function resolveProjectTrust(
  loaded: LoadedSettings,
  options: ResolveProjectTrustOptions = {},
): Promise<ProjectTrustResult> {
  const pending = loaded.pendingProject;
  if (!pending) {
    return { status: 'ready', loaded };
  }

  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (!interactive) {
    return { status: 'non_interactive' };
  }

  const choose = options.choose ?? promptProjectTrust;
  const decision = await choose(pending.projectPath);
  if (decision !== 'trust') {
    return { status: 'rejected' };
  }

  trustProject(loaded.settings, pending.projectPath, { homeDir: options.homeDir });
  return {
    status: 'trusted',
    loaded: loadSettings({ cwd: options.cwd, homeDir: options.homeDir }),
  };
}

async function promptProjectTrust(projectPath: string): Promise<ProjectTrustDecision | null> {
  return select<ProjectTrustDecision>({
    message: `项目包含 .kapibala/settings.json，是否永久信任？\n  ${projectPath}`,
    options: [
      {
        label: '信任并永久记住',
        value: 'trust',
        description: '项目配置可覆盖模型、端点和密钥来源',
      },
      {
        label: '不信任并退出',
        value: 'reject',
        description: '不读取项目配置，也不启动会话',
      },
    ],
    defaultIndex: 1,
  });
}
