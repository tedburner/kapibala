import {
  type ViewBlock,
  type ViewEvidence,
  type ViewTool,
  summarizeToolGroup,
} from '@kiturone/kapibala-host/view-model';
import { artifactFileName } from '../artifact-model.js';
import { textPreviewLabel, toolPreview } from '../html-preview-model.js';
import {
  type UnifiedProcessStep,
  type UnifiedToolItem,
  type UnifiedWorkbenchTarget,
  extractJsonStringProp,
  extractToolFailureSummary,
  relativizeWorkspaceText,
} from './index.js';

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

/**
 * 将连续的工具块聚合为可折叠的 `UnifiedProcessStep`（`tool_group`），
 * 并按产物、内联 HTML/SVG、子代理委派与文件变更优先级解析工作台联动目标。
 */
export function projectToolGroup(
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
