import type {
  PresentationState,
  ViewArtifact,
  ViewBlock,
  ViewCheckpointItem,
  ViewEvidence,
  ViewExternalApproval,
  ViewExternalConfigCategory,
  ViewExternalSnapshot,
  ViewMessage,
  ViewNotice,
  ViewRetryStatus,
  ViewTodoState,
  ViewTool,
  ViewTurnMeta,
  ViewUsage,
} from '@kiturone/kapibala-host/view-model';
import { htmlPreviewSource } from '../html-preview-model.js';

/** 归一后的会话来源身份；决定页头 `HarnessBadge` 文案与输入坞能力位（017 §5.2）。 */
export interface ThreadHarnessIdentity {
  readonly kind: 'native' | 'external';
  readonly id: string;
  readonly label: string;
  readonly transportLabel?: 'ACP' | 'CLI' | 'App-Server' | 'RPC';
  readonly resumable: boolean;
  readonly worktreeBranch?: string;
}

/** 会话关联的受管 Git Worktree 元数据；存在时展示 `⎇ <branch>` 隔离标记。 */
export interface ThreadWorktreeBinding {
  readonly id: string;
  readonly branch: string;
  readonly worktreePath: string;
  readonly baseRef?: string;
  readonly missing?: boolean;
}

/** 本地 Core、委派子代理与外部代理共用的内联审批单结构（首屏脱敏路径，详情入 `inspectorPayload`）。 */
export interface UnifiedApprovalItem {
  readonly id: string;
  readonly source: 'native' | 'delegation' | 'external';
  readonly title: string;
  readonly riskLabel?: string;
  readonly summaryCode: string;
  readonly relativeCwd?: string;
  readonly subagentBadge?: {
    readonly agentId: string;
    readonly role: string;
    readonly description: string;
    readonly childSessionId?: string;
    readonly parentSessionId: string;
  };
  readonly expiresAt?: number;
  readonly actions: readonly {
    readonly id: string;
    readonly label: string;
    readonly intent: 'primary' | 'secondary' | 'danger';
    readonly shortcutHint?: 'Y' | 'S' | 'N';
  }[];
  readonly inspectorPayload: Readonly<Record<string, unknown>>;
}

/** 工具执行行点击后联动右侧工作台或子会话跳转的强类型目标契约（017 §6.3 & U1.7）。 */
export type UnifiedWorkbenchTarget =
  | {
      readonly kind: 'diff';
      readonly callId: string;
      readonly filePath: string;
      readonly additions?: number | null;
      readonly deletions?: number | null;
    }
  | {
      readonly kind: 'preview';
      readonly callId: string;
      readonly previewKind: 'html' | 'svg' | 'image';
      readonly label: string;
      readonly filePath?: string;
      readonly html?: string;
      readonly artifact?: ViewArtifact;
    }
  | {
      readonly kind: 'delegation';
      readonly callId: string;
      readonly childSessionId: string;
      readonly taskName?: string;
    }
  | { readonly kind: 'inspector'; readonly callId: string };

/** 过程组内单条工具调用的归一展示行。 */
export interface UnifiedToolItem {
  readonly callId: string;
  readonly name: string;
  readonly displayName: string;
  readonly verb: string;
  readonly targetLabel: string;
  readonly mono: boolean;
  readonly status: ViewTool['status'];
  readonly durationMs?: number;
  readonly diffStat?: { readonly additions: number | null; readonly deletions: number | null };
  readonly failureReason?: string;
  readonly inlineSummary?: string;
  readonly primaryTarget: UnifiedWorkbenchTarget;
}

/** 助手正文内可送入右侧 `Preview` 沙箱标签的独立 HTML/SVG 代码块。 */
export interface UnifiedPreviewableCodeBlock {
  readonly id: string;
  readonly language: 'html' | 'svg';
  readonly label: string;
  readonly rawCode: string;
  readonly sandboxDocument: string;
}

/** 助手推理与工具执行过程步骤：相邻工具调用自动聚合成可折叠 `tool_group`（017 §6.3）。 */
export type UnifiedProcessStep =
  | {
      readonly id: string;
      readonly kind: 'thinking';
      readonly text: string;
      readonly state: ViewBlock['state'];
      readonly expanded: boolean;
    }
  | {
      readonly id: string;
      readonly kind: 'tool_group';
      readonly status: ViewTool['status'];
      readonly summaryText: string;
      readonly totalCount: number;
      readonly failedCount: number;
      readonly totalDurationMs?: number;
      readonly tools: readonly UnifiedToolItem[];
    };

/** 归一对话轮次（`UnifiedTurn`）：聚合单次用户提问与思考、工具组、正文及成本元数据。 */
export interface UnifiedTurn {
  readonly id: string;
  readonly turnOrdinal: number;
  /** 宿主 Shadow Git 检查点真实 0-based 序号；该轮缺少快照时为 `undefined`。 */
  readonly checkpointOrdinal?: number;
  readonly userMessage?: {
    readonly id: string;
    readonly text: string;
    readonly skillNames: readonly string[];
    readonly state: ViewMessage['state'];
    readonly persisted: boolean;
    readonly isSystemEvent: boolean;
  };
  readonly processSteps: readonly UnifiedProcessStep[];
  readonly proseBlocks: readonly {
    readonly id: string;
    readonly text: string;
    readonly state: ViewBlock['state'];
    readonly previewableCodeBlocks: readonly UnifiedPreviewableCodeBlock[];
  }[];
  readonly streamItems: readonly (
    | { readonly kind: 'process'; readonly step: UnifiedProcessStep }
    | { readonly kind: 'prose'; readonly block: UnifiedTurn['proseBlocks'][number] }
  )[];
  readonly state: 'streaming' | 'completed' | 'interrupted';
  readonly timestamp?: number;
  readonly turnMeta?: ViewTurnMeta;
  readonly turnMetaBadge?: string;
  readonly usage?: ViewUsage;
  readonly canRegenerate: boolean;
  readonly canRestoreCheckpoint: boolean;
}

/** 驱动 `SessionStage`、`ComposerDock` 与 `WorkbenchStage` 的唯一只读会话视图模型（017 §5.2）。 */
export interface UnifiedThreadViewModel {
  readonly sessionKey: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly title: string;
  readonly phase:
    | 'idle'
    | 'starting'
    | 'running'
    | 'waiting_approval'
    | 'cancelling'
    | 'failed'
    | 'ended';
  readonly harness: ThreadHarnessIdentity;
  readonly turns: readonly UnifiedTurn[];
  readonly approvals: readonly UnifiedApprovalItem[];
  readonly retryStatus?: ViewRetryStatus;
  readonly worktree?: ThreadWorktreeBinding;
  readonly todos?: ViewTodoState;
  readonly activeWatchesCount: number;
  readonly diffSummary?: { readonly additions: number; readonly deletions: number };
  readonly evidence?: ViewEvidence;
  readonly notices: readonly ViewNotice[];
  readonly capabilities: {
    readonly canContinue: boolean;
    readonly canSwitchRole: boolean;
    readonly canSwitchPermissionMode: boolean;
    readonly canForkOrCheckpoint: boolean;
    readonly externalConfigCategories: readonly ViewExternalConfigCategory[];
  };
}

/** 本地会话待处理审批入参投影（支持 `subagentOrigin` 冒泡）。 */
export interface NativeApprovalProjectionInput {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly conversationId: string;
  readonly approvalId: string;
  readonly runId: string;
  readonly toolName: string;
  readonly capabilities: readonly string[];
  readonly description: string;
  readonly sessionAllowed: boolean;
  readonly expiresAt: number;
  readonly riskLabel?: string;
  readonly subagentOrigin?: UnifiedApprovalItem['subagentBadge'];
}

/** `projectNativeThread` 纯函数入参。 */
export interface ProjectNativeThreadInput {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceRoot?: string;
  readonly sessionId?: string;
  readonly conversationId: string;
  readonly title?: string;
  readonly agentLabel?: string;
  readonly presentation: PresentationState;
  readonly approvals?: readonly NativeApprovalProjectionInput[];
  readonly activeWatchesCount?: number;
  readonly evidence?: ViewEvidence;
  readonly worktree?: ThreadWorktreeBinding;
  readonly diffSummary?: { readonly additions: number; readonly deletions: number };
  readonly checkpoints?: readonly ViewCheckpointItem[];
  readonly canForkOrCheckpoint?: boolean;
}

/** `projectExternalThread` 纯函数入参。 */
export interface ProjectExternalThreadInput {
  readonly workspaceId: string;
  readonly workspaceName: string;
  readonly workspaceRoot?: string;
  readonly snapshot: ViewExternalSnapshot;
  readonly worktree?: ThreadWorktreeBinding;
  readonly diffSummary?: { readonly additions: number; readonly deletions: number };
  readonly evidence?: ViewEvidence;
}

const APPROVAL_TOOL_TITLES: Readonly<Record<string, string>> = {
  run_command: '运行终端命令',
  write_file: '写入工作区文件',
  edit_file: '修改工作区文件',
  delete_file: '删除工作区文件',
  spawn_agent: '启动委派子代理',
};

/** 构造本地会话全局唯一 `sessionKey`（`native:<workspaceId>:<conversationId>`）。 */
export function buildNativeSessionKey(workspaceId: string, conversationId: string): string {
  return `native:${workspaceId}:${conversationId}`;
}

/** 构造外部代理会话全局唯一 `sessionKey`（`external:<sessionId>`）。 */
export function buildExternalSessionKey(sessionId: string): string {
  return `external:${sessionId}`;
}

/** 解析 `sessionKey` 为强类型会话定位载荷；`null` 或非法格式回退 `null`。 */
export function parseSessionKey(
  sessionKey: string | null | undefined,
):
  | { readonly kind: 'native'; readonly workspaceId: string; readonly conversationId: string }
  | { readonly kind: 'external'; readonly sessionId: string }
  | null {
  if (!sessionKey) return null;
  if (sessionKey.startsWith('external:')) {
    const sessionId = sessionKey.slice('external:'.length);
    return sessionId ? { kind: 'external', sessionId } : null;
  }
  if (!sessionKey.startsWith('native:')) return null;
  const rest = sessionKey.slice('native:'.length);
  const sep = rest.indexOf(':');
  if (sep <= 0 || sep >= rest.length - 1) return null;
  return { kind: 'native', workspaceId: rest.slice(0, sep), conversationId: rest.slice(sep + 1) };
}

/** 将文本中的工作区根绝对路径替换为相对形式，保证内联审批卡与工具行首屏零绝对路径噪音。 */
export function relativizeWorkspaceText(text: string, workspaceRoot?: string): string {
  if (!text || !workspaceRoot) return text;
  const cleanRoot = workspaceRoot.trim().replaceAll('\\', '/').replace(/\/+$/, '');
  if (!cleanRoot) return text;
  const escFwd = cleanRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escBwd = cleanRoot.replaceAll('/', '\\\\').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text
    .replace(new RegExp(`${escFwd}/`, 'gi'), '')
    .replace(new RegExp(`${escBwd}\\\\`, 'gi'), '')
    .replace(new RegExp(escFwd, 'gi'), '.')
    .replace(new RegExp(escBwd, 'gi'), '.');
}

/** 提取已完成文本块中的独立 `html` / `svg` 围栏代码片段，封装 CSP 头后供右侧 `Preview` 标签按需渲染。 */
export function extractPreviewableCodeBlocks(
  blockId: string,
  markdown: string,
  state: ViewBlock['state'],
): UnifiedPreviewableCodeBlock[] {
  if (state === 'streaming' || !markdown.includes('```')) return [];
  const results: UnifiedPreviewableCodeBlock[] = [];
  const fenceRegex = /```(html|svg)\s*\r?\n([\s\S]*?)```/gi;
  let match = fenceRegex.exec(markdown);
  let idx = 0;
  while (match !== null) {
    const lang = (match[1]?.toLowerCase() === 'svg' ? 'svg' : 'html') as 'html' | 'svg';
    const rawCode = (match[2] ?? '').trim();
    if (rawCode.length > 0) {
      idx += 1;
      results.push({
        id: `${blockId}:code-${idx}`,
        language: lang,
        label: lang === 'svg' ? 'SVG 代码片段预览' : 'HTML 代码片段预览',
        rawCode,
        sandboxDocument: htmlPreviewSource(rawCode),
      });
    }
    match = fenceRegex.exec(markdown);
  }
  return results;
}

/** 将本地直接审批或委派子代理冒泡审批映射为 `UnifiedApprovalItem`。 */
export function projectNativeApproval(
  item: NativeApprovalProjectionInput,
  fallbackRoot?: string,
): UnifiedApprovalItem {
  const actionTitle = APPROVAL_TOOL_TITLES[item.toolName] ?? `调用 ${item.toolName}`;
  const sub = item.subagentOrigin;
  const actions: UnifiedApprovalItem['actions'][number][] = [
    { id: 'deny_once', label: '拒绝', intent: 'danger', shortcutHint: 'N' },
    ...(item.sessionAllowed
      ? [
          {
            id: 'allow_session',
            label: '本会话允许相同调用',
            intent: 'secondary',
            shortcutHint: 'S',
          } as const,
        ]
      : []),
    { id: 'allow_once', label: '批准一次', intent: 'primary', shortcutHint: 'Y' },
  ];
  return {
    id: item.approvalId,
    source: sub ? 'delegation' : 'native',
    title: sub ? `子代理（${sub.role}）请求${actionTitle}` : `请求${actionTitle}`,
    riskLabel: item.riskLabel ?? (item.capabilities[0] || undefined),
    summaryCode: relativizeWorkspaceText(
      item.description.trim() || item.toolName,
      item.workspaceRoot || fallbackRoot,
    ),
    relativeCwd: '.',
    subagentBadge: sub,
    expiresAt: item.expiresAt,
    actions,
    inspectorPayload: { ...item },
  };
}

/** 将外部代理审批单映射为统一 `UnifiedApprovalItem` 并补齐快捷键提示与兜底拒绝动作。 */
export function projectExternalApproval(
  item: ViewExternalApproval,
  workspaceRoot?: string,
): UnifiedApprovalItem {
  let hasPrimary = false;
  let hasSession = false;
  let hasReject = false;
  const actions: UnifiedApprovalItem['actions'][number][] = item.options.map((opt) => {
    if (/reject|deny|cancel/i.test(opt.kind)) {
      const hint = hasReject ? undefined : ('N' as const);
      hasReject = true;
      return { id: opt.optionId, label: opt.label, intent: 'danger', shortcutHint: hint };
    }
    if (/session|always/i.test(opt.kind) || /会话|始终|always|session/i.test(opt.label)) {
      const hint = hasSession ? undefined : ('S' as const);
      hasSession = true;
      return { id: opt.optionId, label: opt.label, intent: 'secondary', shortcutHint: hint };
    }
    const intent = hasPrimary ? 'secondary' : 'primary';
    const hint = hasPrimary ? undefined : ('Y' as const);
    hasPrimary = true;
    return { id: opt.optionId, label: opt.label, intent, shortcutHint: hint };
  });
  if (!hasReject) {
    actions.unshift({ id: '__cancel__', label: '拒绝', intent: 'danger', shortcutHint: 'N' });
  }
  return {
    id: item.approvalId,
    source: 'external',
    title: `外部代理请求授权：${item.toolTitle}`,
    riskLabel: item.warning ? '外部权限请求' : undefined,
    summaryCode: relativizeWorkspaceText(item.target?.trim() || item.toolTitle, workspaceRoot),
    relativeCwd: workspaceRoot ? '.' : undefined,
    expiresAt: item.expiresAt,
    actions,
    inspectorPayload: { ...item, workspaceRoot },
  };
}

/** 提取结构化或纯文本工具输出的首条非空错误摘要（过滤孤立大括号）。 */
export function extractToolFailureSummary(result: string | undefined): string | undefined {
  if (!result) return undefined;
  let source = result.trim();
  if (source.startsWith('{')) {
    try {
      const parsed = JSON.parse(source) as Record<string, unknown>;
      const candidate = parsed.message ?? parsed.error ?? parsed.output;
      if (typeof candidate === 'string') source = candidate;
    } catch {
      /* 截断 JSON 回退首行过滤。 */
    }
  }
  return source
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0 && line !== '{' && line !== '}')
    ?.slice(0, 160);
}

/** 从 JSON 工具字符串安全读取首个非空字符串字段。 */
export function extractJsonStringProp(
  raw: string | undefined,
  keys: readonly string[],
): string | undefined {
  if (!raw?.trim().startsWith('{')) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const key of keys) {
      const val = parsed[key];
      if (typeof val === 'string' && val.trim()) return val.trim();
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export { projectExternalThread, projectNativeThread } from './unified-thread.js';
