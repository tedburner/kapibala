import {
  type AgentActivityKind,
  STATIC_ACTIVITY_FRAME_SEC,
  computeActivityGlyphFrame,
} from './activity-glyph-frames.js';

function fmt(value: number): string {
  return value.toFixed(2);
}

/** 将纯函数算出的帧几何直接写入活跃 SVG DOM 节点，避免 60fps 触发 React 渲染树重算。 */
export function applyActivityGlyphFrame(
  svg: SVGSVGElement,
  kind: AgentActivityKind,
  size: number,
  tSec: number,
): void {
  const frame = computeActivityGlyphFrame(kind, size, tSec);

  if (kind === 'thinking' && frame.thinking) {
    const f = frame.thinking;
    svg.querySelector('[data-part="inner"]')?.setAttribute('r', fmt(f.innerR));
    const outer = svg.querySelector('[data-part="outer"]');
    outer?.setAttribute('r', fmt(f.outerR));
    outer?.setAttribute('stroke-opacity', fmt(f.outerOpacity));
    const dot = svg.querySelector('[data-part="dot"]');
    dot?.setAttribute('r', fmt(f.dotR));
    dot?.setAttribute('fill-opacity', fmt(f.dotOpacity));
    return;
  }

  if (kind === 'reading' && frame.reading) {
    const f = frame.reading;
    svg.querySelectorAll('[data-part="seg"]').forEach((node, idx) => {
      const active = f.segActive[idx] ?? false;
      node.setAttribute('stroke', active ? 'var(--kpbl-pulse)' : 'var(--kpbl-ink-faint)');
      node.setAttribute('stroke-opacity', fmt(f.segOpacities[idx] ?? 0.45));
    });
    const dot = svg.querySelector('[data-part="dot"]');
    dot?.setAttribute('cx', fmt(f.dotX));
    dot?.setAttribute('cy', fmt(f.dotY));
    return;
  }

  if (kind === 'searching' && frame.searching) {
    const f = frame.searching;
    svg.querySelectorAll('[data-part="grid-dot"]').forEach((node, idx) => {
      const d = f.dots[idx];
      if (!d) return;
      node.setAttribute('r', fmt(d.r));
      node.setAttribute('fill', d.active ? 'var(--kpbl-pulse)' : 'var(--kpbl-ink-faint)');
      node.setAttribute('fill-opacity', fmt(d.opacity));
    });
    const reticle = svg.querySelector('[data-part="reticle"]');
    reticle?.setAttribute('cx', fmt(f.reticleX));
    reticle?.setAttribute('cy', fmt(f.reticleY));
    return;
  }

  if (kind === 'writing' && frame.writing) {
    const f = frame.writing;
    svg.querySelectorAll('[data-part="fg-line"]').forEach((node, idx) => {
      node.setAttribute('x2', fmt(f.lineEnds[idx] ?? 6));
      node.setAttribute('stroke-opacity', f.lineVisible[idx] ? '0.92' : '0');
    });
    const caret = svg.querySelector('[data-part="caret"]');
    caret?.setAttribute('x1', fmt(f.caretX));
    caret?.setAttribute('x2', fmt(f.caretX));
    caret?.setAttribute('y1', fmt(f.caretY1));
    caret?.setAttribute('y2', fmt(f.caretY2));
    caret?.setAttribute('stroke-opacity', fmt(f.caretOpacity));
    return;
  }

  if (kind === 'checking' && frame.checking) {
    const f = frame.checking;
    const arc = svg.querySelector('[data-part="arc"]');
    arc?.setAttribute('stroke-dashoffset', fmt(f.arcDashOffset));
    arc?.setAttribute('stroke-opacity', f.arcVisible ? fmt(f.arcOpacity) : '0');
    arc?.setAttribute('transform', `rotate(${f.arcRotateDeg.toFixed(1)} 16 16)`);
    const check = svg.querySelector('[data-part="check"]');
    check?.setAttribute('stroke-dashoffset', fmt(f.checkDashOffset));
    check?.setAttribute('stroke-opacity', f.checkVisible ? fmt(f.checkOpacity) : '0');
    return;
  }

  if (kind === 'sending' && frame.sending) {
    const f = frame.sending;
    const left = svg.querySelector('[data-part="left"]');
    left?.setAttribute('stroke', f.leftActive ? 'var(--kpbl-pulse)' : 'var(--kpbl-ink-faint)');
    left?.setAttribute('stroke-opacity', fmt(f.leftOpacity));
    const right = svg.querySelector('[data-part="right"]');
    right?.setAttribute('stroke', f.rightActive ? 'var(--kpbl-pulse)' : 'var(--kpbl-ink-faint)');
    right?.setAttribute('stroke-opacity', fmt(f.rightOpacity));
    svg.querySelector('[data-part="dot"]')?.setAttribute('cx', fmt(f.dotX));
    return;
  }

  if (kind === 'on_hold' && frame.onHold) {
    const f = frame.onHold;
    svg.querySelector('[data-part="ring"]')?.setAttribute('stroke-opacity', fmt(f.ringOpacity));
    svg.querySelector('[data-part="dot"]')?.setAttribute('fill-opacity', fmt(f.dotOpacity));
    svg.querySelectorAll('[data-part="signal-arc"]').forEach((node, idx) => {
      node.setAttribute('stroke-opacity', fmt(f.arcOpacities[idx] ?? 0.2));
    });
    return;
  }

  if (kind === 'waiting' && frame.waiting) {
    const f = frame.waiting;
    svg
      .querySelector('[data-part="tail"]')
      ?.setAttribute('transform', `rotate(${f.tailRotateDeg.toFixed(1)} 16 16)`);
    const dot = svg.querySelector('[data-part="dot"]');
    dot?.setAttribute('cx', fmt(f.dotX));
    dot?.setAttribute('cy', fmt(f.dotY));
  }
}

type FrameListener = (tSec: number) => void;

const listeners = new Set<FrameListener>();
let rafHandle: number | undefined;
let elapsedSec = STATIC_ACTIVITY_FRAME_SEC;
let lastFrameTs: number | undefined;
let envListenersBound = false;

function isReducedMotionEnabled(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden;
}

function stopSharedClock(): void {
  if (rafHandle !== undefined && typeof window !== 'undefined') {
    window.cancelAnimationFrame(rafHandle);
  }
  rafHandle = undefined;
  lastFrameTs = undefined;
}

function tickSharedClock(ts: number): void {
  rafHandle = undefined;
  if (listeners.size === 0 || isDocumentHidden() || isReducedMotionEnabled()) {
    lastFrameTs = undefined;
    return;
  }
  if (lastFrameTs !== undefined) {
    elapsedSec += Math.min(0.05, Math.max(0, (ts - lastFrameTs) / 1000));
  }
  lastFrameTs = ts;
  for (const fn of listeners) {
    fn(elapsedSec);
  }
  rafHandle = window.requestAnimationFrame(tickSharedClock);
}

function ensureSharedClockRunning(): void {
  if (
    rafHandle !== undefined ||
    listeners.size === 0 ||
    typeof window === 'undefined' ||
    typeof window.requestAnimationFrame !== 'function' ||
    isDocumentHidden() ||
    isReducedMotionEnabled()
  ) {
    return;
  }
  lastFrameTs = undefined;
  rafHandle = window.requestAnimationFrame(tickSharedClock);
}

function bindEnvironmentListeners(): void {
  if (envListenersBound || typeof window === 'undefined' || typeof document === 'undefined') return;
  envListenersBound = true;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopSharedClock();
    } else {
      ensureSharedClockRunning();
    }
  });
  if (typeof window.matchMedia === 'function') {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleMotionChange = () => {
      if (mq.matches) {
        stopSharedClock();
        for (const fn of listeners) fn(STATIC_ACTIVITY_FRAME_SEC);
      } else {
        ensureSharedClockRunning();
      }
    };
    mq.addEventListener?.('change', handleMotionChange);
  }
}

/**
 * 订阅全局共享单时钟：
 * - 仅当存在至少一个活跃微动效且窗口可见、未开启减弱动态时启动唯一 `rAF`；
 * - 最后一个订阅者注销时立即停止循环，保证空闲期零 CPU 占用。
 */
export function subscribeActivityClock(listener: FrameListener): () => void {
  if (typeof window === 'undefined') return () => {};
  bindEnvironmentListeners();
  listeners.add(listener);
  if (isReducedMotionEnabled()) {
    listener(STATIC_ACTIVITY_FRAME_SEC);
  } else {
    ensureSharedClockRunning();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      stopSharedClock();
    }
  };
}

/** 仅供单测断言活跃订阅数与空闲自动停帧行为。 */
export function getActiveActivityClockSubscriberCount(): number {
  return listeners.size;
}
