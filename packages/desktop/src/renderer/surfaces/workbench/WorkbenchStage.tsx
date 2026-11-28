import type { ViewArtifact } from '@kiturone/kapibala-host/view-model';
import { type KeyboardEvent, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand';
import type { UnifiedApprovalItem } from '../../adapters/index.js';
import { useI18n } from '../../i18n.js';
import {
  type ShellStoreState,
  WORKBENCH_TAB_LABELS,
  WORKBENCH_TAB_ORDER,
  type WorkbenchTab,
  type WorkbenchTabKind,
  selectSessionWorkbench,
  useSettingsStore,
  useShellStore,
} from '../../stores/index.js';
import { Button, Icon, IconButton, type IconName, ModalDialog } from '../../ui/index.js';
import { DiffTab, type DiffTabProps } from './DiffTab.js';
import { FilesTab, type FilesTabProps } from './FilesTab.js';
import { InspectorTab, type InspectorTabProps } from './InspectorTab.js';
import { PreviewTab, type PreviewTabProps } from './PreviewTab.js';
import { TerminalTab, type TerminalTabProps } from './TerminalTab.js';

const TAB_ICONS: Readonly<Record<WorkbenchTabKind, IconName>> = {
  diff: 'git-diff',
  preview: 'eye',
  files: 'file-code',
  terminal: 'terminal',
  inspector: 'sliders',
};

/**
 * `WorkbenchStage` 入参契约（017 §6.5, §7 & 018 §6）：
 * - 外层严格渲染 `<aside aria-label="工作台面板">`（对应 E2E `complementary[name="工作台面板"]`）；
 * - 顶栏暴露 `role="tablist"` 与精确无障碍名 `变更`、`预览`、`文件`、`终端`、`详情与证据`，右侧配 `IconButton[aria-label="关闭工作台"]`；
 * - **终端保活铁律（018 §6.2）**：只要当前会话已打开过 `terminal` 标签（或显式激活过终端），`TerminalTab` 始终挂载在 DOM 内并通过 `hidden={activeKind !== 'terminal'}` 切换显隐，杜绝切去 `变更 / 预览 / 文件 / 详情与证据` 时卸载重绘。
 */
export interface WorkbenchStageProps {
  readonly sessionKey: string;
  readonly shellStore?: StoreApi<ShellStoreState>;
  readonly tabs?: readonly WorkbenchTab[];
  readonly activeKind?: WorkbenchTabKind;
  readonly keepTerminalMounted?: boolean;
  readonly diffProps?: DiffTabProps;
  readonly previewProps?: PreviewTabProps;
  readonly filesProps?: FilesTabProps;
  readonly terminalProps?: Omit<TerminalTabProps, 'sessionKey'>;
  readonly inspectorProps?: InspectorTabProps;
  readonly onActivateKind?: (kind: WorkbenchTabKind) => void;
  readonly onCloseTab?: (tabId: string) => void;
  readonly onCloseWorkbench?: () => void;
}

function readPayloadString(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): string | undefined {
  const val = payload?.[key];
  return typeof val === 'string' && val.length > 0 ? val : undefined;
}

function readPayloadNumber(
  payload: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const val = payload?.[key];
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}

/**
 * 右侧可调宽五标签工程工作台（取代旧版单槽位 `DetailsDrawer`）。
 */
export function WorkbenchStage({
  sessionKey,
  shellStore = useShellStore,
  tabs: controlledTabs,
  activeKind: controlledActiveKind,
  keepTerminalMounted = false,
  diffProps,
  previewProps,
  filesProps,
  terminalProps,
  inspectorProps,
  onActivateKind,
  onCloseTab,
  onCloseWorkbench,
}: WorkbenchStageProps) {
  const { locale, t } = useI18n();
  const confirmCloseActiveTerminal = useSettingsStore((s) => s.confirmations.closeActiveTerminal);
  const baseId = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const cancelCloseTermTabRef = useRef<HTMLButtonElement | null>(null);
  const [pendingCloseTermTabId, setPendingCloseTermTabId] = useState<string>();
  const tabLabels: Readonly<Record<WorkbenchTabKind, string>> = useMemo(
    () =>
      locale === 'en'
        ? {
            diff: t('workbench.tab.diff'),
            preview: t('workbench.tab.preview'),
            files: t('workbench.tab.files'),
            terminal: t('workbench.tab.terminal'),
            inspector: t('workbench.tab.inspector'),
          }
        : WORKBENCH_TAB_LABELS,
    [locale, t],
  );

  const storeSessionState = useSyncExternalStore(
    shellStore.subscribe,
    () => selectSessionWorkbench(shellStore.getState(), sessionKey),
    () => selectSessionWorkbench(shellStore.getState(), sessionKey),
  );
  const openTabs = controlledTabs ?? storeSessionState.tabs;

  const activeTabFromStore = useMemo(
    () => openTabs.find((t) => t.id === storeSessionState.activeTabId) ?? openTabs[0],
    [openTabs, storeSessionState.activeTabId],
  );

  const activeKind: WorkbenchTabKind =
    controlledActiveKind ?? activeTabFromStore?.kind ?? 'inspector';

  const tabByKind = useMemo(() => {
    const map = new Map<WorkbenchTabKind, WorkbenchTab>();
    for (const tab of openTabs) {
      map.set(tab.kind, tab);
    }
    if (activeTabFromStore) {
      map.set(activeTabFromStore.kind, activeTabFromStore);
    }
    return map;
  }, [activeTabFromStore, openTabs]);

  const hasOpenTerminal =
    keepTerminalMounted || activeKind === 'terminal' || tabByKind.has('terminal');

  const handleSelectKind = (kind: WorkbenchTabKind) => {
    if (onActivateKind) {
      onActivateKind(kind);
      return;
    }
    const existing = tabByKind.get(kind);
    const api = shellStore.getState();
    if (existing) {
      api.setActiveWorkbenchTab(sessionKey, existing.id);
    } else {
      api.openWorkbenchTab(sessionKey, { kind });
    }
  };

  const executeCloseSingleTab = (tabId: string, closeRunningTerminals = false) => {
    setPendingCloseTermTabId(undefined);
    if (closeRunningTerminals && terminalProps?.onCloseTerminal) {
      for (const term of terminalProps.terminals ?? []) {
        terminalProps.onCloseTerminal(term.id);
      }
    }
    if (onCloseTab) {
      onCloseTab(tabId);
      return;
    }
    shellStore.getState().closeWorkbenchTab(sessionKey, tabId);
  };

  const handleCloseSingleTab = (tab: WorkbenchTab) => {
    const hasRunningPty =
      tab.kind === 'terminal' &&
      Boolean(
        terminalProps?.terminals?.some(
          (term) => term.status === 'running' || term.status === 'starting',
        ),
      );
    if (hasRunningPty && confirmCloseActiveTerminal) {
      setPendingCloseTermTabId(tab.id);
      return;
    }
    executeCloseSingleTab(tab.id, tab.kind === 'terminal');
  };

  const handleCloseWorkbench = () => {
    if (onCloseWorkbench) {
      onCloseWorkbench();
      return;
    }
    shellStore.getState().setWorkbenchOpen(sessionKey, false);
  };

  const handleTabListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const currentIdx = Math.max(0, WORKBENCH_TAB_ORDER.indexOf(activeKind));
    let nextIdx: number | null = null;
    if (event.key === 'ArrowRight') {
      nextIdx = (currentIdx + 1) % WORKBENCH_TAB_ORDER.length;
    } else if (event.key === 'ArrowLeft') {
      nextIdx = (currentIdx - 1 + WORKBENCH_TAB_ORDER.length) % WORKBENCH_TAB_ORDER.length;
    } else if (event.key === 'Home') {
      nextIdx = 0;
    } else if (event.key === 'End') {
      nextIdx = WORKBENCH_TAB_ORDER.length - 1;
    }
    if (nextIdx !== null) {
      event.preventDefault();
      const targetKind = WORKBENCH_TAB_ORDER[nextIdx];
      if (targetKind) {
        tabRefs.current[nextIdx]?.focus();
        handleSelectKind(targetKind);
      }
    }
  };

  const tabIdFor = (kind: WorkbenchTabKind) => `${baseId}-tab-${kind}`;
  const panelIdFor = (kind: WorkbenchTabKind) => `${baseId}-panel-${kind}`;

  const diffPayload = tabByKind.get('diff')?.payload;
  const previewPayload = tabByKind.get('preview')?.payload;
  const filesPayload = tabByKind.get('files')?.payload;
  const terminalPayload = tabByKind.get('terminal')?.payload;
  const inspectorPayload = tabByKind.get('inspector')?.payload;

  const mergedPreviewArtifact =
    previewProps?.artifact ?? (previewPayload?.artifact as ViewArtifact | undefined);
  const mergedInspectorApproval =
    inspectorProps?.selectedApproval ??
    (inspectorPayload?.approval as UnifiedApprovalItem | undefined);

  return (
    <aside aria-label={t('workbench.landmark')} className="kpbl-workbench-stage">
      <header className="kpbl-workbench-header">
        <div
          role="tablist"
          aria-label={t('workbench.tablistAria')}
          className="kpbl-workbench-tablist"
          onKeyDown={handleTabListKeyDown}
        >
          {WORKBENCH_TAB_ORDER.map((kind, index) => {
            const label = tabLabels[kind];
            const isSelected = activeKind === kind;
            const matchedTab = tabByKind.get(kind);
            return (
              <div key={kind} className="kpbl-workbench-tab-slot">
                <button
                  ref={(node) => {
                    tabRefs.current[index] = node;
                  }}
                  id={tabIdFor(kind)}
                  type="button"
                  role="tab"
                  aria-label={label}
                  aria-selected={isSelected}
                  aria-controls={panelIdFor(kind)}
                  tabIndex={isSelected ? 0 : -1}
                  className="kpbl-workbench-tab"
                  onClick={() => handleSelectKind(kind)}
                >
                  <Icon name={TAB_ICONS[kind]} size={14} />
                  <span>{label}</span>
                </button>
                {matchedTab && openTabs.length > 1 ? (
                  <IconButton
                    size="xs"
                    icon="x"
                    aria-label={locale === 'en' ? `Close ${label} tab` : `关闭${label}标签`}
                    onClick={() => handleCloseSingleTab(matchedTab)}
                  />
                ) : null}
              </div>
            );
          })}
        </div>

        <IconButton
          size="sm"
          icon="x"
          aria-label={t('workbench.closeAria')}
          onClick={handleCloseWorkbench}
        />
      </header>

      <div className="kpbl-workbench-body">
        {activeKind === 'diff' ? (
          <div
            role="tabpanel"
            id={panelIdFor('diff')}
            aria-labelledby={tabIdFor('diff')}
            className="kpbl-workbench-panel"
          >
            <DiffTab
              {...diffProps}
              selectedFilePath={
                diffProps?.selectedFilePath ?? readPayloadString(diffPayload, 'filePath')
              }
              selectedCheckpointOrdinal={
                diffProps?.selectedCheckpointOrdinal ??
                readPayloadNumber(diffPayload, 'turnOrdinal')
              }
            />
          </div>
        ) : activeKind === 'preview' ? (
          <div
            role="tabpanel"
            id={panelIdFor('preview')}
            aria-labelledby={tabIdFor('preview')}
            className="kpbl-workbench-panel"
          >
            <PreviewTab
              {...previewProps}
              html={previewProps?.html ?? readPayloadString(previewPayload, 'html')}
              htmlLabel={previewProps?.htmlLabel ?? readPayloadString(previewPayload, 'label')}
              artifact={mergedPreviewArtifact}
              initialUrl={previewProps?.initialUrl ?? readPayloadString(previewPayload, 'url')}
            />
          </div>
        ) : activeKind === 'files' ? (
          <div
            role="tabpanel"
            id={panelIdFor('files')}
            aria-labelledby={tabIdFor('files')}
            className="kpbl-workbench-panel"
          >
            <FilesTab
              {...filesProps}
              selectedPath={filesProps?.selectedPath ?? readPayloadString(filesPayload, 'filePath')}
              initialQuery={filesProps?.initialQuery ?? readPayloadString(filesPayload, 'query')}
            />
          </div>
        ) : activeKind === 'inspector' ? (
          <div
            role="tabpanel"
            id={panelIdFor('inspector')}
            aria-labelledby={tabIdFor('inspector')}
            className="kpbl-workbench-panel"
          >
            <InspectorTab
              {...inspectorProps}
              selectedCallId={
                inspectorProps?.selectedCallId ?? readPayloadString(inspectorPayload, 'callId')
              }
              selectedApproval={mergedInspectorApproval}
            />
          </div>
        ) : null}

        {hasOpenTerminal ? (
          <div
            role="tabpanel"
            id={panelIdFor('terminal')}
            aria-labelledby={tabIdFor('terminal')}
            hidden={activeKind !== 'terminal'}
            data-keepalive="terminal"
            className="kpbl-workbench-panel"
          >
            <TerminalTab
              {...terminalProps}
              sessionKey={sessionKey}
              isVisible={activeKind === 'terminal'}
              activeTerminalId={
                terminalProps?.activeTerminalId ?? readPayloadString(terminalPayload, 'terminalId')
              }
            />
          </div>
        ) : null}
      </div>

      <ModalDialog
        open={Boolean(pendingCloseTermTabId)}
        onOpenChange={(open) => !open && setPendingCloseTermTabId(undefined)}
        title={t('archives.terminalConfirmTitle')}
        description={t('archives.terminalConfirmDesc')}
        closeLabel={t('general.cancel')}
        initialFocusRef={cancelCloseTermTabRef}
        footer={
          <>
            <Button
              ref={cancelCloseTermTabRef}
              variant="outline"
              onClick={() => setPendingCloseTermTabId(undefined)}
            >
              {t('general.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() =>
                pendingCloseTermTabId && executeCloseSingleTab(pendingCloseTermTabId, true)
              }
            >
              {t('archives.terminalConfirmAction')}
            </Button>
          </>
        }
      />
    </aside>
  );
}
