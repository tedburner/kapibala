import type { PresentationState, ViewMessage } from '@kiturone/kapibala-host/view-model';
import { useRef, useState } from 'react';
import type { Approval, InteractionRequest, Output, Workspace } from '../../shared/contracts.js';
import type { RuntimeSnapshot } from '../../shared/observations.js';
import {
  type UnifiedThreadViewModel,
  buildExternalSessionKey,
  buildNativeSessionKey,
  projectExternalThread,
  projectNativeThread,
} from '../adapters/index.js';
import type { ReferenceChip, SessionLiveStatusEntry } from '../stores/index.js';
import { Button, ModalDialog, TextField } from '../ui/index.js';

/** 提取异常安全展示文案；非 Error 实例回退统一提示。 */
export function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : '操作失败，请检查配置后重试。';
}

/**
 * 取最后一条真实用户消息的回退占位原文。
 * 宿主执行重试时优先无损重放 canonical 历史中的原始用户消息（含引用块、技能信封与未脱敏原文），
 * 此处仅确认存在可重试的用户轮次并提供非空请求字符串；后台监视与子代理通知消息不计入用户轮次。
 */
export function findLastUserPrompt(messages: readonly ViewMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== 'user') continue;
    const text = message.blocks
      .filter((block) => block.kind === 'text' && !block.skillName)
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text.startsWith('<watch-event ') || text.startsWith('<subagent-notification ')) continue;
    if (message.blocks.some((block) => block.skillName)) return text || '开始执行该技能。';
    return text || undefined;
  }
  return undefined;
}

/**
 * 将输入坞挂载的 `@引用` 胶囊拆分为宿主 `run.start({ references })` 结构化身份与文件提及前缀。
 * - `kind === 'session'`：`target` 支持 `<sessionId>` 或 `<sessionId>#<recordId>@<branchId>`；
 * - `kind === 'file'`：若正文中尚未包含 `@<path>` 则前置拼接，保证模型明确获知关注文件。
 */
export function extractComposerSendReferences(
  rawText: string,
  chips: readonly ReferenceChip[],
): {
  readonly input: string;
  readonly references: readonly {
    readonly sessionId: string;
    readonly recordId?: string;
    readonly branchId?: string;
  }[];
} {
  const references: Array<{
    readonly sessionId: string;
    readonly recordId?: string;
    readonly branchId?: string;
  }> = [];
  const fileMentions: string[] = [];

  for (const chip of chips) {
    if (chip.kind === 'session') {
      const hashIdx = chip.target.indexOf('#');
      if (hashIdx < 0) {
        references.push({ sessionId: chip.target });
      } else {
        const sessionId = chip.target.slice(0, hashIdx);
        const rest = chip.target.slice(hashIdx + 1);
        const atIdx = rest.indexOf('@');
        const recordId = atIdx >= 0 ? rest.slice(0, atIdx) : rest;
        const branchId = atIdx >= 0 ? rest.slice(atIdx + 1) : undefined;
        if (sessionId) {
          references.push({
            sessionId,
            ...(recordId ? { recordId } : {}),
            ...(branchId ? { branchId } : {}),
          });
        }
      }
    } else if (
      (chip.kind === 'file' || chip.kind === 'symbol') &&
      chip.target &&
      !rawText.includes(`@${chip.target}`)
    ) {
      fileMentions.push(`@${chip.target}`);
    }
  }

  const input =
    fileMentions.length > 0 ? `${fileMentions.join(' ')} ${rawText}`.trim() : rawText.trim();
  return { input, references };
}

/** 汇总所有空间的运行中/待审批会话以驱动左栏 `InboxSection` 与会话树实时脉冲点。 */
export function buildLiveStatusMap(params: {
  readonly spaces: readonly Workspace[];
  readonly histories: Readonly<Record<string, Output<'session.list'>>>;
  readonly externalLists: Readonly<
    Record<string, readonly Output<'external.list'>['items'][number][]>
  >;
  readonly runtime?: RuntimeSnapshot;
  readonly approvals: readonly Approval[];
}): Record<string, SessionLiveStatusEntry> {
  const { spaces, histories, externalLists, runtime, approvals } = params;
  const map: Record<string, SessionLiveStatusEntry> = {};
  const spaceNameMap = new Map(spaces.map((s) => [s.id, s.name]));

  const approvalCountByConv = new Map<string, { count: number; workspaceId: string }>();
  for (const app of approvals) {
    const key = `${app.workspaceId}:${app.conversationId}`;
    const prev = approvalCountByConv.get(key);
    approvalCountByConv.set(key, {
      count: (prev?.count ?? 0) + 1,
      workspaceId: app.workspaceId,
    });
  }

  for (const item of runtime?.items ?? []) {
    const convKey = `${item.workspaceId}:${item.conversationId}`;
    const appInfo = approvalCountByConv.get(convKey);
    const hasApproval = Boolean(appInfo && appInfo.count > 0);
    if (!hasApproval && item.phase === 'idle') continue;
    const sessionKey = buildNativeSessionKey(item.workspaceId, item.conversationId);
    const row = histories[item.workspaceId]?.items.find(
      (h) => h.conversationId === item.conversationId,
    );
    map[sessionKey] = {
      sessionKey,
      workspaceId: item.workspaceId,
      workspaceName: spaceNameMap.get(item.workspaceId) ?? '空间',
      conversationId: item.conversationId,
      title: row?.title || '进行中的对话',
      status: hasApproval ? 'waiting_approval' : 'running',
      approvalCount: appInfo?.count ?? 0,
      updatedAt: row?.lastActivityAt ?? Date.now(),
    };
  }

  for (const [convKey, appInfo] of approvalCountByConv.entries()) {
    const sep = convKey.indexOf(':');
    const workspaceId = convKey.slice(0, sep);
    const conversationId = convKey.slice(sep + 1);
    const sessionKey = buildNativeSessionKey(workspaceId, conversationId);
    if (map[sessionKey]) continue;
    const row = histories[workspaceId]?.items.find((h) => h.conversationId === conversationId);
    map[sessionKey] = {
      sessionKey,
      workspaceId,
      workspaceName: spaceNameMap.get(workspaceId) ?? '空间',
      conversationId,
      title: row?.title || '待审批对话',
      status: 'waiting_approval',
      approvalCount: appInfo.count,
      updatedAt: row?.lastActivityAt ?? Date.now(),
    };
  }

  for (const [workspaceId, list] of Object.entries(externalLists)) {
    for (const ext of list) {
      if (
        ext.status !== 'waiting_approval' &&
        ext.status !== 'running' &&
        ext.status !== 'starting'
      ) {
        continue;
      }
      const sessionKey = buildExternalSessionKey(ext.id);
      map[sessionKey] = {
        sessionKey,
        workspaceId,
        workspaceName: spaceNameMap.get(workspaceId) ?? '空间',
        externalSessionId: ext.id,
        title: ext.title || '外部任务',
        harnessLabel: ext.harnessName,
        status: ext.status === 'waiting_approval' ? 'waiting_approval' : 'running',
        approvalCount:
          ext.status === 'waiting_approval' ? Math.max(1, ext.pendingApprovalCount) : 0,
        updatedAt: ext.updatedAt,
      };
    }
  }

  return map;
}

/** 构造加载过渡态空 `PresentationState`（含首帧即时回显的待启动用户提问）。 */
export function buildPlaceholderPresentation(
  conversationId: string,
  pendingPrompt?: string,
): PresentationState {
  const pendingMsg: ViewMessage | undefined = pendingPrompt
    ? {
        id: 'pending-launch-user',
        role: 'user',
        state: 'streaming',
        persisted: false,
        blocks: [{ id: 'b-0', kind: 'text', text: pendingPrompt, state: 'streaming', revision: 1 }],
      }
    : undefined;
  return {
    identity: { conversationId, branchId: 'main', viewEpoch: 0 },
    sequence: 0,
    messages: [],
    pendingMessages: pendingMsg ? [pendingMsg] : [],
    order: pendingMsg ? [pendingMsg.id] : [],
    operation: pendingPrompt ? { id: 'launching', phase: 'running' } : undefined,
    expanded: {},
    notices: [],
  };
}

/** 组合本地会话、外部会话或首帧启动过渡态为统一的 `UnifiedThreadViewModel`。 */
export function buildActiveThreadModel(params: {
  readonly workspace?: Workspace;
  readonly opened?: Output<'session.open'>;
  readonly pendingLaunchPrompt?: string;
  readonly presentation?: PresentationState;
  readonly runPhase?: 'running' | 'cancelling' | 'settling' | 'idle';
  readonly approvals: readonly Approval[];
  readonly activeWatchesCount: number;
  readonly evidence?: Output<'session.evidence'>;
  readonly histories: Readonly<Record<string, Output<'session.list'>>>;
  readonly activeExternal?: {
    readonly workspaceId: string;
    readonly sessionId: string;
    readonly snapshot: Output<'external.snapshot'>;
  };
}): UnifiedThreadViewModel | null {
  const {
    workspace,
    opened,
    pendingLaunchPrompt,
    presentation,
    runPhase,
    approvals,
    activeWatchesCount,
    evidence,
    histories,
    activeExternal,
  } = params;

  if (activeExternal) {
    return projectExternalThread({
      workspaceId: activeExternal.workspaceId,
      workspaceName: workspace?.name ?? '空间',
      workspaceRoot: activeExternal.snapshot.worktree?.worktreePath ?? workspace?.root,
      snapshot: activeExternal.snapshot,
      worktree: activeExternal.snapshot.worktree,
      diffSummary: activeExternal.snapshot.diffSummary,
    });
  }

  if (!opened && !pendingLaunchPrompt) return null;
  const wsId = opened?.workspaceId ?? workspace?.id ?? 'default';
  const convId = opened?.conversationId ?? 'launching';
  const matchingPresentation =
    presentation && (!opened || presentation.identity.conversationId === convId)
      ? presentation
      : undefined;
  const baseState =
    matchingPresentation ?? buildPlaceholderPresentation(convId, pendingLaunchPrompt);
  const effectiveState: PresentationState =
    (!baseState.operation || baseState.operation.phase === 'idle') &&
    runPhase &&
    runPhase !== 'idle'
      ? { ...baseState, operation: { id: convId, phase: runPhase } }
      : baseState;
  const title =
    histories[wsId]?.items.find((item) => item.conversationId === convId)?.title || '新对话';
  const worktree = effectiveState.worktree ?? opened?.worktree;
  const sessionApprovals = opened
    ? approvals.filter(
        (a) => a.sessionId === opened.sessionId || a.conversationId === opened.conversationId,
      )
    : [];

  return projectNativeThread({
    workspaceId: wsId,
    workspaceName: workspace?.name ?? '空间',
    workspaceRoot: worktree?.worktreePath ?? workspace?.root,
    sessionId: opened?.sessionId,
    conversationId: convId,
    title,
    presentation: effectiveState,
    approvals: sessionApprovals,
    activeWatchesCount,
    evidence,
    worktree,
    diffSummary: effectiveState.diffSummary,
  });
}

/** 宿主断连、上次未确认清理或展示失步时的主舞台顶部恢复横幅（保留 `role="alert"` 门禁契约）。 */
export function HostRecoveryBanner({
  message,
  hasOpenSession,
  onRefreshRun,
  onResync,
  onOpenSettings,
  onReconnect,
}: {
  readonly message: string;
  readonly hasOpenSession: boolean;
  readonly onRefreshRun: () => void;
  readonly onResync: () => void;
  readonly onOpenSettings: () => void;
  readonly onReconnect: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2.5 text-xs"
      style={{
        borderColor: 'var(--kpbl-line-default)',
        backgroundColor: 'var(--kpbl-status-warning-soft)',
        color: 'var(--kpbl-ink-strong)',
      }}
    >
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {hasOpenSession ? (
        <Button size="xs" variant="outline" onClick={onRefreshRun}>
          查询运行状态
        </Button>
      ) : null}
      {hasOpenSession ? (
        <Button size="xs" variant="outline" onClick={onResync}>
          重新同步
        </Button>
      ) : null}
      <Button size="xs" variant="ghost" onClick={onOpenSettings}>
        检查设置
      </Button>
      <Button size="xs" variant="ghost" onClick={onReconnect}>
        核查并重新连接
      </Button>
    </div>
  );
}

/** 斜杠命令触发的宿主交互请求（`question` / `secret` / `select`）单层原生模态框。 */
export function InteractionPromptDialog({
  request,
  onReply,
}: {
  readonly request?: InteractionRequest;
  readonly onReply: (value?: string) => void;
}) {
  const [value, setValue] = useState('');
  const [ownerId, setOwnerId] = useState(request?.requestId ?? '');
  const inputRef = useRef<HTMLInputElement | null>(null);

  if ((request?.requestId ?? '') !== ownerId) {
    setOwnerId(request?.requestId ?? '');
    setValue('');
  }

  return (
    <ModalDialog
      open={Boolean(request)}
      onOpenChange={(open) => {
        if (!open && request) onReply(undefined);
      }}
      title={request?.prompt ?? '命令确认'}
      closeLabel="取消交互"
      initialFocusRef={request?.kind === 'select' ? undefined : inputRef}
      footer={
        <div className="inline-flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={() => onReply(undefined)}>
            取消
          </Button>
          {request?.kind !== 'select' ? (
            <Button variant="solid" size="sm" onClick={() => onReply(value)}>
              确定
            </Button>
          ) : null}
        </div>
      }
    >
      {request?.kind === 'select' ? (
        <div className="flex flex-col gap-1.5">
          {(request.options ?? []).map((opt) => (
            <Button
              key={opt.value}
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={() => onReply(opt.value)}
            >
              {opt.label}
            </Button>
          ))}
        </div>
      ) : request ? (
        <TextField
          ref={inputRef}
          type={request.kind === 'secret' ? 'password' : 'text'}
          aria-label={request.prompt}
          value={value}
          onValueChange={setValue}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onReply(value);
            }
          }}
        />
      ) : null}
    </ModalDialog>
  );
}
