import { Button, Combobox, Popover } from '@cloudflare/kumo';
import {
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
  'id' | 'name' | 'transport'
>;

/** 新对话在代理和模型间共用一个搜索入口。外部代理的默认模型由宿主启动时解析。 */
export function ComposerModelPicker({
  models,
  providers,
  harnesses,
  model,
  harness,
  disabled,
  harnessesFailed,
  onModel,
  onHarness,
  onSettings,
  onExternalSettings,
}: {
  models: readonly ModelChoice[];
  providers: readonly Pick<Catalog['providers'][number], 'key' | 'name'>[];
  harnesses: readonly ExternalChoice[];
  model?: Pick<ModelChoice, 'id' | 'name'>;
  harness?: Pick<ExternalChoice, 'id' | 'name'>;
  disabled: boolean;
  harnessesFailed?: boolean;
  onModel(id: string): void;
  onHarness(choice: Pick<ExternalChoice, 'id' | 'name'>): void;
  onSettings(): void;
  onExternalSettings?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState('all');
  const [query, setQuery] = useState('');
  const terms = query.toLowerCase().trim().split(/\s+/);
  const searching = Boolean(query.trim());
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
  const choices = [
    ...models.map((item) => {
      const provider = providerByKey.get(item.providerKey);
      return {
        key: `model:${item.id}`,
        scope: 'kapibala',
        name: item.name,
        detail: provider ? `Kapibala · ${provider}` : 'Kapibala',
        search: `${item.name} ${item.modelName} ${item.id} ${provider ?? ''} Kapibala`,
        select: () => onModel(item.id),
      };
    }),
    ...harnesses.map(({ id, name, transport }) => ({
      key: `harness:${id}`,
      scope: `harness:${id}`,
      name: activeScope === 'all' ? name : '使用默认模型',
      detail: activeScope === 'all' ? '外部代理 · 默认模型' : name,
      search: `${name} ${id} ${transport} 外部代理 默认模型`,
      select: () => onHarness({ id, name }),
    })),
  ].filter(
    (item) =>
      (activeScope === 'all' || item.scope === activeScope) &&
      terms.every((term) => item.search.toLowerCase().includes(term)),
  );
  const selected = harness ? `harness:${harness.id}` : model ? `model:${model.id}` : null;
  const triggerLabel = harness?.name ?? model?.name ?? '选择模型或代理';

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setScope('all');
          setQuery('');
        }
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
            <div className="flex flex-wrap justify-end gap-1 border-t border-kumo-line px-2 py-1.5">
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
