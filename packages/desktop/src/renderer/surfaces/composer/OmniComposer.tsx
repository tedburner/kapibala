import { type ChangeEvent, type KeyboardEvent, useRef } from 'react';
import { flushSync } from 'react-dom';
import { shouldSubmitComposerKey } from '../../../shared/i18n/index.js';
import { useI18n } from '../../i18n.js';
import {
  type ComposerPermissionMode,
  buildOmniBarMenus,
  modeDisplayName,
  pickOmniGuidance,
  resolveComposerPlaceholder,
} from '../../mode-labels.js';
import { isPromptHistoryBrowsing } from '../../prompt-history.js';
import {
  type ReferenceChip,
  type WorkspaceSpace,
  buildDraftScopeKey,
  selectReferenceChips,
  useSessionStore,
  useSettingsStore,
} from '../../stores/index.js';
import {
  ActionMenu,
  type ActionMenuEntry,
  Button,
  Icon,
  IconButton,
  type IconName,
  TextField,
} from '../../ui/index.js';
import { ModelHarnessPicker, type ModelHarnessPickerProps } from './ModelHarnessPicker.js';
import {
  type ComposerCompletionCatalogProps,
  type ComposerCompletionEntry,
  ReferencePopover,
  useCompletionPopoverState,
} from './ReferencePopover.js';

export type { ComposerPermissionMode };

/** 命令执行回显卡片项。 */
export interface CommandFeedbackItem {
  readonly id: string;
  readonly lines: readonly string[];
}

/** 输入框发送载荷。 */
export interface ComposerSendPayload {
  readonly text: string;
  readonly references: readonly ReferenceChip[];
}

function BarMenu(p: {
  readonly label: string;
  readonly aria: string;
  readonly text: string;
  readonly icon: IconName;
  readonly disabled: boolean;
  readonly items: readonly ActionMenuEntry[];
}) {
  return (
    <ActionMenu
      label={p.label}
      placement="top-start"
      items={p.items}
      renderTrigger={(mp) => (
        <Button
          size="sm"
          variant="ghost"
          leadingIcon={p.icon}
          trailingIcon="caret-down"
          disabled={p.disabled}
          aria-label={p.aria}
          aria-haspopup={mp['aria-haspopup']}
          aria-expanded={mp['aria-expanded']}
          onClick={mp.toggle}
        >
          <span className="max-w-36 truncate">{p.text}</span>
        </Button>
      )}
    />
  );
}

/**
 * `OmniComposer` 入参契约（017 §6.4.3, §7 & 018 §5.3 R3.3）：
 * 承载 `@引用` 快照胶囊托盘、`/` 命令补全、双模 `@` 引用、首尾光标 `↑/↓` 历史召回与底栏模型/模式/工作树控制。
 */
export interface OmniComposerProps
  extends Partial<Omit<ModelHarnessPickerProps, 'contextMode' | 'disabled'>>,
    ComposerCompletionCatalogProps {
  readonly sessionKey?: string | null;
  readonly workspaceId?: string | null;
  readonly spaces?: readonly WorkspaceSpace[];
  readonly isOpenedSession?: boolean;
  readonly isRunning?: boolean;
  readonly isCancelling?: boolean;
  readonly busy?: boolean;
  readonly draft?: string;
  readonly placeholder?: string;
  readonly referenceChips?: readonly ReferenceChip[];
  readonly commandFeedbacks?: readonly CommandFeedbackItem[];
  readonly permissionMode?: ComposerPermissionMode;
  readonly canSwitchPermissionMode?: boolean;
  readonly worktreeEnabled?: boolean;
  readonly worktreeBranchDraft?: string;
  readonly missingApiKey?: boolean;
  readonly quotaExhausted?: boolean;
  readonly readonlyArchiveActionLabel?: string;
  readonly stagedHintText?: string;
  readonly onDraftChange?: (draft: string) => void;
  readonly onSend: (
    payload: ComposerSendPayload,
  ) => void | boolean | Promise<boolean> | Promise<void>;
  readonly onCancel?: () => void;
  readonly onDismissFeedback?: (feedbackId: string) => void;
  readonly onAddReferenceChip?: (chip: ReferenceChip) => void;
  readonly onRemoveReferenceChip?: (chipId: string) => void;
  readonly onSelectWorkspace?: (space: WorkspaceSpace) => void;
  readonly onCreateProject?: () => void;
  readonly onSelectPermissionMode?: (mode: ComposerPermissionMode) => void;
  readonly onWorktreeEnabledChange?: (enabled: boolean) => void;
  readonly onWorktreeBranchChange?: (branch: string) => void;
  readonly onRequestTrustWorkspace?: () => void;
  readonly onSwitchModel?: () => void;
  readonly onReadonlyArchiveAction?: () => void;
}

/** 全能内联输入主卡（`OmniComposer`）。 */
export function OmniComposer(props: OmniComposerProps) {
  const { spaces = [], models = [], busy = false, isRunning = false } = props;
  const sessionKey = props.sessionKey ?? null;
  const workspaceId = props.workspaceId ?? null;
  const permissionMode = props.permissionMode ?? 'Approval';
  const isOpenedSession = props.isOpenedSession ?? Boolean(sessionKey);
  const scopeKey = buildDraftScopeKey(sessionKey, workspaceId);
  const { locale, t } = useI18n();
  const sendShortcut = useSettingsStore((s) => s.general.sendShortcut);
  const store = useSessionStore();
  const draft = props.draft ?? store.draftsByKey[scopeKey] ?? '';
  const chips = props.referenceChips ?? selectReferenceChips(store, scopeKey);
  const wtEnabled = props.worktreeEnabled ?? store.worktreeEnabled;
  const wtBranch = props.worktreeBranchDraft ?? store.worktreeBranchDraft;

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const activeSpace = spaces.find((s) => s.id === workspaceId) ?? spaces[0];
  const pop = useCompletionPopoverState(
    props,
    draft,
    activeSpace?.id ?? workspaceId,
    !props.selectedHarness,
  );
  const updateDraft = (next: string) =>
    props.onDraftChange ? props.onDraftChange(next) : store.setDraft(scopeKey, next);

  const acceptEntry = (entry: ComposerCompletionEntry | undefined) => {
    const trig = pop.activeTrigger;
    if (!entry || !trig) return;
    if (entry.kind === 'command' || entry.kind === 'skill') {
      updateDraft(entry.insertText);
    } else if (entry.kind === 'file' && trig.mode === 'at') {
      updateDraft(`${draft.slice(0, trig.atIndex)}${entry.insertText} `);
    } else if (entry.kind === 'session_ref' && trig.mode === 'at') {
      if (props.onAddReferenceChip) props.onAddReferenceChip(entry.chip);
      else store.addReferenceChip(scopeKey, entry.chip);
      updateDraft(draft.slice(0, trig.atIndex));
    }
    pop.setHighlightIdx(0);
  };

  const untrustedBlocked = Boolean(activeSpace && !activeSpace.trusted);
  const missingKeyBlocked =
    props.missingApiKey ?? (!props.selectedHarness && models.length === 0 && !isOpenedSession);
  const trimmedDraft = draft.trim();
  const explicitKeyBlocked = props.missingApiKey === true && !trimmedDraft.startsWith('/');
  const canSubmit =
    Boolean(trimmedDraft) && !busy && !isRunning && !untrustedBlocked && !explicitKeyBlocked;

  const submitNow = () => {
    if (!canSubmit) return;
    const snapshotChips = [...chips];
    const finish = (accepted: unknown) => {
      if (accepted === false || props.onDraftChange) return;
      const cur = useSessionStore.getState();
      if ((cur.draftsByKey[scopeKey] ?? '').trim() === trimmedDraft) {
        cur.recordSubmittedPrompt(scopeKey, trimmedDraft);
      }
      if (selectReferenceChips(cur, scopeKey).length > 0) cur.clearReferenceChips(scopeKey);
    };
    const outcome = props.onSend({ text: trimmedDraft, references: snapshotChips });
    if (outcome && typeof (outcome as PromiseLike<unknown>).then === 'function') {
      void Promise.resolve(outcome).then(finish, () => {});
    } else finish(outcome);
  };

  const handleTextareaChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    e.currentTarget.style.height = 'auto';
    e.currentTarget.style.height = `${Math.min(e.currentTarget.scrollHeight, 200)}px`;
    pop.setHighlightIdx(0);
    updateDraft(e.currentTarget.value);
  };

  const stepHistory = (dir: -1 | 1) => {
    let nextVal: string | undefined;
    flushSync(() => {
      const res = useSessionStore.getState().recallPromptHistory(scopeKey, dir);
      if (!res.consumed || res.value === undefined) return;
      nextVal = res.value;
      props.onDraftChange?.(res.value);
    });
    if (nextVal === undefined) return;
    textareaRef.current?.setSelectionRange(nextVal.length, nextVal.length);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    const len = pop.entries.length;
    if (pop.activeTrigger) {
      if (len > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
        e.preventDefault();
        pop.setHighlightIdx((pop.highlightIdx + (e.key === 'ArrowDown' ? 1 : len - 1)) % len);
        return;
      }
      if (len > 0 && (e.key === 'Tab' || e.key === 'Enter')) {
        e.preventDefault();
        const cur = pop.entries[pop.highlightIdx];
        const runCmd =
          e.key === 'Enter' &&
          (cur?.kind === 'command' || cur?.kind === 'skill') &&
          cur.insertText.trim() === draft.trim();
        if (runCmd) submitNow();
        else acceptEntry(cur);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        pop.dismissTrigger();
        return;
      }
    }
    const { selectionStart: s, selectionEnd: end, value } = e.currentTarget;
    const browsing = isPromptHistoryBrowsing(store.promptHistoryByKey[scopeKey]);
    if (e.key === 'ArrowUp' && s === end && (s === 0 || (browsing && s === value.length))) {
      e.preventDefault();
      stepHistory(-1);
    } else if (e.key === 'ArrowDown' && browsing && s === end && s === value.length) {
      e.preventDefault();
      stepHistory(1);
    } else if (
      shouldSubmitComposerKey(
        {
          key: e.key,
          shiftKey: e.shiftKey,
          metaKey: e.metaKey,
          ctrlKey: e.ctrlKey,
          isComposing: false,
        },
        sendShortcut,
      )
    ) {
      e.preventDefault();
      submitNow();
    }
  };

  const { spaceItems, modeItems } = buildOmniBarMenus(
    spaces,
    props.onSelectWorkspace,
    props.onCreateProject,
    props.onSelectPermissionMode,
    locale,
  );
  const showWtToggle =
    !isOpenedSession &&
    Boolean(activeSpace?.kind === 'project' && activeSpace.gitCapable !== false);
  const placeholderText = resolveComposerPlaceholder({
    isOpenedSession,
    placeholder: props.placeholder,
    sendShortcut,
    locale,
  });
  const guidance = pickOmniGuidance(untrustedBlocked, missingKeyBlocked, props, locale);
  const currentModeName = modeDisplayName(permissionMode, locale);
  const spaceText = activeSpace?.name ?? t('composer.selectSpace');
  const spaceAria = activeSpace ? t('composer.spaceAria', { name: activeSpace.name }) : spaceText;
  const removeChip =
    props.onRemoveReferenceChip ?? ((id: string) => store.removeReferenceChip(scopeKey, id));

  return (
    <div className="kpbl-omni-shell">
      {pop.popoverProps ? (
        <ReferencePopover
          {...pop.popoverProps}
          onAcceptIndex={(idx) => acceptEntry(pop.entries[idx])}
        />
      ) : null}
      {(props.commandFeedbacks ?? []).map((fb) => (
        <div key={fb.id} className="kpbl-omni-feedback">
          <div className="min-w-0 flex-1 whitespace-pre-wrap">{fb.lines.join('\n')}</div>
          {props.onDismissFeedback ? (
            <IconButton
              size="xs"
              icon="x"
              aria-label={t('composer.dismissFeedbackAria')}
              onClick={() => props.onDismissFeedback?.(fb.id)}
            />
          ) : null}
        </div>
      ))}

      <div className="kpbl-omni-card">
        {chips.length > 0 ? (
          <div className="kpbl-omni-chips" aria-label={t('composer.attachedRefsAria')}>
            {chips.map((chip) => (
              <span key={chip.id} className="kpbl-ref-chip" title={chip.preview ?? chip.target}>
                <Icon name={chip.kind === 'file' ? 'file-code' : 'file-text'} size={12} />
                <span className="truncate">@{chip.label}</span>
                <IconButton
                  size="xs"
                  icon="x"
                  aria-label={t('composer.removeRefAria', { label: chip.label })}
                  onClick={() => removeChip(chip.id)}
                />
              </span>
            ))}
          </div>
        ) : null}

        <textarea
          ref={textareaRef}
          rows={1}
          aria-label={t('composer.sendAria')}
          placeholder={placeholderText}
          value={draft}
          disabled={busy || isRunning}
          className="kpbl-omni-textarea"
          onChange={handleTextareaChange}
          onKeyDown={handleKeyDown}
        />

        <div className="kpbl-omni-toolbar">
          <div className="kpbl-omni-controls">
            {spaceItems.length > 0 ? (
              <BarMenu
                label={t('composer.spaceMenuLabel')}
                aria={spaceAria}
                text={spaceText}
                icon="folder"
                disabled={busy}
                items={spaceItems}
              />
            ) : null}

            <ModelHarnessPicker
              {...props}
              models={models}
              role={isOpenedSession ? (props.role ?? 'default') : undefined}
              contextMode={isOpenedSession ? 'session' : 'new'}
              disabled={busy}
              onSelectModel={(id) => props.onSelectModel?.(id)}
              onSelectRole={isOpenedSession ? props.onSelectRole : undefined}
              onSelectHarness={(c) => props.onSelectHarness?.(c)}
            />

            {(props.canSwitchPermissionMode ?? true) && !props.selectedHarness ? (
              <BarMenu
                label={t('composer.modeMenuLabel')}
                aria={t('composer.modeAria', { mode: currentModeName })}
                text={currentModeName}
                icon={permissionMode === 'Approval' ? 'hand' : 'shield-check'}
                disabled={busy || isRunning}
                items={modeItems}
              />
            ) : null}

            {showWtToggle ? (
              <Button
                size="xs"
                variant={wtEnabled ? 'solid' : 'outline'}
                leadingIcon="git-branch"
                aria-pressed={wtEnabled}
                onClick={() =>
                  (props.onWorktreeEnabledChange ?? store.setWorktreeEnabled)(!wtEnabled)
                }
              >
                {t('composer.worktreeToggle')}
              </Button>
            ) : null}
            {showWtToggle && wtEnabled ? (
              <TextField
                mono
                aria-label={t('composer.worktreeBranchAria')}
                placeholder={t('composer.worktreeBranchPlaceholder')}
                value={wtBranch}
                onValueChange={props.onWorktreeBranchChange ?? store.setWorktreeBranchDraft}
              />
            ) : null}
          </div>

          <div className="inline-flex shrink-0 items-center gap-1.5">
            {isRunning ? (
              <Button
                size="sm"
                variant="outline"
                leadingIcon="stop"
                aria-label={t('composer.stopBtn')}
                disabled={props.isCancelling}
                onClick={() => props.onCancel?.()}
              >
                {props.isCancelling ? t('composer.cancelling') : t('composer.stopBtn')}
              </Button>
            ) : (
              <IconButton
                size="sm"
                variant="solid"
                icon="arrow-up"
                aria-label={t('composer.sendBtn')}
                className="kpbl-send-btn"
                disabled={!canSubmit}
                onClick={submitNow}
              />
            )}
          </div>
        </div>

        {guidance ? (
          <div className="kpbl-omni-guidance">
            <span style={guidance.subtle ? { color: 'var(--kpbl-ink-subtle)' } : undefined}>
              {guidance.text}
            </span>
            {guidance.act && guidance.fn ? (
              <Button size="xs" variant="outline" onClick={guidance.fn}>
                {guidance.act}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
