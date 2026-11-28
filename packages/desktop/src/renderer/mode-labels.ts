import { type ResolvedDesktopLocale, translateDesktop } from '../shared/i18n/index.js';
import type { WorkspaceSpace } from './stores/index.js';
import type { ActionMenuEntry } from './ui/index.js';

/**
 * 会话审批/运行模式的中文基准显示名映射。
 *
 * 模式菜单（App）、设置档位与详情检视器共用同一协议侧权限模式枚举键；多语言渲染通过 `modeDisplayName(mode, locale)` 解析。
 */
export const MODE_NAMES = {
  Approval: '变更前确认',
  Plan: '计划模式',
  Auto: '自主模式',
  FullAccess: '完全访问',
} as const;

/** 权限运行档位枚举。 */
export type ComposerPermissionMode = keyof typeof MODE_NAMES;

const MODE_ORDER: readonly ComposerPermissionMode[] = ['Approval', 'Plan', 'Auto', 'FullAccess'];

/**
 * 把协议侧模式枚举解析为当前界面语言的显示名；未知枚举原样返回，避免观察快照旧字段索引报错。
 */
export function modeDisplayName(mode: string, locale: ResolvedDesktopLocale = 'zh-CN'): string {
  if (!(mode in MODE_NAMES)) return mode;
  return translateDesktop(locale, `composer.mode.${mode as ComposerPermissionMode}` as const);
}

/** 输入框状态提示条契约。 */
export interface OmniGuidanceBanner {
  readonly text: string;
  readonly act?: string;
  readonly fn?: () => void;
  readonly subtle?: boolean;
}

/**
 * 根据信任状态、API 密钥、模型配额与只读归档状态裁决底部状态引导文案。
 */
export function pickOmniGuidance(
  untrusted: boolean,
  noKey: boolean,
  options: {
    readonly readonlyArchiveActionLabel?: string;
    readonly onReadonlyArchiveAction?: () => void;
    readonly onRequestTrustWorkspace?: () => void;
    readonly onOpenModelSettings?: () => void;
    readonly quotaExhausted?: boolean;
    readonly onSwitchModel?: () => void;
    readonly stagedHintText?: string;
  },
  locale: ResolvedDesktopLocale = 'zh-CN',
): OmniGuidanceBanner | null {
  if (options.readonlyArchiveActionLabel && options.onReadonlyArchiveAction) {
    return {
      text: translateDesktop(locale, 'composer.readonlyArchiveHint'),
      act: options.readonlyArchiveActionLabel,
      fn: options.onReadonlyArchiveAction,
      subtle: true,
    };
  }
  if (untrusted) {
    return {
      text: translateDesktop(locale, 'composer.untrustedHint'),
      act: translateDesktop(locale, 'composer.trustFolderBtn'),
      fn: options.onRequestTrustWorkspace,
    };
  }
  if (noKey) {
    return {
      text: translateDesktop(locale, 'composer.missingKeyHint'),
      act: translateDesktop(locale, 'composer.openModelSettingsBtn'),
      fn: options.onOpenModelSettings,
    };
  }
  if (options.quotaExhausted) {
    return {
      text: translateDesktop(locale, 'composer.quotaHint'),
      act: translateDesktop(locale, 'composer.switchModelBtn'),
      fn: options.onSwitchModel,
    };
  }
  return options.stagedHintText ? { text: options.stagedHintText, subtle: true } : null;
}

/**
 * 组装输入框底栏「会话空间」与「权限档位」下拉菜单项。
 */
export function buildOmniBarMenus(
  spaces: readonly WorkspaceSpace[],
  onSelectWorkspace?: (space: WorkspaceSpace) => void,
  onCreateProject?: () => void,
  onSelectPermissionMode?: (mode: ComposerPermissionMode) => void,
  locale: ResolvedDesktopLocale = 'zh-CN',
): { readonly spaceItems: ActionMenuEntry[]; readonly modeItems: ActionMenuEntry[] } {
  const spaceItems: ActionMenuEntry[] = spaces.map((sp) => ({
    id: `space:${sp.id}`,
    label: sp.name,
    icon: 'folder',
    onSelect: () => onSelectWorkspace?.(sp),
  }));
  if (onCreateProject) {
    if (spaces.length > 0) spaceItems.push({ type: 'separator', id: 'sep-proj' });
    spaceItems.push({
      id: 'new-proj',
      label: translateDesktop(locale, 'composer.newProject'),
      icon: 'folder-plus',
      onSelect: onCreateProject,
    });
  }
  const modeItems: ActionMenuEntry[] = MODE_ORDER.map((m) => ({
    id: `mode:${m}`,
    label: modeDisplayName(m, locale),
    icon: m === 'FullAccess' ? 'shield-warning' : m === 'Approval' ? 'hand' : 'shield-check',
    onSelect: () => onSelectPermissionMode?.(m),
  }));
  return { spaceItems, modeItems };
}

const ROLE_LABELS_ZH = {
  default: '默认',
  planning: '规划',
  execution: '执行',
  fast: '快速',
} as const;
const ROLE_LABELS_EN = {
  default: 'Default',
  planning: 'Planning',
  execution: 'Execution',
  fast: 'Fast',
} as const;

/** 解析输入框占位文案，在 `mod-enter` 模式下追加对应系统修饰键提示后缀。 */
export function resolveComposerPlaceholder(params: {
  readonly isOpenedSession: boolean;
  readonly placeholder?: string;
  readonly sendShortcut: 'enter' | 'mod-enter';
  readonly locale: ResolvedDesktopLocale;
}): string {
  if (params.placeholder) return params.placeholder;
  const base = translateDesktop(
    params.locale,
    params.isOpenedSession ? 'composer.placeholderOpen' : 'composer.placeholderNew',
  );
  if (params.sendShortcut !== 'mod-enter') return base;
  const mod =
    typeof document !== 'undefined' && document.documentElement.dataset.platform === 'darwin'
      ? '⌘'
      : 'Ctrl+';
  return `${base}${translateDesktop(params.locale, 'composer.placeholderModEnterSuffix', { mod })}`;
}

/**
 * 生成下一轮模型/角色/跨代理接力暂存提示文案，供根级 `App` 注入 `OmniComposer`。
 */
export function formatStagedTurnHint(params: {
  readonly locale: ResolvedDesktopLocale;
  readonly activeExternalHarnessId?: string;
  readonly activeExtStaged?:
    | { readonly kind: 'local' }
    | {
        readonly kind: 'external';
        readonly harness: {
          readonly id: string;
          readonly name: string;
          readonly modelName?: string;
        };
      };
  readonly hasOpenedNative: boolean;
  readonly currentNativeRole?: keyof typeof ROLE_LABELS_ZH;
  readonly activeStagedToExtName?: string;
  readonly activeStagedLocalRole?: keyof typeof ROLE_LABELS_ZH;
  readonly composerModelName?: string;
}): string | undefined {
  const { locale } = params;
  const en = locale === 'en';
  if (params.activeExternalHarnessId) {
    if (params.activeExtStaged?.kind === 'local') {
      const target = params.composerModelName ?? 'Kapibala';
      return en
        ? `Next message will carry current conversation context back to local ${target}.`
        : `下一轮发送将携带当前对话历史，切换回本地 ${target} 继续。`;
    }
    if (params.activeExtStaged?.kind === 'external') {
      const h = params.activeExtStaged.harness;
      if (h.id !== params.activeExternalHarnessId) {
        return en
          ? `Next message will carry current conversation context into a new ${h.name} session.`
          : `下一轮发送将携带当前对话历史，新建 ${h.name} 会话接力继续。`;
      }
      const label = h.modelName ?? h.name;
      return en
        ? `Switched to ${label}; takes effect on next message.`
        : `已切换至 ${label}，将在下一轮发送时生效。`;
    }
    return undefined;
  }
  if (params.hasOpenedNative && params.activeStagedToExtName) {
    return en
      ? `Next message will carry current conversation context into a new ${params.activeStagedToExtName} session.`
      : `下一轮发送时将携带当前对话上下文，新建 ${params.activeStagedToExtName} 会话接力继续。`;
  }
  if (params.hasOpenedNative && params.activeStagedLocalRole !== undefined) {
    const roleChanged =
      params.activeStagedLocalRole && params.activeStagedLocalRole !== params.currentNativeRole;
    const roleSuffix = roleChanged
      ? en
        ? ` · Role: ${ROLE_LABELS_EN[params.activeStagedLocalRole]}`
        : ` · 角色：${ROLE_LABELS_ZH[params.activeStagedLocalRole]}`
      : '';
    const model = params.composerModelName ?? (en ? 'new model' : '新模型');
    return en
      ? `Switched to ${model}${roleSuffix}; takes effect on next message.`
      : `已切换至 ${model}${roleSuffix}，将在下一轮发送时生效。`;
  }
  return undefined;
}
