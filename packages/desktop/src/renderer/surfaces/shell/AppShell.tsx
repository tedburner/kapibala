import type { ViewExternalHarness } from '@kiturone/kapibala-host/view-model';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useI18n } from '../../i18n.js';
import {
  type InboxItem,
  type SettingsTabId,
  type WorkspaceHierarchyNode,
  type WorkspaceHierarchyView,
  type WorkspaceHistoryPage,
  type WorkspaceSpace,
  selectSessionWorkbench,
  useSessionStore,
  useShellStore,
} from '../../stores/index.js';
import { SplitPane, type ToastItem, ToastViewport } from '../../ui/index.js';
import { CommandPalette } from './CommandPalette.js';
import { NavigationRail } from './NavigationRail.js';
import {
  type ShellViewportTier,
  type ShortcutDispatchContext,
  type ShortcutKeyEventLike,
  dispatchAppShellShortcut,
  isEditableElement,
  resolveViewportTier,
} from './shell-shortcuts.js';

export {
  dispatchAppShellShortcut,
  resolveViewportTier,
  type ShellViewportTier,
  type ShortcutDispatchContext,
  type ShortcutKeyEventLike,
};

/**
 * `AppShell` 入参契约（017 §2）：
 * 组合左栏 `NavigationRail`、双态自适应 `SplitPane`（主对话/启动台/壳内设置 + 右侧多标签工作台）、`CommandPalette` 与右上角 `ToastViewport`。
 */
export interface AppShellProps {
  readonly platform?: 'darwin' | 'win32' | 'linux';
  readonly initialViewportWidth?: number;
  readonly inboxItems: readonly InboxItem[];
  readonly spaces: readonly WorkspaceSpace[];
  readonly hierarchies: Readonly<Record<string, WorkspaceHierarchyView>>;
  readonly historiesByWorkspace?: Readonly<Record<string, WorkspaceHistoryPage>>;
  readonly activeWorkspaceId?: string | null;
  readonly expandedWorkspaces?: Readonly<Record<string, boolean>>;
  readonly newDisabled?: boolean;
  readonly enabledHarnesses?: readonly Pick<ViewExternalHarness, 'id' | 'name' | 'transport'>[];
  readonly topBanner?: ReactNode;
  readonly toasts?: readonly ToastItem[];
  readonly onDismissToast?: (id: string) => void;
  readonly sessionStage: ReactNode;
  readonly launchpadStage: ReactNode;
  readonly workbenchStage?: ReactNode;
  readonly settingsStage?: ReactNode;
  readonly onNewConversation: () => void;
  readonly onCreateProject?: () => void;
  readonly onToggleWorkspace: (workspaceId: string) => void;
  readonly onSelectWorkspace: (space: WorkspaceSpace) => void;
  readonly onNewInWorkspace?: (space: WorkspaceSpace) => void;
  readonly onSelectInboxSession: (sessionKey: string, workspaceId: string) => void;
  readonly onSelectTreeSession: (node: WorkspaceHierarchyNode) => void;
  readonly onSearchSessions?: (query: string) => Promise<readonly WorkspaceHierarchyNode[]>;
  readonly onLaunchExternalHarness?: (harnessId: string) => void;
  readonly onRenameSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onTogglePinSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onArchiveSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onDeleteSession?: (node: WorkspaceHierarchyNode) => void;
  readonly onPageChange?: (space: WorkspaceSpace, page: number) => void;
}

/**
 * Kapibala UI 2.0 顶层响应式应用壳（`AppShell`）。
 */
export function AppShell({
  platform = 'win32',
  initialViewportWidth = 1280,
  inboxItems,
  spaces,
  hierarchies,
  historiesByWorkspace,
  activeWorkspaceId,
  expandedWorkspaces,
  newDisabled = false,
  enabledHarnesses = [],
  topBanner,
  toasts = [],
  onDismissToast,
  sessionStage,
  launchpadStage,
  workbenchStage,
  settingsStage,
  onNewConversation,
  onCreateProject,
  onToggleWorkspace,
  onSelectWorkspace,
  onNewInWorkspace,
  onSelectInboxSession,
  onSelectTreeSession,
  onSearchSessions,
  onLaunchExternalHarness,
  onRenameSession,
  onTogglePinSession,
  onArchiveSession,
  onDeleteSession,
  onPageChange,
}: AppShellProps) {
  const { t } = useI18n();
  const [viewportWidth, setViewportWidth] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth : initialViewportWidth,
  );
  const tier = resolveViewportTier(viewportWidth);

  const activeSurface = useShellStore((s) => s.activeSurface);
  const railOpen = useShellStore((s) => s.railOpen);
  const narrowRailDrawerOpen = useShellStore((s) => s.narrowRailDrawerOpen);
  const commandPaletteOpen = useShellStore((s) => s.commandPaletteOpen);
  const workbenchBySession = useShellStore((s) => s.workbenchBySession);

  const activeSessionKey = useSessionStore((s) => s.activeSessionKey);
  const activeThread = useSessionStore((s) => s.activeThread);
  const replyApproval = useSessionStore((s) => s.replyApproval);

  const workbench = selectSessionWorkbench({ workbenchBySession }, activeSessionKey);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const hasOpenNativeModalOrPopover =
        typeof document !== 'undefined' &&
        Boolean(
          document.querySelector(
            'dialog[open], [popover]:popover-open, [popover][data-open="true"]',
          ),
        );
      dispatchAppShellShortcut(
        {
          key: event.key,
          metaKey: event.metaKey,
          ctrlKey: event.ctrlKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          defaultPrevented: event.defaultPrevented,
          isEditableTarget: isEditableElement(event.target),
          hasOpenNativeModalOrPopover,
          preventDefault: () => event.preventDefault(),
        },
        {
          viewportWidth,
          activeSurface,
          activeSessionKey,
          topApproval: activeThread?.approvals[0],
          onToggleCommandPalette: () => useShellStore.getState().toggleCommandPalette(),
          onToggleSettings: () => useShellStore.getState().toggleSettings(),
          onToggleRail: (w) => useShellStore.getState().toggleRail(w),
          onToggleWorkbench: (key) => useShellStore.getState().toggleWorkbench(key),
          onNewConversation: () => {
            useShellStore.getState().returnToWorkspace();
            onNewConversation();
          },
          onActivateWorkbenchTab: (key, idx) =>
            useShellStore.getState().activateTabByIndex(key, idx),
          onApprovalShortcut: (approvalId, actionId) => {
            void replyApproval(approvalId, actionId);
          },
          onEscapeLayer: () =>
            useShellStore.getState().closeTopmostLayerOnEscape({
              sessionKey: activeSessionKey,
              viewportWidth,
            }),
        },
      );
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    activeSessionKey,
    activeSurface,
    activeThread,
    onNewConversation,
    replyApproval,
    viewportWidth,
  ]);

  const recentSessions = useMemo(
    () =>
      spaces
        .flatMap((sp) => hierarchies[sp.id]?.rootNodes ?? [])
        .sort((a, b) => b.lastActivityAt - a.lastActivityAt),
    [hierarchies, spaces],
  );

  const inlineCollapsed = tier === 'minimal' ? true : !railOpen;
  const rightOpen =
    activeSurface === 'workspace' &&
    Boolean(activeSessionKey) &&
    workbench.open &&
    Boolean(workbenchStage);

  const leftStage =
    activeSurface === 'settings'
      ? (settingsStage ?? launchpadStage)
      : activeSessionKey
        ? sessionStage
        : launchpadStage;

  const openSettingsTab = (tab?: SettingsTabId) => useShellStore.getState().openSettings(tab);
  const closeDrawer = () => useShellStore.getState().setNarrowRailDrawerOpen(false);
  const baseRailProps = {
    platform,
    settingsActive: activeSurface === 'settings',
    newDisabled,
    inboxItems,
    spaces,
    hierarchies,
    historiesByWorkspace,
    activeWorkspaceId,
    activeSessionKey,
    expandedWorkspaces,
    onCreateProject,
    onToggleWorkspace,
    onSelectWorkspace,
    onNewInWorkspace,
    onRenameSession,
    onTogglePinSession,
    onArchiveSession,
    onDeleteSession,
    onPageChange,
  } as const;

  return (
    <div data-viewport={tier} className="kpbl-app-shell">
      <NavigationRail
        {...baseRailProps}
        collapsed={inlineCollapsed}
        onNewConversation={() => {
          useShellStore.getState().returnToWorkspace();
          onNewConversation();
        }}
        onToggleRail={() => useShellStore.getState().toggleRail(viewportWidth)}
        onOpenCommandPalette={() => useShellStore.getState().setCommandPaletteOpen(true)}
        onOpenSettings={() => useShellStore.getState().toggleSettings()}
        onSelectInboxSession={(key, wsId) => {
          useShellStore.getState().returnToWorkspace();
          onSelectInboxSession(key, wsId);
        }}
        onSelectTreeSession={(node) => {
          useShellStore.getState().returnToWorkspace();
          onSelectTreeSession(node);
        }}
      />

      {tier === 'minimal' && narrowRailDrawerOpen ? (
        <>
          <button
            type="button"
            aria-label={t('rail.closeDrawerAria')}
            className="kpbl-drawer-scrim"
            onClick={closeDrawer}
          />
          <NavigationRail
            {...baseRailProps}
            drawerMode={true}
            onNewConversation={() => {
              closeDrawer();
              useShellStore.getState().returnToWorkspace();
              onNewConversation();
            }}
            onToggleRail={closeDrawer}
            onOpenCommandPalette={() => {
              closeDrawer();
              useShellStore.getState().setCommandPaletteOpen(true);
            }}
            onOpenSettings={() => {
              closeDrawer();
              openSettingsTab();
            }}
            onSelectInboxSession={(key, wsId) => {
              closeDrawer();
              useShellStore.getState().returnToWorkspace();
              onSelectInboxSession(key, wsId);
            }}
            onSelectTreeSession={(node) => {
              closeDrawer();
              useShellStore.getState().returnToWorkspace();
              onSelectTreeSession(node);
            }}
          />
        </>
      ) : null}

      <main className="kpbl-shell-main">
        {activeSurface === 'workspace' && topBanner ? topBanner : null}
        <SplitPane
          rightOpen={rightOpen}
          ratio={workbench.widthRatio}
          onRatioChange={(ratio) => {
            if (activeSessionKey) {
              useShellStore
                .getState()
                .setWorkbenchWidthRatio(activeSessionKey, ratio, viewportWidth);
            }
          }}
          left={leftStage}
          right={workbenchStage ?? null}
        />
      </main>

      <CommandPalette
        open={commandPaletteOpen}
        onOpenChange={(open) => useShellStore.getState().setCommandPaletteOpen(open)}
        platform={platform}
        recentSessions={recentSessions}
        enabledHarnesses={enabledHarnesses}
        canToggleWorkbench={Boolean(activeSessionKey && activeSurface === 'workspace')}
        onSearchSessions={onSearchSessions}
        onSelectSession={(node) => {
          useShellStore.getState().returnToWorkspace();
          onSelectTreeSession(node);
        }}
        onLaunchExternalHarness={onLaunchExternalHarness}
        onNewConversation={() => {
          useShellStore.getState().returnToWorkspace();
          onNewConversation();
        }}
        onToggleRail={() => useShellStore.getState().toggleRail(viewportWidth)}
        onToggleWorkbench={() => {
          if (activeSessionKey) useShellStore.getState().toggleWorkbench(activeSessionKey);
        }}
        onOpenSettingsTab={(tab) => openSettingsTab(tab)}
      />

      <ToastViewport toasts={toasts} onDismiss={(id) => onDismissToast?.(id)} />
    </div>
  );
}
