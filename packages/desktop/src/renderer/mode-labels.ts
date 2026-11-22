/**
 * 会话审批/运行模式的界面显示名唯一映射。
 *
 * 模式菜单（App）、设置档位（settings-dialog）与详情抽屉「运行事实」必须共用同一份中文
 * 名，任何新入口不得从英文枚举直出显示文本；键与协议侧权限模式枚举一一对应。
 */
export const MODE_NAMES = {
  Approval: '变更前确认',
  Plan: '计划模式',
  Auto: '自主模式',
  FullAccess: '完全访问',
} as const;

/**
 * 把协议侧模式枚举解析为界面显示名；未知枚举原样返回，不猜测。
 * 详情抽屉等收窄场景（数据可能来自旧协议或观察快照）用它兜底，避免直接索引报错。
 */
export function modeDisplayName(mode: string): string {
  return mode in MODE_NAMES ? MODE_NAMES[mode as keyof typeof MODE_NAMES] : mode;
}
