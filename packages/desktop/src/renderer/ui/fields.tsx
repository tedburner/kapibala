import {
  type ChangeEvent,
  type InputHTMLAttributes,
  type ReactNode,
  type Ref,
  type TextareaHTMLAttributes,
  useId,
  useState,
} from 'react';
import { IconButton } from './button.js';
import { Icon } from './icon.js';

/** 表单字段公共装饰与无障碍辅助信息契约。 */
interface FieldChromeProps {
  readonly label?: ReactNode;
  readonly description?: ReactNode;
  readonly error?: ReactNode;
  readonly containerClassName?: string;
}

/**
 * 聚合外部传入的 `aria-describedby` 与组件内部生成的说明/错误节点 ID，
 * 确保无辅助文本时不挂载空串属性。
 */
function mergeDescribedBy(
  external: string | undefined,
  descriptionId: string | undefined,
  errorId: string | undefined,
): string | undefined {
  const parts = [external, descriptionId, errorId].filter(Boolean);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * `TextField` 入参契约：固定 `36px` 单行输入高度（`--kpbl-control-lg`），
 * 自动通过 `useId()` 绑定 `<label htmlFor>`、`aria-describedby` 与 `aria-invalid`。
 */
export interface TextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'>,
    FieldChromeProps {
  readonly mono?: boolean;
  readonly leadingAddon?: ReactNode;
  readonly trailingAddon?: ReactNode;
  readonly onValueChange?: (value: string) => void;
  readonly ref?: Ref<HTMLInputElement>;
}

/**
 * 标准单行文本输入原语：支持前置/后置插槽、等宽字体模式（路径/端点/模型 ID）与内联校验错误反馈。
 */
export function TextField({
  id,
  label,
  description,
  error,
  mono = false,
  leadingAddon,
  trailingAddon,
  disabled = false,
  containerClassName,
  className,
  onChange,
  onValueChange,
  'aria-describedby': ariaDescribedBy,
  ref,
  ...rest
}: TextFieldProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = description ? `${inputId}-desc` : undefined;
  const errId = error ? `${inputId}-err` : undefined;
  const describedBy = mergeDescribedBy(ariaDescribedBy, descId, errId);
  const invalid = Boolean(error) || Boolean(rest['aria-invalid']);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange?.(event);
    onValueChange?.(event.target.value);
  };

  return (
    <div className={containerClassName ? `kpbl-field ${containerClassName}` : 'kpbl-field'}>
      {label ? (
        <label htmlFor={inputId} className="kpbl-field-label">
          {label}
        </label>
      ) : null}
      <div
        className="kpbl-input-shell"
        data-invalid={invalid ? 'true' : undefined}
        data-disabled={disabled ? 'true' : undefined}
      >
        {leadingAddon}
        <input
          ref={ref}
          id={inputId}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          data-mono={mono ? 'true' : undefined}
          className={className ? `kpbl-input ${className}` : 'kpbl-input'}
          onChange={handleChange}
          {...rest}
        />
        {trailingAddon}
      </div>
      {description ? (
        <p id={descId} className="kpbl-field-hint">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errId} role="alert" className="kpbl-field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * `TextArea` 入参契约：多行输入原语，自动关联 `<label>` 与校验提示，可选开启自适应内容高度增长。
 */
export interface TextAreaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement>,
    FieldChromeProps {
  readonly mono?: boolean;
  readonly autoGrow?: boolean;
  readonly onValueChange?: (value: string) => void;
  readonly ref?: Ref<HTMLTextAreaElement>;
}

/**
 * 多行文本域原语：默认保留纵向拖拽调节能力；开启 `autoGrow` 时随输入内容实时重算 `scrollHeight`。
 */
export function TextArea({
  id,
  label,
  description,
  error,
  rows = 3,
  mono = false,
  autoGrow = false,
  disabled = false,
  containerClassName,
  className,
  onChange,
  onValueChange,
  'aria-describedby': ariaDescribedBy,
  ref,
  ...rest
}: TextAreaProps) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = description ? `${inputId}-desc` : undefined;
  const errId = error ? `${inputId}-err` : undefined;
  const describedBy = mergeDescribedBy(ariaDescribedBy, descId, errId);
  const invalid = Boolean(error) || Boolean(rest['aria-invalid']);

  const handleChange = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (autoGrow) {
      const element = event.currentTarget;
      element.style.height = 'auto';
      element.style.height = `${element.scrollHeight}px`;
    }
    onChange?.(event);
    onValueChange?.(event.target.value);
  };

  return (
    <div className={containerClassName ? `kpbl-field ${containerClassName}` : 'kpbl-field'}>
      {label ? (
        <label htmlFor={inputId} className="kpbl-field-label">
          {label}
        </label>
      ) : null}
      <textarea
        ref={ref}
        id={inputId}
        rows={rows}
        disabled={disabled}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        data-invalid={invalid ? 'true' : undefined}
        data-mono={mono ? 'true' : undefined}
        className={className ? `kpbl-textarea ${className}` : 'kpbl-textarea'}
        onChange={handleChange}
        {...rest}
      />
      {description ? (
        <p id={descId} className="kpbl-field-hint">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errId} role="alert" className="kpbl-field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * `SearchField` 入参契约：内置搜索图标与非空一键清空按钮，适配命令面板、文件树及模型检索。
 */
export interface SearchFieldProps extends Omit<TextFieldProps, 'type' | 'leadingAddon'> {
  readonly clearLabel?: string;
  readonly onClear?: () => void;
}

/**
 * 搜索框原语：基于原生 `type="search"`（暴露 `searchbox` 角色），当受控 `value` 非空时展示无障碍清空钮。
 */
export function SearchField({
  value,
  clearLabel = '清空搜索',
  onClear,
  onValueChange,
  trailingAddon,
  ...rest
}: SearchFieldProps) {
  const hasValue = typeof value === 'string' ? value.length > 0 : Boolean(value);
  const canClear = hasValue && Boolean(onClear || onValueChange) && !rest.disabled;

  return (
    <TextField
      type="search"
      value={value}
      onValueChange={onValueChange}
      leadingAddon={<Icon name="magnifying-glass" size={15} />}
      trailingAddon={
        <>
          {canClear ? (
            <IconButton
              size="xs"
              icon="x"
              aria-label={clearLabel}
              onClick={() => {
                onClear?.();
                onValueChange?.('');
              }}
            />
          ) : null}
          {trailingAddon}
        </>
      }
      {...rest}
    />
  );
}

/**
 * `SecretField` 入参契约：专用于服务商 API Key 与凭证输入；
 * `configured = true` 时在空输入态提示已存在密钥，防止将脱敏占位符误回写落盘。
 */
export interface SecretFieldProps extends Omit<TextFieldProps, 'type' | 'mono' | 'trailingAddon'> {
  readonly configured?: boolean;
  readonly configuredPlaceholder?: string;
  readonly showLabel?: string;
  readonly hideLabel?: string;
}

/**
 * 密钥与敏感凭证输入原语：默认掩码隐藏并关闭浏览器自动填充与拼写检查，提供键盘可达的显隐切换按钮。
 */
export function SecretField({
  configured = false,
  configuredPlaceholder = '已配置密钥（留空保持不变）',
  placeholder,
  showLabel = '显示密钥',
  hideLabel = '隐藏密钥',
  disabled = false,
  ...rest
}: SecretFieldProps) {
  const [revealed, setRevealed] = useState(false);
  const resolvedPlaceholder = placeholder ?? (configured ? configuredPlaceholder : undefined);

  return (
    <TextField
      type={revealed ? 'text' : 'password'}
      mono
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
      placeholder={resolvedPlaceholder}
      trailingAddon={
        <IconButton
          size="xs"
          icon={revealed ? 'eye-slash' : 'eye'}
          aria-label={revealed ? hideLabel : showLabel}
          aria-pressed={revealed}
          disabled={disabled}
          onClick={() => setRevealed((prev) => !prev)}
        />
      }
      {...rest}
    />
  );
}
