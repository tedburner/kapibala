import type { ViewEvidence, ViewTool } from '@kiturone/kapibala-host/view-model';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { UnifiedApprovalItem } from '../../adapters/index.js';
import { clipForDisplay } from '../../display-budget.js';
import { useI18n } from '../../i18n.js';
import { Badge, type BadgeTone, Button } from '../../ui/index.js';
import { EvidenceDashboard } from './EvidenceDashboard.js';
import { formatPreviewBytes } from './PreviewTab.js';

const TOOL_STATUS_LABELS: Readonly<
  Record<ViewTool['status'], { readonly label: string; readonly tone: BadgeTone }>
> = {
  running: { label: '执行中', tone: 'pulse' },
  succeeded: { label: '已完成', tone: 'success' },
  failed: { label: '失败', tone: 'danger' },
  interrupted: { label: '已中断', tone: 'warning' },
};

function formatToolPayload(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw;
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return raw;
  }
}

function readStringField(
  payload: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const val = payload[key];
    if (typeof val === 'string' && val.trim().length > 0) return val;
  }
  return undefined;
}

function CopyableCodeSection({
  title,
  code,
  copyLabel,
}: {
  readonly title: string;
  readonly code: string;
  readonly copyLabel: string;
}) {
  const { t } = useI18n();
  const clip = useMemo(() => clipForDisplay(code), [code]);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    return () => {
      if (typeof window !== 'undefined' && timerRef.current !== undefined) {
        window.clearTimeout(timerRef.current);
      }
    };
  }, []);

  return (
    <div className="flex flex-col gap-1">
      <div className="kpbl-wb-toolbar-group justify-between">
        <span className="kpbl-field-label">{title}</span>
        <Button
          variant="ghost"
          size="xs"
          leadingIcon={copied ? 'check' : 'copy'}
          aria-label={copyLabel}
          onClick={() => {
            if (typeof navigator !== 'undefined' && navigator.clipboard) {
              void navigator.clipboard.writeText(code).then(() => {
                setCopied(true);
                if (typeof window !== 'undefined') {
                  window.clearTimeout(timerRef.current);
                  timerRef.current = window.setTimeout(() => setCopied(false), 1_500);
                }
              });
            }
          }}
        >
          {copied
            ? t('thread.copied')
            : clip.truncated
              ? t('inspector.copyFull')
              : t('inspector.copy')}
        </Button>
      </div>
      {clip.truncated ? <span className="kpbl-wb-meta">{t('inspector.truncatedMeta')}</span> : null}
      <pre className="kpbl-inspector-pre">{clip.text}</pre>
    </div>
  );
}

/**
 * `InspectorTab` 入参契约（`tab[name="详情与证据"]`）：
 * - 上半区：检视选中工具调用（`callId`）的完整入参与输出，或内联审批单（`UnifiedApprovalItem`）的底层环境载荷；
 * - 下半区：组合 `EvidenceDashboard` 展示四维会话证据看板与委派会话跳转。
 */
export interface InspectorTabProps {
  readonly selectedCallId?: string;
  readonly selectedTool?: ViewTool;
  readonly tools?: readonly ViewTool[];
  readonly selectedApproval?: UnifiedApprovalItem;
  readonly workspaceRoot?: string;
  readonly executionRoot?: string;
  readonly conversationId?: string;
  readonly evidence?: ViewEvidence;
  readonly onReloadEvidence?: () => void;
  readonly onOpenDelegationSession?: (sessionId: string) => void;
  readonly onOpenDiffFile?: (filePath: string, callId?: string) => void;
  readonly onClearSelection?: () => void;
}

/**
 * 右侧工作台「详情与证据」标签页。
 */
export function InspectorTab({
  selectedCallId,
  selectedTool: explicitTool,
  tools = [],
  selectedApproval,
  workspaceRoot,
  executionRoot,
  conversationId,
  evidence,
  onReloadEvidence,
  onOpenDelegationSession,
  onOpenDiffFile,
  onClearSelection,
}: InspectorTabProps) {
  const { t } = useI18n();
  const resolvedTool = useMemo(
    () =>
      explicitTool ??
      (selectedCallId ? tools.find((item) => item.callId === selectedCallId) : undefined),
    [explicitTool, selectedCallId, tools],
  );

  const approvalEnv = useMemo(() => {
    if (!selectedApproval) return null;
    const p = selectedApproval.inspectorPayload;
    const wsRoot = readStringField(p, ['workspaceRoot']) ?? workspaceRoot;
    const execRoot =
      readStringField(p, ['executionRoot', 'worktreePath', 'cwd']) ?? executionRoot ?? wsRoot;
    const runId = readStringField(p, ['runId', 'toolCallId']);
    const sessionId = readStringField(p, ['sessionId', 'conversationId']) ?? conversationId;
    return {
      wsRoot,
      execRoot,
      runId,
      sessionId,
      json: JSON.stringify(p, null, 2),
    };
  }, [conversationId, executionRoot, selectedApproval, workspaceRoot]);

  const toolStatusLabel = (status: ViewTool['status']): string => {
    if (status === 'running') return t('process.running');
    if (status === 'failed') return t('process.failed');
    if (status === 'interrupted') return t('process.interrupted');
    return t('process.completed');
  };

  return (
    <div className="kpbl-inspector-scroll">
      {selectedApproval && approvalEnv ? (
        <section aria-label={t('inspector.approvalSectionAria')} className="kpbl-inspector-card">
          <div className="kpbl-wb-toolbar-group justify-between">
            <div className="kpbl-wb-toolbar-group">
              <Badge tone="pulse" icon="shield-warning">
                {selectedApproval.source === 'delegation'
                  ? t('inspector.approvalDelegation')
                  : selectedApproval.source === 'external'
                    ? t('inspector.approvalExternal')
                    : t('inspector.approvalNative')}
              </Badge>
              {selectedApproval.riskLabel ? (
                <Badge tone="warning">{selectedApproval.riskLabel}</Badge>
              ) : null}
            </div>
            {onClearSelection ? (
              <Button variant="ghost" size="xs" onClick={onClearSelection}>
                {t('inspector.clearSelection')}
              </Button>
            ) : null}
          </div>
          <div className="kpbl-setting-row-title">{selectedApproval.title}</div>
          <dl className="kpbl-inspector-kv">
            {approvalEnv.wsRoot ? (
              <>
                <dt>{t('inspector.wsRoot')}</dt>
                <dd className="font-mono">{approvalEnv.wsRoot}</dd>
              </>
            ) : null}
            {approvalEnv.execRoot ? (
              <>
                <dt>{t('inspector.execRoot')}</dt>
                <dd className="font-mono">{approvalEnv.execRoot}</dd>
              </>
            ) : null}
            {approvalEnv.runId ? (
              <>
                <dt>{t('inspector.runId')}</dt>
                <dd className="font-mono">{approvalEnv.runId}</dd>
              </>
            ) : null}
            {approvalEnv.sessionId ? (
              <>
                <dt>{t('inspector.sessionId')}</dt>
                <dd className="font-mono">{approvalEnv.sessionId}</dd>
              </>
            ) : null}
          </dl>
          <CopyableCodeSection
            title={t('inspector.rawEnvTitle')}
            code={approvalEnv.json}
            copyLabel={t('inspector.copyApprovalAria')}
          />
        </section>
      ) : resolvedTool ? (
        <section aria-label={t('inspector.toolSectionAria')} className="kpbl-inspector-card">
          <div className="kpbl-wb-toolbar-group justify-between">
            <div className="kpbl-wb-toolbar-group">
              <strong className="kpbl-setting-row-title">
                {resolvedTool.displayName || resolvedTool.name}
              </strong>
              <Badge tone={TOOL_STATUS_LABELS[resolvedTool.status].tone}>
                {toolStatusLabel(resolvedTool.status)}
              </Badge>
            </div>
            <span className="kpbl-wb-meta">
              {resolvedTool.durationMs !== undefined ? `${resolvedTool.durationMs} ms` : ''}
              {resolvedTool.outputBytes !== undefined
                ? ` · ${formatPreviewBytes(resolvedTool.outputBytes)}`
                : ''}
            </span>
          </div>
          <span className="kpbl-wb-meta font-mono">
            {resolvedTool.name} · {resolvedTool.callId}
          </span>
          <CopyableCodeSection
            title={t('inspector.toolInputTitle')}
            code={formatToolPayload(resolvedTool.input || resolvedTool.invocation)}
            copyLabel={t('inspector.copyToolInputAria')}
          />
          <CopyableCodeSection
            title={t('inspector.toolOutputTitle')}
            code={formatToolPayload(resolvedTool.result ?? t('inspector.noToolResult'))}
            copyLabel={t('inspector.copyToolOutputAria')}
          />
        </section>
      ) : (
        <section aria-label={t('inspector.envSectionAria')} className="kpbl-inspector-card">
          <div className="kpbl-setting-row-title">{t('inspector.envTitle')}</div>
          <p className="kpbl-field-hint">{t('inspector.envHint')}</p>
          {workspaceRoot || executionRoot || conversationId ? (
            <dl className="kpbl-inspector-kv">
              {workspaceRoot ? (
                <>
                  <dt>{t('inspector.wsRoot')}</dt>
                  <dd className="font-mono">{workspaceRoot}</dd>
                </>
              ) : null}
              {executionRoot && executionRoot !== workspaceRoot ? (
                <>
                  <dt>{t('inspector.managedExecRoot')}</dt>
                  <dd className="font-mono">{executionRoot}</dd>
                </>
              ) : null}
              {conversationId ? (
                <>
                  <dt>{t('inspector.sessionId')}</dt>
                  <dd className="font-mono">{conversationId}</dd>
                </>
              ) : null}
            </dl>
          ) : null}
        </section>
      )}

      <EvidenceDashboard
        evidence={evidence}
        onReloadEvidence={onReloadEvidence}
        onOpenDelegationSession={onOpenDelegationSession}
        onOpenDiffFile={onOpenDiffFile}
      />
    </div>
  );
}
