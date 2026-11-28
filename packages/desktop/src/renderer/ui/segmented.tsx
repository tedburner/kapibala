import { type KeyboardEvent, type ReactNode, useRef } from 'react';
import { Icon, type IconName } from './icon.js';

/** `Segmented` 单个互斥选项描述。 */
export interface SegmentedOption<T extends string> {
  readonly value: T;
  readonly label: ReactNode;
  readonly icon?: IconName;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}

/**
 * `Segmented` 入参契约：用于外观主题切换、Diff 视图模式切换等互斥低基数（2–5 项）选择；
 * 容器暴露 `role="radiogroup"` 并支持方向键与 `Home` / `End` 漫游焦点（Roving Tabindex）。
 */
export interface SegmentedProps<T extends string> {
  readonly value: T;
  readonly onValueChange: (value: T) => void;
  readonly options: readonly SegmentedOption<T>[];
  readonly 'aria-label': string;
  readonly size?: 'sm' | 'md';
  readonly disabled?: boolean;
  readonly className?: string;
}

/**
 * 单选分段控制器原语：当前选中项维持 `tabIndex={0}`，其余项为 `-1`；
 * 左右/上下方向键直接跳过禁用项完成焦点迁移与即时选中。
 */
export function Segmented<T extends string>({
  value,
  onValueChange,
  options,
  'aria-label': ariaLabel,
  size = 'sm',
  disabled = false,
  className,
}: SegmentedProps<T>) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const enabledIndices = options
    .map((option, index) => (!disabled && !option.disabled ? index : -1))
    .filter((index) => index >= 0);

  const selectedIndex = options.findIndex((option) => option.value === value);
  const focusableIndex =
    selectedIndex >= 0 && !options[selectedIndex]?.disabled
      ? selectedIndex
      : (enabledIndices[0] ?? -1);

  const moveSelection = (targetPos: number) => {
    const targetIndex = enabledIndices[targetPos];
    if (targetIndex === undefined) return;
    const nextOption = options[targetIndex];
    if (!nextOption) return;
    itemRefs.current[targetIndex]?.focus();
    if (nextOption.value !== value) {
      onValueChange(nextOption.value);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (enabledIndices.length === 0) return;
    const currentPos = Math.max(0, enabledIndices.indexOf(selectedIndex));
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      event.preventDefault();
      moveSelection((currentPos + 1) % enabledIndices.length);
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      event.preventDefault();
      moveSelection((currentPos - 1 + enabledIndices.length) % enabledIndices.length);
    } else if (event.key === 'Home') {
      event.preventDefault();
      moveSelection(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      moveSelection(enabledIndices.length - 1);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      data-size={size}
      className={className ? `kpbl-segmented ${className}` : 'kpbl-segmented'}
      onKeyDown={handleKeyDown}
    >
      {options.map((option, index) => {
        const isSelected = option.value === value;
        const isItemDisabled = disabled || Boolean(option.disabled);
        return (
          <button
            key={option.value}
            ref={(node) => {
              itemRefs.current[index] = node;
            }}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: 分段控制器采用 WAI-ARIA radiogroup 按钮漫游焦点模式，避免原生 radio 隐式表单耦合。
            role="radio"
            aria-checked={isSelected}
            aria-label={option.ariaLabel}
            disabled={isItemDisabled}
            tabIndex={index === focusableIndex && !isItemDisabled ? 0 : -1}
            className="kpbl-segmented-item"
            onClick={() => {
              if (!isItemDisabled && option.value !== value) {
                onValueChange(option.value);
              }
            }}
          >
            {option.icon ? <Icon name={option.icon} size={14} /> : null}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
