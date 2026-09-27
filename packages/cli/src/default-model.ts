import type { ModelProfile } from '@kiturone/kapibala';
import {
  type LoadSettingsOptions,
  type UserSettings,
  ensureProfile,
  loadGlobalSettingsForWrite,
  saveGlobalSettings,
} from './settings.js';

/** 设置下次默认启动模型；只补所选 profile，保存成功后才更新内存，不热切换或物化内置目录。 */
export function persistDefaultModel(
  profile: ModelProfile,
  settings: UserSettings,
  options: {
    homeDir?: LoadSettingsOptions['homeDir'];
    saveSettings?: typeof saveGlobalSettings;
  } = {},
): string {
  const global = loadGlobalSettingsForWrite({ homeDir: options.homeDir });
  ensureProfile(global, profile);
  global.defaultModel = profile.id;
  const savedPath = (options.saveSettings ?? saveGlobalSettings)(global, {
    homeDir: options.homeDir,
  });
  settings.defaultModel = profile.id;
  return savedPath;
}
