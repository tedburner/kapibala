import {
  type LoadSettingsOptions,
  type LoadedSettings,
  isProjectTrusted,
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
  /** 技能发现使用的项目根；缺省从 cwd 检测，不把嵌套 cwd 信任扩展为仓库信任。 */
  projectRoot?: string;
  interactive?: boolean;
  choose?: (projectPath: string) => Promise<ProjectTrustDecision | null>;
}

/**
 * 在 CLI 边界确认项目配置的永久信任。
 * 配置未信任时退出；仅有技能的项目在拒绝或非交互时保留全局能力，排除项目技能。
 */
export async function resolveProjectTrust(
  loaded: LoadedSettings,
  options: ResolveProjectTrustOptions = {},
): Promise<ProjectTrustResult> {
  const pending = loaded.pendingProject;
  const interactive = options.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let result = loaded;
  let trusted = false;
  if (pending) {
    if (!interactive) return { status: 'non_interactive' };
    if ((await (options.choose ?? promptProjectTrust)(pending.projectPath)) !== 'trust')
      return { status: 'rejected' };
    trustProject(result.settings, pending.projectPath, { homeDir: options.homeDir });
    result = loadSettings({ cwd: options.cwd, homeDir: options.homeDir });
    trusted = true;
  }
  const projectRoot = fs.realpathSync(
    options.projectRoot ?? detectProjectRoot(options.cwd ?? process.cwd()),
  );
  if (
    result.settings.skills?.enabled !== false &&
    hasProjectSkills(projectRoot) &&
    !isProjectTrusted(result.settings, projectRoot) &&
    interactive
  ) {
    if ((await (options.choose ?? promptSkillTrust)(projectRoot)) === 'trust') {
      trustProject(result.settings, projectRoot, { homeDir: options.homeDir });
      result = loadSettings({ cwd: options.cwd, homeDir: options.homeDir });
      trusted = true;
    }
  }
  return { status: trusted ? 'trusted' : 'ready', loaded: result };
}

/** 技能信任沿用现有顺序输入菜单；拒绝后继续运行全局技能，不永久记录拒绝。 */
async function promptSkillTrust(projectPath: string): Promise<ProjectTrustDecision | null> {
  return select<ProjectTrustDecision>({
    message: `项目包含技能指令，是否永久信任？\n  ${projectPath}`,
    options: [
      {
        label: '信任项目技能',
        value: 'trust',
        description: '允许加载仓库中的技能正文；执行仍受权限规则约束',
      },
      {
        label: '跳过项目技能',
        value: 'reject',
        description: '继续使用全局技能，不读取项目技能正文',
      },
    ],
    defaultIndex: 1,
  });
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
import fs from 'node:fs';
import { detectProjectRoot } from './project-root.js';
import { hasProjectSkills } from './skills.js';
