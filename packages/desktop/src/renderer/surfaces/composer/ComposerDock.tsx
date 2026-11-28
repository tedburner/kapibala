import type { UnifiedApprovalItem, UnifiedThreadViewModel } from '../../adapters/index.js';
import { ApprovalDeck, type ApprovalDeckProps } from './ApprovalDeck.js';
import { LiveStatusStrip, type LiveStatusStripProps } from './LiveStatusStrip.js';
import { OmniComposer, type OmniComposerProps } from './OmniComposer.js';

/**
 * `ComposerDock` 入参契约（017 §6.4）：
 * - 自上而下三层同宽堆叠：`ApprovalDeck`（内联审批）→ `LiveStatusStrip`（动态单行状态条）→ `OmniComposer`（全能输入卡）；
 * - 坞顶附带 `20px` 线性渐隐遮罩（`.kpbl-composer-fade-mask`），与 `760px` 对话阅读列保持像素级居中对齐。
 */
export interface ComposerDockProps {
  readonly thread?: UnifiedThreadViewModel | null;
  readonly approvals?: readonly UnifiedApprovalItem[];
  readonly approvalProps?: Omit<ApprovalDeckProps, 'approvals' | 'sessionKey'>;
  readonly statusStripProps?: Omit<
    LiveStatusStripProps,
    'sessionKey' | 'todos' | 'activeWatchesCount' | 'retryStatus' | 'worktreeBranch'
  >;
  readonly composerProps: OmniComposerProps;
}

/**
 * 底部全能非阻断输入坞容器（`ComposerDock`）。
 */
export function ComposerDock({
  thread,
  approvals,
  approvalProps,
  statusStripProps,
  composerProps,
}: ComposerDockProps) {
  const resolvedSessionKey = thread?.sessionKey ?? composerProps.sessionKey ?? null;
  const resolvedApprovals = approvals ?? thread?.approvals ?? [];
  const isRunning =
    composerProps.isRunning ??
    (thread
      ? thread.phase === 'starting' ||
        thread.phase === 'running' ||
        thread.phase === 'waiting_approval' ||
        thread.phase === 'cancelling'
      : false);
  const isCancelling = composerProps.isCancelling ?? thread?.phase === 'cancelling';

  return (
    <div className="kpbl-composer-dock">
      <div aria-hidden="true" className="kpbl-composer-fade-mask" />
      <div className="kpbl-composer-stack">
        <ApprovalDeck
          sessionKey={resolvedSessionKey}
          approvals={resolvedApprovals}
          {...approvalProps}
        />

        <LiveStatusStrip
          sessionKey={resolvedSessionKey}
          todos={thread?.todos}
          activeWatchesCount={thread?.activeWatchesCount ?? 0}
          retryStatus={thread?.retryStatus}
          worktreeBranch={thread?.worktree?.branch}
          {...statusStripProps}
        />

        <OmniComposer
          {...composerProps}
          sessionKey={resolvedSessionKey}
          workspaceId={composerProps.workspaceId ?? thread?.workspaceId ?? null}
          isOpenedSession={composerProps.isOpenedSession ?? Boolean(thread)}
          isRunning={isRunning}
          isCancelling={isCancelling}
          canSwitchPermissionMode={
            composerProps.canSwitchPermissionMode ??
            (thread ? thread.capabilities.canSwitchPermissionMode : true)
          }
        />
      </div>
    </div>
  );
}
