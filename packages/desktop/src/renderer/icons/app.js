// Copyright (c) 2026 Kubai087. Licensed under the Kubai Icons License; see LICENSE.
// Kapibala 图标展示页：7 个品牌功能图标 + 色板切换 + 演示开关。
// 自检脚本 check.mjs 会把本文件、icons.js 与 engine.js 内联进页面，因此
// import / export 语句都会被剥掉，保持与 classic script 兼容的写法。
import { ICONS, APP_PALETTE, mountIcon, go } from './icons.js';
import { clearTone, flatTone, DUR, REDUCED, runtime } from './engine.js';

const ORDER = ['新建对话', '默认空间', '新建项目', '设置', '搜索', '信任空间', '项目空间'];
const BY_NAME = Object.fromEntries(ICONS.map((icon) => [icon.name, icon]));
const LIST = ORDER.map((name) => BY_NAME[name]);
const N = LIST.length;

const COLORFUL = ['#5393FF', '#6366F1', '#EC4899', '#F97316', '#22C55E', '#06B6D4', '#8B5CF6'];
const spread = (list) => Array.from({ length: N }, (_, i) => list[i % list.length]);
const PALETTES = [
  { name: '彩色', colors: spread(COLORFUL), swatch: ['#5393FF', '#EC4899', '#F59E0B', '#22C55E'] },
  APP_PALETTE,
  clearTone('蓝灰', '#6F87B5', N),
  clearTone('薄荷', '#5FAE8A', N),
  flatTone('黑色', '#2E3036', N)
];
runtime.palette = PALETTES[1];

// ---------- Grid ----------
const grid = document.getElementById('grid');
const insts = LIST.map((icon, i) => {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.tabIndex = 0;
  tile.setAttribute('role', 'img');
  tile.setAttribute('aria-label', icon.name);
  const host = document.createElement('span');
  host.className = 'ic';
  tile.appendChild(host);
  grid.appendChild(tile);
  const inst = mountIcon(icon, i, host);
  bind(inst, tile);
  return inst;
});

function bind(inst, el) {
  el.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { inst.hover++; go(inst); } });
  el.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') { inst.hover = Math.max(0, inst.hover - 1); go(inst); } });
  el.addEventListener('focus', () => { inst.hover++; go(inst); });
  el.addEventListener('blur', () => { inst.hover = Math.max(0, inst.hover - 1); go(inst); });
}

// ---------- Palette control ----------
let timers = [];
const later = (fn, ms) => timers.push(setTimeout(fn, REDUCED ? 0 : ms));
const wave = (fn, gap) => insts.forEach((inst, i) => later(() => fn(inst), i * gap));

const seg = document.getElementById('palette');
const segButtons = PALETTES.map((pal, i) => {
  const b = document.createElement('button');
  b.type = 'button';
  b.setAttribute('role', 'radio');
  b.setAttribute('aria-checked', String(i === 1));
  b.tabIndex = i === 1 ? 0 : -1;
  const dots = pal.swatch || [pal.colors[0]];
  b.innerHTML = `<span class="dots">${dots.map((c) => `<i style="background:${c}"></i>`).join('')}</span>${pal.name}`;
  b.addEventListener('click', () => choose(i));
  seg.appendChild(b);
  return b;
});
function choose(i) {
  const next = (i + PALETTES.length) % PALETTES.length;
  runtime.palette = PALETTES[next];
  segButtons.forEach((b, j) => { b.setAttribute('aria-checked', String(j === next)); b.tabIndex = j === next ? 0 : -1; });
  wave(go, 12);
  return next;
}

// ---------- Demo switch ----------
const sw = document.getElementById('demo');
let demoOn = false;
function demoCycle() {
  const gap = 25, span = gap * N + DUR;
  wave((inst) => { inst.demo = true; go(inst); }, gap);
  later(() => {
    wave((inst) => { inst.demo = false; go(inst); }, gap);
    later(demoCycle, span + 700);
  }, span + 1200);
}
function setDemo(on) {
  demoOn = on;
  sw.setAttribute('aria-checked', String(on));
  timers.forEach(clearTimeout);
  timers = [];
  if (on) demoCycle();
  else insts.forEach((inst) => { if (inst.demo) { inst.demo = false; go(inst); } });
}
sw.addEventListener('click', () => setDemo(!demoOn));
