// Kubai Icons React 包装层：把引擎实例接进组件树。
// 悬停动画绑定在最近的按钮类祖先上（图标只有 20px，绑定自身会漏掉大部分悬停区域）。
// 卸载时取消在途 rAF 并清空宿主，避免对已卸载 DOM 的写入。
import { useEffect, useRef } from 'react';
import { ICONS, go, mountIcon } from './icons.js';

export function KubaiIcon({ name, size = 20 }: { name: string; size?: number }) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    const host = ref.current;
    const icon = ICONS.find((entry) => entry.name === name);
    if (!host || !icon) return;
    const inst = mountIcon(icon, ICONS.indexOf(icon), host);
    const svg = host.querySelector('svg');
    svg?.setAttribute('width', String(size));
    svg?.setAttribute('height', String(size));
    const surface = host.closest('button, a, [role="button"]') ?? host;
    const enter = () => {
      inst.hover++;
      go(inst);
    };
    const leave = () => {
      inst.hover = Math.max(0, inst.hover - 1);
      go(inst);
    };
    surface.addEventListener('pointerenter', enter);
    surface.addEventListener('pointerleave', leave);
    return () => {
      surface.removeEventListener('pointerenter', enter);
      surface.removeEventListener('pointerleave', leave);
      cancelAnimationFrame(inst.raf);
      host.innerHTML = '';
    };
  }, [name, size]);
  return <span ref={ref} aria-hidden="true" className="inline-flex shrink-0" />;
}
