import { type KeyboardEvent, useId, useMemo, useState } from 'react';
import { Badge } from './badges.js';
import { Button, type ButtonSize, type ButtonVariant } from './button.js';
import { SearchField } from './fields.js';
import { Icon, type IconName } from './icon.js';
import { AnchoredPopover, type PopoverPlacement } from './popover.js';

/** `Select` 与 `Combobox` 共用的下拉候选项结构。 */
export interface SelectOption<T extends string> {
  readonly value: T;
  readonly label: string;
  readonly description?: string;
  readonly group?: string;
  readonly badge?: string;
  readonly icon?: IconName;
  readonly disabled?: boolean;
  readonly keywords?: readonly string[];
}

/** 按可选 `group` 字段保持原始出现顺序归组，未分组项归入空键。 */
function groupOptions<T extends string>(
  options: readonly SelectOption<T>[],
): ReadonlyArray<{ readonly group: string; readonly items: readonly SelectOption<T>[] }> {
  const map = new Map<string, SelectOption<T>[]>();
  for (const option of options) {
    const key = option.group ?? '';
    const bucket = map.get(key);
    if (bucket) {
      bucket.push(option);
    } else {
      map.set(key, [option]);
    }
  }
  return Array.from(map.entries(), ([group, items]) => ({ group, items }));
}

/**
 * `Select` 入参契约：基于 `AnchoredPopover` 构建的轻量单选下拉框，
 * 触发器暴露 `role="combobox"` + `aria-expanded` + `aria-controls`，弹层暴露 `role="listbox"`。
 */
export interface SelectProps<T extends string> {
  readonly value: T | undefined;
  readonly onValueChange: (value: T) => void;
  readonly options: readonly SelectOption<T>[];
  readonly placeholder?: string;
  readonly 'aria-label': string;
  readonly size?: ButtonSize;
  readonly variant?: ButtonVariant;
  readonly placement?: PopoverPlacement;
  readonly disabled?: boolean;
  readonly leadingIcon?: IconName;
  readonly className?: string;
}

/**
 * 标准不可搜索下拉选择器：支持上下方向键、`Home` / `End`、`Enter` 确认与分组标题展示。
 */
export function Select<T extends string>({
  value,
  onValueChange,
  options,
  placeholder = '请选择',
  'aria-label': ariaLabel,
  size = 'md',
  variant = 'outline',
  placement = 'bottom-start',
  disabled = false,
  leadingIcon,
  className,
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [highlightIdx, setHighlightIdx] = useState(0);
  const listboxId = useId();
  const selected = options.find((item) => item.value === value);
  const enabledOptions = useMemo(() => options.filter((item) => !item.disabled), [options]);
  const groups = useMemo(() => groupOptions(options), [options]);

  const openAndSyncHighlight = (nextOpen: boolean) => {
    if (disabled) return;
    if (nextOpen) {
      const idx = enabledOptions.findIndex((item) => item.value === value);
      setHighlightIdx(idx >= 0 ? idx : 0);
    }
    setOpen(nextOpen);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (disabled) return;
    if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      openAndSyncHighlight(true);
      return;
    }
    if (!open || enabledOptions.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightIdx((prev) => (prev + 1) % enabledOptions.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightIdx((prev) => (prev - 1 + enabledOptions.length) % enabledOptions.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHighlightIdx(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setHighlightIdx(enabledOptions.length - 1);
    } else if (event.key === 'Enter') {
      const target = enabledOptions[highlightIdx];
      if (target) {
        event.preventDefault();
        onValueChange(target.value);
        setOpen(false);
      }
    }
  };

  const activeValue = enabledOptions[highlightIdx]?.value;

  return (
    <AnchoredPopover
      open={open}
      onOpenChange={openAndSyncHighlight}
      placement={placement}
      trigger={
        <Button
          variant={variant}
          size={size}
          disabled={disabled}
          leadingIcon={leadingIcon ?? selected?.icon}
          trailingIcon="caret-up-down"
          // biome-ignore lint/a11y/useSemanticElements: 基于 AnchoredPopover 的自定义下拉触发器需暴露 WAI-ARIA 1.2 combobox 角色以承载图标与徽标。
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          className={className}
          onClick={() => openAndSyncHighlight(!open)}
          onKeyDown={handleKeyDown}
        >
          <span className="truncate">{selected ? selected.label : placeholder}</span>
        </Button>
      }
    >
      <div
        id={listboxId}
        // biome-ignore lint/a11y/useSemanticElements: 自定义浮层列表框支持分组与富徽标，遵循 WAI-ARIA listbox 契约。
        role="listbox"
        aria-label={ariaLabel}
        tabIndex={-1}
        onKeyDown={handleKeyDown}
      >
        {groups.map(({ group, items }) => (
          <div key={group || '__default'}>
            {group ? <div className="kpbl-option-group">{group}</div> : null}
            {items.map((option) => {
              const isSelected = option.value === value;
              const isHighlighted = option.value === activeValue;
              return (
                <div
                  key={option.value}
                  // biome-ignore lint/a11y/useSemanticElements: 与 role="listbox" 配套的富内容选项节点。
                  role="option"
                  tabIndex={-1}
                  aria-selected={isSelected}
                  aria-disabled={option.disabled || undefined}
                  data-highlighted={isHighlighted ? 'true' : undefined}
                  className="kpbl-option"
                  onClick={() => {
                    if (option.disabled) return;
                    onValueChange(option.value);
                    setOpen(false);
                  }}
                  onKeyDown={(event) => {
                    if (!option.disabled && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault();
                      onValueChange(option.value);
                      setOpen(false);
                    }
                  }}
                >
                  <span className="inline-flex min-w-0 flex-1 items-center gap-2">
                    {option.icon ? <Icon name={option.icon} size={15} /> : null}
                    <span className="min-w-0 flex-1 truncate">{option.label}</span>
                    {option.badge ? <Badge>{option.badge}</Badge> : null}
                  </span>
                  {isSelected ? <Icon name="check" size={14} /> : null}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </AnchoredPopover>
  );
}

/**
 * `Combobox` 入参契约：可搜索分组下拉选择器，专用于 `OmniComposer` 模型/外部代理双栏检索与场景路由选择。
 */
export interface ComboboxProps<T extends string> extends SelectProps<T> {
  readonly searchPlaceholder?: string;
  readonly emptyText?: string;
}

/**
 * 可搜索下拉组合框原语：弹层顶部内嵌 `SearchField`，按标签、描述、分组名及附加关键词实时过滤，
 * 并通过 `aria-activedescendant` 将虚拟焦点同步给读屏器。
 */
export function Combobox<T extends string>({
  value,
  onValueChange,
  options,
  placeholder = '选择模型或代理',
  searchPlaceholder = '搜索名称或标识…',
  emptyText = '无匹配选项',
  'aria-label': ariaLabel,
  size = 'sm',
  variant = 'ghost',
  placement = 'top-start',
  disabled = false,
  leadingIcon,
  className,
}: ComboboxProps<T>) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlightIdx, setHighlightIdx] = useState(0);
  const baseId = useId();
  const listboxId = `${baseId}-listbox`;

  const selected = options.find((item) => item.value === value);
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((option) => {
      const haystacks = [
        option.label,
        option.value,
        option.description ?? '',
        option.group ?? '',
        ...(option.keywords ?? []),
      ];
      return haystacks.some((part) => part.toLowerCase().includes(q));
    });
  }, [options, query]);

  const enabledFiltered = useMemo(() => filtered.filter((item) => !item.disabled), [filtered]);
  const groups = useMemo(() => groupOptions(filtered), [filtered]);
  const clampedIdx = Math.min(highlightIdx, Math.max(0, enabledFiltered.length - 1));
  const activeOption = enabledFiltered[clampedIdx];
  const activeOptionId = activeOption ? `${baseId}-opt-${activeOption.value}` : undefined;

  const handleOpenChange = (nextOpen: boolean) => {
    if (disabled) return;
    setOpen(nextOpen);
    if (!nextOpen) {
      setQuery('');
      setHighlightIdx(0);
    }
  };

  const handleInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (enabledFiltered.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlightIdx((prev) => (prev + 1) % enabledFiltered.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlightIdx((prev) => (prev - 1 + enabledFiltered.length) % enabledFiltered.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      setHighlightIdx(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      setHighlightIdx(enabledFiltered.length - 1);
    } else if (event.key === 'Enter' && activeOption) {
      event.preventDefault();
      onValueChange(activeOption.value);
      handleOpenChange(false);
    }
  };

  return (
    <AnchoredPopover
      open={open}
      onOpenChange={handleOpenChange}
      placement={placement}
      trigger={
        <Button
          variant={variant}
          size={size}
          disabled={disabled}
          leadingIcon={leadingIcon ?? selected?.icon}
          trailingIcon="caret-down"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={listboxId}
          className={className}
          onClick={() => handleOpenChange(!open)}
        >
          <span className="truncate">{selected ? selected.label : placeholder}</span>
        </Button>
      }
    >
      <div className="flex flex-col gap-1">
        <SearchField
          autoFocus
          value={query}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-activedescendant={activeOptionId}
          aria-autocomplete="list"
          onValueChange={(next) => {
            setQuery(next);
            setHighlightIdx(0);
          }}
          onKeyDown={handleInputKeyDown}
        />
        {/* biome-ignore lint/a11y/useSemanticElements: 可搜索 Combobox 的结果容器需暴露 WAI-ARIA listbox 角色供 aria-controls 与 aria-activedescendant 关联。 */}
        <div id={listboxId} role="listbox" aria-label={ariaLabel} tabIndex={-1}>
          {filtered.length === 0 ? (
            <p className="kpbl-field-hint p-2 text-center">{emptyText}</p>
          ) : (
            groups.map(({ group, items }) => (
              <div key={group || '__default'}>
                {group ? <div className="kpbl-option-group">{group}</div> : null}
                {items.map((option) => {
                  const isSelected = option.value === value;
                  const isHighlighted = option.value === activeOption?.value;
                  return (
                    <div
                      key={option.value}
                      id={`${baseId}-opt-${option.value}`}
                      // biome-ignore lint/a11y/useSemanticElements: 与可搜索 role="listbox" 配套的富内容选项节点。
                      role="option"
                      tabIndex={-1}
                      aria-selected={isSelected}
                      aria-disabled={option.disabled || undefined}
                      data-highlighted={isHighlighted ? 'true' : undefined}
                      className="kpbl-option"
                      onClick={() => {
                        if (option.disabled) return;
                        onValueChange(option.value);
                        handleOpenChange(false);
                      }}
                      onKeyDown={(event) => {
                        if (!option.disabled && (event.key === 'Enter' || event.key === ' ')) {
                          event.preventDefault();
                          onValueChange(option.value);
                          handleOpenChange(false);
                        }
                      }}
                    >
                      <span className="inline-flex min-w-0 flex-1 items-center gap-2">
                        {option.icon ? <Icon name={option.icon} size={15} /> : null}
                        <span className="min-w-0 flex-1 truncate">{option.label}</span>
                        {option.badge ? <Badge>{option.badge}</Badge> : null}
                      </span>
                      {isSelected ? <Icon name="check" size={14} /> : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </AnchoredPopover>
  );
}
