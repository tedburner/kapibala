import type { ModelProfile, ModelRole } from '@kiturone/kapibala';
import {
  BUILTIN_PROFILES,
  type LoadSettingsOptions,
  type UserSettings,
  ensureProfile,
  mutateGlobalSettings,
} from '@kiturone/kapibala-host/internal';

/**
 * 内置模型由代码清单提供，defaultModel / modelRouting 的引用在加载时经 loadSettings
 * 合并即可解析，写引用就够了；物化内置条目会把一份当天的清单快照固化进用户文件，
 * 既违背「内置清单由代码提供、升级不改用户文件」的设计，也要靠目录迁移在版本升级时
 * 追平漂移。自定义 Profile（含项目级条目）没有代码来源，必须补入全局文件，
 * 跨项目与重启后的引用才有落点。
 */
function pinProfileIfNeeded(global: UserSettings, profile: ModelProfile): void {
  if (!BUILTIN_PROFILES.some((builtin) => builtin.id === profile.id))
    ensureProfile(global, profile);
}

/**
 * 设置下次默认启动模型；内置模型只写引用，自定义 Profile 补入全局文件。
 * 保存成功后才更新内存，不热切换或物化内置目录。
 */
export function persistDefaultModel(
  profile: ModelProfile,
  settings: UserSettings,
  options: {
    homeDir?: LoadSettingsOptions['homeDir'];
    mutateSettings?: typeof mutateGlobalSettings;
  } = {},
): string {
  const change = (global: UserSettings) => {
    pinProfileIfNeeded(global, profile);
    global.defaultModel = profile.id;
  };
  const savedPath = (options.mutateSettings ?? mutateGlobalSettings)(change, options);
  settings.defaultModel = profile.id;
  return savedPath;
}

/** 保存单个角色映射；内置模型只写引用，自定义 Profile 补入全局文件，写失败不更新运行时或热切换其它角色。 */
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
    pinProfileIfNeeded(global, profile);
    global.modelRouting = { ...global.modelRouting, [role]: profile.id };
  };
  const savedPath = (options.mutateSettings ?? mutateGlobalSettings)(change, options);
  settings.modelRouting = { ...settings.modelRouting, [role]: profile.id };
  return savedPath;
}
