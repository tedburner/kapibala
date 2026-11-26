import { Button, Combobox, Popover } from '@cloudflare/kumo';
import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CpuIcon,
  MagnifyingGlassIcon,
  SquaresFourIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import { useState } from 'react';
import type { Output } from '../shared/contracts.js';

type Catalog = Output<'settings.read'>;
type ModelChoice = Pick<Catalog['profiles'][number], 'id' | 'name' | 'modelName' | 'providerKey'>;
type ExternalChoice = Pick<
  Output<'external.harnesses'>['harnesses'][number],
  'id' | 'name' | 'transport' | 'cachedConfigOptions'
>;
/** 新对话中选定的外部代理及可选显式模型（未选模型时默认沿用该代理自身配置）。 */
export type SelectedHarnessChoice = {
  readonly id: string;
  readonly name: string;
  readonly modelId?: string;
  readonly modelName?: string;
};

/**
 * 新对话代理与模型统一搜索选择器（左栏按代理分栏，右栏选具体模型）。
 *
 * 边界与约束：
 * - 外部代理默认项始终保留「使用默认模型」，选中时不传 `modelId`，完全沿用代理自身默认配置；
 * - 若该外部代理已有本地缓存的模型列表，点选左栏该代理或全局搜索时直接呈现具体模型；
 * - 不在启动阶段自动拉起所有代理探针：仅在用户点击「加载/刷新模型」时按需探测并回填缓存。
 */
export function ComposerModelPicker({
  models,
  providers,
  harnesses,
  model,
  harness,
  disabled,
  harnessesFailed,
  refreshingHarnessId,
  onModel,
  onHarness,
  onRefreshHarnessModels,
  onSettings,
  onExternalSettings,
}: {
  models: readonly ModelChoice[];
  providers: readonly Pick<Catalog['providers'][number], 'key' | 'name'>[];
  harnesses: readonly ExternalChoice[];
  model?: Pick<ModelChoice, 'id' | 'name'>;
  harness?: SelectedHarnessChoice;
  disabled: boolean;
  harnessesFailed?: boolean;
  refreshingHarnessId?: string;
  onModel(id: string): void;
  onHarness(choice: SelectedHarnessChoice): void;
  onRefreshHarnessModels?(harnessId: string): void;
  onSettings(): void;
  onExternalSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('all');
  const [query, setQuery] = useState('');
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const activeScope = searching ? 'all' : scope;
  const categories = [
    { id: 'all', name: '全部', icon: SquaresFourIcon },
    { id: 'kapibala', name: 'Kapibala', icon: CpuIcon },
    ...harnesses.map((item) => ({
      id: `harness:${item.id}`,
      name: item.name,
      icon: TerminalWindowIcon,
    })),
  ];
  const providerByKey = new Map(providers.map((provider) => [provider.key, provider.name]));

  const externalChoices = harnesses.flatMap((item) => {
    const scopeKey = `harness:${item.id}`;
    const modelOption = item.cachedConfigOptions?.find((opt) => opt.category === 'model');
    const cachedModels = modelOption?.options ?? [];
    const defaultRow = {
      key: scopeKey,
      scope: scopeKey,
      showInAll: true,
      name: activeScope === 'all' ? item.name : '使用默认模型',
      detail: activeScope === 'all' ? '外部代理 · 默认模型' : item.name,
      search: `${item.name} ${item.id} ${item.transport} 外部代理 默认模型`,
      select: () => onHarness({ id: item.id, name: item.name }),
    };
    const modelRows = cachedModels.map((choice) => ({
      key: `${scopeKey}:model:${choice.value}`,
      scope: scopeKey,
      // 仅在选中左栏具体代理或全局关键词搜索时展开外部代理的具体模型，避免「全部」首屏被数十条外模淹没。
      showInAll: false,
      name: choice.name,
      detail: choice.group
        ? `${item.name} · ${choice.group}`
        : choice.value === modelOption?.currentValue
          ? `${item.name} · 默认`
          : item.name,
      search: `${choice.name} ${choice.value} ${choice.group ?? ''} ${item.name} ${item.id}`,
      select: () =>
        onHarness({
          id: item.id,
          name: item.name,
          modelId: choice.value,
          modelName: choice.name,
        }),
    }));
    return [defaultRow, ...modelRows];
  });

  const choices = [
    ...models.map((item) => {
      const provider = providerByKey.get(item.providerKey);
      return {
        key: `model:${item.id}`,
        scope: 'kapibala',
        showInAll: true,
        name: item.name,
        detail: provider ? `Kapibala · ${provider}` : 'Kapibala',
        search: `${item.name} ${item.modelName} ${item.id} ${provider ?? ''} Kapibala`,
        select: () => onModel(item.id),
      };
    }),
    ...externalChoices,
  ].filter((item) => {
    if (searching) {
      return terms.every((term) => item.search.toLowerCase().includes(term));
    }
    if (activeScope === 'all') return item.showInAll;
    return item.scope === activeScope;
  });

  const focusedHarness = activeScope.startsWith('harness:')
    ? harnesses.find((item) => `harness:${item.id}` === activeScope)
    : undefined;
  const focusedHarnessModels =
    focusedHarness?.cachedConfigOptions?.find((opt) => opt.category === 'model')?.options ?? [];
  const canProbeFocusedHarness = Boolean(
    focusedHarness && focusedHarness.transport === 'acp' && onRefreshHarnessModels,
  );
  const probingFocused = Boolean(focusedHarness && refreshingHarnessId === focusedHarness.id);

  const selected = harness
    ? harness.modelId
      ? `harness:${harness.id}:model:${harness.modelId}`
      : `harness:${harness.id}`
    : model
      ? `model:${model.id}`
      : null;
  const triggerLabel = harness
    ? harness.modelName
      ? `${harness.name} · ${harness.modelName}`
      : harness.name
    : (model?.name ?? '选择模型或代理');

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setScope(harness ? `harness:${harness.id}` : 'all');
          setQuery('');
        }
        setOpen(next);
      }}
    >
      <Popover.Trigger
        render={
          <Button
            className="kapibala-action kapibala-chip max-w-64"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={
              harness ? `新对话代理：${triggerLabel}` : `新对话模型或代理：${triggerLabel}`
            }
          >
            {harness && <TerminalWindowIcon size={15} className="shrink-0" />}
            <span className="min-w-0 truncate">{triggerLabel}</span>
            <CaretDownIcon size={13} className="shrink-0 text-kumo-subtle" />
          </Button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={12}>
          <Popover.Popup
            aria-label="选择代理或模型"
            className="max-h-(--available-height) w-[min(32rem,var(--available-width))] overflow-y-auto rounded-xl px-0 py-0 shadow-lg motion-reduce:transition-none"
          >
            <Combobox
              inline
              items={choices}
              filter={null}
              inputValue={query}
              onInputValueChange={setQuery}
              itemToStringLabel={(item) => item.name}
              value={choices.find((item) => item.key === selected) ?? null}
              isItemEqualToValue={(first, second) => first.key === second.key}
              autoHighlight
              onValueChange={(item) => {
                if (!item) return;
                setOpen(false);
                item.select();
              }}
            >
              <div className="relative border-b border-kumo-line px-3 py-2.5">
                <MagnifyingGlassIcon
                  className="pointer-events-none absolute top-1/2 left-5 -translate-y-1/2 text-kumo-subtle"
                  size={15}
                  aria-hidden="true"
                />
                <Combobox.Input
                  aria-label="搜索代理或模型"
                  placeholder="搜索代理或模型…"
                  className="m-0 rounded-md bg-kumo-recessed pl-8 text-sm"
                />
              </div>
              <div className="grid sm:grid-cols-[9rem_minmax(0,1fr)]">
                <section
                  aria-label="按代理浏览"
                  className="flex max-h-44 gap-1 overflow-auto border-b border-kumo-line bg-kumo-recessed p-2 sm:max-h-72 sm:flex-col sm:border-e sm:border-b-0"
                >
                  {categories.map(({ id, name, icon: Icon }) => (
                    <button
                      type="button"
                      key={id}
                      title={name}
                      aria-pressed={activeScope === id}
                      className="kapibala-action flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-kumo-subtle hover:bg-kumo-tint aria-pressed:bg-kumo-tint aria-pressed:font-medium aria-pressed:text-kumo-default sm:w-full"
                      onClick={() => {
                        setScope(id);
                        setQuery('');
                      }}
                    >
                      <Icon size={16} className="shrink-0" aria-hidden="true" />
                      <span className="truncate">{name}</span>
                    </button>
                  ))}
                </section>
                <div className="min-w-0 sm:min-h-44">
                  <Combobox.List className="max-h-72 py-1.5">
                    {(item: (typeof choices)[number]) => (
                      <Combobox.Item
                        key={item.key}
                        value={item}
                        aria-label={item.name}
                        aria-description={item.detail}
                        className="grid-cols-[minmax(0,1fr)_16px] text-sm"
                      >
                        <span className="block truncate font-medium">{item.name}</span>
                        <span className="block truncate text-xs text-kumo-subtle">
                          {item.detail}
                        </span>
                      </Combobox.Item>
                    )}
                  </Combobox.List>
                  <Combobox.Empty className="py-4">
                    {searching ? '没有匹配的代理或模型' : '当前没有可用模型'}
                  </Combobox.Empty>
                </div>
              </div>
            </Combobox>
            <div className="flex flex-wrap items-center justify-end gap-1 border-t border-kumo-line px-2 py-1.5">
              {canProbeFocusedHarness && focusedHarness && (
                <Button
                  className="kapibala-action mr-auto"
                  variant="ghost"
                  size="sm"
                  disabled={probingFocused || Boolean(refreshingHarnessId)}
                  onClick={() => onRefreshHarnessModels?.(focusedHarness.id)}
                >
                  <ArrowsClockwiseIcon size={14} aria-hidden="true" />
                  {probingFocused
                    ? '正在加载模型…'
                    : focusedHarnessModels.length > 0
                      ? '刷新模型列表'
                      : '加载可用模型'}
                </Button>
              )}
              <Popover.Close
                render={
                  <Button
                    className="kapibala-action"
                    variant="ghost"
                    size="sm"
                    onClick={onSettings}
                  />
                }
              >
                模型设置
              </Popover.Close>
              {onExternalSettings && (
                <Popover.Close
                  render={
                    <Button
                      className="kapibala-action"
                      variant="ghost"
                      size="sm"
                      onClick={onExternalSettings}
                    />
                  }
                >
                  {harnessesFailed ? '代理列表读取失败，打开设置' : '外部代理设置'}
                </Popover.Close>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover>
  );
}
