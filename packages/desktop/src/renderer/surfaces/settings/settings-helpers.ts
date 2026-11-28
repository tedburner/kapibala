import type { Output, ProfileDraft } from '../../../shared/contracts.js';
import { type ResolvedDesktopLocale, translateDesktop } from '../../../shared/i18n/index.js';
import type { SettingsTabId } from '../../stores/index.js';
import type { IconName } from '../../ui/index.js';

/** 宿主 `settings.read` 完整目录快照类型。 */
export type SettingsCatalog = Output<'settings.read'>;

/** 公开模型配置条目类型（仅含凭证状态布尔位与分组键，绝不含密钥明文）。 */
export type SettingsModelProfile = SettingsCatalog['profiles'][number];

/** MCP 服务器与诊断目录快照类型。 */
export type McpCatalog = Output<'resources.readMcp'>;

/** 单条 MCP 服务器视图投影类型。 */
export type McpServerView = McpCatalog['servers'][number];

/** 技能目录与诊断快照类型。 */
export type SkillsCatalog = Output<'resources.readSkills'>;

/** 壳内设置中心左轨单个分组元数据定义。 */
export interface SettingsNavItem {
  readonly id: SettingsTabId;
  readonly label: string;
  readonly icon: IconName;
  readonly description: string;
  readonly wide?: boolean;
}

/** 按当前解析语言动态构造八大设置分类导航项（首项固定为「常规 / General」）。 */
export function buildSettingsNavItems(
  locale: ResolvedDesktopLocale = 'zh-CN',
): readonly SettingsNavItem[] {
  const tr = (key: Parameters<typeof translateDesktop>[1]) => translateDesktop(locale, key);
  return [
    {
      id: 'general',
      label: tr('settings.nav.general'),
      icon: 'sliders',
      description: tr('settings.nav.generalDesc'),
    },
    {
      id: 'providers',
      label: tr('settings.nav.providers'),
      icon: 'plugs-connected',
      description: tr('settings.nav.providersDesc'),
      wide: true,
    },
    {
      id: 'routing',
      label: tr('settings.nav.routing'),
      icon: 'shuffle',
      description: tr('settings.nav.routingDesc'),
    },
    {
      id: 'external',
      label: tr('settings.nav.external'),
      icon: 'terminal',
      description: tr('settings.nav.externalDesc'),
      wide: true,
    },
    {
      id: 'permissions',
      label: tr('settings.nav.permissions'),
      icon: 'shield-check',
      description: tr('settings.nav.permissionsDesc'),
    },
    {
      id: 'resources',
      label: tr('settings.nav.resources'),
      icon: 'package',
      description: tr('settings.nav.resourcesDesc'),
    },
    {
      id: 'archives',
      label: tr('settings.nav.archives'),
      icon: 'archive',
      description: tr('settings.nav.archivesDesc'),
    },
    {
      id: 'diagnostics',
      label: tr('settings.nav.diagnostics'),
      icon: 'pulse',
      description: tr('settings.nav.diagnosticsDesc'),
    },
  ];
}

/**
 * 壳内设置与代理中心默认简体中文八大一级分组真源（017 §6.7 & §7）：
 * 首项合并原「外观与应用」升级为「常规」，复合双栏/长列表页（`providers` / `external`）启用 `960px` 宽版容器。
 */
export const SETTINGS_NAV_ITEMS: readonly SettingsNavItem[] = Object.freeze(
  buildSettingsNavItems('zh-CN'),
);

/**
 * 将历史或外部入口传入的设置分类标识归一化为标准 `SettingsTabId`，
 * 兼容旧版 `'appearance' | 'models' | 'permission' | 'archived'` 别名以保障切流零断链。
 */
export function normalizeSettingsTab(raw?: string | null): SettingsTabId {
  if (!raw) return 'general';
  if (raw === 'appearance') return 'general';
  if (raw === 'models') return 'providers';
  if (raw === 'permission') return 'permissions';
  if (raw === 'archived') return 'archives';
  const matched = SETTINGS_NAV_ITEMS.find((item) => item.id === raw);
  return matched ? matched.id : 'general';
}

/**
 * 为设置页异步 IPC 请求附加前端超时看门狗：
 * 当宿主重建或控制通道挂起时及时释放按钮加载态，防止表单长期锁死在忙碌态。
 */
export function withSettingsWatchdog<T>(
  task: Promise<T>,
  timeoutMessage: string,
  timeoutMs = 12_000,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    task.finally(() => {
      if (timer) clearTimeout(timer);
    }),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
    }),
  ]);
}

/** 将公开模型配置转换为可写回 `settings.saveProfile` 的纯净草稿结构。 */
export function profileToDraft(model: SettingsModelProfile): ProfileDraft {
  return {
    id: model.id,
    name: model.name,
    provider: model.provider,
    modelName: model.modelName,
    baseURL: model.baseURL,
    apiKeyEnv: model.apiKeyEnv,
    vendorName: model.vendorName,
    disabled: model.disabled,
    contextWindow: model.contextWindow,
    maxOutputTokens: model.maxOutputTokens,
    supportsThinking: model.supportsThinking,
  };
}

/** 构造新建自定义兼容端点模型的空白草稿。 */
export function createBlankCustomProfileDraft(vendorName = ''): ProfileDraft {
  return {
    id: `custom-${crypto.randomUUID().slice(0, 8)}`,
    name: '',
    provider: 'openai-compatible',
    modelName: '',
    baseURL: '',
    apiKeyEnv: 'CUSTOM_API_KEY',
    vendorName,
  };
}

/** 将字节数格式化为易读的 KB / MB 字符串（用于更新包大小与流式下载进度）。 */
export function formatByteSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 将更新包下载失败原因码转换为面向用户的中文诊断说明。 */
export function describeUpdateDownloadFailure(reason: string, detail?: string): string {
  if (reason === 'NO_UPDATE_STATE') return '请先重新检查更新，再执行下载。';
  if (reason === 'DOWNLOAD_IN_PROGRESS') return '已有更新安装包正在下载中。';
  if (reason === 'UNTRUSTED_SOURCE') return '下载地址不属于受信任的官方发布源，已拒绝连接。';
  if (reason === 'CHECKSUM_FETCH_FAILED') {
    return `无法拉取 SHA-256 校验清单，已中止下载${detail ? `（${detail}）` : ''}。`;
  }
  if (reason === 'CHECKSUM_MISSING') return '发布资产缺少当前安装包的 SHA-256 摘要，已拒绝下载。';
  if (reason === 'CHECKSUM_MISMATCH') {
    return '安装包 SHA-256 摘要比对不一致，已清除临时文件，请重试。';
  }
  if (reason === 'INVALID_ASSET_NAME') return '安装包文件名不合法，已拒绝写入磁盘。';
  return `下载失败${detail ? `（${detail}）` : ''}，可重试或前往 GitHub Releases 手动下载。`;
}

/** 在浏览器剪贴板可用时复制文本，失败时静默返回 `false` 而不抛出未捕获异常。 */
export async function copyTextSafe(value: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}
