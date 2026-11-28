import type { ViewExternalHarness } from '@kiturone/kapibala-host/view-model';
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n.js';
import type { SettingsTabId, WorkspaceHierarchyNode } from '../../stores/index.js';
import { Badge, Icon, type IconName, Kbd, ModalDialog, SearchField } from '../../ui/index.js';
import { buildSettingsNavItems } from '../settings/settings-helpers.js';

/** 命令面板可执行候选条目。 */
export interface CommandPaletteActionItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly subtitle?: string;
  readonly badge?: string;
  readonly shortcut?: string;
  readonly icon: IconName;
  readonly keywords?: string;
  readonly onSelect: () => void;
}

/**
 * `CommandPalette` 入参契约（017 §6.8 & §7）：
 * 封装原生 `ModalDialog`（可访问名 `命令面板`，`closedBy="any"`）与 `searchbox[aria-label="搜索会话或命令"]`，
 * 统一提供运行中/最近会话检索、快速新建外部代理会话、分栏切换与设置分组直达。
 */
export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly platform?: 'darwin' | 'win32' | 'linux';
  readonly recentSessions?: readonly WorkspaceHierarchyNode[];
  readonly enabledHarnesses?: readonly Pick<ViewExternalHarness, 'id' | 'name' | 'transport'>[];
  readonly canToggleWorkbench?: boolean;
  readonly onSearchSessions?: (query: string) => Promise<readonly WorkspaceHierarchyNode[]>;
  readonly onSelectSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onLaunchExternalHarness?: (harnessId: string) => void;
  readonly onNewConversation?: () => void;
  readonly onToggleRail?: () => void;
  readonly onToggleWorkbench?: () => void;
  readonly onOpenSettingsTab?: (tab: SettingsTabId) => void;
}

const SETTINGS_KEYWORDS: Readonly<Record<SettingsTabId, string>> = {
  general: 'general theme dark light language font size 常规 外观 主题 语言 字体 字号',
  providers: 'model provider api key 模型 密钥',
  routing: 'routing default 路由 默认模型',
  external: 'external acp claude codex pi 外部代理',
  permissions: 'permission approval 权限 审批',
  resources: 'mcp skills 资源 技能',
  archives: 'archive 归档 恢复 查看',
  diagnostics: 'diagnostics 诊断 状态',
};

/**
 * 全局 `⌘K` 命令面板（`CommandPalette`）：支持上下方向键、Home/End 循环高亮与 Enter 立即执行。
 */
export function CommandPalette({
  open,
  onOpenChange,
  platform = 'win32',
  recentSessions = [],
  enabledHarnesses = [],
  canToggleWorkbench = false,
  onSearchSessions,
  onSelectSession,
  onLaunchExternalHarness,
  onNewConversation,
  onToggleRail,
  onToggleWorkbench,
  onOpenSettingsTab,
}: CommandPaletteProps) {
  const { locale, t } = useI18n();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [remoteSessions, setRemoteSessions] = useState<readonly WorkspaceHierarchyNode[] | null>(
    null,
  );
  const inputRef = useRef<HTMLInputElement | null>(null);
  const mod = platform === 'darwin' ? '⌘' : 'Ctrl+';

  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      setRemoteSessions(null);
    }
  }, [open]);

  useEffect(() => {
    const trimmed = query.trim();
    if (!open || !trimmed || !onSearchSessions) {
      setRemoteSessions(null);
      return undefined;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void onSearchSessions(trimmed)
        .then((items) => {
          if (!cancelled) setRemoteSessions(items);
        })
        .catch(() => {
          if (!cancelled) setRemoteSessions(null);
        });
    }, 80);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, onSearchSessions]);

  const allItems = useMemo<readonly CommandPaletteActionItem[]>(() => {
    const entries: CommandPaletteActionItem[] = [];
    const sessionSource = remoteSessions !== null ? remoteSessions : recentSessions.slice(0, 12);

    for (const session of sessionSource) {
      entries.push({
        id: `session:${session.sessionKey}`,
        group: t('palette.groupRecent'),
        label: session.title,
        subtitle: session.harnessLabel,
        badge: session.statusText,
        icon: session.kind === 'external' ? 'plugs-connected' : 'file-text',
        keywords: `${session.title} ${session.harnessLabel ?? ''} ${session.worktree?.branch ?? ''} ${remoteSessions !== null ? query : ''}`,
        onSelect: () => onSelectSession?.(session),
      });
    }

    for (const harness of enabledHarnesses) {
      entries.push({
        id: `harness:${harness.id}`,
        group: t('palette.groupExternal'),
        label: locale === 'en' ? `New ${harness.name} Chat` : `新建 ${harness.name} 会话`,
        badge: harness.transport.toUpperCase(),
        icon: 'plugs-connected',
        keywords: `${harness.name} ${harness.transport} external 新建 代理`,
        onSelect: () => onLaunchExternalHarness?.(harness.id),
      });
    }

    if (onNewConversation) {
      entries.push({
        id: 'cmd:new-conversation',
        group: t('palette.groupActions'),
        label: t('rail.newChat'),
        shortcut: `${mod}N`,
        icon: 'plus',
        keywords: 'new chat launchpad 新建对话 启动台',
        onSelect: onNewConversation,
      });
    }
    if (canToggleWorkbench && onToggleWorkbench) {
      entries.push({
        id: 'cmd:toggle-workbench',
        group: t('palette.groupActions'),
        label: t('header.toggleWorkbenchAria'),
        shortcut: `${mod}J`,
        icon: 'split-horizontal',
        keywords: 'workbench split diff preview files terminal 工作台 分栏',
        onSelect: onToggleWorkbench,
      });
    }
    if (onToggleRail) {
      entries.push({
        id: 'cmd:toggle-rail',
        group: t('palette.groupActions'),
        label: t('rail.toggle'),
        shortcut: `${mod}B`,
        icon: 'sidebar',
        keywords: 'sidebar rail 侧栏 导航',
        onSelect: onToggleRail,
      });
    }

    if (onOpenSettingsTab) {
      for (const sec of buildSettingsNavItems(locale)) {
        entries.push({
          id: `settings:${sec.id}`,
          group: t('palette.groupSettings'),
          label: t('palette.gotoSettings', { label: sec.label }),
          shortcut: sec.id === 'general' ? `${mod},` : undefined,
          icon: sec.icon,
          keywords: SETTINGS_KEYWORDS[sec.id],
          onSelect: () => onOpenSettingsTab(sec.id),
        });
      }
    }

    return entries;
  }, [
    canToggleWorkbench,
    enabledHarnesses,
    locale,
    mod,
    onLaunchExternalHarness,
    onNewConversation,
    onOpenSettingsTab,
    onSelectSession,
    onToggleRail,
    onToggleWorkbench,
    query,
    recentSessions,
    remoteSessions,
    t,
  ]);

  const filteredItems = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return allItems;
    return allItems.filter((item) =>
      `${item.label} ${item.subtitle ?? ''} ${item.group} ${item.keywords ?? ''}`
        .toLowerCase()
        .includes(keyword),
    );
  }, [allItems, query]);

  const safeIndex =
    filteredItems.length === 0 ? -1 : Math.min(activeIndex, filteredItems.length - 1);

  const grouped = useMemo(() => {
    const map = new Map<string, Array<{ item: CommandPaletteActionItem; flatIdx: number }>>();
    filteredItems.forEach((item, flatIdx) => {
      const list = map.get(item.group) ?? [];
      list.push({ item, flatIdx });
      map.set(item.group, list);
    });
    return [...map.entries()];
  }, [filteredItems]);

  const executeItem = (item: CommandPaletteActionItem | undefined) => {
    if (!item) return;
    onOpenChange(false);
    item.onSelect();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (filteredItems.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((prev) => (prev + 1) % filteredItems.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((prev) => (prev - 1 + filteredItems.length) % filteredItems.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setActiveIndex(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setActiveIndex(filteredItems.length - 1);
    } else if (event.key === 'Enter' && safeIndex >= 0) {
      event.preventDefault();
      executeItem(filteredItems[safeIndex]);
    }
  };

  return (
    <ModalDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('palette.title')}
      closedBy="any"
      width="lg"
      initialFocusRef={inputRef}
      closeLabel={t('general.cancel')}
    >
      <SearchField
        ref={inputRef}
        aria-label={t('palette.searchAria')}
        placeholder={t('palette.searchPlaceholder')}
        value={query}
        onValueChange={(next) => {
          setQuery(next);
          setActiveIndex(0);
        }}
        onKeyDown={handleKeyDown}
      />

      <section aria-label="命令面板结果" className="kpbl-palette-results">
        {grouped.length === 0 ? (
          <p className="py-6 text-center text-xs">{t('palette.empty')}</p>
        ) : (
          grouped.map(([groupTitle, entries]) => (
            <div key={groupTitle} className="flex flex-col gap-0.5">
              <div className="kpbl-section-heading">
                <span>{groupTitle}</span>
              </div>
              {entries.map(({ item, flatIdx }) => {
                const highlighted = flatIdx === safeIndex;
                return (
                  <button
                    key={item.id}
                    type="button"
                    aria-current={highlighted ? 'true' : undefined}
                    data-highlighted={highlighted ? 'true' : undefined}
                    className="kpbl-palette-item"
                    onMouseEnter={() => setActiveIndex(flatIdx)}
                    onClick={() => executeItem(item)}
                  >
                    <span className="inline-flex min-w-0 items-center gap-2">
                      <Icon name={item.icon} size={15} />
                      <span className="truncate">{item.label}</span>
                      {item.subtitle ? (
                        <span className="truncate text-xs opacity-70">{item.subtitle}</span>
                      ) : null}
                    </span>
                    <span className="inline-flex shrink-0 items-center gap-1.5">
                      {item.badge ? <Badge>{item.badge}</Badge> : null}
                      {item.shortcut ? <Kbd>{item.shortcut}</Kbd> : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ))
        )}
      </section>
    </ModalDialog>
  );
}
