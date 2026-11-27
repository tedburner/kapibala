import { Button, InputArea } from '@cloudflare/kumo';
import type {
  ViewArtifact,
  ViewExternalApproval,
  ViewExternalConfigOption,
  ViewExternalSnapshot,
} from '@kiturone/kapibala-host/view-model';
import {
  ArrowUpIcon,
  CpuIcon,
  ShieldWarningIcon,
  StopIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { Output } from '../shared/contracts.js';
import { ComposerModelPicker, type SelectedHarnessChoice } from './composer-model-picker.js';
import { MessageList } from './message-list.js';
import { TaskPanel } from './task-panel.js';

type Catalog = Output<'settings.read'>;
type LocalModelChoice = Pick<
  Catalog['profiles'][number],
  'id' | 'name' | 'modelName' | 'providerKey'
>;
type ExternalHarnessChoice = Pick<
  Output<'external.harnesses'>['harnesses'][number],
  'id' | 'name' | 'transport' | 'cachedConfigUpdatedAt'
> & {
  readonly cachedConfigOptions?: readonly ViewExternalConfigOption[];
};

function transportLabel(transport: ViewExternalSnapshot['session']['transport']): string {
  if (transport === 'acp') return 'ACP';
  if (transport === 'claude-cli') return 'CLI 直连';
  if (transport === 'pi-rpc') return 'Pi 直连';
  return 'App-Server';
}

function statusBadge(status: ViewExternalSnapshot['session']['status']): {
  label: string;
  className: string;
} {
  switch (status) {
    case 'starting':
      return { label: '正在启动', className: 'text-(--kapibala-signal)' };
    case 'running':
      return { label: '运行中', className: 'text-(--kapibala-signal)' };
    case 'waiting_approval':
      return { label: '待审批', className: 'text-kumo-warning' };
    case 'cancelling':
      return { label: '正在取消', className: 'text-kumo-subtle' };
    case 'failed':
      return { label: '失败', className: 'text-kumo-danger' };
    case 'ended':
      return { label: '已结束', className: 'text-kumo-subtle' };
    default:
      return { label: '空闲', className: 'text-kumo-subtle' };
  }
}

/**
 * 内联外部代理审批卡片组：原样呈现对端工具提供的选项列表与剩余超时秒数。
 * 本地会话的 Auto / FullAccess 档位绝不跨信任域自动放行此处请求。
 */
function ExternalApprovalDeck({
  approvals,
  busy,
  onApprove,
}: {
  readonly approvals: readonly ViewExternalApproval[];
  readonly busy: boolean;
  readonly onApprove: (approvalId: string, optionId?: string, cancel?: boolean) => void;
}) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (approvals.length === 0) return undefined;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [approvals.length]);

  if (approvals.length === 0) return null;

  return (
    <section
      aria-label="外部代理待处理审批"
      className="mx-auto flex w-full max-w-[var(--kapibala-content-max)] flex-col gap-2"
    >
      {approvals.map((approval) => {
        const remainingSec = Math.max(0, Math.ceil((approval.expiresAt - now) / 1000));
        const expired = remainingSec <= 0;
        return (
          <div
            key={approval.approvalId}
            className="space-y-2.5 rounded-2xl border border-kumo-line border-l-3 border-l-kumo-warning bg-kumo-base p-3.5 shadow-(--kapibala-shadow-composer)"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <ShieldWarningIcon size={16} className="shrink-0 text-kumo-warning" />
                <span className="text-sm font-medium text-kumo-default">
                  外部代理请求授权：{approval.toolTitle}
                </span>
              </div>
              <span className="text-xs text-kumo-subtle tabular-nums">
                {expired ? '已超时，正在按拒绝收口…' : `剩余 ${remainingSec}s（超时自动拒绝）`}
              </span>
            </div>
            {approval.target && (
              <pre className="max-h-28 overflow-auto rounded-lg border border-kumo-hairline bg-kumo-recessed px-3 py-2 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] text-kumo-default">
                {approval.target}
              </pre>
            )}
            {approval.warning && <p className="text-xs text-kumo-warning">{approval.warning}</p>}
            <div className="flex flex-wrap items-center justify-end gap-2 pt-0.5">
              <Button
                className="kapibala-action mr-auto text-kumo-subtle"
                variant="ghost"
                size="sm"
                disabled={busy || expired}
                onClick={() => onApprove(approval.approvalId, undefined, true)}
              >
                取消本轮
              </Button>
              {approval.options.map((option, index) => {
                const isReject = /reject|deny|cancel/i.test(option.kind);
                return (
                  <Button
                    key={option.optionId}
                    className="kapibala-action"
                    variant={!isReject && index === 0 ? 'primary' : 'secondary'}
                    size="sm"
                    disabled={busy || expired}
                    onClick={() => onApprove(approval.approvalId, option.optionId, false)}
                  >
                    {option.label}
                  </Button>
                );
              })}
            </div>
          </div>
        );
      })}
    </section>
  );
}

type StagedExternalTarget =
  | { readonly kind: 'same-external'; readonly choice: SelectedHarnessChoice }
  | { readonly kind: 'cross-external'; readonly choice: SelectedHarnessChoice }
  | { readonly kind: 'local-kapibala'; readonly modelId: string };

/**
 * 外部代理会话工作台主视图。
 *
 * 前置约束与复用边界：
 * - 消息流直接复用 `MessageList`，计划清单直接复用 `TaskPanel`，工具与产物点击复用右侧 `DetailsDrawer`；
 * - 底部输入区复用统一三栏 `ComposerModelPicker`：模型、推理档位、运行模式或跨代理切换均仅暂存至下一轮发送时生效，绝不打断正在生成的当前轮次；
 * - 跨代理切换（或从只读历史归档选择任意可用模型/代理）发送下一轮时，自动携带当前对话上下文接力创建新会话继续。
 */
export function ExternalSessionView({
  workspaceName,
  workspaceRoot,
  snapshot,
  draft,
  busy,
  localBusy,
  wide,
  detailsOpen,
  scrollRef,
  models,
  providers,
  harnesses,
  defaultLocalModel,
  harnessesFailed,
  refreshingHarnessId,
  onRefreshHarnessModels,
  onSettings,
  onExternalSettings,
  onDraftChange,
  onHistoryKeyDown,
  onSend,
  onHandoffToExternal,
  onHandoffToLocal,
  onCancel,
  onApprove,
  onNewSameHarness,
  onTool,
  onArtifact,
  report,
}: {
  readonly workspaceName?: string;
  readonly workspaceRoot?: string;
  readonly snapshot: ViewExternalSnapshot;
  readonly draft: string;
  readonly busy: boolean;
  /** 同一工作区是否有本地会话正在运行；为 true 时展示并发无写租约覆盖提醒。 */
  readonly localBusy: boolean;
  readonly wide: boolean;
  readonly detailsOpen: boolean;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly models: readonly LocalModelChoice[];
  readonly providers: readonly Pick<Catalog['providers'][number], 'key' | 'name'>[];
  readonly harnesses: readonly ExternalHarnessChoice[];
  readonly defaultLocalModel?: Pick<LocalModelChoice, 'id' | 'name'>;
  readonly harnessesFailed?: boolean;
  readonly refreshingHarnessId?: string;
  readonly onRefreshHarnessModels?: (
    harnessId: string,
    options?: { readonly silent?: boolean },
  ) => void;
  readonly onSettings: () => void;
  readonly onExternalSettings: () => void;
  readonly onDraftChange: (value: string) => void;
  /** 外部会话输入区 ↑/↓ 历史问句召回回调；返回 true 表示按键已消费。 */
  readonly onHistoryKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly onSend: (
    text: string,
    clearDraft?: boolean,
    configOverrides?: {
      readonly modelId?: string;
      readonly modeId?: string;
      readonly thoughtLevel?: string;
    },
  ) => void;
  readonly onHandoffToExternal: (text: string, choice: SelectedHarnessChoice) => void;
  readonly onHandoffToLocal: (text: string, profileId: string) => void;
  readonly onCancel: () => void;
  readonly onApprove: (approvalId: string, optionId?: string, cancel?: boolean) => void;
  readonly onNewSameHarness: () => void;
  readonly onTool: (callId: string, trigger: HTMLElement) => void;
  readonly onArtifact: (callId: string, artifact: ViewArtifact, trigger: HTMLElement) => void;
  readonly report: (message: string) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const { session } = snapshot;

  const [stagedOwnerId, setStagedOwnerId] = useState(session.id);
  const [stagedTarget, setStagedTarget] = useState<StagedExternalTarget>();
  if (stagedOwnerId !== session.id) {
    setStagedOwnerId(session.id);
    setStagedTarget(undefined);
  }

  const activeRun =
    session.status === 'starting' ||
    session.status === 'running' ||
    session.status === 'waiting_approval' ||
    session.status === 'cancelling';
  const badge = statusBadge(session.status);

  const modeOption = snapshot.configOptions?.find((opt) => opt.category === 'mode');
  const modelOption = snapshot.configOptions?.find((opt) => opt.category === 'model');
  const thoughtOption = snapshot.configOptions?.find((opt) => opt.category === 'thought_level');

  // 将当前外部会话实时上报的 configOptions 合入选择器目录兜底，确保即便磁盘尚未预热也能展开三栏选择。
  const mergedHarnesses = useMemo<readonly ExternalHarnessChoice[]>(() => {
    const existing = harnesses.some((item) => item.id === session.harnessId);
    const mapped = harnesses.map((item) => {
      if (
        item.id === session.harnessId &&
        (!item.cachedConfigOptions || item.cachedConfigOptions.length === 0) &&
        snapshot.configOptions &&
        snapshot.configOptions.length > 0
      ) {
        return { ...item, cachedConfigOptions: snapshot.configOptions };
      }
      return item;
    });
    if (!existing) {
      return [
        ...mapped,
        {
          id: session.harnessId,
          name: session.harnessName,
          transport: session.transport,
          ...(snapshot.configOptions && snapshot.configOptions.length > 0
            ? { cachedConfigOptions: snapshot.configOptions }
            : {}),
        },
      ];
    }
    return mapped;
  }, [
    harnesses,
    session.harnessId,
    session.harnessName,
    session.transport,
    snapshot.configOptions,
  ]);

  const currentHarnessBaseline = useMemo<SelectedHarnessChoice>(() => {
    const currentModelVal = modelOption?.currentValue;
    const currentModelName =
      modelOption?.options.find((c) => c.value === currentModelVal)?.name ?? session.modelLabel;
    const currentThoughtVal = thoughtOption?.currentValue;
    const currentThoughtName =
      thoughtOption?.options.find((c) => c.value === currentThoughtVal)?.name ??
      session.thoughtLevelLabel;
    const currentModeVal = modeOption?.currentValue;
    const isRoutineMode =
      !session.modeLabel ||
      /^(build|code|ask|default|standard|auto|workspacewrite|workspace-write)$/i.test(
        currentModeVal ?? session.modeLabel,
      );
    return {
      id: session.harnessId,
      name: session.harnessName,
      ...(currentModelVal
        ? { modelId: currentModelVal, modelName: currentModelName ?? currentModelVal }
        : session.modelLabel
          ? { modelName: session.modelLabel }
          : {}),
      ...(currentThoughtVal
        ? {
            thoughtLevel: currentThoughtVal,
            thoughtLevelName: currentThoughtName ?? currentThoughtVal,
          }
        : session.thoughtLevelLabel
          ? {
              thoughtLevel: session.thoughtLevelLabel.toLowerCase(),
              thoughtLevelName: session.thoughtLevelLabel,
            }
          : {}),
      ...(currentModeVal
        ? {
            modeId: currentModeVal,
            ...(!isRoutineMode && session.modeLabel ? { modeName: session.modeLabel } : {}),
          }
        : {}),
    };
  }, [
    modeOption,
    modelOption,
    thoughtOption,
    session.harnessId,
    session.harnessName,
    session.modelLabel,
    session.modeLabel,
    session.thoughtLevelLabel,
  ]);

  const pickerModel =
    stagedTarget?.kind === 'local-kapibala'
      ? (models.find((m) => m.id === stagedTarget.modelId) ?? defaultLocalModel)
      : defaultLocalModel;

  const pickerHarness =
    stagedTarget?.kind === 'local-kapibala'
      ? undefined
      : stagedTarget
        ? stagedTarget.choice
        : currentHarnessBaseline;

  const isHandoffStaged =
    stagedTarget?.kind === 'cross-external' || stagedTarget?.kind === 'local-kapibala';
  const inputWritable = session.canContinue || isHandoffStaged;
  const canSend = inputWritable && !activeRun && !busy && Boolean(draft.trim());

  const submitTurn = (rawText: string, clearDraft = true): void => {
    const trimmed = rawText.trim();
    if (!trimmed || !canSend) return;
    if (stagedTarget?.kind === 'local-kapibala') {
      const targetModelId = stagedTarget.modelId;
      setStagedTarget(undefined);
      onHandoffToLocal(trimmed, targetModelId);
      return;
    }
    if (stagedTarget?.kind === 'cross-external') {
      const targetChoice = stagedTarget.choice;
      setStagedTarget(undefined);
      onHandoffToExternal(trimmed, targetChoice);
      return;
    }
    const overrides =
      stagedTarget?.kind === 'same-external'
        ? {
            ...(stagedTarget.choice.modelId ? { modelId: stagedTarget.choice.modelId } : {}),
            ...(stagedTarget.choice.modeId ? { modeId: stagedTarget.choice.modeId } : {}),
            ...(stagedTarget.choice.thoughtLevel
              ? { thoughtLevel: stagedTarget.choice.thoughtLevel }
              : {}),
          }
        : undefined;
    setStagedTarget(undefined);
    onSend(
      trimmed,
      clearDraft,
      overrides && Object.keys(overrides).length > 0 ? overrides : undefined,
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部外部代理权限与运行边界提示条 */}
      <div className="shrink-0 border-b border-kumo-hairline bg-kumo-base px-6 py-1.5 text-xs">
        <div className="mx-auto flex w-full max-w-[var(--kapibala-content-max)] flex-col gap-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-kumo-subtle">
            <span className={`inline-flex items-center gap-1.5 font-medium ${badge.className}`}>
              {activeRun && (
                <span
                  className={`size-1.5 rounded-full ${
                    session.status === 'waiting_approval' || snapshot.approvals.length > 0
                      ? 'bg-kumo-warning'
                      : 'bg-(--kapibala-signal)'
                  }`}
                  aria-hidden="true"
                />
              )}
              {badge.label}
            </span>
            <span aria-hidden="true">·</span>
            <span>{transportLabel(session.transport)}</span>
            {session.modelLabel && (
              <>
                <span aria-hidden="true">·</span>
                <span className="inline-flex items-center gap-1">
                  <CpuIcon size={12} className="shrink-0" />
                  {session.modelLabel}
                </span>
              </>
            )}
            {session.thoughtLevelLabel && (
              <>
                <span aria-hidden="true">·</span>
                <span>推理：{session.thoughtLevelLabel}</span>
              </>
            )}
            {session.modeLabel && (
              <>
                <span aria-hidden="true">·</span>
                <span>模式：{session.modeLabel}</span>
              </>
            )}
            <span className="ml-auto text-kumo-faint">外部代理 · 遵循该工具自有权限与登录态</span>
          </div>
          {localBusy && (
            <p className="flex items-center gap-1.5 text-kumo-warning">
              <WarningCircleIcon size={14} className="shrink-0" />
              <span>
                当前工作区同时有本地会话正在运行；外部代理不共享文件写租约，请留意并发改动冲突。
              </span>
            </p>
          )}
          {snapshot.truncatedArchive && (
            <p className="text-kumo-subtle">该会话历史较长，归档仅保留最近消息快照供只读查阅。</p>
          )}
          {session.status === 'failed' && session.lastError && snapshot.messages.length === 0 && (
            <p role="alert" className="text-kumo-danger">
              运行失败：{session.lastError}
            </p>
          )}
        </div>
      </div>

      {/* 主消息流 */}
      {snapshot.messages.length > 0 ? (
        <MessageList
          key={`external:${session.id}`}
          memoryKey={`external:${session.id}`}
          messages={snapshot.messages}
          operation={
            session.status === 'cancelling'
              ? { id: session.id, phase: 'cancelling' }
              : activeRun
                ? { id: session.id, phase: 'running' }
                : session.status === 'failed'
                  ? { id: session.id, phase: 'idle', result: 'failed' }
                  : snapshot.operation
          }
          hasPendingApproval={snapshot.approvals.length > 0}
          latestErrorNotice={session.lastError}
          onContinue={
            session.canContinue && !activeRun && !busy ? () => submitTurn('继续', false) : undefined
          }
          root={workspaceRoot}
          scrollRef={scrollRef}
          onTool={onTool}
          onArtifact={onArtifact}
          onEdit={
            inputWritable
              ? (text) => {
                  onDraftChange(text);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }
              : undefined
          }
          report={report}
        />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-sm text-kumo-subtle">
          {session.status === 'starting'
            ? `正在启动 ${session.harnessName} 外部会话…`
            : session.canContinue
              ? `外部会话已就绪，在下方输入任务即可交由 ${session.harnessName} 执行。`
              : '该外部会话已结束，且没有可展示的历史输出。'}
        </div>
      )}

      {/* 底部计划清单、内联外部审批卡与输入框 */}
      <footer
        className={`kapibala-composer-dock shrink-0 ${
          detailsOpen && !wide ? 'mr-(--kapibala-dock-width)' : ''
        }`}
      >
        <div className="relative w-full space-y-2">
          <TaskPanel key={`external-plan:${session.id}`} todos={snapshot.plan} />
          <ExternalApprovalDeck approvals={snapshot.approvals} busy={busy} onApprove={onApprove} />
          <div className="kapibala-composer px-3 pt-3 pb-2">
            <InputArea
              ref={inputRef}
              aria-label="发送消息"
              placeholder={
                isHandoffStaged
                  ? '继续输入，下一轮将携带当前对话历史切换至所选代理/模型…'
                  : session.canContinue
                    ? `向 ${session.harnessName} 发送后续指令…`
                    : '当前为外部代理只读历史归档，如需继续请新建外部会话'
              }
              value={inputWritable ? draft : ''}
              onValueChange={onDraftChange}
              disabled={!inputWritable || busy}
              autoResize
              minRows={1}
              maxRows={8}
              className="max-h-[200px] rounded-none bg-transparent px-2 py-1 ring-0 focus:ring-0"
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (onHistoryKeyDown?.(event)) return;
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  submitTurn(draft);
                }
              }}
            />
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-kumo-subtle">
                {workspaceName && <span className="truncate px-1">{workspaceName}</span>}
                <ComposerModelPicker
                  contextMode="session"
                  models={models}
                  providers={providers}
                  harnesses={mergedHarnesses}
                  model={pickerModel}
                  harness={pickerHarness}
                  disabled={busy}
                  harnessesFailed={harnessesFailed}
                  refreshingHarnessId={refreshingHarnessId}
                  onModel={(profileId) =>
                    setStagedTarget({ kind: 'local-kapibala', modelId: profileId })
                  }
                  onHarness={(choice) => {
                    if (choice.id === session.harnessId && session.canContinue) {
                      setStagedTarget({ kind: 'same-external', choice });
                    } else {
                      setStagedTarget({ kind: 'cross-external', choice });
                    }
                  }}
                  onRefreshHarnessModels={onRefreshHarnessModels}
                  onSettings={onSettings}
                  onExternalSettings={onExternalSettings}
                />
                {!session.canContinue && !isHandoffStaged && (
                  <Button
                    className="kapibala-action"
                    variant="secondary"
                    size="sm"
                    onClick={onNewSameHarness}
                  >
                    新建 {session.harnessName} 会话
                  </Button>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                {activeRun ? (
                  <Button
                    className="kapibala-action kapibala-chip"
                    size="sm"
                    variant="secondary"
                    disabled={session.status === 'cancelling'}
                    onClick={onCancel}
                  >
                    <StopIcon size={15} />
                    {session.status === 'cancelling' ? '正在取消' : '停止'}
                  </Button>
                ) : (
                  <Button
                    className="kapibala-action kapibala-send text-(--text-color-kumo-inverse)!"
                    size="base"
                    variant="primary"
                    shape="square"
                    style={
                      {
                        '--kumo-button-emphasis-ring': 'var(--color-kumo-focus)',
                      } as CSSProperties
                    }
                    aria-label="发送"
                    disabled={!canSend}
                    onClick={() => submitTurn(draft)}
                  >
                    <ArrowUpIcon size={17} weight="bold" />
                  </Button>
                )}
              </div>
            </div>
            {stagedTarget && (
              <div className="mt-2 border-t border-kumo-hairline px-2 pt-2">
                <p className="kapibala-composer-hint text-kumo-subtle">
                  {stagedTarget.kind === 'same-external'
                    ? '已选择新模型/推理配置，将在下一轮发送时生效，不会打断当前对话。'
                    : stagedTarget.kind === 'cross-external'
                      ? `下一轮发送时将携带当前对话历史，切换至 ${stagedTarget.choice.name} 新会话继续。`
                      : `下一轮发送时将携带当前对话历史，切换至 Kapibala 本地模型（${pickerModel?.name ?? stagedTarget.modelId}）继续。`}
                </p>
              </div>
            )}
          </div>
        </div>
      </footer>
    </div>
  );
}
