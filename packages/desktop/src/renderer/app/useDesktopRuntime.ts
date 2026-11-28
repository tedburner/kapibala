import { selectMessages } from '@kiturone/kapibala-host/view-model';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DesktopAPI, Output, Workspace } from '../../shared/contracts.js';
import { buildExternalSessionKey, buildNativeSessionKey } from '../adapters/index.js';
import { HistoryListClient } from '../history-list-client.js';
import {
  buildDraftScopeKey,
  useSessionStore,
  useSettingsStore,
  useWorkspaceStore,
} from '../stores/index.js';
import type { PreferredShellId } from '../surfaces/settings/index.js';
import { ViewClient } from '../view-client.js';
import { buildActiveThreadModel, buildLiveStatusMap, failureMessage } from './desktop-helpers.js';
import { useDesktopCatalogs } from './useDesktopCatalogs.js';
import { type ExternalToastNotice, useDesktopEventStream } from './useDesktopEventStream.js';

export type OpenedSession = Output<'session.open'>;
export type SettingsCatalog = Output<'settings.read'>;
export type HarnessCatalogEntry = Pick<
  Output<'external.harnesses'>['harnesses'][number],
  'id' | 'name' | 'transport' | 'cachedConfigOptions' | 'cachedConfigUpdatedAt'
>;

export interface ActiveExternalState {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly subscriptionId: string;
  readonly snapshot: Output<'external.snapshot'>;
}

export interface SessionTerminalSnapshotMap {
  readonly [sessionKey: string]: Output<'terminal.ensure'>;
}

/**
 * 桌面渲染层核心运行时协调 Hook：
 * 管理 `ViewClient` 订阅、空间登记恢复、本地与外部会话快照及 PTY 终端流，并同步四域 Zustand Store。
 */
export function useDesktopRuntime(api: DesktopAPI) {
  const [client] = useState(() => new ViewClient(api));
  const facts = useSyncExternalStore(client.subscribe, client.snapshot);

  const [spaces, setSpaces] = useState<Workspace[]>([]);
  const spacesRef = useRef<Workspace[]>([]);
  const currentSpaceRef = useRef<Workspace | undefined>(undefined);
  const [workspace, setWorkspace] = useState<Workspace>();
  const [trustTarget, setTrustTarget] = useState<Workspace>();
  const [opened, setOpened] = useState<OpenedSession>();
  const [pendingLaunchPrompt, setPendingLaunchPrompt] = useState<string>();
  const [histories, setHistories] = useState<Record<string, Output<'session.list'>>>({});
  const [historyClient] = useState(
    () =>
      new HistoryListClient(
        (id, page) => api.session.list(id, page),
        (id, list) => setHistories((prev) => ({ ...prev, [id]: list })),
      ),
  );

  const [catalog, setCatalog] = useState<SettingsCatalog>();
  const [appInfo, setAppInfo] = useState<Output<'app.getInfo'>>();
  const [preferredShell, setPreferredShell] = useState<PreferredShellId>('auto');
  const [archiveRevision, setArchiveRevision] = useState(0);

  const [externalLists, setExternalLists] = useState<
    Record<string, readonly Output<'external.list'>['items'][number][]>
  >({});
  const [activeExternal, setActiveExternal] = useState<ActiveExternalState>();
  const activeExternalRef = useRef<ActiveExternalState | undefined>(undefined);
  activeExternalRef.current = activeExternal;
  const externalNavGen = useRef(0);

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [dismissedNotices, setDismissedNotices] = useState<Record<string, true>>({});
  const [externalToasts, setExternalToasts] = useState<readonly ExternalToastNotice[]>([]);
  const [terminalBySession, setTerminalBySession] = useState<SessionTerminalSnapshotMap>({});
  const clearSessionTerminals = useCallback((sessionKey: string) => {
    setTerminalBySession((prev) => {
      if (!(sessionKey in prev)) return prev;
      const next = { ...prev };
      delete next[sessionKey];
      return next;
    });
  }, []);

  const act = useCallback(async (task: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (reason) {
      setError(failureMessage(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  const reloadCatalog = useCallback(async () => {
    const targetId = currentSpaceRef.current?.trusted ? currentSpaceRef.current.id : undefined;
    setCatalog(await api.settings.read(targetId));
  }, [api]);

  const refreshHistory = useCallback(
    async (space = currentSpaceRef.current, page?: number) => {
      if (!space?.trusted) return;
      await historyClient.refresh(space.id, page);
    },
    [historyClient],
  );

  const externalListInFlight = useRef(new Map<string, { running: boolean; queued: boolean }>());
  const refreshExternalSpace = useCallback(
    async (id: string) => {
      const state = externalListInFlight.current.get(id);
      if (state?.running) {
        state.queued = true;
        return;
      }
      const tracker = { running: true, queued: false };
      externalListInFlight.current.set(id, tracker);
      try {
        do {
          tracker.queued = false;
          try {
            const result = await api.external.list(id);
            setExternalLists((prev) => ({ ...prev, [id]: result.items }));
          } catch {
            /* 空间断连期间保留既有列表。 */
          }
        } while (tracker.queued);
      } finally {
        externalListInFlight.current.delete(id);
      }
    },
    [api],
  );

  const refreshExternalList = useCallback(
    async (spaceId?: string) => {
      const targets = spaceId
        ? spacesRef.current.filter((item) => item.id === spaceId && item.trusted)
        : spacesRef.current.filter((item) => item.trusted);
      if (
        spaceId &&
        targets.length === 0 &&
        currentSpaceRef.current?.id === spaceId &&
        currentSpaceRef.current.trusted
      ) {
        targets.push(currentSpaceRef.current);
      }
      await Promise.all(targets.map((item) => refreshExternalSpace(item.id)));
    },
    [refreshExternalSpace],
  );

  const detachActiveExternal = useCallback(async () => {
    externalNavGen.current += 1;
    const prev = activeExternalRef.current;
    if (!prev) return;
    activeExternalRef.current = undefined;
    setActiveExternal(undefined);
    await api.external.unsubscribe(prev.subscriptionId).catch(() => {});
  }, [api]);

  const selectSpace = useCallback(
    async (space: Workspace | null) => {
      if (!space) return;
      if (!space.trusted) {
        setTrustTarget(space);
        return;
      }
      await detachActiveExternal();
      await client.clear();
      currentSpaceRef.current = space;
      setWorkspace(space);
      setSpaces((previous) => {
        const next = [space, ...previous.filter((item) => item.id !== space.id)].sort(
          (a, b) => Number(b.kind === 'default') - Number(a.kind === 'default'),
        );
        spacesRef.current = next;
        return next;
      });
      setOpened(undefined);
      useSessionStore.getState().openLaunchpad();
      setCatalog(undefined);
      setError('');
      await refreshHistory(space);
      await refreshExternalList(space.id);
      await reloadCatalog();
    },
    [client, detachActiveExternal, refreshExternalList, refreshHistory, reloadCatalog],
  );

  useEffect(() => {
    let cancelled = false;
    const restoreRecentProjects = async (items: Output<'preferences.read'>['recent']) => {
      const restored: Workspace[] = [];
      for (const item of [...items].reverse()) {
        if (cancelled) return;
        try {
          const ws = await api.workspace.openRecent(item.id);
          if (ws && !restored.some((s) => s.id === ws.id)) restored.push(ws);
        } catch {
          /* 已删除历史目录静默跳过。 */
        }
      }
      if (cancelled) return;
      restored.reverse();
      setSpaces((previous) => {
        const known = new Set(previous.map((s) => s.root));
        const additions = restored.filter((s) => !known.has(s.root));
        const next = additions.length > 0 ? [...previous, ...additions] : previous;
        spacesRef.current = next;
        return next;
      });
      for (const space of restored) {
        if (cancelled) return;
        if (space.trusted) {
          void refreshHistory(space);
          void refreshExternalList(space.id);
        }
      }
    };

    let recentItems: Output<'preferences.read'>['recent'] = [];
    void act(async () => {
      await api.ready();
      void api.app
        .getInfo()
        .then(setAppInfo)
        .catch(() => {});
      await client.connectRuntime();
      const prefs = await api.preferences.read();
      useSettingsStore.getState().hydratePreferences(prefs);
      setPreferredShell(prefs.general.preferredShell);
      recentItems = prefs.recent;
      await selectSpace(await api.workspace.openDefault());
    }).then(() => {
      if (!cancelled && recentItems.length > 0) void restoreRecentProjects(recentItems);
    });

    return () => {
      cancelled = true;
    };
  }, [act, api, client, refreshExternalList, refreshHistory, selectSpace]);

  const syncUpdatedSpace = useCallback(
    async (updated: Workspace) => {
      setSpaces((previous) => {
        const exists = previous.some((item) => item.id === updated.id);
        const next = exists
          ? previous.map((item) => (item.id === updated.id ? updated : item))
          : [...previous, updated];
        spacesRef.current = next;
        return next;
      });
      if (currentSpaceRef.current?.id === updated.id) {
        currentSpaceRef.current = updated;
        setWorkspace(updated);
        if (!updated.trusted) {
          await detachActiveExternal();
          await client.clear();
          setOpened(undefined);
          useSessionStore.getState().openLaunchpad();
        } else {
          await refreshHistory(updated);
          await refreshExternalList(updated.id);
          await reloadCatalog();
        }
      }
    },
    [client, detachActiveExternal, refreshExternalList, refreshHistory, reloadCatalog],
  );

  useDesktopEventStream({
    api,
    activeExternalRef,
    setActiveExternal,
    setExternalToasts,
    setTerminalBySession,
    setPreferredShell,
    refreshExternalList,
    detachActiveExternal,
  });

  useEffect(() => {
    for (const space of spaces) {
      if (
        facts.runtime?.items.some((item) => item.workspaceId === space.id && item.phase === 'idle')
      ) {
        void refreshHistory(space).catch((reason) => setError(failureMessage(reason)));
      }
    }
  }, [facts.runtime, spaces, refreshHistory]);

  const runtimeItem =
    opened && facts.runtime?.items.find((item) => item.sessionId === opened.sessionId);
  const run = opened && (facts.runs[opened.sessionId] ?? runtimeItem);
  const messages = useMemo(() => (facts.state ? selectMessages(facts.state) : []), [facts.state]);

  const catalogs = useDesktopCatalogs({
    api,
    workspace,
    spaces,
    opened,
    activeExternal,
    messages,
    projection: facts.state,
    runPhase: run?.phase,
    archiveRevision,
    setError,
  });

  const activeThread = useMemo(
    () =>
      buildActiveThreadModel({
        workspace,
        opened,
        pendingLaunchPrompt,
        presentation: facts.state,
        runPhase: run?.phase,
        approvals: facts.approvals,
        activeWatchesCount: runtimeItem?.watches ?? 0,
        evidence: catalogs.evidence,
        checkpoints: catalogs.checkpoints,
        histories,
        activeExternal,
      }),
    [
      activeExternal,
      catalogs.checkpoints,
      catalogs.evidence,
      facts.approvals,
      facts.state,
      histories,
      opened,
      pendingLaunchPrompt,
      run?.phase,
      runtimeItem?.watches,
      workspace,
    ],
  );

  useEffect(() => {
    const wsStore = useWorkspaceStore.getState();
    wsStore.setSpaces(spaces);
    wsStore.setActiveWorkspaceId(workspace?.id ?? null);
    for (const [wsId, page] of Object.entries(histories)) wsStore.setWorkspaceHistory(wsId, page);
    for (const [wsId, list] of Object.entries(externalLists)) {
      wsStore.setExternalSessions(wsId, list);
    }
    const nextLive = buildLiveStatusMap({
      spaces,
      histories,
      externalLists,
      runtime: facts.runtime,
      approvals: facts.approvals,
    });
    wsStore.clearLiveStatuses();
    for (const entry of Object.values(nextLive)) wsStore.upsertLiveStatus(entry);
  }, [externalLists, facts.approvals, facts.runtime, histories, spaces, workspace?.id]);

  useEffect(() => {
    const sessStore = useSessionStore.getState();
    if (activeThread) sessStore.setActiveSession(activeThread.sessionKey, activeThread);
    else sessStore.openLaunchpad();
  }, [activeThread]);

  const loadedConvId = facts.state?.identity.conversationId;
  useEffect(() => {
    if (opened && loadedConvId === opened.conversationId && messages.length > 0) {
      const key = buildDraftScopeKey(
        buildNativeSessionKey(opened.workspaceId, opened.conversationId),
        opened.workspaceId,
      );
      useSessionStore.getState().seedSessionPromptHistory(key, messages);
    }
  }, [loadedConvId, messages, opened]);

  useEffect(() => {
    if (activeExternal && activeExternal.snapshot.messages.length > 0) {
      const key = buildDraftScopeKey(
        buildExternalSessionKey(activeExternal.sessionId),
        activeExternal.workspaceId,
      );
      useSessionStore.getState().seedSessionPromptHistory(key, activeExternal.snapshot.messages);
    }
  }, [activeExternal]);

  return {
    client,
    facts,
    spaces,
    spacesRef,
    currentSpaceRef,
    workspace,
    trustTarget,
    setTrustTarget,
    opened,
    setOpened,
    pendingLaunchPrompt,
    setPendingLaunchPrompt,
    histories,
    catalog,
    reloadCatalog,
    appInfo,
    preferredShell,
    setPreferredShell,
    archiveRevision,
    bumpArchiveRevision: () => setArchiveRevision((v) => v + 1),
    externalLists,
    activeExternal,
    setActiveExternal,
    activeExternalRef,
    externalNavGen,
    detachActiveExternal,
    syncUpdatedSpace,
    refreshHistory,
    refreshExternalList,
    selectSpace,
    error,
    setError,
    busy,
    act,
    dismissedNotices,
    dismissNotice: (id: string) => setDismissedNotices((prev) => ({ ...prev, [id]: true })),
    externalToasts,
    setExternalToasts,
    terminalBySession,
    setTerminalBySession,
    clearSessionTerminals,
    messages,
    run,
    activeThread,
    ...catalogs,
  };
}
