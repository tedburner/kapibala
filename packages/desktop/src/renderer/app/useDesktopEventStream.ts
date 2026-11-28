import { useEffect } from 'react';
import type { DesktopAPI } from '../../shared/contracts.js';
import { applyDesktopPreferencesToDom, useSettingsStore } from '../stores/index.js';
import type { PreferredShellId } from '../surfaces/settings/index.js';
import { emitTerminalStreamData } from '../surfaces/workbench/index.js';
import type { ActiveExternalState, SessionTerminalSnapshotMap } from './useDesktopRuntime.js';

export interface ExternalToastNotice {
  readonly id: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly level: 'info' | 'warning' | 'error';
}

/**
 * 订阅 `DesktopAPI.onEvent` 的外部代理状态变更、常规偏好同步、提醒吐司与保活 PTY 终端流事件。
 */
export function useDesktopEventStream(params: {
  readonly api: DesktopAPI;
  readonly activeExternalRef: React.MutableRefObject<ActiveExternalState | undefined>;
  readonly setActiveExternal: React.Dispatch<React.SetStateAction<ActiveExternalState | undefined>>;
  readonly setExternalToasts: React.Dispatch<React.SetStateAction<readonly ExternalToastNotice[]>>;
  readonly setTerminalBySession: React.Dispatch<React.SetStateAction<SessionTerminalSnapshotMap>>;
  readonly setPreferredShell?: React.Dispatch<React.SetStateAction<PreferredShellId>>;
  readonly refreshExternalList: (spaceId?: string) => Promise<void>;
  readonly detachActiveExternal: () => Promise<void>;
}): void {
  const {
    api,
    activeExternalRef,
    setActiveExternal,
    setExternalToasts,
    setTerminalBySession,
    setPreferredShell,
    refreshExternalList,
    detachActiveExternal,
  } = params;

  useEffect(() => {
    const off = api.onEvent((event) => {
      if (event.type === 'preferences.changed') {
        useSettingsStore.getState().hydratePreferences(event.preferences);
        setPreferredShell?.(event.preferences.general.preferredShell);
        return;
      }
      if (event.type === 'theme.changed') {
        const s = useSettingsStore.getState();
        applyDesktopPreferencesToDom({
          themeMode: s.themeMode,
          systemMode: event.mode,
          resolvedLocale: s.resolvedLocale,
          typography: s.typography,
          codeWordWrap: s.general.codeWordWrap,
        });
        return;
      }
      if (event.type === 'external.listChanged') {
        void refreshExternalList(event.workspaceId);
        return;
      }
      if (event.type === 'external.snapshotChanged') {
        setActiveExternal((prev) => {
          if (!prev || prev.subscriptionId !== event.subscriptionId) return prev;
          if (event.snapshot.sequence !== 0 && event.snapshot.sequence < prev.snapshot.sequence) {
            return prev;
          }
          const next = { ...prev, snapshot: event.snapshot };
          activeExternalRef.current = next;
          return next;
        });
        return;
      }
      if (event.type === 'external.snapshotInvalidated') {
        const cur = activeExternalRef.current;
        if (!cur || cur.subscriptionId !== event.subscriptionId) return;
        const nextSubId = crypto.randomUUID();
        void api.external
          .subscribe({
            workspaceId: cur.workspaceId,
            sessionId: cur.sessionId,
            subscriptionId: nextSubId,
          })
          .then((snapshot) => {
            if (activeExternalRef.current?.subscriptionId !== event.subscriptionId) {
              void api.external.unsubscribe(nextSubId).catch(() => {});
              return;
            }
            const updated = { ...cur, subscriptionId: nextSubId, snapshot };
            activeExternalRef.current = updated;
            setActiveExternal(updated);
          })
          .catch(() => {});
        return;
      }
      if (event.type === 'external.attention') {
        if (activeExternalRef.current?.sessionId === event.sessionId) return;
        const text =
          event.kind === 'approval_requested'
            ? `${event.harnessName} 请求授权 · ${event.title || '外部任务'}`
            : event.kind === 'turn_failed'
              ? `${event.harnessName} 任务失败 · ${event.title || '外部任务'}`
              : `${event.harnessName} 已完成本轮 · ${event.title || '外部任务'}`;
        const level =
          event.kind === 'turn_failed'
            ? 'error'
            : event.kind === 'approval_requested'
              ? 'warning'
              : 'info';
        const toastId = crypto.randomUUID();
        setExternalToasts((prev) =>
          [
            {
              id: toastId,
              workspaceId: event.workspaceId,
              sessionId: event.sessionId,
              text,
              level,
            } as const,
            ...prev,
          ].slice(0, 4),
        );
        if (event.kind === 'turn_completed') {
          window.setTimeout(() => {
            setExternalToasts((prev) => prev.filter((t) => t.id !== toastId));
          }, 5000);
        }
        return;
      }
      if (event.type === 'terminal.data') {
        emitTerminalStreamData(event.sessionKey, event.terminalId, event.data);
        setTerminalBySession((prev) => {
          const snap = prev[event.sessionKey];
          if (!snap) return prev;
          return {
            ...prev,
            [event.sessionKey]: {
              ...snap,
              terminals: snap.terminals.map((t) =>
                t.id === event.terminalId
                  ? { ...t, replayBuffer: `${t.replayBuffer}${event.data}`.slice(-200_000) }
                  : t,
              ),
            },
          };
        });
        return;
      }
      if (event.type === 'terminal.exit') {
        setTerminalBySession((prev) => {
          const snap = prev[event.sessionKey];
          if (!snap) return prev;
          return {
            ...prev,
            [event.sessionKey]: {
              ...snap,
              terminals: snap.terminals.map((t) =>
                t.id === event.terminalId
                  ? { ...t, status: 'exited', exitCode: event.exitCode }
                  : t,
              ),
            },
          };
        });
      }
    });
    return () => {
      off();
      void detachActiveExternal();
    };
  }, [
    activeExternalRef,
    api,
    detachActiveExternal,
    refreshExternalList,
    setActiveExternal,
    setExternalToasts,
    setPreferredShell,
    setTerminalBySession,
  ]);
}
