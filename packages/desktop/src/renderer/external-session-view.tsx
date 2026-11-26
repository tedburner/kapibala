import { Button, Combobox, DropdownMenu, InputArea, LayerCard, Popover } from '@cloudflare/kumo';
import type {
  ViewArtifact,
  ViewExternalApproval,
  ViewExternalConfigCategory,
  ViewExternalConfigOption,
  ViewExternalSnapshot,
} from '@kiturone/kapibala-host/view-model';
import {
  ArrowUpIcon,
  CaretDownIcon,
  CheckIcon,
  CpuIcon,
  MagnifyingGlassIcon,
  ShieldWarningIcon,
  SlidersHorizontalIcon,
  SparkleIcon,
  StopIcon,
  TerminalWindowIcon,
  WarningCircleIcon,
} from '@phosphor-icons/react';
import {
  type CSSProperties,
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from 'react';
import { MessageList } from './message-list.js';
import { TaskPanel } from './task-panel.js';

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
          <LayerCard
            key={approval.approvalId}
            className="space-y-2.5 border border-kumo-line bg-kumo-elevated p-3.5 shadow-md"
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
              <pre className="max-h-28 overflow-auto rounded-md bg-kumo-recessed px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap [overflow-wrap:anywhere] text-kumo-default">
                {approval.target}
              </pre>
            )}
            {approval.warning && <p className="text-xs text-kumo-warning">{approval.warning}</p>}
            <div className="flex flex-wrap items-center justify-end gap-2">
              <Button
                className="kapibala-action mr-auto"
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
          </LayerCard>
        );
      })}
    </section>
  );
}

/** 外部会话内可搜索的模型选择浮层，支持数十条 ACP 候选模型快速筛选切换。 */
function ExternalModelSelector({
  option,
  fallbackLabel,
  disabled,
  onSelect,
}: {
  readonly option: ViewExternalConfigOption;
  readonly fallbackLabel?: string;
  readonly disabled: boolean;
  readonly onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const currentChoice = option.options.find((item) => item.value === option.currentValue);
  const triggerLabel = currentChoice?.name ?? fallbackLabel ?? option.currentValue ?? '选择模型';
  const filtered = option.options.filter((item) => {
    if (terms.length === 0) return true;
    const hay =
      `${item.name} ${item.value} ${item.group ?? ''} ${item.description ?? ''}`.toLowerCase();
    return terms.every((term) => hay.includes(term));
  });

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setQuery('');
        setOpen(next);
      }}
    >
      <Popover.Trigger
        render={
          <Button
            className="kapibala-action kapibala-chip max-w-56"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`外部会话模型：${triggerLabel}`}
          >
            <CpuIcon size={14} className="shrink-0 text-kumo-subtle" />
            <span className="min-w-0 truncate">{triggerLabel}</span>
            <CaretDownIcon size={13} className="shrink-0 text-kumo-subtle" />
          </Button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={12}>
          <Popover.Popup
            aria-label="切换外部代理模型"
            className="max-h-(--available-height) w-[min(24rem,var(--available-width))] overflow-y-auto rounded-xl px-0 py-0 shadow-lg motion-reduce:transition-none"
          >
            <Combobox
              inline
              items={filtered}
              filter={null}
              inputValue={query}
              onInputValueChange={setQuery}
              itemToStringLabel={(item) => item.name}
              value={currentChoice ?? null}
              isItemEqualToValue={(first, second) => first.value === second.value}
              autoHighlight
              onValueChange={(item) => {
                if (!item || item.value === option.currentValue) {
                  setOpen(false);
                  return;
                }
                setOpen(false);
                onSelect(item.value);
              }}
            >
              {option.options.length > 6 && (
                <div className="relative border-b border-kumo-line px-3 py-2">
                  <MagnifyingGlassIcon
                    className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-kumo-subtle"
                    size={14}
                    aria-hidden="true"
                  />
                  <Combobox.Input
                    aria-label="搜索外部代理模型"
                    placeholder="搜索模型…"
                    className="m-0 rounded-md bg-kumo-recessed pl-7 text-sm"
                  />
                </div>
              )}
              <Combobox.List className="max-h-72 py-1.5">
                {(item: ViewExternalConfigOption['options'][number]) => (
                  <Combobox.Item
                    key={item.value}
                    value={item}
                    aria-label={item.name}
                    className="grid-cols-[minmax(0,1fr)_16px] text-sm"
                  >
                    <span className="block truncate font-medium">{item.name}</span>
                    {(item.group || item.description) && (
                      <span className="block truncate text-xs text-kumo-subtle">
                        {item.group ?? item.description}
                      </span>
                    )}
                  </Combobox.Item>
                )}
              </Combobox.List>
              <Combobox.Empty className="py-4">没有匹配的模型</Combobox.Empty>
            </Combobox>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover>
  );
}

/** 外部会话内的模式或推理档位下拉选择器。 */
function ExternalOptionMenu({
  option,
  fallbackLabel,
  disabled,
  onSelect,
}: {
  readonly option: ViewExternalConfigOption;
  readonly fallbackLabel?: string;
  readonly disabled: boolean;
  readonly onSelect: (value: string) => void;
}) {
  const currentChoice = option.options.find((item) => item.value === option.currentValue);
  const currentLabel = currentChoice?.name ?? fallbackLabel ?? option.currentValue ?? option.name;
  const isThought = option.category === 'thought_level';
  const ariaPrefix = isThought ? '外部会话推理档位' : '外部会话模式';

  return (
    <DropdownMenu>
      <DropdownMenu.Trigger
        render={
          <Button
            className="kapibala-action kapibala-chip max-w-44"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={`${ariaPrefix}：${currentLabel}`}
          >
            {isThought ? (
              <SparkleIcon size={14} className="shrink-0 text-kumo-subtle" />
            ) : (
              <SlidersHorizontalIcon size={14} className="shrink-0 text-kumo-subtle" />
            )}
            <span className="min-w-0 truncate">
              {isThought ? `推理：${currentLabel}` : currentLabel}
            </span>
            <CaretDownIcon size={13} className="shrink-0 text-kumo-subtle" />
          </Button>
        }
      />
      <DropdownMenu.Content className="max-h-[min(20rem,var(--available-height))]">
        <DropdownMenu.Group>
          <DropdownMenu.Label>{isThought ? '推理档位' : '会话模式'}</DropdownMenu.Label>
          {option.options.map((choice) => (
            <DropdownMenu.Item
              key={choice.value}
              onClick={() => {
                if (choice.value !== option.currentValue) onSelect(choice.value);
              }}
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate">{choice.name}</span>
                {choice.description && (
                  <span className="truncate text-xs text-kumo-subtle">{choice.description}</span>
                )}
              </span>
              {choice.value === option.currentValue && <CheckIcon size={14} />}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Group>
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

/**
 * 外部代理会话工作台主视图。
 *
 * 前置约束与复用边界：
 * - 消息流直接复用 `MessageList`，计划清单直接复用 `TaskPanel`，工具与产物点击复用右侧 `DetailsDrawer`；
 * - 顶部常驻展示外部信任边界提示，以及同工作区本地会话并发运行时的无写租约冲突预警；
 * - 当会话不可原地续聊（如通用自定义 ACP 进程已退出或配置摘要变更）时，输入框置为只读归档态并提供一键新建入口。
 */
export function ExternalSessionView({
  workspaceName,
  workspaceRoot,
  snapshot,
  draft,
  busy,
  configBusy,
  localBusy,
  wide,
  detailsOpen,
  scrollRef,
  onDraftChange,
  onHistoryKeyDown,
  onSetConfig,
  onSend,
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
  /** 外部会话正在切换模型/模式/推理档位时为 true。 */
  readonly configBusy?: boolean;
  /** 同一工作区是否有本地会话正在运行；为 true 时展示并发无写租约覆盖提醒。 */
  readonly localBusy: boolean;
  readonly wide: boolean;
  readonly detailsOpen: boolean;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly onDraftChange: (value: string) => void;
  /** 外部会话输入区 ↑/↓ 历史问句召回回调；返回 true 表示按键已消费。 */
  readonly onHistoryKeyDown?: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** 会话空闲态切换模型、模式或推理档位回调。 */
  readonly onSetConfig?: (input: {
    readonly configId: string;
    readonly category: ViewExternalConfigCategory;
    readonly value: string;
  }) => void;
  readonly onSend: (text: string, clearDraft?: boolean) => void;
  readonly onCancel: () => void;
  readonly onApprove: (approvalId: string, optionId?: string, cancel?: boolean) => void;
  readonly onNewSameHarness: () => void;
  readonly onTool: (callId: string, trigger: HTMLElement) => void;
  readonly onArtifact: (callId: string, artifact: ViewArtifact, trigger: HTMLElement) => void;
  readonly report: (message: string) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const { session } = snapshot;
  const activeRun =
    session.status === 'starting' ||
    session.status === 'running' ||
    session.status === 'waiting_approval' ||
    session.status === 'cancelling';
  const badge = statusBadge(session.status);
  const canSend =
    session.canContinue && !activeRun && !busy && !configBusy && Boolean(draft.trim());
  const modeOption = snapshot.configOptions?.find((opt) => opt.category === 'mode');
  const modelOption = snapshot.configOptions?.find((opt) => opt.category === 'model');
  const thoughtOption = snapshot.configOptions?.find((opt) => opt.category === 'thought_level');
  const configSwitchDisabled = activeRun || busy || Boolean(configBusy);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* 顶部外部代理权限与运行边界横幅 */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-kumo-line bg-kumo-recessed px-4 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex items-center gap-1 rounded-md bg-kumo-base px-2 py-0.5 font-medium text-kumo-default">
            <TerminalWindowIcon size={13} className="shrink-0 text-kumo-brand" />
            {session.harnessName}
          </span>
          <span className="rounded-md bg-kumo-base px-1.5 py-0.5 text-kumo-subtle">
            {transportLabel(session.transport)}
          </span>
          {session.modelLabel && (
            <span className="inline-flex items-center gap-1 rounded-md bg-kumo-base px-2 py-0.5 text-kumo-subtle">
              <CpuIcon size={12} className="shrink-0" />
              {session.modelLabel}
            </span>
          )}
          {session.modeLabel && (
            <span className="rounded-md bg-kumo-base px-2 py-0.5 text-kumo-subtle">
              模式：{session.modeLabel}
            </span>
          )}
          {session.thoughtLevelLabel && (
            <span className="rounded-md bg-kumo-base px-2 py-0.5 text-kumo-subtle">
              推理：{session.thoughtLevelLabel}
            </span>
          )}
          <span className={`font-medium ${badge.className}`}>{badge.label}</span>
          <span className="ml-auto text-kumo-subtle">外部代理 · 遵循该工具自有权限与登录态</span>
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
          latestErrorNotice={session.lastError}
          onContinue={
            session.canContinue && !activeRun && !busy ? () => onSend('继续', false) : undefined
          }
          onRetry={() => {}}
          root={workspaceRoot}
          scrollRef={scrollRef}
          onTool={onTool}
          onArtifact={onArtifact}
          onEvidence={() => {}}
          onEdit={(text) => {
            if (!session.canContinue) return;
            onDraftChange(text);
            requestAnimationFrame(() => inputRef.current?.focus());
          }}
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
                session.canContinue
                  ? `向 ${session.harnessName} 发送后续指令…`
                  : '当前为外部代理只读历史归档，如需继续请新建外部会话'
              }
              value={session.canContinue ? draft : ''}
              onValueChange={onDraftChange}
              disabled={!session.canContinue || busy}
              autoResize
              minRows={1}
              maxRows={8}
              className="max-h-[200px] rounded-none bg-transparent px-2 py-1 ring-0 focus:ring-0"
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (onHistoryKeyDown?.(event)) return;
                if (event.key === 'Enter' && !event.shiftKey) {
                  event.preventDefault();
                  if (canSend) onSend(draft.trim());
                }
              }}
            />
            <div className="flex items-center justify-between gap-2 pt-1">
              <div className="flex min-w-0 flex-wrap items-center gap-1 text-xs text-kumo-subtle">
                {workspaceName && <span className="truncate px-1">{workspaceName}</span>}
                {session.canContinue &&
                onSetConfig &&
                (modeOption || modelOption || thoughtOption) ? (
                  <>
                    {modeOption && modeOption.options.length > 0 && (
                      <ExternalOptionMenu
                        option={modeOption}
                        fallbackLabel={session.modeLabel}
                        disabled={configSwitchDisabled}
                        onSelect={(value) =>
                          onSetConfig({
                            configId: modeOption.id,
                            category: 'mode',
                            value,
                          })
                        }
                      />
                    )}
                    {modelOption && modelOption.options.length > 0 && (
                      <ExternalModelSelector
                        option={modelOption}
                        fallbackLabel={session.modelLabel}
                        disabled={configSwitchDisabled}
                        onSelect={(value) =>
                          onSetConfig({
                            configId: modelOption.id,
                            category: 'model',
                            value,
                          })
                        }
                      />
                    )}
                    {thoughtOption && thoughtOption.options.length > 0 && (
                      <ExternalOptionMenu
                        option={thoughtOption}
                        fallbackLabel={session.thoughtLevelLabel}
                        disabled={configSwitchDisabled}
                        onSelect={(value) =>
                          onSetConfig({
                            configId: thoughtOption.id,
                            category: 'thought_level',
                            value,
                          })
                        }
                      />
                    )}
                  </>
                ) : (
                  <>
                    <span>·</span>
                    <span className="truncate">{session.harnessName}</span>
                  </>
                )}
                {!session.canContinue && (
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
                    onClick={() => onSend(draft.trim())}
                  >
                    <ArrowUpIcon size={17} weight="bold" />
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
