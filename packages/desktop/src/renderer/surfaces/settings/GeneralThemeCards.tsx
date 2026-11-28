import { type KeyboardEvent, useRef } from 'react';
import type { ThemeMode } from '../../stores/index.js';

/**
 * `GeneralThemeCards` 入参契约（017 §6.7）：
 * 对标 T3 Code「配色模式」三列微缩窗口预览选择卡，纯 SVG 绑定 `--kpbl-preview-*` 语义令牌渲染，
 * 严守零硬编码色值与完整 `radiogroup` 键盘左右方向键巡航契约。
 */
export interface GeneralThemeCardsProps {
  readonly value: ThemeMode;
  readonly groupLabel: string;
  readonly systemLabel: string;
  readonly lightLabel: string;
  readonly darkLabel: string;
  readonly onChange: (next: ThemeMode) => void;
}

const MODES: readonly ThemeMode[] = ['system', 'light', 'dark'];

function WindowMiniature({ variant }: { readonly variant: ThemeMode }) {
  if (variant === 'system') {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 180 96"
        className="kpbl-theme-card-preview"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* 左半宣石暖纸（Light） */}
        <g>
          <rect x="0" y="0" width="90" height="96" fill="var(--kpbl-preview-light-canvas)" />
          <rect x="0" y="0" width="38" height="96" fill="var(--kpbl-preview-light-rail)" />
          <rect x="6" y="10" width="24" height="6" rx="3" fill="var(--kpbl-preview-light-bubble)" />
          <rect
            x="6"
            y="24"
            width="26"
            height="5"
            rx="2.5"
            fill="var(--kpbl-preview-light-bubble)"
          />
          <rect
            x="6"
            y="34"
            width="22"
            height="5"
            rx="2.5"
            fill="var(--kpbl-preview-light-bubble)"
          />
          <rect
            x="46"
            y="18"
            width="38"
            height="8"
            rx="4"
            fill="var(--kpbl-preview-light-bubble)"
          />
          <rect
            x="46"
            y="32"
            width="44"
            height="5"
            rx="2.5"
            fill="var(--kpbl-preview-light-ink)"
            fillOpacity="0.22"
          />
          <rect
            x="46"
            y="41"
            width="34"
            height="5"
            rx="2.5"
            fill="var(--kpbl-preview-light-ink)"
            fillOpacity="0.16"
          />
          <rect
            x="46"
            y="70"
            width="44"
            height="16"
            rx="5"
            fill="var(--kpbl-preview-light-bubble)"
          />
        </g>
        {/* 右半曜石墨（Dark） */}
        <g>
          <rect x="90" y="0" width="90" height="96" fill="var(--kpbl-preview-dark-canvas)" />
          <rect
            x="96"
            y="16"
            width="42"
            height="9"
            rx="4.5"
            fill="var(--kpbl-preview-dark-bubble)"
          />
          <rect x="142" y="14" width="30" height="36" rx="5" fill="var(--kpbl-preview-dark-rail)" />
          <circle cx="149" cy="23" r="2" fill="var(--kpbl-pulse)" />
          <rect
            x="154"
            y="21"
            width="13"
            height="4"
            rx="2"
            fill="var(--kpbl-preview-dark-ink)"
            fillOpacity="0.3"
          />
          <rect
            x="96"
            y="34"
            width="38"
            height="5"
            rx="2.5"
            fill="var(--kpbl-preview-dark-ink)"
            fillOpacity="0.24"
          />
          <rect
            x="90"
            y="70"
            width="82"
            height="16"
            rx="5"
            fill="var(--kpbl-preview-dark-bubble)"
          />
          <circle cx="163" cy="78" r="4.5" fill="var(--kpbl-pulse)" />
        </g>
      </svg>
    );
  }

  const isDark = variant === 'dark';
  const rail = isDark ? 'var(--kpbl-preview-dark-rail)' : 'var(--kpbl-preview-light-rail)';
  const canvas = isDark ? 'var(--kpbl-preview-dark-canvas)' : 'var(--kpbl-preview-light-canvas)';
  const bubble = isDark ? 'var(--kpbl-preview-dark-bubble)' : 'var(--kpbl-preview-light-bubble)';
  const ink = isDark ? 'var(--kpbl-preview-dark-ink)' : 'var(--kpbl-preview-light-ink)';

  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 180 96"
      className="kpbl-theme-card-preview"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect x="0" y="0" width="180" height="96" fill={canvas} />
      <rect x="0" y="0" width="40" height="96" fill={rail} />
      <rect x="7" y="10" width="26" height="6" rx="3" fill={bubble} />
      <rect x="7" y="24" width="26" height="5" rx="2.5" fill={bubble} />
      <rect x="7" y="34" width="20" height="5" rx="2.5" fill={bubble} />
      <rect x="94" y="14" width="40" height="9" rx="4.5" fill={bubble} />
      <rect x="48" y="30" width="58" height="5" rx="2.5" fill={ink} fillOpacity="0.22" />
      <rect x="48" y="40" width="44" height="5" rx="2.5" fill={ink} fillOpacity="0.15" />
      <rect x="138" y="14" width="34" height="38" rx="5" fill={rail} />
      <circle cx="145" cy="24" r="2" fill="var(--kpbl-pulse)" />
      <rect x="150" y="22" width="16" height="4" rx="2" fill={ink} fillOpacity="0.28" />
      <rect x="145" y="32" width="21" height="4" rx="2" fill={ink} fillOpacity="0.18" />
      <rect x="48" y="70" width="124" height="16" rx="5" fill={bubble} />
      <circle cx="163" cy="78" r="4.5" fill="var(--kpbl-pulse)" />
    </svg>
  );
}

/**
 * T3 Code 风格三列微缩窗口配色模式单选卡组。
 */
export function GeneralThemeCards({
  value,
  groupLabel,
  systemLabel,
  lightLabel,
  darkLabel,
  onChange,
}: GeneralThemeCardsProps) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const labels: Readonly<Record<ThemeMode, string>> = {
    system: systemLabel,
    light: lightLabel,
    dark: darkLabel,
  };

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const idx = Math.max(0, MODES.indexOf(value));
    let nextIdx = -1;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIdx = (idx + 1) % MODES.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIdx = (idx - 1 + MODES.length) % MODES.length;
    }
    if (nextIdx >= 0) {
      event.preventDefault();
      const target = MODES[nextIdx];
      if (target) {
        refs.current[nextIdx]?.focus();
        onChange(target);
      }
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={groupLabel}
      className="kpbl-theme-cards"
      onKeyDown={handleKeyDown}
    >
      {MODES.map((mode, idx) => {
        const checked = value === mode;
        return (
          <button
            key={mode}
            ref={(el) => {
              refs.current[idx] = el;
            }}
            type="button"
            // biome-ignore lint/a11y/useSemanticElements: T3 Code 风格微缩窗口预览选择卡采用 button + role="radio" 搭配 radiogroup 方向键焦点管理，与 SegmentedControl 原语保持一致。
            role="radio"
            aria-checked={checked}
            aria-label={labels[mode]}
            tabIndex={checked ? 0 : -1}
            className="kpbl-theme-card"
            onClick={() => onChange(mode)}
          >
            <WindowMiniature variant={mode} />
            <span className="kpbl-theme-card-label">{labels[mode]}</span>
          </button>
        );
      })}
    </div>
  );
}
