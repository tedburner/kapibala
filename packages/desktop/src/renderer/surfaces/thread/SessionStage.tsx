import type { ReactNode } from 'react';
import type {
  UnifiedPreviewableCodeBlock,
  UnifiedThreadViewModel,
  UnifiedTurn,
  UnifiedWorkbenchTarget,
} from '../../adapters/index.js';
import { useI18n } from '../../i18n.js';
import { useShellStore } from '../../stores/index.js';
import { SessionHeader, type SessionHeaderProps } from './SessionHeader.js';
import { VirtualTurnList } from './VirtualTurnList.js';

/**
 * `SessionStage` 入参契约（017 §0 铁律 2 & §9 阶段 3）：
 * - 自研本地会话、委派子会话与全部外部代理会话（ACP / CLI / App-Server / RPC）100% 共用唯一会话舞台；
 * - 默认将工具行与代码块预览点击直接路由至 `ShellStore.openWorkbenchTab`（`diff` / `preview` / `inspector`），
 *   委派工具行（`primaryTarget.kind === 'delegation'`）转发至 `onJumpToChildSession` 一键切入子会话。
 */
export interface SessionStageProps
  extends Omit<SessionHeaderProps, 'thread' | 'onOpenDiffWorkbench'> {
  readonly thread: UnifiedThreadViewModel;
  readonly workspaceRoot?: string;
  readonly composerSlot?: ReactNode;
  readonly defaultShowScrollToBottom?: boolean;
  readonly onOpenDiffWorkbench?: () => void;
  readonly onOpenWorkbenchTarget?: (target: UnifiedWorkbenchTarget) => void;
  readonly onJumpToChildSession?: (childSessionId: string, workspaceId: string) => void;
  readonly onRegenerate?: (turn: UnifiedTurn) => void;
  readonly onRestoreAndRetry?: (turn: UnifiedTurn) => void;
  readonly onRestoreCheckpoint?: (turn: UnifiedTurn) => void;
  readonly onEditUserMessage?: (text: string) => void;
  readonly onThinkingExpandedChange?: (stepId: string, expanded: boolean) => void;
  readonly onContinue?: () => void;
  readonly onReport?: (message: string) => void;
}

/**
 * 单一会话流主舞台（`SessionStage`）：组合 `SessionHeader`、`VirtualTurnList` 与底部 `ComposerDock` 插槽。
 */
export function SessionStage({
  thread,
  workspaceRoot,
  composerSlot,
  defaultShowScrollToBottom,
  showRailToggle,
  pinned,
  workbenchOpen,
  platform,
  canRename,
  onToggleRail,
  onRenameTitle,
  onOpenDiffWorkbench,
  onOpenWorktreeMerge,
  onToggleWorkbench,
  onTogglePin,
  onForkSession,
  onBranchWithSummary,
  onArchiveSession,
  onCloseExternalProcess,
  onCloseSession,
  onOpenWorkbenchTarget,
  onJumpToChildSession,
  onRegenerate,
  onRestoreAndRetry,
  onRestoreCheckpoint,
  onEditUserMessage,
  onThinkingExpandedChange,
  onContinue,
  onReport,
}: SessionStageProps) {
  const { t } = useI18n();
  const latestErrorNotice = [...thread.notices]
    .reverse()
    .find((notice) => notice.level === 'error')?.text;

  const handleWorkbenchTarget = (target: UnifiedWorkbenchTarget) => {
    if (onOpenWorkbenchTarget) {
      onOpenWorkbenchTarget(target);
      return;
    }
    if (target.kind === 'delegation') {
      onJumpToChildSession?.(target.childSessionId, thread.workspaceId);
      return;
    }
    const shell = useShellStore.getState();
    if (target.kind === 'diff') {
      shell.openWorkbenchTab(thread.sessionKey, {
        kind: 'diff',
        targetKey: target.filePath,
        payload: {
          callId: target.callId,
          filePath: target.filePath,
          additions: target.additions,
          deletions: target.deletions,
        },
      });
      return;
    }
    if (target.kind === 'preview') {
      shell.openWorkbenchTab(thread.sessionKey, {
        kind: 'preview',
        targetKey: target.callId,
        payload: {
          callId: target.callId,
          previewKind: target.previewKind,
          label: target.label,
          filePath: target.filePath,
          html: target.html,
          artifact: target.artifact,
        },
      });
      return;
    }
    shell.openWorkbenchTab(thread.sessionKey, {
      kind: 'inspector',
      targetKey: target.callId,
      payload: { callId: target.callId },
    });
  };

  const handleCodePreview = (codeBlock: UnifiedPreviewableCodeBlock) => {
    handleWorkbenchTarget({
      kind: 'preview',
      callId: codeBlock.id,
      previewKind: codeBlock.language,
      label: codeBlock.label,
      html: codeBlock.rawCode,
    });
  };

  return (
    <section aria-label={t('thread.stageAria')} className="kpbl-session-stage">
      <SessionHeader
        thread={thread}
        showRailToggle={showRailToggle}
        pinned={pinned}
        workbenchOpen={workbenchOpen}
        platform={platform}
        canRename={canRename}
        onToggleRail={onToggleRail}
        onRenameTitle={onRenameTitle}
        onOpenDiffWorkbench={onOpenDiffWorkbench}
        onOpenWorktreeMerge={onOpenWorktreeMerge}
        onToggleWorkbench={onToggleWorkbench}
        onTogglePin={onTogglePin}
        onForkSession={onForkSession}
        onBranchWithSummary={onBranchWithSummary}
        onArchiveSession={onArchiveSession}
        onCloseExternalProcess={onCloseExternalProcess}
        onCloseSession={onCloseSession}
      />

      <VirtualTurnList
        sessionKey={thread.sessionKey}
        turns={thread.turns}
        phase={thread.phase}
        hasRetry={Boolean(thread.retryStatus)}
        harnessKind={thread.harness.kind}
        harnessLabel={thread.harness.label}
        workspaceRoot={workspaceRoot}
        latestErrorText={latestErrorNotice}
        defaultShowScrollToBottom={defaultShowScrollToBottom}
        onOpenWorkbenchTarget={handleWorkbenchTarget}
        onOpenCodePreview={handleCodePreview}
        onRegenerate={onRegenerate}
        onRestoreAndRetry={onRestoreAndRetry}
        onRestoreCheckpoint={onRestoreCheckpoint}
        onEditUserMessage={onEditUserMessage}
        onThinkingExpandedChange={onThinkingExpandedChange}
        onContinue={onContinue}
        onReport={onReport}
      />

      {composerSlot ?? null}
    </section>
  );
}
