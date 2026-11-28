import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useRef,
  useState,
} from 'react';

/** 右侧多标签工作台默认宽度占比（45%，双击分隔条复位至此值，见 017 §2.2）。 */
export const SPLIT_DEFAULT_RATIO = 0.45;

/** 展开右侧工作台时，左侧对话列最小保留像素宽度（017 §2.1 & §2.2）。 */
export const SPLIT_LEFT_MIN_PX = 420;

/** 展开右侧工作台时，右侧工作台最小像素宽度（017 §2.2）。 */
export const SPLIT_RIGHT_MIN_PX = 360;

/** 展开右侧工作台时，右侧工作台最大宽度占比（60%，见 017 §2.2）。 */
export const SPLIT_RIGHT_MAX_RATIO = 0.6;

/**
 * 计算受左栏最小像素、右栏最小像素与最大占比三重约束夹逼后的右侧面板宽度比例：
 * - 非法数值（`NaN` / `Infinity`）安全回退至 `SPLIT_DEFAULT_RATIO`；
 * - 未测量到容器宽度（如 SSR 或首帧前）时按 `[0.25, rightMaxRatio]` 保底夹逼。
 */
export function clampSplitRatio(
  ratio: number,
  containerWidth?: number,
  leftMinPx = SPLIT_LEFT_MIN_PX,
  rightMinPx = SPLIT_RIGHT_MIN_PX,
  rightMaxRatio = SPLIT_RIGHT_MAX_RATIO,
): number {
  const candidate = Number.isFinite(ratio) ? ratio : SPLIT_DEFAULT_RATIO;
  if (!containerWidth || containerWidth <= 0) {
    return Math.min(rightMaxRatio, Math.max(0.25, candidate));
  }
  const minByRight = rightMinPx / containerWidth;
  const maxByLeft = (containerWidth - leftMinPx) / containerWidth;
  const effectiveMax = Math.min(rightMaxRatio, Math.max(minByRight, maxByLeft));
  const effectiveMin = Math.min(minByRight, effectiveMax);
  return Math.min(effectiveMax, Math.max(effectiveMin, candidate));
}

/**
 * `SplitPane` 入参契约（017 §0 铁律 1 & §4）：
 * - `rightOpen = false` 时退化为无干扰单画布阅读态，不挂载分隔条与右侧 DOM；
 * - `rightOpen = true` 时挂载 `setPointerCapture` 指针拖拽分隔条，支持键盘左右方向键微调与双击复位。
 */
export interface SplitPaneProps {
  readonly left: ReactNode;
  readonly right?: ReactNode;
  readonly rightOpen: boolean;
  readonly ratio?: number;
  readonly onRatioChange?: (nextRatio: number) => void;
  readonly defaultRatio?: number;
  readonly leftMinPx?: number;
  readonly rightMinPx?: number;
  readonly rightMaxRatio?: number;
  readonly separatorLabel?: string;
  readonly className?: string;
}

/**
 * 主舞台自适应水平分栏容器：同时满足鼠标拖拽、`role="separator"` 键盘无障碍调整与窄屏覆盖回退。
 */
export function SplitPane({
  left,
  right,
  rightOpen,
  ratio = SPLIT_DEFAULT_RATIO,
  onRatioChange,
  defaultRatio = SPLIT_DEFAULT_RATIO,
  leftMinPx = SPLIT_LEFT_MIN_PX,
  rightMinPx = SPLIT_RIGHT_MIN_PX,
  rightMaxRatio = SPLIT_RIGHT_MAX_RATIO,
  separatorLabel = '调整工作台面板宽度',
  className,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [dragging, setDragging] = useState(false);

  const containerWidth = containerRef.current?.clientWidth;
  const clamped = clampSplitRatio(ratio, containerWidth, leftMinPx, rightMinPx, rightMaxRatio);
  const minRatio = clampSplitRatio(0, containerWidth, leftMinPx, rightMinPx, rightMaxRatio);
  const maxRatio = clampSplitRatio(1, containerWidth, leftMinPx, rightMinPx, rightMaxRatio);

  const commitRatio = (rawNext: number) => {
    const width = containerRef.current?.clientWidth;
    const next = clampSplitRatio(rawNext, width, leftMinPx, rightMinPx, rightMaxRatio);
    onRatioChange?.(Number(next.toFixed(4)));
  };

  const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width <= 0) return;
    const rightWidth = rect.right - event.clientX;
    commitRatio(rightWidth / rect.width);
  };

  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  const handleSeparatorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 0.05 : 0.02;
    if (event.key === 'ArrowLeft') {
      /* 分隔条向左移动 = 扩大右侧工作台占比。 */
      event.preventDefault();
      commitRatio(clamped + step);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      commitRatio(clamped - step);
    } else if (event.key === 'Home') {
      event.preventDefault();
      commitRatio(minRatio);
    } else if (event.key === 'End') {
      event.preventDefault();
      commitRatio(maxRatio);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      commitRatio(defaultRatio);
    }
  };

  const showRight = rightOpen && Boolean(right);
  const rightStyle = {
    '--kpbl-split-right-width': `${(clamped * 100).toFixed(2)}%`,
  } as CSSProperties;

  return (
    <div
      ref={containerRef}
      data-open={showRight ? 'true' : 'false'}
      className={className ? `kpbl-split-pane ${className}` : 'kpbl-split-pane'}
    >
      <div className="kpbl-split-left">{left}</div>
      {showRight ? (
        <>
          <div
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={separatorLabel}
            aria-valuenow={Math.round(clamped * 100)}
            aria-valuemin={Math.round(minRatio * 100)}
            aria-valuemax={Math.round(maxRatio * 100)}
            data-dragging={dragging ? 'true' : undefined}
            className="kpbl-split-separator"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={stopDragging}
            onPointerCancel={stopDragging}
            onDoubleClick={() => commitRatio(defaultRatio)}
            onKeyDown={handleSeparatorKeyDown}
          />
          <div style={rightStyle} className="kpbl-split-right">
            {right}
          </div>
        </>
      ) : null}
    </div>
  );
}
