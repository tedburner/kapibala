import type {
  ViewExternalConfigChoice,
  ViewExternalConfigOption,
  ViewExternalTransport,
} from '@kiturone/kapibala-host/view-model';
import { useEffect, useRef, useState } from 'react';
import { AnchoredPopover, Badge, Button, Icon, SearchField } from '../../ui/index.js';

/** 本地可选模型摘要项。 */
export interface PickerModelOption {
  readonly id: string;
  readonly name: string;
  readonly modelName: string;
  readonly providerKey: string;
}

/** 服务商分组名项。 */
export interface PickerProviderOption {
  readonly key: string;
  readonly name: string;
}

/** 已启用的外部代理目录项。 */
export interface PickerHarnessOption {
  readonly id: string;
  readonly name: string;
  readonly transport: ViewExternalTransport;
  readonly cachedConfigOptions?: readonly ViewExternalConfigOption[];
  readonly cachedConfigUpdatedAt?: number;
}

/** 选中的外部代理及其可选显式子模型、推理档位与运行模式。 */
export interface SelectedExternalHarness {
  readonly id: string;
  readonly name: string;
  readonly modelId?: string;
  readonly modelName?: string;
  readonly thoughtLevel?: string;
  readonly thoughtLevelName?: string;
  readonly modeId?: string;
  readonly modeName?: string;
}

/** Kapibala 本地会话四档角色路由。 */
export type NativeSessionRole = 'default' | 'planning' | 'execution' | 'fast';

const ROLE_CHOICES: readonly ViewExternalConfigChoice[] = [
  { value: 'default', name: '默认' },
  { value: 'planning', name: '规划' },
  { value: 'execution', name: '执行' },
  { value: 'fast', name: '快速' },
];

const compactMode = (raw: string) => /^([^(（]+?)\s*[（(]/.exec(raw)?.[1]?.trim() || raw.trim();
const compactBadge = (raw: string, id: string) =>
  raw.toLowerCase().startsWith(`${id.toLowerCase()}/`) && raw.length > id.length + 1
    ? raw.slice(id.length + 1)
    : raw;

function mergeHarness(
  t: PickerHarnessOption,
  prev: SelectedExternalHarness | undefined,
  p: Partial<SelectedExternalHarness> & { readonly reset?: boolean },
): SelectedExternalHarness {
  if (p.reset) return { id: t.id, name: t.name };
  const b = prev?.id === t.id ? prev : undefined;
  const modelId = p.modelId ?? b?.modelId;
  const thought = p.thoughtLevel ?? b?.thoughtLevel;
  const modeId = p.modeId ?? b?.modeId;
  const modeName = p.modeName ?? b?.modeName;
  return {
    id: t.id,
    name: t.name,
    ...(modelId ? { modelId, modelName: p.modelName ?? b?.modelName ?? modelId } : {}),
    ...(thought
      ? {
          thoughtLevel: thought,
          thoughtLevelName: p.thoughtLevelName ?? b?.thoughtLevelName ?? thought,
        }
      : {}),
    ...(modeId ? { modeId, ...(modeName ? { modeName } : {}) } : {}),
  };
}

/**
 * `ModelHarnessPicker` 入参契约（017 §6.4.3 & §7）：
 * 基于原生 `AnchoredPopover` 自建三栏可搜索模型与外部代理选择器（零第三方预设组件库依赖）。
 */
export interface ModelHarnessPickerProps {
  readonly models: readonly PickerModelOption[];
  readonly providers?: readonly PickerProviderOption[];
  readonly harnesses?: readonly PickerHarnessOption[];
  readonly selectedModel?: Pick<PickerModelOption, 'id' | 'name'>;
  readonly selectedHarness?: SelectedExternalHarness;
  readonly role?: NativeSessionRole;
  readonly contextMode?: 'new' | 'session';
  readonly disabled?: boolean;
  readonly refreshingHarnessId?: string;
  readonly onSelectModel: (profileId: string) => void;
  readonly onSelectRole?: (role: NativeSessionRole) => void;
  readonly onSelectHarness: (choice: SelectedExternalHarness) => void;
  readonly onRefreshHarnessModels?: (
    harnessId: string,
    options?: { readonly silent?: boolean },
  ) => void;
  readonly onOpenModelSettings?: () => void;
  readonly onOpenExternalSettings?: () => void;
}

/** 本地模型与外部代理三栏检索选择器（`ModelHarnessPicker`）。 */
export function ModelHarnessPicker(props: ModelHarnessPickerProps) {
  const { models, providers = [], harnesses = [], selectedHarness, role = 'default' } = props;
  const contextMode = props.contextMode ?? 'new';
  const disabled = props.disabled ?? false;
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('all');
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const autoProbedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return undefined;
    const raf = requestAnimationFrame(() => searchInputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const searching = terms.length > 0;
  const activeScope = searching ? 'all' : scope;
  const focused = activeScope.startsWith('harness:')
    ? harnesses.find((h) => `harness:${h.id}` === activeScope)
    : undefined;

  const { refreshingHarnessId, onRefreshHarnessModels: refreshModels } = props;
  useEffect(() => {
    if (!open || !focused || !refreshModels || focused.cachedConfigOptions?.length) return;
    if (refreshingHarnessId || autoProbedRef.current.has(focused.id)) return;
    autoProbedRef.current.add(focused.id);
    refreshModels(focused.id, { silent: true });
  }, [open, focused, refreshingHarnessId, refreshModels]);

  const providerMap = new Map(providers.map((p) => [p.key, p.name]));
  const findOpt = (cat: 'model' | 'thought_level' | 'mode') =>
    focused?.cachedConfigOptions?.find((o) => o.category === cat);
  const focusedOptions = findOpt('model')?.options ?? [];
  const activeModelId =
    (focused && selectedHarness?.id === focused.id ? selectedHarness.modelId : undefined) ??
    findOpt('model')?.currentValue;
  const supportedThoughts = focusedOptions.find(
    (c) => c.value === activeModelId,
  )?.supportedThoughtLevels;
  const visibleThoughts = (findOpt('thought_level')?.options ?? []).filter(
    (c) => !supportedThoughts || supportedThoughts.includes(c.value),
  );
  const visibleModes = findOpt('mode')?.options ?? [];

  const pickPatch = (patch: Partial<SelectedExternalHarness>) => {
    if (focused) props.onSelectHarness(mergeHarness(focused, selectedHarness, patch));
  };
  const rightSections: {
    heading: string;
    choices: readonly ViewExternalConfigChoice[];
    selectedValue: string | undefined;
    formatLabel?: (name: string) => string;
    onPick: (choice: ViewExternalConfigChoice) => void;
  }[] = [];
  if (activeScope === 'kapibala' && !searching && props.onSelectRole) {
    rightSections.push({
      heading: '会话角色',
      choices: ROLE_CHOICES,
      selectedValue: role,
      onPick: (c) => props.onSelectRole?.(c.value as NativeSessionRole),
    });
  }
  if (focused && !searching && visibleThoughts.length > 0) {
    rightSections.push({
      heading: '推理强度',
      choices: visibleThoughts,
      selectedValue: selectedHarness?.thoughtLevel,
      onPick: (c) => pickPatch({ thoughtLevel: c.value, thoughtLevelName: c.name }),
    });
  }
  if (focused && !searching && visibleModes.length > 0) {
    rightSections.push({
      heading: '运行模式',
      choices: visibleModes,
      selectedValue: selectedHarness?.modeId,
      formatLabel: compactMode,
      onPick: (c) => pickPatch({ modeId: c.value, modeName: compactMode(c.name) }),
    });
  }

  const rows: {
    key: string;
    title: string;
    subtitle: string;
    keepOpen: boolean;
    onPick: () => void;
  }[] = [];
  const pushRow = (rowScope: string, inAll: boolean, blob: string, row: (typeof rows)[number]) => {
    const ok = searching
      ? terms.every((t) => blob.toLowerCase().includes(t))
      : activeScope === 'all'
        ? inAll
        : rowScope === activeScope;
    if (ok) rows.push(row);
  };
  for (const m of models) {
    const v = providerMap.get(m.providerKey);
    pushRow('kapibala', true, `${m.name} ${m.modelName} ${m.id} ${v ?? ''} kapibala`, {
      key: `model:${m.id}`,
      title: m.name,
      subtitle: v ? `Kapibala · ${v}` : 'Kapibala',
      keepOpen: rightSections.length > 0,
      onPick: () => props.onSelectModel(m.id),
    });
  }
  for (const h of harnesses) {
    const hScope = `harness:${h.id}`;
    const mOpt = h.cachedConfigOptions?.find((o) => o.category === 'model');
    const hasRight = Boolean(
      h.cachedConfigOptions?.some((o) => o.category !== 'model' && o.options.length > 0),
    );
    pushRow(hScope, true, `${h.name} ${h.id} ${h.transport} 外部代理 默认模型`, {
      key: hScope,
      title: activeScope === 'all' ? h.name : '使用默认模型',
      subtitle: activeScope === 'all' ? `外部代理 · ${h.transport}` : h.name,
      keepOpen: activeScope !== 'all' && hasRight,
      onPick: () => props.onSelectHarness(mergeHarness(h, selectedHarness, { reset: true })),
    });
    for (const c of mOpt?.options ?? []) {
      pushRow(hScope, false, `${c.name} ${c.value} ${c.group ?? ''} ${h.name} ${h.id}`, {
        key: `${hScope}:model:${c.value}`,
        title: c.name,
        subtitle: c.group ? `${h.name} · ${c.group}` : c.description || h.name,
        keepOpen: hasRight,
        onPick: () =>
          props.onSelectHarness(
            mergeHarness(h, selectedHarness, { modelId: c.value, modelName: c.name }),
          ),
      });
    }
  }

  const selectedKey = selectedHarness
    ? `harness:${selectedHarness.id}${selectedHarness.modelId ? `:model:${selectedHarness.modelId}` : ''}`
    : props.selectedModel
      ? `model:${props.selectedModel.id}`
      : '';
  const ariaPrefix = `${contextMode === 'session' ? '当前会话' : '新对话'}${selectedHarness ? '代理' : contextMode === 'session' ? '模型' : '模型或代理'}`;
  const roleLabel = role !== 'default' ? ROLE_CHOICES.find((r) => r.value === role)?.name : '';
  const thoughtLabel =
    selectedHarness?.thoughtLevel && selectedHarness.thoughtLevel !== 'default'
      ? selectedHarness.thoughtLevelName
      : '';
  const modelLabel = selectedHarness?.modelName
    ? compactBadge(selectedHarness.modelName, selectedHarness.id)
    : '';
  const triggerText = (
    selectedHarness
      ? [selectedHarness.name, modelLabel, thoughtLabel, selectedHarness.modeName]
      : [props.selectedModel?.name ?? '选择模型或代理', roleLabel]
  )
    .filter(Boolean)
    .join(' · ');

  const handleOpenChange = (next: boolean) => {
    if (disabled) return;
    if (next) {
      setScope(
        selectedHarness
          ? `harness:${selectedHarness.id}`
          : contextMode === 'session'
            ? 'kapibala'
            : 'all',
      );
      setQuery('');
    }
    setOpen(next);
  };
  const scopes = [
    { key: 'all', label: '全部', icon: 'squares-four' as const },
    { key: 'kapibala', label: 'Kapibala', icon: 'cpu' as const },
    ...harnesses.map((h) => ({
      key: `harness:${h.id}`,
      label: h.name,
      icon: 'plugs-connected' as const,
    })),
  ];
  const jump = (fn?: () => void) => () => {
    setOpen(false);
    fn?.();
  };

  return (
    <AnchoredPopover
      open={open}
      onOpenChange={handleOpenChange}
      placement="top-start"
      className="kpbl-model-picker-popover"
      trigger={
        <Button
          size="sm"
          variant="ghost"
          disabled={disabled}
          leadingIcon={selectedHarness ? 'plugs-connected' : 'cpu'}
          trailingIcon="caret-down"
          aria-label={`${ariaPrefix}：${triggerText}`}
          aria-expanded={open}
          onClick={() => handleOpenChange(!open)}
        >
          <span className="max-w-56 truncate">{triggerText}</span>
        </Button>
      }
    >
      <div className="flex flex-col">
        <div className="kpbl-picker-head">
          <SearchField
            ref={searchInputRef}
            autoFocus
            aria-label="搜索代理或模型"
            placeholder="搜索代理或模型…"
            value={query}
            onValueChange={setQuery}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && rows.length > 0) {
                e.preventDefault();
                const first = rows[0]!;
                first.onPick();
                if (searching || !first.keepOpen) setOpen(false);
              }
            }}
          />
        </div>
        <div
          className="kpbl-picker-grid"
          data-three-col={rightSections.length > 0 ? 'true' : undefined}
        >
          <nav aria-label="按代理浏览" className="kpbl-picker-col">
            {scopes.map((s) => (
              <button
                key={s.key}
                type="button"
                aria-pressed={activeScope === s.key}
                className="kpbl-option"
                onClick={() => {
                  setScope(s.key);
                  setQuery('');
                }}
              >
                <span className="inline-flex min-w-0 items-center gap-2">
                  <Icon name={s.icon} size={15} />
                  <span className="truncate">{s.label}</span>
                </span>
              </button>
            ))}
          </nav>

          {/* biome-ignore lint/a11y/useSemanticElements: 三栏可搜索模型面板需使用自定义 listbox 承载双行富文本候选项。 */}
          <div className="kpbl-picker-col" role="listbox" aria-label="可用模型列表" tabIndex={-1}>
            {rows.length === 0 ? (
              <p className="kpbl-field-hint p-3 text-center">
                {searching ? '没有匹配的代理或模型' : '当前没有可用模型'}
              </p>
            ) : (
              rows.map((row) => (
                <button
                  key={row.key}
                  type="button"
                  // biome-ignore lint/a11y/useSemanticElements: 与自定义 listbox 配套的可交互按钮选项。
                  role="option"
                  aria-selected={row.key === selectedKey}
                  className="kpbl-option"
                  onClick={() => {
                    row.onPick();
                    if (searching || !row.keepOpen) setOpen(false);
                  }}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">{row.title}</span>
                    <span className="truncate text-xs opacity-70">{row.subtitle}</span>
                  </span>
                  {row.key === selectedKey ? <Icon name="check" size={14} /> : null}
                </button>
              ))
            )}
          </div>

          {rightSections.length > 0 ? (
            <div className="kpbl-picker-col">
              {rightSections.map((sec) => (
                <section key={sec.heading} aria-label={sec.heading}>
                  <div className="kpbl-option-group">{sec.heading}</div>
                  {sec.choices.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      aria-pressed={sec.selectedValue === c.value}
                      className="kpbl-option"
                      onClick={() => sec.onPick(c)}
                    >
                      <span className="truncate">
                        {sec.formatLabel ? sec.formatLabel(c.name) : c.name}
                      </span>
                      {sec.selectedValue === c.value ? <Icon name="check" size={14} /> : null}
                    </button>
                  ))}
                </section>
              ))}
            </div>
          ) : null}
        </div>

        <div className="kpbl-picker-foot">
          <div className="inline-flex items-center gap-2">
            {focused && refreshModels ? (
              <Button
                size="xs"
                variant="ghost"
                leadingIcon="arrows-clockwise"
                disabled={Boolean(refreshingHarnessId)}
                onClick={() => refreshModels(focused.id, { silent: false })}
              >
                {refreshingHarnessId === focused.id ? '同步中…' : '刷新模型缓存'}
              </Button>
            ) : null}
            {focused?.cachedConfigUpdatedAt !== undefined ? (
              <Badge>已缓存 {focusedOptions.length} 项</Badge>
            ) : null}
          </div>
          <div className="inline-flex items-center gap-1">
            {props.onOpenModelSettings ? (
              <Button size="xs" variant="ghost" onClick={jump(props.onOpenModelSettings)}>
                模型设置
              </Button>
            ) : null}
            {props.onOpenExternalSettings ? (
              <Button size="xs" variant="ghost" onClick={jump(props.onOpenExternalSettings)}>
                外部代理设置
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </AnchoredPopover>
  );
}
