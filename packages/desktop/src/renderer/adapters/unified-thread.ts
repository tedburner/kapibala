import {
  type ViewBlock,
  type ViewEvidence,
  type ViewExternalTransport,
  type ViewMessage,
  type ViewTool,
  type ViewTurnMeta,
  selectMessages,
  summarizeToolGroup,
} from '@kiturone/kapibala-host/view-model';
import { artifactFileName } from '../artifact-model.js';
import { textPreviewLabel, toolPreview } from '../html-preview-model.js';
import { aggregateTurnUsage, formatTurnMetaBadge } from '../turn-usage.js';
import {
  type ProjectExternalThreadInput,
  type ProjectNativeThreadInput,
  type ThreadHarnessIdentity,
  type UnifiedApprovalItem,
  type UnifiedProcessStep,
  type UnifiedThreadViewModel,
  type UnifiedToolItem,
  type UnifiedTurn,
  type UnifiedWorkbenchTarget,
  buildExternalSessionKey,
  buildNativeSessionKey,
  extractJsonStringProp,
  extractPreviewableCodeBlocks,
  extractToolFailureSummary,
  parseSessionKey,
  projectExternalApproval,
  projectNativeApproval,
  relativizeWorkspaceText,
} from './index.js';

export {
  buildExternalSessionKey,
  buildNativeSessionKey,
  parseSessionKey,
  type ThreadHarnessIdentity,
  type UnifiedApprovalItem,
  type UnifiedProcessStep,
  type UnifiedThreadViewModel,
  type UnifiedTurn,
};

const TOOL_VERBS: Readonly<Record<string, string>> = {
  read_file: '读取',
  write_file: '写入',
  edit_file: '编辑',
  delete_file: '删除',
  run_command: '运行',
  glob: '搜索路径',
  grep: '搜索内容',
  spawn_agent: '委派子代理',
  send_agent: '消息子代理',
};
const TRANSPORT_LABELS: Readonly<
  Record<ViewExternalTransport, 'ACP' | 'CLI' | 'App-Server' | 'RPC'>
> = { acp: 'ACP', 'claude-cli': 'CLI', 'codex-app-server': 'App-Server', 'pi-rpc': 'RPC' };

function resolveToolTarget(
  tool: ViewTool,
  workspaceRoot: string | undefined,
  changeMap: ReadonlyMap<
    string,
    { additions: number | null; deletions: number | null; path: string }
  >,
  delegations: ViewEvidence['delegations'] | undefined,
): UnifiedWorkbenchTarget {
  const artifact = tool.status === 'succeeded' ? tool.artifacts?.[0] : undefined;
  if (artifact) {
    return {
      kind: 'preview',
      callId: tool.callId,
      previewKind: artifact.ext === 'svg' ? 'svg' : 'image',
      label: artifactFileName(artifact.path),
      filePath: relativizeWorkspaceText(artifact.path, workspaceRoot),
      artifact,
    };
  }
  const inputPath = extractJsonStringProp(tool.input, ['path', 'file_path']) ?? tool.chip ?? '';
  const inlineHtml = toolPreview(tool.name, tool.input, tool.status);
  if (inlineHtml) {
    return {
      kind: 'preview',
      callId: tool.callId,
      previewKind: /\.svg$/i.test(inputPath) ? 'svg' : 'html',
      label: inputPath ? textPreviewLabel(inputPath) : inlineHtml.label,
      filePath: inputPath ? relativizeWorkspaceText(inputPath, workspaceRoot) : undefined,
      html: inlineHtml.html,
    };
  }
  if (tool.name === 'spawn_agent' || tool.name === 'send_agent' || tool.name === 'delegate') {
    const directId =
      extractJsonStringProp(tool.result, ['sessionId', 'childSessionId', 'conversationId']) ??
      extractJsonStringProp(tool.input, ['sessionId', 'childSessionId', 'recipient']);
    const taskName =
      extractJsonStringProp(tool.input, ['role', 'taskName', 'description']) ?? tool.chip;
    const matched = !directId
      ? delegations?.find((d) => d.taskName === taskName)
      : delegations?.find((d) => d.sessionId === directId);
    const childSessionId = directId ?? matched?.sessionId;
    if (childSessionId) {
      return {
        kind: 'delegation',
        callId: tool.callId,
        childSessionId,
        taskName: matched?.taskName ?? taskName,
      };
    }
  }
  const change = changeMap.get(tool.callId);
  if (change || tool.name === 'edit_file' || tool.name === 'write_file') {
    return {
      kind: 'diff',
      callId: tool.callId,
      filePath: relativizeWorkspaceText(
        change?.path || inputPath || tool.invocation,
        workspaceRoot,
      ),
      additions: change?.additions,
      deletions: change?.deletions,
    };
  }
  return { kind: 'inspector', callId: tool.callId };
}

function resolveToolStatus(tools: readonly ViewTool[]): ViewTool['status'] {
  if (tools.some((t) => t.status === 'running')) return 'running';
  if (tools.some((t) => t.status === 'failed')) return 'failed';
  return tools.some((t) => t.status === 'interrupted') ? 'interrupted' : 'succeeded';
}

function projectToolGroup(
  groupId: string,
  blocks: readonly ViewBlock[],
  workspaceRoot: string | undefined,
  evidence: ViewEvidence | undefined,
): UnifiedProcessStep {
  const changeMap = new Map(
    (evidence?.changes ?? []).map((c) => [
      c.callId,
      { additions: c.additions, deletions: c.deletions, path: c.path },
    ]),
  );
  const rawTools = blocks.flatMap((b) => (b.tool ? [b.tool] : []));
  let durationSum = 0;
  let hasDuration = false;
  const tools: UnifiedToolItem[] = rawTools.map((tool) => {
    if (tool.durationMs !== undefined) {
      durationSum += tool.durationMs;
      hasDuration = true;
    }
    const stat = changeMap.get(tool.callId);
    return {
      callId: tool.callId,
      name: tool.name,
      displayName: tool.displayName,
      verb: tool.verb ?? TOOL_VERBS[tool.name] ?? tool.displayName,
      targetLabel: relativizeWorkspaceText(
        tool.chip ?? tool.invocation ?? tool.displayName,
        workspaceRoot,
      ),
      mono: tool.mono ?? Boolean(tool.chip),
      status: tool.status,
      durationMs: tool.durationMs ?? tool.elapsedMs,
      diffStat:
        stat && (stat.additions !== null || stat.deletions !== null)
          ? { additions: stat.additions, deletions: stat.deletions }
          : undefined,
      failureReason: tool.status === 'failed' ? extractToolFailureSummary(tool.result) : undefined,
      primaryTarget: resolveToolTarget(tool, workspaceRoot, changeMap, evidence?.delegations),
    };
  });
  const summary = summarizeToolGroup(rawTools);
  return {
    id: groupId,
    kind: 'tool_group',
    status: resolveToolStatus(rawTools),
    summaryText: summary?.text ?? `已执行 ${tools.length} 步操作`,
    totalCount: summary?.total ?? tools.length,
    failedCount: summary?.failed ?? tools.filter((t) => t.status === 'failed').length,
    totalDurationMs: hasDuration ? durationSum : undefined,
    tools,
  };
}

function readPlainUserText(msg: ViewMessage): string {
  return msg.blocks
    .filter((b) => b.kind === 'text' && !b.skillName)
    .map((b) => b.text)
    .join('\n')
    .trim();
}

function isSystemText(text: string): boolean {
  return text.startsWith('<watch-event ') || text.startsWith('<subagent-notification ');
}

function buildUnifiedTurns(
  messages: readonly ViewMessage[],
  expandedMap: Readonly<Record<string, boolean>>,
  opts: {
    readonly workspaceRoot?: string;
    readonly evidence?: ViewEvidence;
    readonly isIdleOrFailed: boolean;
    readonly canRegenerateSession: boolean;
    readonly canForkOrCheckpoint: boolean;
  },
): UnifiedTurn[] {
  const buckets: Array<{ id: string; userMsg?: ViewMessage; assistantMsgs: ViewMessage[] }> = [];
  for (const message of messages) {
    if (message.role === 'user')
      buckets.push({ id: message.id, userMsg: message, assistantMsgs: [] });
    else if (message.role === 'assistant') {
      const last = buckets.at(-1);
      if (last) last.assistantMsgs.push(message);
      else buckets.push({ id: message.id, assistantMsgs: [message] });
    }
  }
  let lastRealUserIdx = -1;
  buckets.forEach((b, idx) => {
    if (b.userMsg && !isSystemText(readPlainUserText(b.userMsg))) lastRealUserIdx = idx;
  });

  return buckets.map((bucket, idx) => {
    const userText = bucket.userMsg ? readPlainUserText(bucket.userMsg) : '';
    const userMessage: UnifiedTurn['userMessage'] = bucket.userMsg
      ? {
          id: bucket.userMsg.id,
          text: userText,
          skillNames: bucket.userMsg.blocks.flatMap((b) =>
            b.kind === 'text' && b.skillName ? [b.skillName] : [],
          ),
          state: bucket.userMsg.state,
          persisted: bucket.userMsg.persisted,
          isSystemEvent: isSystemText(userText),
        }
      : undefined;

    const processSteps: UnifiedProcessStep[] = [];
    const proseBlocks: UnifiedTurn['proseBlocks'][number][] = [];
    const streamItems: UnifiedTurn['streamItems'][number][] = [];
    let pendingTools: ViewBlock[] = [];
    const flushTools = () => {
      if (pendingTools.length === 0) return;
      const step = projectToolGroup(
        `group:${pendingTools[0]?.id ?? 'tools'}`,
        pendingTools,
        opts.workspaceRoot,
        opts.evidence,
      );
      processSteps.push(step);
      streamItems.push({ kind: 'process', step });
      pendingTools = [];
    };

    for (const block of bucket.assistantMsgs.flatMap((m) => m.blocks)) {
      if (block.kind === 'tool') {
        pendingTools.push(block);
        continue;
      }
      flushTools();
      if (block.kind === 'thinking') {
        const step: UnifiedProcessStep = {
          id: block.id,
          kind: 'thinking',
          text: block.text,
          state: block.state,
          expanded: expandedMap[block.id] ?? block.state === 'streaming',
        };
        processSteps.push(step);
        streamItems.push({ kind: 'process', step });
      } else if (block.kind === 'text' && block.text.trim().length > 0) {
        const prose: UnifiedTurn['proseBlocks'][number] = {
          id: block.id,
          text: block.text,
          state: block.state,
          previewableCodeBlocks: extractPreviewableCodeBlocks(block.id, block.text, block.state),
        };
        proseBlocks.push(prose);
        streamItems.push({ kind: 'prose', block: prose });
      }
    }
    flushTools();

    const state: UnifiedTurn['state'] = bucket.assistantMsgs.some((m) => m.state === 'streaming')
      ? 'streaming'
      : bucket.assistantMsgs.some((m) => m.state === 'interrupted')
        ? 'interrupted'
        : 'completed';
    const turnMeta: ViewTurnMeta | undefined = [...bucket.assistantMsgs]
      .reverse()
      .find((m) => Boolean(m.turnMeta))?.turnMeta;

    return {
      id: bucket.id,
      turnOrdinal: idx + 1,
      userMessage,
      processSteps,
      proseBlocks,
      streamItems,
      state,
      turnMeta,
      turnMetaBadge: formatTurnMetaBadge(bucket.assistantMsgs),
      usage: aggregateTurnUsage(bucket.assistantMsgs),
      canRegenerate: opts.canRegenerateSession && opts.isIdleOrFailed && idx === lastRealUserIdx,
      canRestoreCheckpoint:
        opts.canForkOrCheckpoint &&
        opts.isIdleOrFailed &&
        Boolean(userMessage && !userMessage.isSystemEvent && userMessage.persisted),
    };
  });
}

function resolveDiffSummary(
  explicit: { readonly additions: number; readonly deletions: number } | undefined,
  evidence: ViewEvidence | undefined,
): { readonly additions: number; readonly deletions: number } | undefined {
  const source = explicit ?? evidence?.summary;
  if (!source || (source.additions === 0 && source.deletions === 0)) return undefined;
  return { additions: source.additions, deletions: source.deletions };
}

/** 将本地自研 Core 会话状态纯函数投影为 `UnifiedThreadViewModel`。 */
export function projectNativeThread(input: ProjectNativeThreadInput): UnifiedThreadViewModel {
  const approvals = (input.approvals ?? [])
    .filter(
      (a) =>
        a.workspaceId === input.workspaceId &&
        (a.conversationId === input.conversationId ||
          (Boolean(input.sessionId) &&
            (a.sessionId === input.sessionId ||
              a.subagentOrigin?.parentSessionId === input.sessionId))),
    )
    .map((a) => projectNativeApproval(a, input.workspaceRoot));
  const opPhase = input.presentation.operation?.phase ?? 'idle';
  const phase: UnifiedThreadViewModel['phase'] =
    approvals.length > 0
      ? 'waiting_approval'
      : opPhase === 'cancelling'
        ? 'cancelling'
        : opPhase === 'running' || opPhase === 'settling'
          ? 'running'
          : input.presentation.operation?.result === 'failed'
            ? 'failed'
            : 'idle';
  const canFork = input.canForkOrCheckpoint ?? true;
  const turns = buildUnifiedTurns(selectMessages(input.presentation), input.presentation.expanded, {
    workspaceRoot: input.workspaceRoot,
    evidence: input.evidence,
    isIdleOrFailed: phase === 'idle' || phase === 'failed',
    canRegenerateSession: true,
    canForkOrCheckpoint: canFork,
  });
  return {
    sessionKey: buildNativeSessionKey(input.workspaceId, input.conversationId),
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    title: input.title?.trim() || '未命名对话',
    phase,
    harness: {
      kind: 'native',
      id: 'kapibala-core',
      label: input.agentLabel?.trim() || 'Kapibala',
      resumable: true,
      worktreeBranch: input.worktree?.branch,
    },
    turns,
    approvals,
    retryStatus: input.presentation.retryStatus,
    worktree: input.worktree,
    todos: input.presentation.todos,
    activeWatchesCount: input.activeWatchesCount ?? 0,
    diffSummary: resolveDiffSummary(input.diffSummary, input.evidence),
    evidence: input.evidence,
    notices: input.presentation.notices,
    capabilities: {
      canContinue: true,
      canSwitchRole: true,
      canSwitchPermissionMode: true,
      canForkOrCheckpoint: canFork,
      externalConfigCategories: [],
    },
  };
}

/** 将四类外部代理快照（`acp / claude-cli / codex-app-server / pi-rpc`）纯函数投影为同一 `UnifiedThreadViewModel`。 */
export function projectExternalThread(input: ProjectExternalThreadInput): UnifiedThreadViewModel {
  const { session } = input.snapshot;
  const effectiveRoot = input.workspaceRoot || session.workspaceRoot;
  const approvals = input.snapshot.approvals.map((a) => projectExternalApproval(a, effectiveRoot));
  const phase: UnifiedThreadViewModel['phase'] =
    approvals.length > 0 || session.status === 'waiting_approval'
      ? 'waiting_approval'
      : session.status;
  const categories = Array.from(
    new Set((input.snapshot.configOptions ?? []).map((opt) => opt.category)),
  );
  const turns = buildUnifiedTurns(
    input.snapshot.messages,
    {},
    {
      workspaceRoot: effectiveRoot,
      evidence: input.evidence,
      isIdleOrFailed: phase === 'idle' || phase === 'failed' || phase === 'ended',
      canRegenerateSession: false,
      canForkOrCheckpoint: false,
    },
  );
  return {
    sessionKey: buildExternalSessionKey(session.id),
    workspaceId: input.workspaceId,
    workspaceName: input.workspaceName,
    title: session.title.trim() || `${session.harnessName} 会话`,
    phase,
    harness: {
      kind: 'external',
      id: session.harnessId,
      label: session.harnessName,
      transportLabel: TRANSPORT_LABELS[session.transport],
      resumable: session.resumable,
      worktreeBranch: input.worktree?.branch,
    },
    turns,
    approvals,
    worktree: input.worktree,
    todos: input.snapshot.plan,
    activeWatchesCount: 0,
    diffSummary: resolveDiffSummary(input.diffSummary, input.evidence),
    evidence: input.evidence,
    notices: input.snapshot.notices,
    capabilities: {
      canContinue: session.canContinue,
      canSwitchRole: false,
      canSwitchPermissionMode: categories.includes('mode'),
      canForkOrCheckpoint: false,
      externalConfigCategories: categories,
    },
  };
}
