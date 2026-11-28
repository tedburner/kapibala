import { useEffect, useRef } from 'react';
import { applyActivityGlyphFrame, subscribeActivityClock } from './activity-glyph-clock.js';
import {
  AGENT_ACTIVITY_LABELS,
  type AgentActivityKind,
  CHECKING_RING_CIRCUMFERENCE,
  STATIC_ACTIVITY_FRAME_SEC,
  WAITING_RING_CIRCUMFERENCE,
  computeActivityGlyphFrame,
} from './activity-glyph-frames.js';

/**
 * `AgentActivityGlyph` 入参契约：
 * - 以纯 SVG 墨线轨道（`--kpbl-ink-faint`）+ 水豚琥珀焦点（`--kpbl-pulse`）表达 8 类运行语义；
 * - 默认按 `StatusDot` 同款无障碍策略输出 `.kpbl-sr-only` 状态文本；当相邻节点已含完整可见状态词时可设 `decorative` 防重复朗读。
 */
export interface AgentActivityGlyphProps {
  readonly kind: AgentActivityKind;
  readonly size?: number;
  readonly label?: string;
  readonly showLabel?: boolean;
  readonly decorative?: boolean;
  readonly active?: boolean;
  readonly className?: string;
}

const READING_SEGS: readonly {
  readonly key: string;
  readonly x1: number;
  readonly x2: number;
  readonly y: number;
}[] = [
  { key: 'r0-0', x1: 6, x2: 14, y: 9.5 },
  { key: 'r0-1', x1: 17, x2: 26, y: 9.5 },
  { key: 'r1-0', x1: 6, x2: 18, y: 16 },
  { key: 'r1-1', x1: 21, x2: 26, y: 16 },
  { key: 'r2-0', x1: 6, x2: 12, y: 22.5 },
  { key: 'r2-1', x1: 15, x2: 22, y: 22.5 },
];

const WRITING_TRACKS: readonly {
  readonly key: string;
  readonly y: number;
  readonly x0: number;
  readonly len: number;
}[] = [
  { key: 'w0', y: 11, x0: 6, len: 18 },
  { key: 'w1', y: 16.5, x0: 6, len: 20 },
  { key: 'w2', y: 22, x0: 6, len: 13 },
];

const ON_HOLD_ARC_RADII: readonly number[] = [7.5, 11.2, 14.9];

function buildOnHoldArcPath(radius: number): string {
  const cx = 10.5;
  const x1 = (cx + Math.cos(-0.68) * radius).toFixed(2);
  const y1 = (16 + Math.sin(-0.68) * radius).toFixed(2);
  const x2 = (cx + Math.cos(0.68) * radius).toFixed(2);
  const y2 = (16 + Math.sin(0.68) * radius).toFixed(2);
  return `M ${x1} ${y1} A ${radius} ${radius} 0 0 1 ${x2} ${y2}`;
}

function renderGlyphShapes(kind: AgentActivityKind, size: number) {
  const small = size <= 20;
  const sw = small ? 2.2 : 1.65;
  const frame = computeActivityGlyphFrame(kind, size, STATIC_ACTIVITY_FRAME_SEC);

  if (kind === 'thinking' && frame.thinking) {
    const f = frame.thinking;
    return (
      <>
        <circle
          data-part="inner"
          cx={16}
          cy={16}
          r={f.innerR}
          stroke="var(--kpbl-ink-faint)"
          strokeOpacity={0.45}
          strokeWidth={sw * 0.85}
        />
        <circle
          data-part="outer"
          cx={16}
          cy={16}
          r={f.outerR}
          stroke="var(--kpbl-pulse)"
          strokeOpacity={f.outerOpacity}
          strokeWidth={sw}
        />
        <circle
          data-part="dot"
          cx={16}
          cy={16}
          r={f.dotR}
          fill="var(--kpbl-pulse)"
          fillOpacity={f.dotOpacity}
        />
      </>
    );
  }

  if (kind === 'reading' && frame.reading) {
    const f = frame.reading;
    return (
      <>
        {READING_SEGS.map((seg, idx) => (
          <line
            key={seg.key}
            data-part="seg"
            x1={seg.x1}
            y1={seg.y}
            x2={seg.x2}
            y2={seg.y}
            stroke={f.segActive[idx] ? 'var(--kpbl-pulse)' : 'var(--kpbl-ink-faint)'}
            strokeOpacity={f.segOpacities[idx] ?? 0.45}
            strokeWidth={sw}
          />
        ))}
        <circle
          data-part="dot"
          cx={f.dotX}
          cy={f.dotY}
          r={small ? 2.3 : 1.9}
          fill="var(--kpbl-pulse)"
        />
      </>
    );
  }

  if (kind === 'searching' && frame.searching) {
    const f = frame.searching;
    return (
      <>
        {f.dots.map((d) => (
          <circle
            key={`s-${d.cx.toFixed(1)}-${d.cy.toFixed(1)}`}
            data-part="grid-dot"
            cx={d.cx}
            cy={d.cy}
            r={d.r}
            fill={d.active ? 'var(--kpbl-pulse)' : 'var(--kpbl-ink-faint)'}
            fillOpacity={d.opacity}
          />
        ))}
        <circle
          data-part="reticle"
          cx={f.reticleX}
          cy={f.reticleY}
          r={small ? 3.8 : 4.2}
          stroke="var(--kpbl-pulse)"
          strokeOpacity={0.95}
          strokeWidth={sw * 0.9}
        />
      </>
    );
  }

  if (kind === 'writing' && frame.writing) {
    const f = frame.writing;
    return (
      <>
        {WRITING_TRACKS.map((ln) => (
          <line
            key={`bg-${ln.key}`}
            x1={ln.x0}
            y1={ln.y}
            x2={ln.x0 + ln.len}
            y2={ln.y}
            stroke="var(--kpbl-ink-faint)"
            strokeOpacity={0.38}
            strokeWidth={sw}
          />
        ))}
        {WRITING_TRACKS.map((ln, idx) => (
          <line
            key={`fg-${ln.key}`}
            data-part="fg-line"
            x1={ln.x0}
            y1={ln.y}
            x2={f.lineEnds[idx] ?? ln.x0}
            y2={ln.y}
            stroke="var(--kpbl-pulse)"
            strokeOpacity={f.lineVisible[idx] ? 0.92 : 0}
            strokeWidth={sw}
          />
        ))}
        <line
          data-part="caret"
          x1={f.caretX}
          y1={f.caretY1}
          x2={f.caretX}
          y2={f.caretY2}
          stroke="var(--kpbl-pulse)"
          strokeOpacity={f.caretOpacity}
          strokeWidth={sw}
        />
      </>
    );
  }

  if (kind === 'checking' && frame.checking) {
    const f = frame.checking;
    return (
      <>
        <circle
          cx={16}
          cy={16}
          r={10.5}
          stroke="var(--kpbl-ink-faint)"
          strokeOpacity={0.38}
          strokeWidth={sw}
        />
        <circle
          data-part="arc"
          cx={16}
          cy={16}
          r={10.5}
          stroke="var(--kpbl-pulse)"
          strokeOpacity={f.arcVisible ? f.arcOpacity : 0}
          strokeWidth={sw}
          strokeDasharray={CHECKING_RING_CIRCUMFERENCE.toFixed(2)}
          strokeDashoffset={f.arcDashOffset.toFixed(2)}
          transform={`rotate(${f.arcRotateDeg.toFixed(1)} 16 16)`}
        />
        <path
          data-part="check"
          d="M11.4 16.2 L14.6 19.3 L20.8 12.8"
          stroke="var(--kpbl-pulse)"
          strokeOpacity={f.checkVisible ? f.checkOpacity : 0}
          strokeWidth={sw * 1.05}
          strokeDasharray="14"
          strokeDashoffset={f.checkDashOffset.toFixed(2)}
        />
      </>
    );
  }

  if (kind === 'sending' && frame.sending) {
    const f = frame.sending;
    const nr = small ? 4.4 : 4.6;
    return (
      <>
        <circle
          data-part="left"
          cx={9.5}
          cy={16}
          r={nr}
          stroke={f.leftActive ? 'var(--kpbl-pulse)' : 'var(--kpbl-ink-faint)'}
          strokeOpacity={f.leftOpacity}
          strokeWidth={sw}
        />
        <circle
          data-part="right"
          cx={22.5}
          cy={16}
          r={nr}
          stroke={f.rightActive ? 'var(--kpbl-pulse)' : 'var(--kpbl-ink-faint)'}
          strokeOpacity={f.rightOpacity}
          strokeWidth={sw}
        />
        <circle
          data-part="dot"
          cx={f.dotX}
          cy={16}
          r={small ? 2.1 : 1.85}
          fill="var(--kpbl-pulse)"
        />
      </>
    );
  }

  if (kind === 'on_hold' && frame.onHold) {
    const f = frame.onHold;
    return (
      <>
        <circle
          data-part="ring"
          cx={10.5}
          cy={16}
          r={small ? 3.8 : 4.0}
          stroke="var(--kpbl-pulse)"
          strokeOpacity={f.ringOpacity}
          strokeWidth={sw}
        />
        <circle
          data-part="dot"
          cx={10.5}
          cy={16}
          r={small ? 1.8 : 1.5}
          fill="var(--kpbl-pulse)"
          fillOpacity={f.dotOpacity}
        />
        {ON_HOLD_ARC_RADII.map((r, idx) => (
          <path
            key={r}
            data-part="signal-arc"
            d={buildOnHoldArcPath(r)}
            stroke="var(--kpbl-pulse)"
            strokeOpacity={f.arcOpacities[idx] ?? 0.25}
            strokeWidth={sw * 0.92}
          />
        ))}
      </>
    );
  }

  const w = frame.waiting ?? { tailRotateDeg: -57, dotX: 16, dotY: 5.8 };
  return (
    <>
      <circle
        cx={16}
        cy={16}
        r={10.2}
        stroke="var(--kpbl-ink-faint)"
        strokeOpacity={0.5}
        strokeWidth={sw * 0.9}
      />
      <circle
        data-part="tail"
        cx={16}
        cy={16}
        r={10.2}
        stroke="var(--kpbl-pulse)"
        strokeOpacity={0.45}
        strokeWidth={sw}
        strokeDasharray={`${(WAITING_RING_CIRCUMFERENCE * 0.16).toFixed(2)} ${WAITING_RING_CIRCUMFERENCE.toFixed(2)}`}
        transform={`rotate(${w.tailRotateDeg.toFixed(1)} 16 16)`}
      />
      <circle
        data-part="dot"
        cx={w.dotX}
        cy={w.dotY}
        r={small ? 2.2 : 1.95}
        fill="var(--kpbl-pulse)"
      />
    </>
  );
}

/**
 * 智能体语义化微动效原语（`AgentActivityGlyph`）：
 * 仅在活跃运行态（`active = true`）订阅全局单时钟，空闲与 `prefers-reduced-motion: reduce` 下退化为清晰静态帧。
 */
export function AgentActivityGlyph({
  kind,
  size = 16,
  label,
  showLabel = false,
  decorative = false,
  active = true,
  className,
}: AgentActivityGlyphProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const resolvedLabel = label ?? AGENT_ACTIVITY_LABELS[kind];

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    if (!active) {
      applyActivityGlyphFrame(svg, kind, size, STATIC_ACTIVITY_FRAME_SEC);
      return undefined;
    }
    return subscribeActivityClock((tSec) => {
      applyActivityGlyphFrame(svg, kind, size, tSec);
    });
  }, [active, kind, size]);

  const svgNode = (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      width={size}
      height={size}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-activity={kind}
      className={
        decorative && className ? `kpbl-activity-glyph ${className}` : 'kpbl-activity-glyph'
      }
    >
      {renderGlyphShapes(kind, size)}
    </svg>
  );

  if (decorative) {
    return svgNode;
  }

  return (
    <span
      title={showLabel ? undefined : resolvedLabel}
      className={className ? `kpbl-status ${className}` : 'kpbl-status'}
    >
      {svgNode}
      {showLabel ? (
        <span>{resolvedLabel}</span>
      ) : (
        <span className="kpbl-sr-only">{resolvedLabel}</span>
      )}
    </span>
  );
}
