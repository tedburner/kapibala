import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, IconButton } from './button.js';

/** 轻量通知严重级别：`error` 映射至 `role="alert"` 立即播报，其余映射至 `role="status"`。 */
export type ToastLevel = 'info' | 'success' | 'warning' | 'error';

/** 默认自动收起毫秒数；`error` 级别延长停留时间，显式传 `durationMs: 0` 时常驻直至手动关闭。 */
export const DEFAULT_TOAST_DURATION_MS = 4500;
export const ERROR_TOAST_DURATION_MS = 7000;

/** 单条非模态通知数据结构。 */
export interface ToastItem {
  readonly id: string;
  readonly level?: ToastLevel;
  readonly title: string;
  readonly description?: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly durationMs?: number;
}

/**
 * 纯函数入队：同 `id` 通知原地替换（如后台会话新审批刷新），并裁剪队列上限防止遮挡半屏。
 */
export function appendToast(
  current: readonly ToastItem[],
  incoming: ToastItem,
  maxItems = 5,
): ToastItem[] {
  const filtered = current.filter((item) => item.id !== incoming.id);
  const next = [...filtered, incoming];
  return next.length > maxItems ? next.slice(next.length - maxItems) : next;
}

/** 纯函数出队：按 `id` 移除指定通知。 */
export function dismissToast(current: readonly ToastItem[], id: string): ToastItem[] {
  return current.filter((item) => item.id !== id);
}

/** 轻量本地通知队列 Hook，供顶层壳或独立子视图快速接入。 */
export function useToastQueue(initial: readonly ToastItem[] = []) {
  const [toasts, setToasts] = useState<ToastItem[]>(() => [...initial]);
  const pushToast = useCallback((item: ToastItem) => {
    setToasts((prev) => appendToast(prev, item));
  }, []);
  const removeToast = useCallback((id: string) => {
    setToasts((prev) => dismissToast(prev, id));
  }, []);
  const clearToasts = useCallback(() => {
    setToasts([]);
  }, []);
  return { toasts, pushToast, removeToast, clearToasts } as const;
}

/**
 * `ToastViewport` 入参契约（017 §4）：
 * 右上角非模态通知栈，空白区域 `pointer-events: none` 绝不拦截下方工作台点击；
 * 每条通知按自身 `id` 维护独立定时器，新增或关闭相邻通知不会重置既有通知倒计时。
 */
export interface ToastViewportProps {
  readonly toasts: readonly ToastItem[];
  readonly onDismiss: (id: string) => void;
  readonly label?: string;
}

/** 右上角非模态轻量通知栈原语。 */
export function ToastViewport({ toasts, onDismiss, label = '系统通知' }: ToastViewportProps) {
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  const [pausedIds, setPausedIds] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    const timers = timersRef.current;
    const activeIds = new Set(toasts.map((item) => item.id));

    for (const [id, handle] of timers) {
      if (!activeIds.has(id) || pausedIds.has(id)) {
        clearTimeout(handle);
        timers.delete(id);
      }
    }

    for (const item of toasts) {
      if (timers.has(item.id) || pausedIds.has(item.id)) continue;
      const duration =
        item.durationMs ??
        (item.level === 'error' ? ERROR_TOAST_DURATION_MS : DEFAULT_TOAST_DURATION_MS);
      if (duration <= 0) continue;
      const handle = setTimeout(() => {
        timers.delete(item.id);
        onDismissRef.current(item.id);
      }, duration);
      timers.set(item.id, handle);
    }
  }, [toasts, pausedIds]);

  useEffect(
    () => () => {
      for (const handle of timersRef.current.values()) {
        clearTimeout(handle);
      }
      timersRef.current.clear();
    },
    [],
  );

  if (toasts.length === 0) {
    return null;
  }

  const pauseToast = (id: string, paused: boolean) => {
    setPausedIds((prev) => {
      const next = new Set(prev);
      if (paused) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return next;
    });
  };

  return (
    <section aria-label={label} className="kpbl-toast-viewport">
      {toasts.map((item) => {
        const level = item.level ?? 'info';
        const isError = level === 'error';
        return (
          <div
            key={item.id}
            role={isError ? 'alert' : 'status'}
            aria-live={isError ? 'assertive' : 'polite'}
            data-level={level}
            className="kpbl-toast"
            onPointerEnter={() => pauseToast(item.id, true)}
            onPointerLeave={() => pauseToast(item.id, false)}
            onFocus={() => pauseToast(item.id, true)}
            onBlur={() => pauseToast(item.id, false)}
          >
            <div className="min-w-0 flex-1">
              <div className="kpbl-setting-row-title">{item.title}</div>
              {item.description ? <p className="kpbl-field-hint mt-1">{item.description}</p> : null}
              {item.actionLabel && item.onAction ? (
                <div className="mt-2">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => {
                      item.onAction?.();
                      onDismiss(item.id);
                    }}
                  >
                    {item.actionLabel}
                  </Button>
                </div>
              ) : null}
            </div>
            <IconButton
              size="xs"
              icon="x"
              aria-label={`关闭通知：${item.title}`}
              onClick={() => onDismiss(item.id)}
            />
          </div>
        );
      })}
    </section>
  );
}
