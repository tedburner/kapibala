import { Button, Combobox, Popover } from '@cloudflare/kumo';
import {
  ArrowsClockwiseIcon,
  CaretDownIcon,
  CheckIcon,
  CpuIcon,
  MagnifyingGlassIcon,
  SquaresFourIcon,
  TerminalWindowIcon,
} from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';
import type { Output } from '../shared/contracts.js';

type Catalog = Output<'settings.read'>;
type ModelChoice = Pick<Catalog['profiles'][number], 'id' | 'name' | 'modelName' | 'providerKey'>;
type ExternalChoice = Pick<
  Output<'external.harnesses'>['harnesses'][number],
  'id' | 'name' | 'transport' | 'cachedConfigOptions' | 'cachedConfigUpdatedAt'
>;

/** 新对话中选定的外部代理及可选显式模型、推理强度与运行模式（未指定子项时沿用该代理自身默认配置）。 */
export type SelectedHarnessChoice = {
  readonly id: string;
  readonly name: string;
  readonly modelId?: string;
  readonly modelName?: string;
  readonly thoughtLevel?: string;
  readonly thoughtLevelName?: string;
  readonly modeId?: string;
  readonly modeName?: string;
};

/**
 * 单色几何代理标识图标：全部继承 `currentColor` 语义墨色，不引入彩色硬编码，
 * 供左栏代理导航、模型候选行与输入框底部芯片保持一致的视觉锚点。
 */
function HarnessGlyph({
  harnessId,
  transport,
  size = 15,
  className = 'shrink-0',
}: {
  readonly harnessId: string;
  readonly transport?: ExternalChoice['transport'];
  readonly size?: number;
  readonly className?: string;
}) {
  const lower = harnessId.toLowerCase();
  if (lower.includes('codex')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        <circle cx="8" cy="8" r="5.75" stroke="currentColor" strokeWidth="1.35" />
        <path
          d="M8 2.4v4.1M12.85 5.2L9.3 7.25M12.85 10.8L9.3 8.75M8 13.6V9.5M3.15 10.8L6.7 8.75M3.15 5.2L6.7 7.25"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (lower.includes('claude')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        <path
          d="M8 1.9v12.2M1.9 8h12.2M3.7 3.7l8.6 8.6M12.3 3.7l-8.6 8.6M5.65 2.35l4.7 11.3M13.65 5.65l-11.3 4.7"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  if (lower.includes('antigravity') || lower === 'agy') {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        <path
          d="M3.1 13.2L7.45 2.8a.6.6 0 0 1 1.1 0l4.35 10.4M5.1 9.7c1.6-.95 4.2-.95 5.8 0"
          stroke="currentColor"
          strokeWidth="1.45"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (lower === 'pi' || lower.includes('omp')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        <path
          d="M3.2 4.6h9.6M6.1 4.6v7.6M10.2 4.6v6.2a1.4 1.4 0 0 0 1.4 1.4h.6"
          stroke="currentColor"
          strokeWidth="1.45"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (lower.includes('opencode')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        <rect
          x="3"
          y="2.5"
          width="10"
          height="11"
          rx="1.8"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <rect x="6" y="5.5" width="4" height="5" rx="0.6" fill="currentColor" />
      </svg>
    );
  }
  if (lower.includes('gemini')) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        className={className}
        aria-hidden="true"
      >
        <path
          d="M8 2c.45 3.3 2.7 5.55 6 6-3.3.45-5.55 2.7-6 6-.45-3.3-2.7-5.55-6-6 3.3-.45 5.55-2.7 6-6Z"
          stroke="currentColor"
          strokeWidth="1.35"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  if (transport === 'acp') {
    return <TerminalWindowIcon size={size} className={className} aria-hidden="true" />;
  }
  return <TerminalWindowIcon size={size} className={className} aria-hidden="true" />;
}

function compactModeDisplayName(rawName: string): string {
  const parenMatch = /^([^(（]+?)\s*[（(]/.exec(rawName);
  return parenMatch?.[1]?.trim() || rawName.trim();
}

/** 芯片与右栏副标题展示紧凑模型名：当模型显示名自带与当前代理同名的 `<harnessId>/` 前缀时去重，避免重复占用宽度挤掉推理档位。 */
function compactModelBadgeName(rawModelName: string, harnessId: string): string {
  const prefix = `${harnessId.toLowerCase()}/`;
  if (rawModelName.toLowerCase().startsWith(prefix) && rawModelName.length > prefix.length) {
    return rawModelName.slice(prefix.length);
  }
  return rawModelName;
}

function formatPickerCacheTime(updatedAt: number): string {
  const date = new Date(updatedAt);
  const now = new Date();
  const pad = (num: number) => String(num).padStart(2, '0');
  const hhmm = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return hhmm;
  }
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${hhmm}`;
}

/**
 * 新对话代理、模型与推理强度三栏选择器（左栏切换代理，中栏搜索/选择模型，右栏联动调节推理强度与运行模式）。
 *
 * 边界与约束：
 * - 外部代理默认项始终保留「使用默认模型」，不传显式子参数时沿用该代理自身默认配置；
 * - 支持全部四类外部传输（`acp`、`codex-app-server`、`claude-cli`、`pi-rpc`）按需拉取并缓存模型与推理目录；
 * - 启动首屏零预热开销：仅当用户展开面板并切到尚未缓存目录的具体外部代理时静默探测一次，后续读取本地磁盘缓存零延迟呈现。
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
  onRefreshHarnessModels?(harnessId: string, options?: { readonly silent?: boolean }): void;
  onSettings(): void;
  onExternalSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('all');
  const [query, setQuery] = useState('');
  const autoProbedIdsRef = useRef<Set<string>>(new Set());

  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const activeScope = searching ? 'all' : scope;

  const focusedHarness = activeScope.startsWith('harness:')
    ? harnesses.find((item) => `harness:${item.id}` === activeScope)
    : undefined;

  // 用户在左栏聚焦到尚未缓存模型目录的外部代理时，自动静默拉取一次目录，免去手动寻找底部刷新按钮。
  useEffect(() => {
    if (!open || !focusedHarness || !onRefreshHarnessModels) return;
    if (focusedHarness.cachedConfigOptions && focusedHarness.cachedConfigOptions.length > 0) {
      return;
    }
    if (refreshingHarnessId) return;
    if (autoProbedIdsRef.current.has(focusedHarness.id)) return;
    autoProbedIdsRef.current.add(focusedHarness.id);
    onRefreshHarnessModels(focusedHarness.id, { silent: true });
  }, [open, focusedHarness, refreshingHarnessId, onRefreshHarnessModels]);

  const focusedModelOption = focusedHarness?.cachedConfigOptions?.find(
    (opt) => opt.category === 'model',
  );
  const focusedThoughtOption = focusedHarness?.cachedConfigOptions?.find(
    (opt) => opt.category === 'thought_level',
  );
  const focusedModeOption = focusedHarness?.cachedConfigOptions?.find(
    (opt) => opt.category === 'mode',
  );
  const focusedHarnessModels = focusedModelOption?.options ?? [];

  const isFocusedHarnessSelected = Boolean(focusedHarness && harness?.id === focusedHarness.id);
  const defaultModelChoiceForFocused = focusedModelOption?.currentValue
    ? focusedHarnessModels.find((c) => c.value === focusedModelOption.currentValue)
    : undefined;
  const activeModelChoiceForFocused =
    isFocusedHarnessSelected && harness?.modelId
      ? focusedHarnessModels.find((c) => c.value === harness.modelId)
      : defaultModelChoiceForFocused;

  const visibleThoughtChoices = (() => {
    const allThoughts = focusedThoughtOption?.options ?? [];
    if (allThoughts.length === 0) return [];
    const allowedSet = activeModelChoiceForFocused?.supportedThoughtLevels;
    // 显式记录空数组代表该具体模型不支持任何推理变体（如 OpenCode 下部分免费非推理模型），此时隐藏推理栏而非回退全集。
    if (allowedSet !== undefined) {
      return allThoughts.filter((choice) => allowedSet.includes(choice.value));
    }
    return allThoughts;
  })();

  const visibleModeChoices = focusedModeOption?.options ?? [];
  const hasRightConfigColumn =
    Boolean(focusedHarness) &&
    !searching &&
    (visibleThoughtChoices.length > 0 || visibleModeChoices.length > 0);

  const effectiveThoughtValue =
    (isFocusedHarnessSelected ? harness?.thoughtLevel : undefined) ??
    activeModelChoiceForFocused?.defaultThoughtLevel ??
    focusedThoughtOption?.currentValue ??
    visibleThoughtChoices[0]?.value;

  const effectiveModeValue =
    (isFocusedHarnessSelected ? harness?.modeId : undefined) ??
    focusedModeOption?.currentValue ??
    visibleModeChoices[0]?.value;

  const providerByKey = new Map(providers.map((provider) => [provider.key, provider.name]));

  const resolveNextHarnessSelection = (
    targetHarness: ExternalChoice,
    patch: {
      readonly resetToDefault?: boolean;
      readonly modelChoice?: NonNullable<typeof focusedModelOption>['options'][number];
      readonly thoughtChoice?: NonNullable<typeof focusedThoughtOption>['options'][number];
      readonly modeChoice?: NonNullable<typeof focusedModeOption>['options'][number];
    },
  ): SelectedHarnessChoice => {
    if (patch.resetToDefault) {
      return { id: targetHarness.id, name: targetHarness.name };
    }
    const prevSame = harness?.id === targetHarness.id ? harness : undefined;
    const hModelOpt = targetHarness.cachedConfigOptions?.find((o) => o.category === 'model');
    const hThoughtOpt = targetHarness.cachedConfigOptions?.find(
      (o) => o.category === 'thought_level',
    );
    const hModeOpt = targetHarness.cachedConfigOptions?.find((o) => o.category === 'mode');

    const nextModelId = patch.modelChoice ? patch.modelChoice.value : prevSame?.modelId;
    const nextModelName = patch.modelChoice ? patch.modelChoice.name : prevSame?.modelName;
    const modelMeta = nextModelId
      ? hModelOpt?.options.find((c) => c.value === nextModelId)
      : hModelOpt?.options.find((c) => c.value === hModelOpt.currentValue);

    let nextThoughtLevel = patch.thoughtChoice ? patch.thoughtChoice.value : prevSame?.thoughtLevel;
    let nextThoughtName = patch.thoughtChoice
      ? patch.thoughtChoice.name
      : prevSame?.thoughtLevelName;

    if (hThoughtOpt && hThoughtOpt.options.length > 0) {
      const supported = modelMeta?.supportedThoughtLevels;
      if (supported !== undefined && supported.length === 0) {
        nextThoughtLevel = undefined;
        nextThoughtName = undefined;
      } else {
        const isSupported = (val: string | undefined): val is string =>
          Boolean(
            val &&
              hThoughtOpt.options.some((o) => o.value === val) &&
              (supported === undefined || supported.includes(val)),
          );
        if (!isSupported(nextThoughtLevel)) {
          const candidate = modelMeta?.defaultThoughtLevel ?? hThoughtOpt.currentValue;
          if (isSupported(candidate)) {
            nextThoughtLevel = candidate;
            nextThoughtName = hThoughtOpt.options.find((o) => o.value === candidate)?.name;
          } else {
            const firstValid = hThoughtOpt.options.find((o) => isSupported(o.value));
            nextThoughtLevel = firstValid?.value;
            nextThoughtName = firstValid?.name;
          }
        } else if (!nextThoughtName) {
          nextThoughtName = hThoughtOpt.options.find((o) => o.value === nextThoughtLevel)?.name;
        }
      }
    } else {
      nextThoughtLevel = undefined;
      nextThoughtName = undefined;
    }

    const rawNextModeId = patch.modeChoice ? patch.modeChoice.value : prevSame?.modeId;
    const isDefaultMode = Boolean(
      rawNextModeId && hModeOpt?.currentValue && rawNextModeId === hModeOpt.currentValue,
    );
    const nextModeName =
      rawNextModeId && !isDefaultMode
        ? compactModeDisplayName(
            patch.modeChoice?.name ??
              hModeOpt?.options.find((o) => o.value === rawNextModeId)?.name ??
              prevSame?.modeName ??
              rawNextModeId,
          )
        : undefined;

    return {
      id: targetHarness.id,
      name: targetHarness.name,
      ...(nextModelId ? { modelId: nextModelId, modelName: nextModelName ?? nextModelId } : {}),
      ...(nextThoughtLevel
        ? {
            thoughtLevel: nextThoughtLevel,
            thoughtLevelName: nextThoughtName ?? nextThoughtLevel,
          }
        : {}),
      ...(rawNextModeId
        ? {
            modeId: rawNextModeId,
            ...(nextModeName ? { modeName: nextModeName } : {}),
          }
        : {}),
    };
  };

  type PickerRow = {
    readonly key: string;
    readonly scope: string;
    readonly showInAll: boolean;
    readonly name: string;
    readonly detail: string;
    readonly search: string;
    readonly harnessId?: string;
    readonly transport?: ExternalChoice['transport'];
    readonly keepOpenOnSelect?: boolean;
    readonly select: () => void;
  };

  const externalChoices: PickerRow[] = harnesses.flatMap((item) => {
    const scopeKey = `harness:${item.id}`;
    const modelOption = item.cachedConfigOptions?.find((opt) => opt.category === 'model');
    const cachedModels = modelOption?.options ?? [];
    const defaultModelMeta = modelOption?.currentValue
      ? cachedModels.find((c) => c.value === modelOption.currentValue)
      : undefined;
    const itemHasRightConfig = Boolean(
      item.cachedConfigOptions?.some(
        (opt) =>
          (opt.category === 'thought_level' || opt.category === 'mode') && opt.options.length > 0,
      ),
    );
    const defaultRow: PickerRow = {
      key: scopeKey,
      scope: scopeKey,
      showInAll: true,
      name: activeScope === 'all' ? item.name : '使用默认模型',
      detail:
        activeScope === 'all'
          ? '外部代理 · 默认模型'
          : defaultModelMeta
            ? `${item.name} · 默认 (${defaultModelMeta.name})`
            : item.name,
      search: `${item.name} ${item.id} ${item.transport} 外部代理 默认模型`,
      harnessId: item.id,
      transport: item.transport,
      keepOpenOnSelect: activeScope !== 'all' && itemHasRightConfig,
      select: () => onHarness(resolveNextHarnessSelection(item, { resetToDefault: true })),
    };
    const modelRows: PickerRow[] = cachedModels.map((choice) => ({
      key: `${scopeKey}:model:${choice.value}`,
      scope: scopeKey,
      // 仅在选中左栏具体代理或全局关键词搜索时展开外部代理的具体模型，避免「全部」首屏被数十条外模淹没。
      showInAll: false,
      name: choice.name,
      detail: choice.group
        ? `${item.name} · ${choice.group}`
        : choice.value === modelOption?.currentValue
          ? `${item.name} · 默认`
          : choice.description || item.name,
      search: `${choice.name} ${choice.value} ${choice.group ?? ''} ${choice.description ?? ''} ${item.name} ${item.id}`,
      harnessId: item.id,
      transport: item.transport,
      keepOpenOnSelect: itemHasRightConfig,
      select: () => onHarness(resolveNextHarnessSelection(item, { modelChoice: choice })),
    }));
    return [defaultRow, ...modelRows];
  });

  const choices: PickerRow[] = [
    ...models.map((item): PickerRow => {
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

  const canProbeFocusedHarness = Boolean(focusedHarness && onRefreshHarnessModels);
  const probingFocused = Boolean(focusedHarness && refreshingHarnessId === focusedHarness.id);

  const selected = harness
    ? harness.modelId
      ? `harness:${harness.id}:model:${harness.modelId}`
      : `harness:${harness.id}`
    : model
      ? `model:${model.id}`
      : null;

  const displayThoughtInChip =
    harness?.thoughtLevel && harness.thoughtLevel !== 'default'
      ? harness.thoughtLevelName
      : undefined;

  const triggerLabel = harness
    ? [harness.name, harness.modelName, displayThoughtInChip, harness.modeName]
        .filter(Boolean)
        .join(' · ')
    : (model?.name ?? '选择模型或代理');

  const visualTriggerLead = harness
    ? [
        harness.name,
        harness.modelName ? compactModelBadgeName(harness.modelName, harness.id) : undefined,
      ]
        .filter(Boolean)
        .join(' · ')
    : (model?.name ?? '选择模型或代理');
  const visualTriggerTail = harness
    ? [displayThoughtInChip, harness.modeName].filter(Boolean).join(' · ')
    : '';

  const selectedHarnessTransport = harness
    ? harnesses.find((item) => item.id === harness.id)?.transport
    : undefined;

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
            className="kapibala-action kapibala-chip max-w-96"
            variant="ghost"
            size="sm"
            disabled={disabled}
            aria-label={
              harness ? `新对话代理：${triggerLabel}` : `新对话模型或代理：${triggerLabel}`
            }
          >
            {harness && (
              <HarnessGlyph
                harnessId={harness.id}
                transport={selectedHarnessTransport}
                size={15}
                className="shrink-0 text-kumo-subtle"
              />
            )}
            <span className="min-w-0 truncate">{visualTriggerLead}</span>
            {visualTriggerTail && <span className="shrink-0">· {visualTriggerTail}</span>}
            <CaretDownIcon size={13} className="shrink-0 text-kumo-subtle" />
          </Button>
        }
      />
      <Popover.Portal>
        <Popover.Positioner side="top" align="start" sideOffset={8} collisionPadding={12}>
          <Popover.Popup
            aria-label="选择代理或模型"
            className={`max-h-(--available-height) ${
              hasRightConfigColumn
                ? 'w-[min(44rem,var(--available-width))]'
                : 'w-[min(34rem,var(--available-width))]'
            } overflow-y-auto rounded-xl px-0 py-0 shadow-lg motion-reduce:transition-none`}
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
                item.select();
                if (searching || !item.keepOpenOnSelect) {
                  setOpen(false);
                }
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
              <div
                className={
                  hasRightConfigColumn
                    ? 'grid sm:grid-cols-[9.5rem_minmax(0,1fr)_12.5rem]'
                    : 'grid sm:grid-cols-[9.5rem_minmax(0,1fr)]'
                }
              >
                <section
                  aria-label="按代理浏览"
                  className="flex max-h-40 gap-1 overflow-auto border-b border-kumo-line bg-kumo-recessed p-2 sm:max-h-80 sm:flex-col sm:border-e sm:border-b-0"
                >
                  <button
                    type="button"
                    title="全部"
                    aria-pressed={activeScope === 'all'}
                    className="kapibala-action relative flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-kumo-subtle hover:bg-kumo-tint aria-pressed:bg-kumo-tint aria-pressed:font-medium aria-pressed:text-kumo-strong sm:w-full"
                    onClick={() => {
                      setScope('all');
                      setQuery('');
                    }}
                  >
                    <SquaresFourIcon size={16} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">全部</span>
                  </button>
                  <button
                    type="button"
                    title="Kapibala"
                    aria-pressed={activeScope === 'kapibala'}
                    className="kapibala-action relative flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-kumo-subtle hover:bg-kumo-tint aria-pressed:bg-kumo-tint aria-pressed:font-medium aria-pressed:text-kumo-strong sm:w-full"
                    onClick={() => {
                      setScope('kapibala');
                      setQuery('');
                    }}
                  >
                    <CpuIcon size={16} className="shrink-0" aria-hidden="true" />
                    <span className="truncate">Kapibala</span>
                  </button>
                  {harnesses.map((item) => {
                    const catId = `harness:${item.id}`;
                    return (
                      <button
                        type="button"
                        key={catId}
                        title={item.name}
                        aria-pressed={activeScope === catId}
                        className="kapibala-action relative flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-kumo-subtle hover:bg-kumo-tint aria-pressed:bg-kumo-tint aria-pressed:font-medium aria-pressed:text-kumo-strong sm:w-full"
                        onClick={() => {
                          setScope(catId);
                          setQuery('');
                        }}
                      >
                        <HarnessGlyph
                          harnessId={item.id}
                          transport={item.transport}
                          size={16}
                          className="shrink-0"
                        />
                        <span className="truncate">{item.name}</span>
                      </button>
                    );
                  })}
                </section>

                <div className="min-w-0 sm:min-h-48">
                  <Combobox.List className="max-h-80 py-1.5">
                    {(item: PickerRow) => (
                      <Combobox.Item
                        key={item.key}
                        value={item}
                        aria-label={item.name}
                        aria-description={item.detail}
                        className="grid-cols-[minmax(0,1fr)_16px] text-sm"
                        onClick={() => {
                          // 点击已是当前选中的外部模型行时同样确保同步推理默认值（防止受控 Combobox 同值点击不触发 onValueChange）
                          if (item.key === selected && item.keepOpenOnSelect) {
                            item.select();
                          }
                        }}
                      >
                        <div className="flex min-w-0 items-start gap-2">
                          {item.harnessId ? (
                            <HarnessGlyph
                              harnessId={item.harnessId}
                              transport={item.transport}
                              size={15}
                              className="mt-0.5 shrink-0 text-kumo-subtle"
                            />
                          ) : (
                            <CpuIcon
                              size={15}
                              className="mt-0.5 shrink-0 text-kumo-subtle"
                              aria-hidden="true"
                            />
                          )}
                          <div className="min-w-0 flex-1">
                            <span className="block truncate font-medium">{item.name}</span>
                            <span className="block truncate text-xs text-kumo-subtle">
                              {item.detail}
                            </span>
                          </div>
                        </div>
                      </Combobox.Item>
                    )}
                  </Combobox.List>
                  {probingFocused && focusedHarnessModels.length === 0 && (
                    <p className="px-3.5 pb-2.5 text-xs text-kumo-subtle">
                      正在读取 {focusedHarness?.name} 的可用模型与推理档位…
                    </p>
                  )}
                  <Combobox.Empty className="py-4">
                    {searching ? '没有匹配的代理或模型' : '当前没有可用模型'}
                  </Combobox.Empty>
                </div>

                {hasRightConfigColumn && focusedHarness && (
                  <section
                    aria-label="推理与模式配置"
                    className="flex max-h-80 flex-col overflow-y-auto border-t border-kumo-line bg-kumo-base sm:border-s sm:border-t-0"
                  >
                    {visibleThoughtChoices.length > 0 && (
                      <div className="p-2">
                        <div className="flex items-center justify-between gap-2 px-2 pt-0.5 pb-1.5 text-xs">
                          <span className="shrink-0 font-medium text-kumo-subtle">推理强度</span>
                          <span className="min-w-0 truncate text-kumo-faint">
                            {activeModelChoiceForFocused
                              ? compactModelBadgeName(
                                  activeModelChoiceForFocused.name,
                                  focusedHarness.id,
                                )
                              : '默认模型'}
                          </span>
                        </div>
                        <section aria-label="推理强度" className="space-y-0.5">
                          {visibleThoughtChoices.map((choice) => {
                            const checked = effectiveThoughtValue === choice.value;
                            return (
                              <button
                                key={choice.value}
                                type="button"
                                aria-pressed={checked}
                                className="kapibala-action flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-kumo-default hover:bg-kumo-tint aria-pressed:bg-kumo-tint aria-pressed:font-medium aria-pressed:text-kumo-strong"
                                onClick={() =>
                                  onHarness(
                                    resolveNextHarnessSelection(focusedHarness, {
                                      thoughtChoice: choice,
                                    }),
                                  )
                                }
                              >
                                <span className="truncate">{choice.name}</span>
                                {checked && (
                                  <CheckIcon
                                    size={14}
                                    className="shrink-0 text-kumo-strong"
                                    aria-hidden="true"
                                  />
                                )}
                              </button>
                            );
                          })}
                        </section>
                      </div>
                    )}

                    {visibleModeChoices.length > 0 && (
                      <div
                        className={`p-2 ${
                          visibleThoughtChoices.length > 0 ? 'border-t border-kumo-line' : ''
                        }`}
                      >
                        <div className="px-2 pt-0.5 pb-1.5 text-xs font-medium text-kumo-subtle">
                          运行模式
                        </div>
                        <section aria-label="运行模式" className="space-y-0.5">
                          {visibleModeChoices.map((choice) => {
                            const checked = effectiveModeValue === choice.value;
                            return (
                              <button
                                key={choice.value}
                                type="button"
                                aria-pressed={checked}
                                title={choice.description ?? choice.name}
                                className="kapibala-action flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm text-kumo-default hover:bg-kumo-tint aria-pressed:bg-kumo-tint aria-pressed:font-medium aria-pressed:text-kumo-strong"
                                onClick={() =>
                                  onHarness(
                                    resolveNextHarnessSelection(focusedHarness, {
                                      modeChoice: choice,
                                    }),
                                  )
                                }
                              >
                                <span className="truncate">
                                  {compactModeDisplayName(choice.name)}
                                </span>
                                {checked && (
                                  <CheckIcon
                                    size={14}
                                    className="shrink-0 text-kumo-strong"
                                    aria-hidden="true"
                                  />
                                )}
                              </button>
                            );
                          })}
                        </section>
                      </div>
                    )}
                  </section>
                )}
              </div>
            </Combobox>
            <div className="flex flex-wrap items-center justify-end gap-1 border-t border-kumo-line px-2 py-1.5">
              {canProbeFocusedHarness && focusedHarness && (
                <div className="mr-auto flex items-center gap-2">
                  <Button
                    className="kapibala-action"
                    variant="ghost"
                    size="sm"
                    disabled={probingFocused || Boolean(refreshingHarnessId)}
                    onClick={() => onRefreshHarnessModels?.(focusedHarness.id, { silent: false })}
                  >
                    <ArrowsClockwiseIcon size={14} aria-hidden="true" />
                    {probingFocused
                      ? '正在同步缓存…'
                      : focusedHarnessModels.length > 0
                        ? '刷新模型缓存'
                        : '加载可用模型'}
                  </Button>
                  {!probingFocused && focusedHarness.cachedConfigUpdatedAt !== undefined && (
                    <span className="hidden whitespace-nowrap text-xs text-kumo-subtle sm:inline">
                      本地缓存 {focusedHarnessModels.length} 项 ·{' '}
                      {formatPickerCacheTime(focusedHarness.cachedConfigUpdatedAt)}
                    </span>
                  )}
                </div>
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
