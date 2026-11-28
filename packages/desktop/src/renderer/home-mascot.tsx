import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 桌面端首屏动态水豚吉祥物组件入参。
 *
 * 设计取舍：`typing` 仅同步输入坞是否存在非空草稿以切换轻微前倾倾听姿态，
 * 组件内部不订阅全局 Store，确保首屏重绘边界最小化。
 */
export interface KapibalaHomeMascotProps {
  readonly typing: boolean;
}

/**
 * 桌面端新建对话首屏的无底框循环动图吉祥物（对齐 Pi-Desktop 悬浮动态线条风）。
 *
 * 前置约束与边界：
 * - 外层固定为 `aria-hidden="true"` 的装饰性 `<span>` 而非 `<button>`，避免向无障碍树注入冗余按钮破坏桌面 E2E 选择器契约；
 * - 颜色完全委托 `styles/tokens.css` 的 `currentColor` 与 `--kpbl-pulse` 语义令牌，跟随手动明暗切换即时生效；
 * - 内置原生 SVG SMIL 呼吸热气与小橘微摆（零 JS 帧循环），悬停或点击触发一次有界「顶橘子」位移。
 */
export function KapibalaHomeMascot({ typing }: KapibalaHomeMascotProps) {
  const [hopping, setHopping] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerHop = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    setHopping(true);
    timerRef.current = setTimeout(() => {
      setHopping(false);
      timerRef.current = null;
    }, 560);
  }, []);

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
    };
  }, []);

  return (
    <span
      aria-hidden="true"
      className="kapibala-home-mark kapibala-home-mascot"
      data-typing={typing ? 'true' : 'false'}
      data-hop={hopping ? 'true' : 'false'}
      onPointerEnter={triggerHop}
      onPointerDown={triggerHop}
    >
      <svg
        aria-hidden="true"
        className="kapibala-mascot-svg"
        viewBox="-20 -48 552 604"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        {/* 袅袅温泉热气丝：双相位原生 SMIL 循环上浮淡出 */}
        <g
          stroke="var(--kpbl-pulse, var(--kapibala-mascot-amber))"
          strokeWidth="14"
          strokeLinecap="round"
        >
          <path
            className="kapibala-mascot-steam kapibala-mascot-steam-1"
            d="M 274 8 Q 262 -12 274 -30"
          >
            <animate
              attributeName="opacity"
              values="0.2;0.82;0.2"
              dur="3.6s"
              repeatCount="indefinite"
            />
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 3;0 -7;0 3"
              dur="3.6s"
              repeatCount="indefinite"
            />
          </path>
          <path
            className="kapibala-mascot-steam kapibala-mascot-steam-2"
            d="M 386 12 Q 398 -8 386 -26"
          >
            <animate
              attributeName="opacity"
              values="0.78;0.18;0.78"
              dur="3.6s"
              repeatCount="indefinite"
            />
            <animateTransform
              attributeName="transform"
              type="translate"
              values="0 -5;0 4;0 -5"
              dur="3.6s"
              repeatCount="indefinite"
            />
          </path>
        </g>

        {/* 水豚琥珀小橘：随呼吸轻缓起伏 */}
        <g className="kapibala-mascot-yuzu">
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 0;0 -6;0 0"
            dur="3.6s"
            repeatCount="indefinite"
          />
          <circle
            cx="330"
            cy="59"
            r="40.5"
            fill="var(--kpbl-pulse, var(--kapibala-mascot-amber))"
          />
        </g>

        {/* 朝右极简墨线水豚本体：与 assets/capybara.svg 单一真源几何完全一致 */}
        <g
          className="kapibala-mascot-body"
          stroke="currentColor"
          strokeWidth="23"
          strokeLinecap="round"
          strokeLinejoin="miter"
          strokeMiterlimit="6"
        >
          <path className="kapibala-mascot-ear" d="M 234 173 A 30 30 0 1 1 256 145" />
          <path
            d="M 278 137
               H 430
               A 51 51 0 0 1 481 188
               V 253
               A 51 51 0 0 1 430 304
               H 377
               A 51 51 0 0 0 326 355
               V 481
               H 150
               A 119 119 0 0 1 31 362
               V 356
               A 146 146 0 0 1 177 210
               H 190
               A 34 34 0 0 0 216 198
               L 252 150
               A 34 34 0 0 1 278 137
               Z"
          />
          <line
            className="kapibala-mascot-eye"
            x1="309"
            y1="185.5"
            x2="351"
            y2="185.5"
            strokeWidth="22"
          />
        </g>

        {/* 心如止水双层微澜 */}
        <g stroke="currentColor" strokeLinecap="round">
          <line
            className="kapibala-mascot-ripple kapibala-mascot-ripple-1"
            x1="76"
            y1="518"
            x2="378"
            y2="518"
            strokeWidth="16"
          >
            <animate
              attributeName="opacity"
              values="0.45;0.85;0.45"
              dur="4.2s"
              repeatCount="indefinite"
            />
          </line>
          <line
            className="kapibala-mascot-ripple kapibala-mascot-ripple-2"
            x1="146"
            y1="544"
            x2="308"
            y2="544"
            strokeWidth="13"
          >
            <animate
              attributeName="opacity"
              values="0.75;0.3;0.75"
              dur="4.2s"
              repeatCount="indefinite"
            />
          </line>
        </g>
      </svg>
    </span>
  );
}
