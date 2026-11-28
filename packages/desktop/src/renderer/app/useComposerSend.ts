import type { DesktopAPI, Workspace } from '../../shared/contracts.js';
import { buildNativeSessionKey } from '../adapters/index.js';
import { type ReferenceChip, buildDraftScopeKey, useSessionStore } from '../stores/index.js';
import type {
  CommandFeedbackItem,
  ComposerSendPayload,
  SelectedExternalHarness,
} from '../surfaces/composer/index.js';
import { extractComposerSendReferences } from './desktop-helpers.js';
import type { OpenedSession, useDesktopRuntime } from './useDesktopRuntime.js';
import { type StagedExternalNext, executeExternalOrHandoffSend } from './useExternalHandoffs.js';

type RuntimeBag = ReturnType<typeof useDesktopRuntime>;

const scopeOf = (opened: OpenedSession) => ({
  workspaceId: opened.workspaceId,
  sessionId: opened.sessionId,
});

/** 发送异常回滚时恢复原草稿与 `@引用` 胶囊快照，避免网络或握手报错吞掉用户已选上下文。 */
export function restoreDraftAndChips(
  scopeKey: string,
  rawInput: string,
  chips: readonly ReferenceChip[],
): void {
  const cur = useSessionStore.getState();
  if (!cur.draftsByKey[scopeKey]) cur.setDraft(scopeKey, rawInput);
  for (const chip of chips) cur.addReferenceChip(scopeKey, chip);
}

/**
 * 为外部代理组装携带 `@会话` 引用内容块与 `@文件` 提及的完整提问文本：
 * 生成与本地宿主同构的 `<session-reference>` 包络，既向外部代理注入历史摘录，又能被 `TurnItem` 自动解析为 `@标题` 徽标。
 */
export async function buildExternalPromptWithReferences(params: {
  readonly api?: Pick<DesktopAPI, 'reference'>;
  readonly workspaceId?: string;
  readonly input: string;
  readonly chips: readonly ReferenceChip[];
}): Promise<string> {
  const sessionChips = params.chips.filter((c) => c.kind === 'session' && c.target);
  if (sessionChips.length === 0) return params.input;
  const blocks: string[] = [];
  for (const chip of sessionChips) {
    const hashIdx = chip.target.indexOf('#');
    const sessionId = hashIdx < 0 ? chip.target : chip.target.slice(0, hashIdx);
    const rest = hashIdx < 0 ? '' : chip.target.slice(hashIdx + 1);
    const atIdx = rest.indexOf('@');
    const recordId = rest ? (atIdx >= 0 ? rest.slice(0, atIdx) : rest) : undefined;
    const branchId = atIdx >= 0 ? rest.slice(atIdx + 1) : undefined;
    if (!sessionId) continue;
    let title = chip.label;
    let body = chip.preview?.trim() ?? '';
    if (params.api?.reference?.read && params.workspaceId) {
      try {
        const snap = await params.api.reference.read({
          workspaceId: params.workspaceId,
          sessionId,
          ...(recordId ? { recordIds: [recordId] } : { limit: 4 }),
          ...(branchId ? { branchId } : {}),
        });
        if (snap.title?.trim()) title = snap.title.trim();
        if (snap.records.length > 0) {
          body = snap.records.map((r) => `[${r.role}]: ${r.text}`).join('\n\n');
        }
      } catch {
        /* 引用读取降级保留胶囊自带预览摘要。 */
      }
    }
    const safeTitle = title.replaceAll('"', '&quot;');
    const recAttr = recordId ? ` record="${recordId}"` : '';
    blocks.push(
      `<session-reference session="${sessionId}"${recAttr} title="${safeTitle}">\n${body || title}\n</session-reference>`,
    );
  }
  return blocks.length > 0 ? `${blocks.join('\n')}\n${params.input}`.trim() : params.input;
}

/**
 * 统一发送流水线：编排外部会话/跨代理接力、斜杠命令（含首页 `/skill` 直发）、已打开会话续聊与首页新建会话首轮发送。
 */
export async function executeComposerSend(params: {
  readonly api: DesktopAPI;
  readonly rt: RuntimeBag;
  readonly payload: ComposerSendPayload;
  readonly composerModel?: { readonly id: string; readonly name: string };
  readonly composerHarness?: SelectedExternalHarness;
  readonly activeExtStaged?: StagedExternalNext;
  readonly activeStagedToExt?: SelectedExternalHarness;
  readonly currentWorktreeOption: () =>
    | { readonly enabled: true; readonly branch?: string }
    | undefined;
  readonly resetWorktreeDraft: () => void;
  readonly createNativeSession: (
    space: Workspace,
    explicitProfileId?: string,
  ) => Promise<OpenedSession>;
  readonly openExternalSession: (space: Workspace, sessionId: string) => Promise<void>;
  readonly flushStagedOpenedConfig: (target: OpenedSession) => Promise<void>;
  readonly pushCommandFeedback: (lines: readonly string[]) => void;
  readonly clearStagedExternal: () => void;
  readonly clearStagedLocalToExt: () => void;
}): Promise<boolean> {
  const {
    api,
    rt,
    payload,
    composerModel,
    composerHarness,
    activeExtStaged,
    activeStagedToExt,
    currentWorktreeOption,
    resetWorktreeDraft,
    createNativeSession,
    openExternalSession,
    flushStagedOpenedConfig,
    pushCommandFeedback,
    clearStagedExternal,
    clearStagedLocalToExt,
  } = params;

  const rawInput = payload.text.trim();
  if (!rawInput || rt.busy) return false;
  const sessStore = useSessionStore.getState();

  const { input: finalInput, references } = extractComposerSendReferences(
    rawInput,
    payload.references,
  );

  const extOutcome = await executeExternalOrHandoffSend({
    api,
    rt,
    rawInput,
    finalInput,
    snapshotChips: payload.references,
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
  });
  if (extOutcome.handled) return extOutcome.sent;

  if (rawInput.startsWith('/')) {
    if (!rt.opened) {
      if (/^\/skill(?:\s|$)/i.test(rawInput) && rt.workspace?.trusted) {
        if (!composerModel) {
          rt.setError('还没有可用模型，请先在设置中为模型填写密钥。');
          return false;
        }
        const launchScope = buildDraftScopeKey(null, rt.workspace.id);
        let handledOk = false;
        await rt.act(async () => {
          const created = await createNativeSession(rt.workspace!);
          const result = await api.run.command({ ...scopeOf(created), input: rawInput });
          if (!result.handled) {
            rt.setError(`未知命令：${rawInput.split(/\s+/)[0]}`);
            return;
          }
          handledOk = true;
          if (result.feedback.length > 0) pushCommandFeedback(result.feedback);
          sessStore.recordSubmittedPrompt(launchScope, rawInput);
        });
        return handledOk;
      }
      rt.setError('斜杠命令需要在已打开的会话中使用。');
      return false;
    }
    const openScope = buildDraftScopeKey(
      buildNativeSessionKey(rt.opened.workspaceId, rt.opened.conversationId),
      rt.opened.workspaceId,
    );
    let handledOk = false;
    await rt.act(async () => {
      const result = await api.run.command({ ...scopeOf(rt.opened!), input: rawInput });
      if (!result.handled) {
        rt.setError(`未知命令：${rawInput.split(/\s+/)[0]}`);
        return;
      }
      handledOk = true;
      if (result.feedback.length > 0) pushCommandFeedback(result.feedback);
      sessStore.recordSubmittedPrompt(openScope, rawInput);
    });
    return handledOk;
  }

  if (rt.opened) {
    const target = rt.opened;
    const runtimeItem = rt.facts.runtime?.items.find((i) => i.sessionId === target.sessionId);
    const ready = rt.facts.runtimeValid && runtimeItem?.cleanup === 'none';
    if (!rt.facts.valid || !ready || (rt.run && rt.run.phase !== 'idle')) return false;
    const scopeKey = buildDraftScopeKey(
      buildNativeSessionKey(target.workspaceId, target.conversationId),
      target.workspaceId,
    );
    sessStore.recordSubmittedPrompt(scopeKey, rawInput);
    sessStore.clearReferenceChips(scopeKey);
    let dispatched = false;
    await rt.act(async () => {
      try {
        await flushStagedOpenedConfig(target);
        await rt.client.start(scopeOf(target), finalInput, {
          ...(references.length > 0 ? { references } : {}),
        });
        dispatched = true;
      } catch (err) {
        restoreDraftAndChips(scopeKey, rawInput, payload.references);
        throw err;
      }
    });
    return dispatched;
  }

  if (!rt.workspace?.trusted || !rt.facts.runtimeValid) return false;
  if (!composerModel) {
    rt.setError('还没有可用模型，请先在设置中为模型填写密钥。');
    return false;
  }
  const targetSpace = rt.workspace;
  const launchScope = buildDraftScopeKey(null, targetSpace.id);
  sessStore.recordSubmittedPrompt(launchScope, rawInput);
  sessStore.clearReferenceChips(launchScope);
  rt.setPendingLaunchPrompt(finalInput);
  let dispatched = false;
  await rt.act(async () => {
    let newScope: string | undefined;
    try {
      const created = await createNativeSession(targetSpace);
      newScope = buildDraftScopeKey(
        buildNativeSessionKey(created.workspaceId, created.conversationId),
        created.workspaceId,
      );
      sessStore.recordSubmittedPrompt(newScope, finalInput);
      await rt.client.start(scopeOf(created), finalInput, {
        ...(references.length > 0 ? { references } : {}),
      });
      dispatched = true;
      await rt.refreshHistory(targetSpace);
    } catch (err) {
      restoreDraftAndChips(newScope ?? launchScope, rawInput, payload.references);
      throw err;
    } finally {
      rt.setPendingLaunchPrompt(undefined);
    }
  });
  return dispatched;
}

/** 构造命令反馈卡片项（保留最近 5 张）。 */
export function prependCommandFeedback(
  current: readonly CommandFeedbackItem[],
  lines: readonly string[],
): readonly CommandFeedbackItem[] {
  return [{ id: crypto.randomUUID(), lines }, ...current].slice(0, 5);
}
