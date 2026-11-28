import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from 'react';
import { IconButton } from './button.js';

/** 原生 `<dialog>` 关闭触发策略：对齐 Chromium `closedby` 属性语义。 */
export type DialogClosedBy = 'any' | 'closerequest' | 'none';

/**
 * `ModalDialog` 入参契约（017 §0 铁律 3 & §4）：
 * - 严格封装原生 `<dialog>` + `showModal()`，**禁止手动附加冗余 `role="dialog"` / `aria-modal`**；
 * - 破坏性操作确认框可通过 `initialFocusRef` 将初始焦点锁定在「取消」安全按钮，防误触回车；
 * - 全应用模态 `<dialog>` 仅限破坏性确认、目录信任授权、`⌘K` 命令面板及设置页单层新建/编辑子表单。
 */
export interface ModalDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly footer?: ReactNode;
  readonly children?: ReactNode;
  readonly closedBy?: DialogClosedBy;
  readonly width?: 'md' | 'lg';
  readonly hideCloseButton?: boolean;
  readonly closeLabel?: string;
  readonly initialFocusRef?: RefObject<HTMLElement | null>;
  readonly className?: string;
}

/**
 * 原生顶层模态框原语：客户端经 `showModal()` 接管焦点陷阱与 Inert 背景，
 * 服务端静态渲染（SSR 单测）回退输出 `open` 属性以支持无 DOM 环境结构断言。
 */
export function ModalDialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  children,
  closedBy = 'closerequest',
  width = 'md',
  hideCloseButton = false,
  closeLabel = '关闭对话框',
  initialFocusRef,
  className,
}: ModalDialogProps) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const baseId = useId();
  const titleId = `${baseId}-title`;
  const descId = description ? `${baseId}-desc` : undefined;
  const isServer = typeof document === 'undefined';

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open) {
      if (!dialog.open && typeof dialog.showModal === 'function') {
        dialog.showModal();
      }
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
      }
    } else if (dialog.open && typeof dialog.close === 'function') {
      dialog.close();
    }

    return () => {
      if (dialog.open && typeof dialog.close === 'function') {
        dialog.close();
      }
    };
  }, [open, initialFocusRef]);

  if (!open) {
    return null;
  }

  const handleBackdropClick = (event: MouseEvent<HTMLDialogElement>) => {
    if (closedBy !== 'any') return;
    if (event.target === dialogRef.current) {
      onOpenChange(false);
    }
  };

  const dismissNestedOpenPopover = (): boolean => {
    const dialog = dialogRef.current;
    if (!dialog) return false;
    let openPopover: (HTMLElement & { hidePopover?: () => void }) | null = null;
    try {
      openPopover = dialog.querySelector<HTMLElement>('[popover]:popover-open');
    } catch {
      openPopover = null;
    }
    if (!openPopover) {
      openPopover = dialog.querySelector<HTMLElement>('[popover][data-open="true"]');
    }
    if (!openPopover) return false;
    if (typeof openPopover.hidePopover === 'function') {
      try {
        openPopover.hidePopover();
      } catch {
        /* 非 Top-Layer 回退环境忽略。 */
      }
    }
    return true;
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key === 'Escape') {
      if (event.defaultPrevented || dismissNestedOpenPopover()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }
      event.preventDefault();
      if (closedBy !== 'none') {
        onOpenChange(false);
      }
    }
  };

  const closedByAttr: Record<string, string> = { closedby: closedBy };

  return (
    <dialog
      ref={dialogRef}
      open={isServer ? open || undefined : undefined}
      aria-labelledby={titleId}
      aria-describedby={descId}
      data-width={width}
      className={className ? `kpbl-dialog ${className}` : 'kpbl-dialog'}
      onCancel={(event) => {
        if (event.defaultPrevented || dismissNestedOpenPopover() || closedBy === 'none') {
          event.preventDefault();
          return;
        }
        onOpenChange(false);
      }}
      onClose={() => {
        if (open) {
          onOpenChange(false);
        }
      }}
      onClick={handleBackdropClick}
      onKeyDown={handleKeyDown}
      {...closedByAttr}
    >
      <div className="kpbl-dialog-header">
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="kpbl-dialog-title">
            {title}
          </h2>
          {description ? (
            <p id={descId} className="kpbl-dialog-desc">
              {description}
            </p>
          ) : null}
        </div>
        {!hideCloseButton && closedBy !== 'none' ? (
          <IconButton
            size="sm"
            icon="x"
            aria-label={closeLabel}
            onClick={() => onOpenChange(false)}
          />
        ) : null}
      </div>
      {children ? <div className="kpbl-dialog-body">{children}</div> : null}
      {footer ? <div className="kpbl-dialog-footer">{footer}</div> : null}
    </dialog>
  );
}
