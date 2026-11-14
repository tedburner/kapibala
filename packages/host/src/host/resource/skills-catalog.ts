import {
  type SkillDiagnostic,
  type SkillMetadata,
  SkillRegistry,
  type SkillScope,
} from '@kiturone/kapibala';
import type { UserSettings } from '../settings.js';
import { getCliSkillOptions } from '../skills.js';

/** 资源面板可见的技能摘要；不含正文，只含发现事实与可用状态。 */
export interface SkillSummary {
  name: string;
  /** 声明来源范围（含内置路径）；project 侧带信任标注，不可用时描述原因。 */
  scope: SkillScope;
  available: boolean;
  unavailableReason: string | undefined;
  userInvocable: boolean;
  /** 被全局 `settings.skills.disabled` 列表禁用；目录不存在时该标记仍然保留。 */
  disabled: boolean;
  description: string;
  sourceRoot: string;
  filePath: string;
}

/** 技能资源快照：全局开关 + 清单 + 扫描诊断，全部经既有发现与信任规则投影。 */
export interface SkillsResourceSnapshot {
  /** 全局启用开关（`settings.skills.enabled`）；关闭时清单仍展示但标注功能已禁用。 */
  enabled: boolean;
  skills: SkillSummary[];
  diagnostics: SkillDiagnostic[];
}

/**
 * 读取技能资源快照（无会话轻投影）。
 *
 * 保证：
 * - 与会话装配同源——复用 `getCliSkillOptions` 的同一根构造与信任解析，扫描走同一
 *   `SkillRegistry` 实现，新建会话的技能目录与本快照的可用集合一致；
 * - 只读扫描，不加载技能正文、不注册工具、不产生任何授权；
 * - 被禁用名称在目录不存在时仍以 disabled 形态出现（禁用项先于目录存在的语义）。
 */
export async function readSkillsResourceSnapshot(options: {
  settings: UserSettings;
  homeDir?: string;
  cwd?: string;
  projectRoot?: string;
  signal?: AbortSignal;
}): Promise<SkillsResourceSnapshot> {
  const skillOptions = getCliSkillOptions(options.settings, {
    homeDir: options.homeDir,
    cwd: options.cwd,
    projectRoot: options.projectRoot,
  });
  const disabledList = new Set(options.settings.skills?.disabled ?? []);
  const registry = new SkillRegistry(skillOptions);
  await registry.refresh(options.signal);
  const metadata: SkillMetadata[] = registry.list('host');
  const skills: SkillSummary[] = metadata.map((item) => ({
    name: item.name,
    scope: item.scope,
    available: item.available,
    unavailableReason: item.unavailableReason,
    userInvocable: item.userInvocable,
    disabled: disabledList.has(item.name),
    description: item.description,
    sourceRoot: item.sourceRoot,
    filePath: item.filePath,
  }));
  for (const name of options.settings.skills?.disabled ?? []) {
    if (skills.some((skill) => skill.name === name)) continue;
    skills.push({
      name,
      scope: 'global',
      available: false,
      unavailableReason: '已禁用且目录中暂无同名技能；目录出现同名技能时将继续排除',
      userInvocable: false,
      disabled: true,
      description: '',
      sourceRoot: '',
      filePath: '',
    });
  }
  return {
    enabled: options.settings.skills?.enabled ?? true,
    skills,
    diagnostics: registry.diagnostics,
  };
}
