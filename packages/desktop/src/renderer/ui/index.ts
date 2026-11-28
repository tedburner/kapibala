/**
 * Kapibala UI 2.0 零外部样式库原语层唯一公共入口（017 §4）。
 * 采用显式命名重导出清单（禁用 `export *`），供 `surfaces/*` 业务面统一消费。
 */
export {
  Badge,
  type BadgeProps,
  type BadgeTone,
  HarnessBadge,
  type HarnessBadgeProps,
  Kbd,
  type KbdProps,
  STATUS_DOT_LABELS,
  StatusDot,
  type StatusDotProps,
  type StatusDotState,
} from './badges.js';
export {
  Button,
  type ButtonProps,
  type ButtonSize,
  type ButtonVariant,
  IconButton,
  type IconButtonProps,
} from './button.js';
export {
  type DialogClosedBy,
  ModalDialog,
  type ModalDialogProps,
} from './dialog.js';
export {
  SearchField,
  type SearchFieldProps,
  SecretField,
  type SecretFieldProps,
  TextArea,
  type TextAreaProps,
  TextField,
  type TextFieldProps,
} from './fields.js';
export {
  BrandMark,
  type BrandMarkProps,
  ICON_REGISTRY,
  Icon,
  type IconName,
  type IconProps,
} from './icon.js';
export {
  ActionMenu,
  type ActionMenuEntry,
  type ActionMenuProps,
  AnchoredPopover,
  type AnchoredPopoverProps,
  computePopoverPosition,
  type PopoverPlacement,
  type PopoverRect,
} from './popover.js';
export {
  Segmented,
  type SegmentedOption,
  type SegmentedProps,
} from './segmented.js';
export {
  Combobox,
  type ComboboxProps,
  Select,
  type SelectOption,
  type SelectProps,
} from './select.js';
export {
  EmptyState,
  type EmptyStateProps,
  SettingRow,
  type SettingRowProps,
  SettingSection,
  type SettingSectionProps,
} from './settings-kit.js';
export {
  clampSplitRatio,
  SPLIT_DEFAULT_RATIO,
  SPLIT_LEFT_MIN_PX,
  SPLIT_RIGHT_MAX_RATIO,
  SPLIT_RIGHT_MIN_PX,
  SplitPane,
  type SplitPaneProps,
} from './split-pane.js';
export {
  Switch,
  type SwitchProps,
} from './switch.js';
export {
  appendToast,
  DEFAULT_TOAST_DURATION_MS,
  dismissToast,
  ERROR_TOAST_DURATION_MS,
  type ToastItem,
  type ToastLevel,
  ToastViewport,
  type ToastViewportProps,
  useToastQueue,
} from './toast.js';
export {
  MiddleTruncate,
  type MiddleTruncateParts,
  type MiddleTruncateProps,
  truncateMiddle,
} from './truncate.js';
