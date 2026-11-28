import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../../i18n.js';
import { useSettingsStore } from '../../stores/index.js';
import {
  Badge,
  Button,
  EmptyState,
  ModalDialog,
  Select,
  type SelectOption,
  StatusDot,
  TextField,
} from '../../ui/index.js';
import { XtermViewport } from './XtermViewport.js';

/** 单个会话允许同时开启的子终端硬上限（018 §6.2；全宿主上限 8 个由 `agent-host` 强控）。 */
export const MAX_SESSION_TERMINALS = 3;

/** 宿主探测到的可用交互式 Shell 候选项。 */
export interface TerminalShellOption {
  readonly id: string;
  readonly label: string;
}

/** 单个会话级保活伪终端实例快照。 */
export interface TerminalInstanceState {
  readonly id: string;
  readonly title?: string;
  readonly cwdLabel?: string;
  readonly shell?: string;
  readonly status: 'starting' | 'running' | 'exited' | 'unavailable';
  readonly exitCode?: number | null;
  readonly replayBuffer?: string;
  readonly unavailableReason?: string;
  readonly generation?: number;
}

/** 传递给可插拔终端渲染器（`@xterm/xterm` 适配器或自定义视口）的受控上下文。 */
export interface TerminalViewportRenderProps {
  readonly sessionKey: string;
  readonly terminal: TerminalInstanceState;
  readonly active: boolean;
  readonly onWriteInput: (data: string) => void;
  readonly onResize: (cols: number, rows: number) => void;
}

/** 命令式 DOM 挂载适配器契约：接收容器节点与终端上下文，返回可选卸载清理回调。 */
export type TerminalRendererMount = (
  container: HTMLDivElement,
  context: TerminalViewportRenderProps,
) => (() => void) | undefined;

/** `TerminalTab` 入参契约：支持单会话最多 3 个子终端标签、Shell 切换、清屏、重拉与不可用降级。 */
export interface TerminalTabProps {
  readonly sessionKey: string;
  readonly repoLabel?: string;
  readonly isVisible?: boolean;
  readonly terminals?: readonly TerminalInstanceState[];
  readonly activeTerminalId?: string;
  readonly shells?: readonly TerminalShellOption[];
  readonly selectedShell?: string;
  readonly unavailableReason?: string;
  readonly useFallbackViewport?: boolean;
  readonly renderXtermViewport?: (props: TerminalViewportRenderProps) => ReactNode;
  readonly onMountRenderer?: TerminalRendererMount;
  readonly onSelectTerminal?: (terminalId: string) => void;
  readonly onCreateTerminal?: (shellId?: string) => void;
  readonly onSelectShell?: (shellId: string) => void;
  readonly onClearTerminal?: (terminalId: string) => void;
  readonly onCloseTerminal?: (terminalId: string) => void;
  readonly onRestartTerminal?: (terminalId: string) => void;
  readonly onWriteTerminal?: (terminalId: string, data: string) => void;
  readonly onResizeTerminal?: (terminalId: string, cols: number, rows: number) => void;
}

function MountedXtermHost({
  mount,
  viewportProps,
}: {
  readonly mount: TerminalRendererMount;
  readonly viewportProps: TerminalViewportRenderProps;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const latestPropsRef = useRef(viewportProps);
  latestPropsRef.current = viewportProps;

  useEffect(() => {
    const el = hostRef.current;
    return el ? mount(el, latestPropsRef.current) : undefined;
  }, [mount]);

  return <div ref={hostRef} className="kpbl-terminal-xterm-host" />;
}

function formatSubtabTitle(
  term: TerminalInstanceState,
  repo: string | undefined,
  base: string,
): string {
  if (term.title) return term.title;
  const suffix = term.cwdLabel ?? repo;
  return suffix ? `${base} · ${suffix}` : base;
}

/** 右侧工作台「终端」标签页：通过 `hidden` 保活 DOM，关闭运行中终端时按常规偏好弹出二次确认。 */
export function TerminalTab({
  sessionKey,
  repoLabel = 'repo',
  isVisible = true,
  terminals: externalTerminals,
  activeTerminalId,
  shells = [],
  selectedShell,
  unavailableReason,
  useFallbackViewport = false,
  renderXtermViewport,
  onMountRenderer,
  onSelectTerminal,
  onCreateTerminal,
  onSelectShell,
  onClearTerminal,
  onCloseTerminal,
  onRestartTerminal,
  onWriteTerminal,
  onResizeTerminal,
}: TerminalTabProps) {
  const { t } = useI18n();
  const confirmCloseActive = useSettingsStore((s) => s.confirmations.closeActiveTerminal);
  const terminalFontSize = useSettingsStore((s) => s.typography.terminalFontSize);
  const [pendingCloseId, setPendingCloseId] = useState<string>();
  const cancelCloseRef = useRef<HTMLButtonElement | null>(null);
  const [fallbackTerminals, setFallbackTerminals] = useState<readonly TerminalInstanceState[]>(
    () => [
      { id: `${sessionKey}:term-1`, cwdLabel: repoLabel, status: 'running', replayBuffer: '' },
    ],
  );
  const [internalActiveId, setInternalActiveId] = useState<string>();
  const [internalShell, setInternalShell] = useState<string | undefined>(
    () => selectedShell ?? shells[0]?.id,
  );
  const [commandDrafts, setCommandDrafts] = useState<Readonly<Record<string, string>>>({});
  const [clearedBuffers, setClearedBuffers] = useState<Readonly<Record<string, boolean>>>({});

  const terminals = externalTerminals ?? fallbackTerminals;
  const activeShell = selectedShell ?? internalShell ?? shells[0]?.id;
  const resolvedActiveId =
    activeTerminalId && terminals.some((item) => item.id === activeTerminalId)
      ? activeTerminalId
      : internalActiveId && terminals.some((item) => item.id === internalActiveId)
        ? internalActiveId
        : terminals[0]?.id;
  const activeTerminal = terminals.find((item) => item.id === resolvedActiveId);
  const shellOptions = useMemo<readonly SelectOption<string>[]>(
    () => shells.map((sh) => ({ value: sh.id, label: sh.label, icon: 'terminal' })),
    [shells],
  );
  const canCreateMore = terminals.length < MAX_SESSION_TERMINALS && !unavailableReason;

  const handleCreate = () => {
    if (!canCreateMore) return;
    if (onCreateTerminal) return void onCreateTerminal(activeShell);
    const nextId = `${sessionKey}:term-${Date.now()}-${fallbackTerminals.length + 1}`;
    setFallbackTerminals((prev) => [
      ...prev,
      { id: nextId, cwdLabel: repoLabel, shell: activeShell, status: 'running', replayBuffer: '' },
    ]);
    setInternalActiveId(nextId);
  };

  const handleClear = (termId: string) => {
    setClearedBuffers((prev) => ({ ...prev, [termId]: true }));
    if (!externalTerminals) {
      setFallbackTerminals((prev) =>
        prev.map((item) => (item.id === termId ? { ...item, replayBuffer: '' } : item)),
      );
    }
    onClearTerminal?.(termId);
  };

  const executeClose = (termId: string) => {
    setPendingCloseId(undefined);
    if (onCloseTerminal) return void onCloseTerminal(termId);
    setFallbackTerminals((prev) => prev.filter((item) => item.id !== termId));
  };

  const handleClose = (term: TerminalInstanceState) => {
    if (confirmCloseActive && (term.status === 'running' || term.status === 'starting')) {
      setPendingCloseId(term.id);
      return;
    }
    executeClose(term.id);
  };

  const handleFallbackSubmit = (event: FormEvent<HTMLFormElement>, term: TerminalInstanceState) => {
    event.preventDefault();
    const raw = commandDrafts[term.id] ?? '';
    if (!raw.trim()) return;
    setClearedBuffers((prev) => ({ ...prev, [term.id]: false }));
    if (onWriteTerminal) {
      onWriteTerminal(term.id, `${raw}\r`);
    } else {
      setFallbackTerminals((prev) =>
        prev.map((item) =>
          item.id === term.id
            ? { ...item, replayBuffer: `${item.replayBuffer ?? ''}$ ${raw}\n` }
            : item,
        ),
      );
    }
    setCommandDrafts((prev) => ({ ...prev, [term.id]: '' }));
  };

  const topUnavailable =
    unavailableReason ??
    (activeTerminal?.status === 'unavailable'
      ? (activeTerminal.unavailableReason ?? '当前环境缺少伪终端原生组件（TERMINAL_UNAVAILABLE）。')
      : undefined);

  return (
    <div className="kpbl-workbench-panel">
      <div className="kpbl-terminal-subbar">
        <div
          role="tablist"
          aria-label={t('terminal.subtabsAria')}
          className="kpbl-terminal-subtabs"
        >
          {terminals.map((term, index) => {
            const isSelected = term.id === resolvedActiveId;
            const dotState =
              term.status === 'running' || term.status === 'starting'
                ? 'success'
                : term.status === 'unavailable'
                  ? 'danger'
                  : 'offline';
            return (
              <Button
                key={term.id}
                role="tab"
                aria-selected={isSelected}
                variant={isSelected ? 'outline' : 'ghost'}
                size="xs"
                onClick={() => {
                  setInternalActiveId(term.id);
                  onSelectTerminal?.(term.id);
                }}
              >
                <StatusDot status={dotState} />
                <span>
                  {formatSubtabTitle(term, repoLabel, t('terminal.tabTitle', { index: index + 1 }))}
                </span>
              </Button>
            );
          })}
          <Button
            variant="ghost"
            size="xs"
            disabled={!canCreateMore}
            title={
              terminals.length >= MAX_SESSION_TERMINALS
                ? t('terminal.maxLimitTitle', { max: MAX_SESSION_TERMINALS })
                : t('terminal.newTitle')
            }
            onClick={handleCreate}
          >
            {t('terminal.newBtn')}
          </Button>
        </div>

        <div className="kpbl-wb-toolbar-group">
          {shellOptions.length > 0 ? (
            <Select
              aria-label={t('terminal.shellSelectAria')}
              size="xs"
              value={activeShell}
              options={shellOptions}
              onValueChange={(nextShell) => {
                setInternalShell(nextShell);
                onSelectShell?.(nextShell);
              }}
            />
          ) : null}
          {activeTerminal ? (
            <>
              <Button variant="ghost" size="xs" onClick={() => handleClear(activeTerminal.id)}>
                {t('terminal.clearBtn')}
              </Button>
              <Button
                variant="ghost"
                size="xs"
                leadingIcon="trash"
                onClick={() => handleClose(activeTerminal)}
              >
                {t('terminal.closeBtn')}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {topUnavailable ? (
        <div className="p-4">
          <EmptyState
            icon="warning-circle"
            title={t('terminal.unavailableTitle')}
            description={topUnavailable}
            action={
              onRestartTerminal && activeTerminal ? (
                <Button
                  variant="outline"
                  size="sm"
                  leadingIcon="arrow-clockwise"
                  onClick={() => onRestartTerminal(activeTerminal.id)}
                >
                  {t('terminal.restartBtn')}
                </Button>
              ) : (
                <Badge tone="warning">{t('terminal.unavailableBadge')}</Badge>
              )
            }
          />
        </div>
      ) : terminals.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon="terminal"
            title={t('terminal.emptyTitle')}
            description={t('terminal.emptyDesc')}
            action={
              <Button variant="solid" size="sm" leadingIcon="plus" onClick={handleCreate}>
                {t('terminal.newBtn')}
              </Button>
            }
          />
        </div>
      ) : (
        terminals.map((term) => {
          const isSubActive = term.id === resolvedActiveId;
          const viewportProps: TerminalViewportRenderProps = {
            sessionKey,
            terminal: term,
            active: isSubActive && isVisible,
            onWriteInput: (data) => onWriteTerminal?.(term.id, data),
            onResize: (cols, rows) => onResizeTerminal?.(term.id, cols, rows),
          };
          const visibleReplay = clearedBuffers[term.id] ? '' : (term.replayBuffer ?? '');

          return (
            <div key={term.id} hidden={!isSubActive} className="kpbl-terminal-pane">
              {term.status === 'exited' ? (
                <output data-tone="warning" className="kpbl-wb-banner">
                  <span>{t('terminal.exitedBanner', { code: term.exitCode ?? 0 })}</span>
                  {onRestartTerminal ? (
                    <Button
                      variant="outline"
                      size="xs"
                      leadingIcon="arrow-clockwise"
                      onClick={() => onRestartTerminal(term.id)}
                    >
                      {t('terminal.restartBtn')}
                    </Button>
                  ) : null}
                </output>
              ) : null}

              {renderXtermViewport ? (
                renderXtermViewport(viewportProps)
              ) : onMountRenderer ? (
                <MountedXtermHost
                  key={`${sessionKey}:${term.id}:${term.generation ?? 0}`}
                  mount={onMountRenderer}
                  viewportProps={viewportProps}
                />
              ) : !useFallbackViewport &&
                typeof window !== 'undefined' &&
                Boolean(onWriteTerminal) ? (
                <XtermViewport
                  key={`${sessionKey}:${term.id}:${term.generation ?? 0}`}
                  {...viewportProps}
                />
              ) : (
                <>
                  <pre
                    aria-label={t('terminal.fallbackOutputAria')}
                    style={{ fontSize: `${terminalFontSize}px` }}
                    className="kpbl-terminal-fallback-output"
                  >
                    {visibleReplay || t('terminal.fallbackReady')}
                  </pre>
                  <form
                    className="kpbl-terminal-fallback-form"
                    onSubmit={(event) => handleFallbackSubmit(event, term)}
                  >
                    <TextField
                      mono
                      containerClassName="flex-1"
                      aria-label={t('terminal.fallbackInputAria')}
                      placeholder={t('terminal.fallbackPlaceholder')}
                      disabled={term.status === 'exited'}
                      value={commandDrafts[term.id] ?? ''}
                      onValueChange={(val) =>
                        setCommandDrafts((prev) => ({ ...prev, [term.id]: val }))
                      }
                    />
                    <Button
                      type="submit"
                      variant="solid"
                      size="sm"
                      disabled={term.status === 'exited'}
                    >
                      {t('composer.sendBtn')}
                    </Button>
                  </form>
                </>
              )}
            </div>
          );
        })
      )}

      <ModalDialog
        open={Boolean(pendingCloseId)}
        onOpenChange={(open) => !open && setPendingCloseId(undefined)}
        title={t('archives.terminalConfirmTitle')}
        description={t('archives.terminalConfirmDesc')}
        closeLabel={t('general.cancel')}
        initialFocusRef={cancelCloseRef}
        footer={
          <>
            <Button
              ref={cancelCloseRef}
              variant="outline"
              onClick={() => setPendingCloseId(undefined)}
            >
              {t('general.cancel')}
            </Button>
            <Button variant="danger" onClick={() => pendingCloseId && executeClose(pendingCloseId)}>
              {t('archives.terminalConfirmAction')}
            </Button>
          </>
        }
      />
    </div>
  );
}
