import { type KeyboardEvent, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Output, Workspace } from '../../../shared/contracts.js';
import type { Inspection, RuntimeSnapshot } from '../../../shared/observations.js';
import { useI18n } from '../../i18n.js';
import {
  type SettingsTabId,
  type ThemeMode,
  useSettingsStore,
  useShellStore,
} from '../../stores/index.js';
import { Button, Icon, ModalDialog } from '../../ui/index.js';
import type { SessionTarget } from '../dialogs/index.js';
import {
  type ArchivedWorkspaceGroup,
  ArchivesPage,
  type ManagedWorktreeSummary,
} from './ArchivesPage.js';
import { DiagnosticsPage } from './DiagnosticsPage.js';
import { ExternalHarnessesPage } from './ExternalHarnessesPage.js';
import { GeneralPage, type PreferredShellId } from './GeneralPage.js';
import { PermissionsPage } from './PermissionsPage.js';
import { ProvidersPage } from './ProvidersPage.js';
import { ResourcesPage } from './ResourcesPage.js';
import { RoutingPage } from './RoutingPage.js';
import type { ExternalHarnessItem, ExternalTemplateItem } from './external-helpers.js';
import {
  type McpCatalog,
  type SettingsCatalog,
  type SkillsCatalog,
  buildSettingsNavItems,
  normalizeSettingsTab,
} from './settings-helpers.js';

/**
 * `SettingsStage` 入参契约（017 §0 铁律 3、§6.7 & §7）：
 * - 作为应用壳主舞台一级全尺寸视图，左侧固定 `196px` 导航轨（顶部 `返回工作台` + 首项 `常规` 在内的 8 个分组入口）；
 * - 「常规」页右上角提供对标 T3 Code 的 `恢复默认设置` 二次确认入口。
 */
export interface SettingsStageProps {
  readonly tab?: SettingsTabId | string;
  readonly initialTab?: SettingsTabId | string;
  readonly onInitialTabConsumed?: () => void;
  readonly onTabChange?: (tab: SettingsTabId) => void;
  readonly onBack?: () => void;
  readonly catalog?: SettingsCatalog;
  readonly reloadCatalog?: () => Promise<void>;
  readonly report?: (message: string) => void;
  readonly spaces?: readonly Workspace[];
  readonly onSpacesChanged?: (updated?: Workspace) => Promise<void> | void;
  readonly workspaceId?: string;
  readonly activeSessionScope?: { readonly workspaceId: string; readonly sessionId: string };
  readonly currentSessionMode?: 'Approval' | 'Plan' | 'Auto' | 'FullAccess';
  readonly onEnableFullAccess?: () => Promise<void>;
  readonly archiveRevision?: number;
  readonly onArchivedChanged?: () => void;
  readonly onOpenRestoredConversation?: (space: Workspace, conversationId: string) => void;
  readonly onRequestDelete?: (target: SessionTarget) => void;
  readonly onPruneWorktrees?: () => Promise<number>;
  readonly hostDown?: boolean;
  readonly runtime?: RuntimeSnapshot;
  readonly inspection?: Inspection;
  readonly activeTerminalsCount?: number;
  readonly appInfo?: Output<'app.getInfo'>;
  readonly preferredShell?: PreferredShellId;
  readonly onPreferredShellChange?: (shell: PreferredShellId) => void;
  readonly initialTheme?: ThemeMode;
  readonly initialHarnesses?: readonly ExternalHarnessItem[];
  readonly initialTemplates?: readonly ExternalTemplateItem[];
  readonly initialMcp?: McpCatalog;
  readonly initialSkills?: SkillsCatalog;
  readonly initialArchivedGroups?: readonly ArchivedWorkspaceGroup[];
  readonly managedWorktrees?: readonly ManagedWorktreeSummary[];
}

/**
 * Kapibala UI 2.0 壳内设置与代理中心主舞台视图（`SettingsStage`）。
 */
export function SettingsStage({
  tab: controlledTab,
  initialTab,
  onInitialTabConsumed,
  onTabChange,
  onBack,
  catalog,
  reloadCatalog,
  report,
  spaces,
  onSpacesChanged,
  workspaceId,
  activeSessionScope,
  currentSessionMode,
  onEnableFullAccess,
  archiveRevision,
  onArchivedChanged,
  onOpenRestoredConversation,
  onRequestDelete,
  onPruneWorktrees,
  hostDown = false,
  runtime,
  inspection,
  activeTerminalsCount,
  appInfo,
  preferredShell,
  onPreferredShellChange,
  initialTheme,
  initialHarnesses,
  initialTemplates,
  initialMcp,
  initialSkills,
  initialArchivedGroups,
  managedWorktrees,
}: SettingsStageProps) {
  const { locale, t } = useI18n();
  const resetGeneralPreferences = useSettingsStore((s) => s.resetGeneralPreferences);
  const storeTab = useShellStore((s) => s.settingsTab);
  const [uncontrolledTab, setUncontrolledTab] = useState<SettingsTabId>(() =>
    initialTab ? normalizeSettingsTab(initialTab) : storeTab,
  );
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const cancelResetRef = useRef<HTMLButtonElement | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const baseId = useId();

  const navItems = useMemo(() => buildSettingsNavItems(locale), [locale]);

  useEffect(() => {
    if (!initialTab) return;
    const normalized = normalizeSettingsTab(initialTab);
    setUncontrolledTab(normalized);
    useShellStore.getState().setSettingsTab(normalized);
    onInitialTabConsumed?.();
  }, [initialTab, onInitialTabConsumed]);

  useEffect(() => {
    if (!controlledTab && !initialTab) {
      setUncontrolledTab(storeTab);
    }
  }, [controlledTab, initialTab, storeTab]);

  const activeTab: SettingsTabId = controlledTab
    ? normalizeSettingsTab(controlledTab)
    : uncontrolledTab;
  const activeIndex = Math.max(
    0,
    navItems.findIndex((item) => item.id === activeTab),
  );
  const activeMeta = navItems[activeIndex] ?? navItems[0]!;
  const panelId = `${baseId}-panel-${activeMeta.id}`;
  const activeTabDomId = `${baseId}-tab-${activeMeta.id}`;

  function selectTab(nextTab: SettingsTabId): void {
    setUncontrolledTab(nextTab);
    useShellStore.getState().setSettingsTab(nextTab);
    onTabChange?.(nextTab);
  }

  function handleBack(): void {
    useShellStore.getState().returnToWorkspace();
    onBack?.();
  }

  function handleTabListKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const total = navItems.length;
    let nextIdx = -1;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      nextIdx = (activeIndex + 1) % total;
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      nextIdx = (activeIndex - 1 + total) % total;
    } else if (event.key === 'Home') {
      nextIdx = 0;
    } else if (event.key === 'End') {
      nextIdx = total - 1;
    }
    if (nextIdx >= 0) {
      event.preventDefault();
      const target = navItems[nextIdx];
      if (target) {
        tabRefs.current[nextIdx]?.focus();
        selectTab(target.id);
      }
    }
  }

  return (
    <section aria-label={t('settings.landmark')} className="kpbl-settings-stage">
      <aside aria-label={t('settings.railAria')} className="kpbl-settings-rail">
        <Button
          variant="ghost"
          size="md"
          leadingIcon="arrow-left"
          aria-label={t('settings.backBtn')}
          className="kpbl-settings-back-btn"
          onClick={handleBack}
        >
          {t('settings.backBtn')}
        </Button>

        <div
          role="tablist"
          aria-orientation="vertical"
          aria-label={t('settings.tablistAria')}
          className="kpbl-settings-tablist"
          onKeyDown={handleTabListKeyDown}
        >
          {navItems.map((item, idx) => {
            const selected = item.id === activeMeta.id;
            return (
              <button
                key={item.id}
                ref={(node) => {
                  tabRefs.current[idx] = node;
                }}
                id={`${baseId}-tab-${item.id}`}
                type="button"
                role="tab"
                aria-selected={selected}
                aria-controls={selected ? panelId : undefined}
                tabIndex={selected ? 0 : -1}
                className="kpbl-settings-tab"
                onClick={() => selectTab(item.id)}
              >
                <Icon name={item.icon} size={16} />
                <span className="kpbl-settings-tab-label">{item.label}</span>
              </button>
            );
          })}
        </div>
      </aside>

      <div className="kpbl-settings-main">
        <div data-wide={activeMeta.wide ? 'true' : undefined} className="kpbl-settings-container">
          <header className="kpbl-settings-page-header">
            <div className="kpbl-settings-page-header-row">
              <h2 className="kpbl-settings-page-title">{activeMeta.label}</h2>
              {activeMeta.id === 'general' ? (
                <Button
                  variant="ghost"
                  size="xs"
                  leadingIcon="arrow-clockwise"
                  onClick={() => setResetConfirmOpen(true)}
                >
                  {t('general.resetBtn')}
                </Button>
              ) : null}
            </div>
            <p className="kpbl-settings-page-desc">{activeMeta.description}</p>
          </header>

          {hostDown ? (
            <div role="alert" className="kpbl-settings-banner" data-tone="danger">
              <span>{t('settings.hostDown')}</span>
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  if (typeof window !== 'undefined' && window.kapibala) {
                    void window.kapibala.app.reconnect().catch((err: unknown) => {
                      report?.(err instanceof Error ? err.message : '重新连接请求失败。');
                    });
                  }
                }}
              >
                {t('settings.reconnect')}
              </Button>
            </div>
          ) : null}

          <div role="tabpanel" id={panelId} aria-labelledby={activeTabDomId}>
            {activeMeta.id === 'general' ? (
              <GeneralPage
                active
                appInfo={appInfo}
                initialTheme={initialTheme}
                preferredShell={preferredShell}
                onPreferredShellChange={onPreferredShellChange}
                report={report}
              />
            ) : activeMeta.id === 'providers' ? (
              <ProvidersPage
                catalog={catalog}
                reload={reloadCatalog}
                report={report}
                hostDown={hostDown}
              />
            ) : activeMeta.id === 'routing' ? (
              <RoutingPage
                catalog={catalog}
                reload={reloadCatalog}
                report={report}
                hostDown={hostDown}
              />
            ) : activeMeta.id === 'external' ? (
              <ExternalHarnessesPage
                active
                workspaceId={workspaceId}
                hostDown={hostDown}
                report={report}
                initialHarnesses={initialHarnesses}
                initialTemplates={initialTemplates}
              />
            ) : activeMeta.id === 'permissions' ? (
              <PermissionsPage
                catalog={catalog}
                spaces={spaces}
                activeSessionScope={activeSessionScope}
                currentSessionMode={currentSessionMode}
                hostDown={hostDown}
                reload={reloadCatalog}
                onSpacesChanged={onSpacesChanged}
                onEnableFullAccess={onEnableFullAccess}
                report={report}
              />
            ) : activeMeta.id === 'resources' ? (
              <ResourcesPage
                active
                workspaceId={workspaceId}
                inspection={inspection}
                hostDown={hostDown}
                report={report}
                initialMcp={initialMcp}
                initialSkills={initialSkills}
              />
            ) : activeMeta.id === 'archives' ? (
              <ArchivesPage
                active
                spaces={spaces}
                archiveRevision={archiveRevision}
                initialArchivedGroups={initialArchivedGroups}
                managedWorktrees={managedWorktrees}
                onArchivedChanged={onArchivedChanged}
                onOpenRestoredConversation={onOpenRestoredConversation}
                onRequestDelete={onRequestDelete}
                onPruneWorktrees={onPruneWorktrees}
                report={report}
              />
            ) : (
              <DiagnosticsPage
                active
                appInfo={appInfo}
                runtime={runtime}
                inspection={inspection}
                activeTerminalsCount={activeTerminalsCount}
                hostDown={hostDown}
                report={report}
              />
            )}
          </div>
        </div>
      </div>

      <ModalDialog
        open={resetConfirmOpen}
        onOpenChange={setResetConfirmOpen}
        title={t('general.resetTitle')}
        description={t('general.resetDesc')}
        closeLabel={t('general.cancel')}
        initialFocusRef={cancelResetRef}
        footer={
          <>
            <Button
              ref={cancelResetRef}
              variant="outline"
              onClick={() => setResetConfirmOpen(false)}
            >
              {t('general.cancel')}
            </Button>
            <Button
              variant="solid"
              onClick={() => {
                setResetConfirmOpen(false);
                onPreferredShellChange?.('auto');
                void resetGeneralPreferences().catch((err: unknown) =>
                  report?.(err instanceof Error ? err.message : '重置常规设置失败。'),
                );
              }}
            >
              {t('general.resetConfirm')}
            </Button>
          </>
        }
      />
    </section>
  );
}
