import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Kbd } from './badges.js';
import { Icon, type IconName } from './icon.js';

/** 锚定浮层首选展开方位；触碰视口边缘时自动向反方向翻转。 */
export type PopoverPlacement = 'bottom-start' | 'bottom-end' | 'top-start' | 'top-end';

/** 视口边缘翻转纯几何计算输入矩形。 */
export interface PopoverRect {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

/**
 * 计算锚定弹层的视口安全坐标与翻转后方位：
 * 当首选方向剩余空间不足且对侧空间更充裕时自动翻转，供不支持 CSS Anchor 的环境回退及单测断言。
 */
export function computePopoverPosition(
  anchor: PopoverRect,
  floating: { readonly width: number; readonly height: number },
  viewport: { readonly width: number; readonly height: number },
  placement: PopoverPlacement = 'bottom-start',
  offsetPx = 4,
): { readonly top: number; readonly left: number; readonly resolvedPlacement: PopoverPlacement } {
  const pad = 8;
  const preferTop = placement.startsWith('top');
  const preferEnd = placement.endsWith('end');

  const spaceBelow = viewport.height - anchor.bottom - offsetPx - pad;
  const spaceAbove = anchor.top - offsetPx - pad;
  const flipToTop = !preferTop && spaceBelow < floating.height && spaceAbove > spaceBelow;
  const flipToBottom = preferTop && spaceAbove < floating.height && spaceBelow > spaceAbove;
  const finalTopSide = preferTop ? !flipToBottom : flipToTop;

  const rawTop = finalTopSide ? anchor.top - floating.height - offsetPx : anchor.bottom + offsetPx;
  const rawLeft = preferEnd ? anchor.right - floating.width : anchor.left;

  const top = Math.max(
    pad,
    Math.min(rawTop, Math.max(pad, viewport.height - floating.height - pad)),
  );
  const left = Math.max(
    pad,
    Math.min(rawLeft, Math.max(pad, viewport.width - floating.width - pad)),
  );
  const resolvedPlacement: PopoverPlacement = `${finalTopSide ? 'top' : 'bottom'}-${preferEnd ? 'end' : 'start'}`;

  return { top, left, resolvedPlacement };
}

/**
 * `AnchoredPopover` 入参契约（017 §4）：
 * 封装原生 `popover="auto"` 与 `useId()` 显式 `--kpbl-anchor-*` 锚点定位；
 * 纯内容浮层（如任务清单气泡）**绝不滥标 `role="menu"`**，菜单语义仅在 `ActionMenu` 内启用。
 */
export interface AnchoredPopoverProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly trigger: ReactNode;
  readonly children: ReactNode;
  readonly placement?: PopoverPlacement;
  readonly className?: string;
}

/**
 * 锚定非模态浮层原语：优先驱动 Chromium 原生 Top-Layer `showPopover()` / `hidePopover()` 与轻触关闭，
 * 同时监听 `Escape` 与视口翻转回退坐标。
 */
export function AnchoredPopover({
  open,
  onOpenChange,
  trigger,
  children,
  placement = 'bottom-start',
  className,
}: AnchoredPopoverProps) {
  const rawId = useId();
  const safeToken = rawId.replace(/[^a-zA-Z0-9_-]/g, '');
  const anchorName = `--kpbl-anchor-${safeToken}`;
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [fallbackStyle, setFallbackStyle] = useState<CSSProperties | undefined>(undefined);

  useEffect(() => {
    const node = popoverRef.current;
    if (!node) return;

    const handleToggle = (event: Event) => {
      const toggleEvent = event as Event & { newState?: string };
      if (toggleEvent.newState === 'closed') {
        onOpenChange(false);
      }
    };
    node.addEventListener('toggle', handleToggle);

    if (open) {
      if (typeof node.showPopover === 'function' && !node.matches(':popover-open')) {
        try {
          node.showPopover();
        } catch {
          /* 已处于打开态或受限容器时忽略。 */
        }
      }
      if (
        typeof CSS !== 'undefined' &&
        typeof CSS.supports === 'function' &&
        !CSS.supports('anchor-name: --a') &&
        anchorRef.current
      ) {
        const rect = anchorRef.current.getBoundingClientRect();
        const popRect = node.getBoundingClientRect();
        const pos = computePopoverPosition(
          rect,
          { width: popRect.width || 220, height: popRect.height || 180 },
          { width: window.innerWidth, height: window.innerHeight },
          placement,
        );
        setFallbackStyle({ top: `${pos.top}px`, left: `${pos.left}px` });
      }
    } else if (typeof node.hidePopover === 'function') {
      try {
        if (node.matches(':popover-open')) {
          node.hidePopover();
        }
      } catch {
        /* 未挂载至 Top-Layer 时安全跳过。 */
      }
    }

    return () => {
      node.removeEventListener('toggle', handleToggle);
    };
  }, [open, onOpenChange, placement]);

  const anchorCss = { '--kpbl-anchor-name': anchorName } as CSSProperties;
  const popoverCss: CSSProperties = {
    ...anchorCss,
    ...fallbackStyle,
  };

  return (
    <span ref={anchorRef} style={anchorCss} className="kpbl-popover-anchor">
      {trigger}
      {open ? (
        <div
          ref={popoverRef}
          popover="auto"
          data-open="true"
          data-placement={placement}
          style={popoverCss}
          className={className ? `kpbl-popover ${className}` : 'kpbl-popover'}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              event.stopPropagation();
              onOpenChange(false);
              requestAnimationFrame(() => {
                anchorRef.current
                  ?.querySelector<HTMLElement>('button, [tabindex]:not([tabindex="-1"])')
                  ?.focus();
              });
            }
          }}
        >
          {children}
        </div>
      ) : null}
    </span>
  );
}

/** `ActionMenu` 条目联合定义：支持常规/危险动作项与水平分隔线。 */
export type ActionMenuEntry =
  | {
      readonly type?: 'item';
      readonly id: string;
      readonly label: string;
      readonly icon?: IconName;
      readonly shortcut?: string;
      readonly danger?: boolean;
      readonly disabled?: boolean;
      readonly onSelect: () => void;
    }
  | {
      readonly type: 'separator';
      readonly id: string;
    };

/**
 * `ActionMenu` 入参契约：完整实现 WAI-ARIA `role="menu"` / `role="menuitem"` 规范，
 * 支持 `ArrowDown`、`ArrowUp`、`Home`、`End` 及单字符首字母焦点巡航。
 */
export interface ActionMenuProps {
  readonly label: string;
  readonly items: readonly ActionMenuEntry[];
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly placement?: PopoverPlacement;
  readonly renderTrigger: (triggerProps: {
    readonly open: boolean;
    readonly toggle: () => void;
    readonly 'aria-haspopup': 'menu';
    readonly 'aria-expanded': boolean;
  }) => ReactNode;
}

/** 上下文动作菜单原语：用于会话行 `···` 操作、页头更多操作等命令列表。 */
export function ActionMenu({
  label,
  items,
  open: controlledOpen,
  onOpenChange,
  placement = 'bottom-end',
  renderTrigger,
}: ActionMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const isOpen = controlledOpen ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) {
      setUncontrolledOpen(next);
    }
    onOpenChange?.(next);
  };

  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const wasOpenRef = useRef(false);
  const actionableEntries = useMemo(
    () =>
      items
        .map((entry, idx) =>
          entry.type !== 'separator' && !entry.disabled ? { entry, idx } : null,
        )
        .filter((item): item is NonNullable<typeof item> => item !== null),
    [items],
  );

  useEffect(() => {
    if (isOpen && !wasOpenRef.current) {
      const firstIdx = actionableEntries[0]?.idx;
      if (firstIdx !== undefined) {
        itemRefs.current[firstIdx]?.focus();
      }
    }
    wasOpenRef.current = isOpen;
  }, [isOpen, actionableEntries]);

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (actionableEntries.length === 0) return;
    const activeElement = typeof document !== 'undefined' ? document.activeElement : null;
    const currentPos = actionableEntries.findIndex(
      ({ idx }) => itemRefs.current[idx] === activeElement,
    );

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = actionableEntries[(currentPos + 1) % actionableEntries.length];
      if (next) itemRefs.current[next.idx]?.focus();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      const prev =
        actionableEntries[(currentPos - 1 + actionableEntries.length) % actionableEntries.length];
      if (prev) itemRefs.current[prev.idx]?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      const first = actionableEntries[0];
      if (first) itemRefs.current[first.idx]?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      const last = actionableEntries[actionableEntries.length - 1];
      if (last) itemRefs.current[last.idx]?.focus();
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const prefix = event.key.toLowerCase();
      const rotated = [
        ...actionableEntries.slice(currentPos + 1),
        ...actionableEntries.slice(0, currentPos + 1),
      ];
      const matched = rotated.find(({ entry }) => entry.label.toLowerCase().startsWith(prefix));
      if (matched) {
        event.preventDefault();
        itemRefs.current[matched.idx]?.focus();
      }
    }
  };

  return (
    <AnchoredPopover
      open={isOpen}
      onOpenChange={setOpen}
      placement={placement}
      trigger={renderTrigger({
        open: isOpen,
        toggle: () => setOpen(!isOpen),
        'aria-haspopup': 'menu',
        'aria-expanded': isOpen,
      })}
    >
      <div role="menu" aria-label={label} tabIndex={-1} onKeyDown={handleMenuKeyDown}>
        {items.map((entry, index) => {
          if (entry.type === 'separator') {
            return <hr key={entry.id} className="kpbl-menu-sep" />;
          }
          return (
            <button
              key={entry.id}
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              type="button"
              role="menuitem"
              disabled={entry.disabled}
              data-danger={entry.danger ? 'true' : undefined}
              className="kpbl-menu-item"
              onClick={() => {
                if (entry.disabled) return;
                setOpen(false);
                entry.onSelect();
              }}
            >
              <span className="inline-flex min-w-0 items-center gap-2">
                {entry.icon ? <Icon name={entry.icon} size={15} /> : null}
                <span className="truncate">{entry.label}</span>
              </span>
              {entry.shortcut ? <Kbd>{entry.shortcut}</Kbd> : null}
            </button>
          );
        })}
      </div>
    </AnchoredPopover>
  );
}
