import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react';
import { Icon, type IconName } from './icon.js';

/** 按钮语义视觉层级：`solid` 采用高对比碳素墨色，彻底摒弃蓝色默认主按钮。 */
export type ButtonVariant = 'solid' | 'outline' | 'ghost' | 'danger';

/** 按钮高度档位：严格对应 `tokens.css` 中 `24px / 28px / 32px` 三档控件高度。 */
export type ButtonSize = 'xs' | 'sm' | 'md';

/**
 * `Button` 入参契约：默认锁定 `type="button"` 防止嵌套在 `<form>` 内时意外触发表单原生提交；
 * `loading` 态自动禁用二次点击并同步 `aria-busy`，同时保留原按钮文案供读屏器定位。
 */
export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  readonly type?: 'button' | 'submit' | 'reset';
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  readonly leadingIcon?: IconName;
  readonly trailingIcon?: IconName;
  readonly ref?: Ref<HTMLButtonElement>;
}

/**
 * Kapibala 标准文本按钮原语：提供显式属性过渡与统一 `:focus-visible` 焦点环，
 * 不依赖任何第三方组件库内联变量或 `!important` 覆盖。
 */
export function Button({
  type = 'button',
  variant = 'outline',
  size = 'md',
  loading = false,
  disabled = false,
  leadingIcon,
  trailingIcon,
  className,
  children,
  ref,
  ...rest
}: ButtonProps) {
  const isDisabled = disabled || loading;
  const iconSize = size === 'xs' ? 13 : 15;
  const classes = className ? `kpbl-btn ${className}` : 'kpbl-btn';

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      data-variant={variant}
      data-size={size}
      className={classes}
      {...rest}
    >
      {loading ? (
        <Icon name="spinner" size={iconSize} />
      ) : leadingIcon ? (
        <Icon name={leadingIcon} size={iconSize} />
      ) : null}
      {children}
      {!loading && trailingIcon ? <Icon name={trailingIcon} size={iconSize} /> : null}
    </button>
  );
}

/**
 * `IconButton` 入参契约：**在类型层强制要求必填 `'aria-label': string`**，
 * 编译期直接拦截无名纯图标按钮，守护读屏器可访问性与桌面端 E2E `getByRole('button', { name })` 选择器契约。
 */
export interface IconButtonProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'aria-label' | 'children'> {
  readonly 'aria-label': string;
  readonly type?: 'button' | 'submit' | 'reset';
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly icon?: IconName;
  readonly iconSize?: number;
  readonly loading?: boolean;
  readonly active?: boolean;
  readonly children?: ReactNode;
  readonly ref?: Ref<HTMLButtonElement>;
}

/**
 * 纯图标方形按钮原语：默认 `ghost` + `sm`（`28px`）适配页头与输入坞工具栏，
 * 未显式传入 `title` 时自动复用 `aria-label` 作为悬停原生提示。
 */
export function IconButton({
  type = 'button',
  variant = 'ghost',
  size = 'sm',
  icon,
  iconSize,
  loading = false,
  active = false,
  disabled = false,
  title,
  className,
  children,
  ref,
  ...rest
}: IconButtonProps) {
  const ariaLabel = rest['aria-label'];
  const isDisabled = disabled || loading;
  const resolvedIconSize = iconSize ?? (size === 'xs' ? 14 : 16);
  const classes = className ? `kpbl-icon-btn ${className}` : 'kpbl-icon-btn';

  return (
    <button
      ref={ref}
      type={type}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      title={title ?? ariaLabel}
      data-variant={variant}
      data-size={size}
      data-active={active ? 'true' : undefined}
      className={classes}
      {...rest}
    >
      {loading ? (
        <Icon name="spinner" size={resolvedIconSize} />
      ) : icon ? (
        <Icon name={icon} size={resolvedIconSize} />
      ) : (
        children
      )}
    </button>
  );
}
