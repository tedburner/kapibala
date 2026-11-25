import { Button } from '@cloudflare/kumo';
import type {
  ViewTodoItem,
  ViewTodoState,
  ViewTodoStatus,
} from '@kiturone/kapibala-host/view-model';
import { CheckCircleIcon, CircleIcon, CircleNotchIcon, XCircleIcon } from '@phosphor-icons/react';
import { useEffect, useRef, useState } from 'react';

/** 状态的中文无障碍名；任务状态不得只靠颜色表达，每项都带可读文字。 */
const STATUS_LABEL: Record<ViewTodoStatus, string> = {
  completed: '已完成',
  in_progress: '进行中',
  pending: '待办',
  cancelled: '已取消',
};

/** 状态图标；只做视觉强化，语义由 aria-label 承载。 */
function StatusIcon({ status }: { status: ViewTodoStatus }) {
  if (status === 'completed')
    return <CheckCircleIcon aria-hidden="true" size={14} className="shrink-0 text-kumo-brand" />;
  if (status === 'in_progress')
    return <CircleNotchIcon aria-hidden="true" size={14} className="shrink-0 text-kumo-brand" />;
  if (status === 'cancelled')
    return <XCircleIcon aria-hidden="true" size={14} className="shrink-0 text-kumo-warning" />;
  return <CircleIcon aria-hidden="true" size={14} className="shrink-0 text-kumo-subtle" />;
}

/**
 * 输入框上方的任务进度 pill 与只读浮层。
 *
 * 约束与边界：
 * - 清单由模型经 `todo_write` 维护，这里只读展示，不提供增删改；
 * - 无清单时不渲染，避免占位；清单消失时自动收起浮层；
 * - 进度分母为全部条目，分子为 `completed`；多条 `in_progress` 全部保留进行中样式，
 *   第一条作为 pill 的主任务标题，其余折叠为 `+N`；
 * - Esc 关闭浮层、点击外部关闭；开合按钮的 aria-label 固定为「任务清单」，开合状态由
 *   `aria-expanded` 承载：可访问名必须稳定，若随开合态切换会与浮层 region 名互相包含，
 *   e2e 的 `getByRole` 精确名称匹配无法唯一命中。
 */
export function TaskPanel({ todos }: { todos?: ViewTodoState }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const activeItemRef = useRef<HTMLLIElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    activeItemRef.current?.scrollIntoView?.({ block: 'nearest' });
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (!todos || todos.items.length === 0) setOpen(false);
  }, [todos]);

  if (!todos || todos.items.length === 0) return undefined;

  const total = todos.items.length;
  const completed = todos.items.filter((item) => item.status === 'completed').length;
  const active = todos.items.filter((item) => item.status === 'in_progress');
  const firstActiveId = active[0]?.id;
  const suffix = completed === total ? ' · 已完成' : active[0] ? ` · ${active[0].title}` : '';
  const extra = active.length > 1 ? ` +${active.length - 1}` : '';

  return (
    <div
      ref={rootRef}
      className="relative mx-auto flex w-full max-w-[var(--kapibala-content-max)] justify-center"
    >
      {open && (
        <section
          aria-label="任务清单"
          className="absolute inset-x-0 bottom-full z-20 mb-1 max-h-[40vh] overflow-y-auto rounded-lg border border-kumo-line bg-kumo-recessed p-2 shadow-lg"
        >
          <ul className="space-y-1">
            {todos.items.map((item: ViewTodoItem) => (
              <li
                key={item.id}
                ref={item.id === firstActiveId ? activeItemRef : undefined}
                aria-label={`${STATUS_LABEL[item.status]}：${item.title}`}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm"
              >
                <StatusIcon status={item.status} />
                <span
                  className={
                    item.status === 'cancelled'
                      ? 'min-w-0 flex-1 truncate text-kumo-subtle line-through'
                      : 'min-w-0 flex-1 truncate'
                  }
                >
                  {item.title}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Button
        variant="ghost"
        size="sm"
        // 可访问名固定为「任务清单」，不随开合态切换（见组件注释）；状态只由 aria-expanded 表达。
        aria-label="任务清单"
        aria-expanded={open}
        className="flex h-auto max-w-full min-w-0 items-center gap-1.5 rounded-full border border-kumo-line bg-kumo-base px-3 py-1 text-xs text-kumo-subtle"
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
        }}
      >
        <span className="shrink-0 tabular-nums">
          任务 {completed}/{total}
        </span>
        {suffix && <span className="min-w-0 truncate">{suffix}</span>}
        {extra && <span className="shrink-0">{extra}</span>}
      </Button>
    </div>
  );
}
