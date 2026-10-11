import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SkillOptions } from '@kiturone/kapibala';
import { detectProjectRoot } from './project-root.js';
import { type LoadSettingsOptions, type UserSettings, isProjectTrusted } from './settings.js';

/** CLI 的发现环境；项目根与 cwd 分开传递，续答仍使用本次宿主的根与信任。 */
export interface CliSkillOptions extends Pick<LoadSettingsOptions, 'cwd' | 'homeDir'> {
  projectRoot?: string;
}

/** 只检查技能根是否存在，不读取尚未信任仓库内的技能正文。 */
export function hasProjectSkills(projectRoot: string): boolean {
  return ['.kapibala', '.agents'].some((dir) =>
    fs.existsSync(path.join(projectRoot, dir, 'skills')),
  );
}

/** 显式提供四个来源与物理边界；项目默认不可信，全局来源不会因拒绝项目信任而消失。 */
export function getCliSkillOptions(
  settings: UserSettings,
  options: CliSkillOptions = {},
): SkillOptions {
  const projectRoot = fs.realpathSync(
    options.projectRoot ?? detectProjectRoot(options.cwd ?? process.cwd()),
  );
  const homeDir = options.homeDir ?? os.homedir();
  const trusted = isProjectTrusted(settings, projectRoot);
  return {
    enabled: settings.skills?.enabled ?? true,
    disabled: [...(settings.skills?.disabled ?? [])],
    roots: [
      {
        path: path.join(projectRoot, '.kapibala/skills'),
        scope: 'project',
        kind: 'native',
        trusted,
        boundary: projectRoot,
      },
      {
        path: path.join(projectRoot, '.agents/skills'),
        scope: 'project',
        kind: 'agents',
        trusted,
        boundary: projectRoot,
      },
      {
        path: path.join(homeDir, '.kapibala/skills'),
        scope: 'global',
        kind: 'native',
        trusted: true,
      },
      {
        path: path.join(homeDir, '.agents/skills'),
        scope: 'global',
        kind: 'agents',
        trusted: true,
      },
    ],
  };
}
