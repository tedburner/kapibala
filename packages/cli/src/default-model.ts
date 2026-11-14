import type { ModelProfile, ModelRole } from '@kiturone/kapibala';
import {
  type LoadSettingsOptions,
  type UserSettings,
  ensureProfile,
  mutateGlobalSettings,
} from './settings.js';

/** 设置下次默认启动模型；只补所选 profile，保存成功后才更新内存，不热切换或物化内置目录。 */
export function persistDefaultModel(
  profile: ModelProfile,
  settings: UserSettings,
  options: {
    homeDir?: LoadSettingsOptions['homeDir'];
    mutateSettings?: typeof mutateGlobalSettings;
  } = {},
): string {
  const change = (global: UserSettings) => {
    ensureProfile(global, profile);
    global.defaultModel = profile.id;
  };
  const savedPath = (options.mutateSettings ?? mutateGlobalSettings)(change, options);
  settings.defaultModel = profile.id;
  return savedPath;
}

/** 保存单个角色映射；仅保存所选 Profile，写失败不更新运行时或热切换其它角色。 */
export function persistModelRole(
  profile: ModelProfile,
  role: Exclude<ModelRole, 'default'>,
  settings: UserSettings,
  options: {
    homeDir?: LoadSettingsOptions['homeDir'];
    mutateSettings?: typeof mutateGlobalSettings;
  } = {},
): string {
  const change = (global: UserSettings) => {
    ensureProfile(global, profile);
    global.modelRouting = { ...global.modelRouting, [role]: profile.id };
  };
  const savedPath = (options.mutateSettings ?? mutateGlobalSettings)(change, options);
  settings.modelRouting = { ...settings.modelRouting, [role]: profile.id };
  return savedPath;
}
