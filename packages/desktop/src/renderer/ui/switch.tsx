import { type ButtonHTMLAttributes, type ReactNode, type Ref, useId } from 'react';

/**
 * `Switch` 入参契约：严格采用 `<button type="button" role="switch" aria-checked={checked}>`，
 * 开启态使用 `--kpbl-control-solid` 碳素墨色轨道与反转滑块，彻底消灭第三方组件库的蓝色开关噪音。
 */
export interface SwitchProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'role' | 'onChange'> {
  readonly checked: boolean;
  readonly onCheckedChange?: (checked: boolean) => void;
  readonly size?: 'sm' | 'md';
  readonly label?: ReactNode;
  readonly ref?: Ref<HTMLButtonElement>;
}

/**
 * 二态拨动开关原语：原生 `<button>` 自动响应 `Space` 与 `Enter` 键盘切换，
 * 当传入行内 `label` 时自动建立 `aria-labelledby` 关联，未传 `label` 时消费调用方传入的 `aria-label`。
 */
export function Switch({
  id,
  checked,
  onCheckedChange,
  size = 'md',
  label,
  disabled = false,
  className,
  onClick,
  'aria-labelledby': ariaLabelledBy,
  ref,
  ...rest
}: SwitchProps) {
  const autoId = useId();
  const buttonId = id ?? autoId;
  const labelId = label ? `${buttonId}-label` : undefined;
  const resolvedLabelledBy = [ariaLabelledBy, labelId].filter(Boolean).join(' ') || undefined;

  const buttonNode = (
    <button
      ref={ref}
      id={buttonId}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-labelledby={resolvedLabelledBy}
      disabled={disabled}
      data-size={size}
      data-state={checked ? 'checked' : 'unchecked'}
      className={className ? `kpbl-switch ${className}` : 'kpbl-switch'}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented && !disabled) {
          onCheckedChange?.(!checked);
        }
      }}
      {...rest}
    >
      <span aria-hidden="true" className="kpbl-switch-thumb" />
    </button>
  );

  if (!label) {
    return buttonNode;
  }

  return (
    <span className="kpbl-switch-wrap">
      {buttonNode}
      <label id={labelId} htmlFor={buttonId} className="kpbl-field-label">
        {label}
      </label>
    </span>
  );
}
