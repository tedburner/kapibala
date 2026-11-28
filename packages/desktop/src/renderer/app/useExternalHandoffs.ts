import type { DesktopAPI, Workspace } from '../../shared/contracts.js';
import { buildExternalSessionKey, buildNativeSessionKey } from '../adapters/index.js';
import { buildSessionHandoffPayload } from '../handoff-context.js';
import { type ReferenceChip, buildDraftScopeKey, useSessionStore } from '../stores/index.js';
import type { SelectedExternalHarness } from '../surfaces/composer/index.js';
import { buildExternalPromptWithReferences, restoreDraftAndChips } from './useComposerSend.js';
import type { OpenedSession, useDesktopRuntime } from './useDesktopRuntime.js';

type RuntimeBag = ReturnType<typeof useDesktopRuntime>;

export type StagedExternalNext =
  | {
      readonly sessionId: string;
      readonly kind: 'external';
      readonly harness: SelectedExternalHarness;
    }
  | { readonly sessionId: string; readonly kind: 'local'; readonly profileId: string };

/**
 * 执行活跃外部会话发送、跨外部代理接力、外部切回本地接力及本地切外部接力：
 * `handled` 标识是否命中外部或接力分支，`sent` 标识是否实际派发成功（前置拒绝或异常时保留草稿与 `@` 胶囊）。
 */
export async function executeExternalOrHandoffSend(params: {
  readonly api: DesktopAPI;
  readonly rt: RuntimeBag;
  readonly rawInput: string;
  readonly finalInput: string;
  readonly snapshotChips: readonly ReferenceChip[];
  readonly references: readonly {
    readonly sessionId: string;
    readonly recordId?: string;
    readonly branchId?: string;
  }[];
  readonly activeExtStaged?: StagedExternalNext;
  readonly activeStagedToExt?: SelectedExternalHarness;
  readonly composerHarness?: SelectedExternalHarness;
  readonly currentWorktreeOption: () =>
    | { readonly enabled: true; readonly branch?: string }
    | undefined;
  readonly resetWorktreeDraft: () => void;
  readonly createNativeSession: (
    space: Workspace,
    explicitProfileId?: string,
  ) => Promise<OpenedSession>;
  readonly openExternalSession: (space: Workspace, sessionId: string) => Promise<void>;
  readonly clearStagedExternal: () => void;
  readonly clearStagedLocalToExt: () => void;
}): Promise<{ readonly handled: boolean; readonly sent: boolean }> {
  const {
    api,
    rt,
    rawInput,
    finalInput,
    snapshotChips,
    references,
    activeExtStaged,
    activeStagedToExt,
    composerHarness,
    currentWorktreeOption,
    resetWorktreeDraft,
    createNativeSession,
    openExternalSession,
    clearStagedExternal,
    clearStagedLocalToExt,
  } = params;
  const sessStore = useSessionStore.getState();
  const clearScope = (key: string) => {
    sessStore.recordSubmittedPrompt(key, rawInput);
    sessStore.clearReferenceChips(key);
  };

  // 1. 活跃外部会话：切回本地、跨外部代理接力、或同代理续聊。
  if (rt.activeExternal) {
    const cur = rt.activeExternal;
    const extKey = buildDraftScopeKey(buildExternalSessionKey(cur.sessionId), cur.workspaceId);
    const space = rt.spacesRef.current.find((s) => s.id === cur.workspaceId) ?? rt.workspace;
    if (!space?.trusted) return { handled: true, sent: false };

    if (activeExtStaged?.kind === 'local') {
      const handoff = buildSessionHandoffPayload(cur.snapshot.session.title, cur.snapshot.messages);
      let sent = false;
      clearScope(extKey);
      await rt.act(async () => {
        let newKey: string | undefined;
        try {
          const created = await createNativeSession(space, activeExtStaged.profileId);
          const srcTitle = cur.snapshot.session.title.trim();
          if (srcTitle && srcTitle !== '外部任务') {
            await api.session
              .rename({
                workspaceId: created.workspaceId,
                conversationId: created.conversationId,
                title: srcTitle,
              })
              .catch(() => {});
          }
          await rt.detachActiveExternal();
          newKey = buildDraftScopeKey(
            buildNativeSessionKey(created.workspaceId, created.conversationId),
            created.workspaceId,
          );
          sessStore.recordSubmittedPrompt(newKey, finalInput);
          await rt.client.start(
            { workspaceId: created.workspaceId, sessionId: created.sessionId },
            finalInput,
            handoff || references.length > 0
              ? {
                  ...(handoff ? { handoff } : {}),
                  ...(references.length > 0 ? { references } : {}),
                }
              : undefined,
          );
          sent = true;
          await rt.refreshHistory(space);
        } catch (err) {
          restoreDraftAndChips(newKey ?? extKey, rawInput, snapshotChips);
          throw err;
        }
      });
      return { handled: true, sent };
    }

    if (
      activeExtStaged?.kind === 'external' &&
      activeExtStaged.harness.id !== cur.snapshot.session.harnessId
    ) {
      const choice = activeExtStaged.harness;
      const handoff = buildSessionHandoffPayload(cur.snapshot.session.title, cur.snapshot.messages);
      const navBefore = rt.externalNavGen.current;
      let sent = false;
      clearScope(extKey);
      await rt.act(async () => {
        try {
          const promptText = await buildExternalPromptWithReferences({
            api,
            workspaceId: space.id,
            input: finalInput,
            chips: snapshotChips,
          });
          const snap = await api.external.open({
            workspaceId: space.id,
            harnessId: choice.id,
            ...(cur.snapshot.session.title.trim() && cur.snapshot.session.title !== '外部任务'
              ? { title: cur.snapshot.session.title.trim() }
              : {}),
            prompt: promptText,
            ...(choice.modelId ? { modelId: choice.modelId } : {}),
            ...(choice.thoughtLevel ? { thoughtLevel: choice.thoughtLevel } : {}),
            ...(choice.modeId ? { modeId: choice.modeId } : {}),
            ...(handoff ? { handoff } : {}),
          });
          sent = true;
          await rt.reloadHarnessCatalog(space.id);
          if (
            rt.currentSpaceRef.current?.id === space.id &&
            rt.externalNavGen.current === navBefore
          ) {
            await openExternalSession(space, snap.session.id);
          } else {
            await rt.refreshExternalList(space.id);
          }
        } catch (err) {
          restoreDraftAndChips(extKey, rawInput, snapshotChips);
          throw err;
        }
      });
      return { handled: true, sent };
    }

    const overrides =
      activeExtStaged?.kind === 'external'
        ? {
            ...(activeExtStaged.harness.modelId
              ? { modelId: activeExtStaged.harness.modelId }
              : {}),
            ...(activeExtStaged.harness.modeId ? { modeId: activeExtStaged.harness.modeId } : {}),
            ...(activeExtStaged.harness.thoughtLevel
              ? { thoughtLevel: activeExtStaged.harness.thoughtLevel }
              : {}),
          }
        : undefined;
    let sent = false;
    clearScope(extKey);
    await rt.act(async () => {
      try {
        const promptText = await buildExternalPromptWithReferences({
          api,
          workspaceId: cur.workspaceId,
          input: finalInput,
          chips: snapshotChips,
        });
        const snap = await api.external.prompt({
          workspaceId: cur.workspaceId,
          sessionId: cur.sessionId,
          text: promptText,
          ...(overrides && Object.keys(overrides).length > 0 ? { configOverrides: overrides } : {}),
        });
        sent = true;
        clearStagedExternal();
        rt.setActiveExternal((prev) =>
          prev && prev.sessionId === cur.sessionId ? { ...prev, snapshot: snap } : prev,
        );
        await rt.refreshExternalList(cur.workspaceId);
      } catch (err) {
        restoreDraftAndChips(extKey, rawInput, snapshotChips);
        throw err;
      }
    });
    return { handled: true, sent };
  }

  // 2. 已打开本地会话暂存切换到外部代理接力。
  if (rt.opened && rt.workspace && activeStagedToExt) {
    const targetSpace = rt.workspace;
    if (!targetSpace.trusted) return { handled: true, sent: false };
    const sourceOpened = rt.opened;
    const scopeKey = buildDraftScopeKey(
      buildNativeSessionKey(sourceOpened.workspaceId, sourceOpened.conversationId),
      sourceOpened.workspaceId,
    );
    const currentTitle = rt.activeThread?.title ?? '新对话';
    const handoff = buildSessionHandoffPayload(currentTitle, rt.messages);
    const navBefore = rt.externalNavGen.current;
    let sent = false;
    clearScope(scopeKey);
    await rt.act(async () => {
      try {
        const promptText = await buildExternalPromptWithReferences({
          api,
          workspaceId: targetSpace.id,
          input: finalInput,
          chips: snapshotChips,
        });
        const snap = await api.external.open({
          workspaceId: targetSpace.id,
          harnessId: activeStagedToExt.id,
          ...(currentTitle && currentTitle !== '新对话' ? { title: currentTitle } : {}),
          prompt: promptText,
          ...(activeStagedToExt.modelId ? { modelId: activeStagedToExt.modelId } : {}),
          ...(activeStagedToExt.thoughtLevel
            ? { thoughtLevel: activeStagedToExt.thoughtLevel }
            : {}),
          ...(activeStagedToExt.modeId ? { modeId: activeStagedToExt.modeId } : {}),
          ...(handoff ? { handoff } : {}),
        });
        sent = true;
        clearStagedLocalToExt();
        await api.session
          .close({ workspaceId: sourceOpened.workspaceId, sessionId: sourceOpened.sessionId })
          .catch(() => {});
        await rt.reloadHarnessCatalog(targetSpace.id);
        if (
          rt.currentSpaceRef.current?.id === targetSpace.id &&
          rt.externalNavGen.current === navBefore
        ) {
          await openExternalSession(targetSpace, snap.session.id);
          await rt.refreshHistory(targetSpace);
        } else {
          await rt.refreshExternalList(targetSpace.id);
        }
      } catch (err) {
        restoreDraftAndChips(scopeKey, rawInput, snapshotChips);
        throw err;
      }
    });
    return { handled: true, sent };
  }

  // 3. Launchpad 新建外部代理会话（支持 Git Worktree 隔离）。
  if (!rt.opened && rt.workspace && composerHarness) {
    const targetSpace = rt.workspace;
    if (!targetSpace.trusted) return { handled: true, sent: false };
    const launchScope = buildDraftScopeKey(null, targetSpace.id);
    const wt = currentWorktreeOption();
    const navBefore = rt.externalNavGen.current;
    let sent = false;
    clearScope(launchScope);
    await rt.act(async () => {
      try {
        const promptText = await buildExternalPromptWithReferences({
          api,
          workspaceId: targetSpace.id,
          input: finalInput,
          chips: snapshotChips,
        });
        const snap = await api.external.open({
          workspaceId: targetSpace.id,
          harnessId: composerHarness.id,
          prompt: promptText,
          ...(composerHarness.modelId ? { modelId: composerHarness.modelId } : {}),
          ...(composerHarness.thoughtLevel ? { thoughtLevel: composerHarness.thoughtLevel } : {}),
          ...(composerHarness.modeId ? { modeId: composerHarness.modeId } : {}),
          ...(wt ? { worktree: wt } : {}),
        });
        sent = true;
        resetWorktreeDraft();
        await rt.reloadHarnessCatalog(targetSpace.id);
        if (
          rt.currentSpaceRef.current?.id === targetSpace.id &&
          rt.externalNavGen.current === navBefore
        ) {
          clearStagedLocalToExt();
          await openExternalSession(targetSpace, snap.session.id);
        } else {
          await rt.refreshExternalList(targetSpace.id);
        }
      } catch (err) {
        restoreDraftAndChips(launchScope, rawInput, snapshotChips);
        throw err;
      }
    });
    return { handled: true, sent };
  }

  return { handled: false, sent: false };
}
