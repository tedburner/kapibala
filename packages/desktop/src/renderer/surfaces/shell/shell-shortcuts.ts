import type { UnifiedApprovalItem } from '../../adapters/index.js';

/** 四视口响应式布局档位（017 §2.2：`>=1280` 标准、`1024..1279` 紧凑、`800..1023` 最小门禁）。 */
export type ShellViewportTier = 'standard' | 'compact' | 'minimal';

/** 根据窗口像素宽度计算当前响应式布局档位。 */
export function resolveViewportTier(width: number): ShellViewportTier {
  if (width >= 1280) return 'standard';
  if (width >= 1024) return 'compact';
  return 'minimal';
}

/** 全局键盘事件最小结构，便于在无浏览器 DOM 的 Node 测试中直接验证快捷键分发。 */
export interface ShortcutKeyEventLike {
  readonly key: string;
  readonly metaKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
  readonly defaultPrevented?: boolean;
  readonly isEditableTarget?: boolean;
  readonly hasOpenNativeModalOrPopover?: boolean;
  preventDefault?: () => void;
}

/** `dispatchAppShellShortcut` 所需的上下文回调集合。 */
export interface ShortcutDispatchContext {
  readonly viewportWidth: number;
  readonly activeSurface: 'workspace' | 'settings';
  readonly activeSessionKey: string | null;
  readonly topApproval?: UnifiedApprovalItem;
  readonly onToggleCommandPalette: () => void;
  readonly onToggleSettings: () => void;
  readonly onToggleRail: (viewportWidth: number) => void;
  readonly onToggleWorkbench: (sessionKey: string) => void;
  readonly onNewConversation: () => void;
  readonly onActivateWorkbenchTab: (sessionKey: string, index: number) => void;
  readonly onApprovalShortcut?: (approvalId: string, actionId: string) => void;
  readonly onEscapeLayer: () => boolean;
}

/**
 * 纯函数分发全局键盘快捷键（017 §2.3）：
 * - `⌘/Ctrl + K | , | B | J | N | 1..5`；
 * - 焦点不在可编辑控件且无顶层模态框时，`Y / S / N` 触发当前会话栈顶内联审批单对应动作；
 * - `Esc` 按「Popover/Modal -> 命令面板 -> 窄屏覆盖抽屉/工作台 -> 壳内设置回退会话」顺序逐层收起。
 */
export function dispatchAppShellShortcut(
  event: ShortcutKeyEventLike,
  ctx: ShortcutDispatchContext,
): boolean {
  if (event.defaultPrevented) return false;
  const mod = Boolean(event.metaKey || event.ctrlKey);
  const lower = event.key.toLowerCase();

  if (mod && !event.altKey && !event.shiftKey) {
    if (lower === 'k') {
      event.preventDefault?.();
      ctx.onToggleCommandPalette();
      return true;
    }
    if (event.key === ',') {
      event.preventDefault?.();
      ctx.onToggleSettings();
      return true;
    }
    if (lower === 'b') {
      event.preventDefault?.();
      ctx.onToggleRail(ctx.viewportWidth);
      return true;
    }
    if (lower === 'j') {
      if (ctx.activeSurface === 'workspace' && ctx.activeSessionKey) {
        event.preventDefault?.();
        ctx.onToggleWorkbench(ctx.activeSessionKey);
        return true;
      }
      return false;
    }
    if (lower === 'n') {
      event.preventDefault?.();
      ctx.onNewConversation();
      return true;
    }
    if (event.key >= '1' && event.key <= '5') {
      if (ctx.activeSurface === 'workspace' && ctx.activeSessionKey) {
        event.preventDefault?.();
        ctx.onActivateWorkbenchTab(ctx.activeSessionKey, Number(event.key) - 1);
        return true;
      }
      return false;
    }
  }

  if (
    !mod &&
    !event.altKey &&
    !event.isEditableTarget &&
    !event.hasOpenNativeModalOrPopover &&
    ctx.activeSurface === 'workspace' &&
    ctx.topApproval &&
    ctx.onApprovalShortcut
  ) {
    const hint = event.key.toUpperCase();
    if (hint === 'Y' || hint === 'S' || hint === 'N') {
      const matched = ctx.topApproval.actions.find((act) => act.shortcutHint === hint);
      if (matched) {
        event.preventDefault?.();
        ctx.onApprovalShortcut(ctx.topApproval.id, matched.id);
        return true;
      }
    }
  }

  if (event.key === 'Escape' && !event.hasOpenNativeModalOrPopover) {
    if (ctx.onEscapeLayer()) {
      event.preventDefault?.();
      return true;
    }
  }

  return false;
}

/**
 * 判断事件目标或当前焦点元素是否处于文本输入控件或内置终端容器（`.kpbl-terminal-pane` / `.xterm`）内部：
 * 即使终端 Shell 已退出或 `@xterm/xterm` 仍在懒加载，焦点位于终端面板内时也强制屏蔽单键 `Y / S / N` 审批快捷键防误触。
 */
export function isEditableElement(target: EventTarget | null): boolean {
  const inspectNode = (candidate: EventTarget | null): boolean => {
    if (!candidate || typeof (candidate as HTMLElement).tagName !== 'string') return false;
    const el = candidate as HTMLElement;
    if (typeof el.closest === 'function' && el.closest('.kpbl-terminal-pane, .xterm')) {
      return true;
    }
    const tag = el.tagName.toLowerCase();
    return (
      tag === 'input' ||
      tag === 'textarea' ||
      tag === 'select' ||
      el.isContentEditable ||
      el.getAttribute?.('contenteditable') === 'true'
    );
  };
  if (inspectNode(target)) return true;
  if (
    typeof document !== 'undefined' &&
    document.activeElement &&
    document.activeElement !== target
  ) {
    return inspectNode(document.activeElement);
  }
  return false;
}
