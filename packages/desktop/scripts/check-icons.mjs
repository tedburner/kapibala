#!/usr/bin/env node
// Copyright (c) 2026 Kubai087. Licensed under the Kubai Icons License; see LICENSE.
// Kapibala 图标自检（PROMPT.md 第 10 节）：无头 Chrome 里以 reduced-motion 截出
//   rest.png, hover.png / frames.png / size-24.png, size-28.png / palettes.png
// 并读出页面脚本报错。放在 scripts/ 下是因为它依赖 Node 内置模块，不能进
// src/renderer（check-desktop 门禁禁止）；src/renderer/icons 里只留运行时模块。
// 与 skill 原版的差异只有两处：文件路径按本仓库布局读取；内联前剥掉
// ES module 的 import / export（classic script 里会报语法错）。
//
//   node scripts/check-icons.mjs [--only 名字,名字] [--accent #hex] [--scale n] [--out dir]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const iconsDir = path.join(root, 'src/renderer/icons');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const list = (v) =>
  v
    ? v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [];
const only = list(opt('--only'));
const extra = list(opt('--with'));
const scale = Math.max(1, Number(opt('--scale')) || 1);
const accent = opt('--accent');
const out = path.resolve(opt('--out') || path.join(root, 'icons-check-out'));

const chrome =
  process.env.CHROME ||
  [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((p) => fs.existsSync(p));
if (!chrome) {
  console.error('Chrome not found. Set CHROME to the browser binary.');
  process.exit(1);
}

const read = (f) => fs.readFileSync(path.join(iconsDir, f), 'utf8');
// 剥掉 ES module 语句后，三个文件共享一个 classic script 作用域。
const strip = (s) =>
  s
    .replace(/^import\s+[^;]*?from\s+'[^']*';\s*$/gm, '')
    .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')
    .replace(/^export const /gm, 'const ')
    .replace(/^export function /gm, 'function ');
const icons = read('icons.js');
const js = [strip(read('engine.js')), strip(icons), strip(read('app.js'))].join('\n');
const html = read('index.html');

const known = new Set([...icons.matchAll(/\bname:\s*'([^']+)'/g)].map((m) => m[1]));
const order = (js.match(/^const ORDER = \[([\s\S]*?)\];/m)?.[1].match(/'[^']+'/g) || []).map((s) =>
  s.slice(1, -1),
);
const shown = [...extra, ...only];
const unknown = shown.filter((n) => !known.has(n));
if (unknown.length) {
  console.error(`Unknown icon names: ${unknown.join(', ')}`);
  process.exit(1);
}
const unlisted = shown.filter((n) => !order.includes(n));
if (unlisted.length) {
  console.error(`Not in ORDER (app.js): ${unlisted.join(', ')}`);
  process.exit(1);
}
if (accent && !/^#[0-9a-f]{6}$/i.test(accent)) {
  console.error('--accent takes a colour like #F59E0B.');
  process.exit(1);
}

fs.mkdirSync(out, { recursive: true });
const work = fs.mkdtempSync(path.join(out, '.work-'));
const pages = [];

const recolor = accent
  ? `PALETTES[0].colors.fill(${JSON.stringify(accent)}); insts.forEach((x) => { x.cur = targetOf(x); render(x); });`
  : '';
function page(css, script) {
  const pick = shown.length
    ? `const keep = ${JSON.stringify(shown)};
       const g = document.getElementById('grid');
       [...g.children].forEach((t) => { if (!keep.includes(t.getAttribute('aria-label'))) t.remove(); });
       keep.forEach((n) => { const t = [...g.children].find((c) => c.getAttribute('aria-label') === n); if (t) g.appendChild(t); });`
    : '';
  return html
    .replace(
      '<head>',
      '<head><script>window.addEventListener("error",(e)=>{const r=document.documentElement;r.dataset.err=(r.dataset.err?r.dataset.err+" | ":"")+e.message+" @"+e.lineno;});</script>',
    )
    .replace(
      /<script type="module" src="\.\/app\.js"><\/script>/,
      `<script>\n${js}\n</script><script>{${recolor}}{${pick}}{${script || ''}}</script><style>${css || ''}</style>`,
    );
}

function shot(name, content, w, h, factor = 1) {
  const file = path.join(work, `${name}.html`);
  fs.writeFileSync(file, content);
  pages.push(file);
  execFileSync(
    chrome,
    [
      '--headless=new',
      '--disable-gpu',
      '--force-prefers-reduced-motion',
      `--user-data-dir=${path.join(work, 'profile')}`,
      '--hide-scrollbars',
      '--virtual-time-budget=3000',
      `--window-size=${Math.round(w)},${Math.round(h)}`,
      `--force-device-scale-factor=${factor * scale}`,
      `--screenshot=${path.join(out, `${name}.png`)}`,
      `file://${file}`,
    ],
    { stdio: 'ignore' },
  );
}

const prelude = `const shownTiles = [...document.getElementById('grid').children];
  const shownIcons = shownTiles.map((t) => ICONS.find((x) => x.name === t.getAttribute('aria-label')));
  let nextKey = 1000;
  const copy = (icon, host, pal) => {
    const src = insts.findIndex((x) => x.icon === icon), k = nextKey++;
    PALETTES.forEach((p) => { p.colors[k] = p.colors[src]; if (p.edges) p.edges[k] = p.edges[src]; });
    const prev = runtime.palette; if (pal) runtime.palette = pal;
    const inst = mountIcon(icon, k, host);
    runtime.palette = prev;
    return inst;
  };
  const pose = (inst, t) => {
    const prev = runtime.palette; runtime.palette = inst.pal || prev;
    inst.hover = 0; const a = targetOf(inst); inst.hover = 1; const b = targetOf(inst);
    inst.cur = interp(a, b, EASE(t)); render(inst);
    runtime.palette = prev;
  };
  const row = (label) => { const r = document.createElement('div'); r.className = 'row';
    const l = document.createElement('span'); l.className = 'lab'; l.textContent = label; r.appendChild(l); return r; };
  const cell = (r) => { const h = document.createElement('span'); h.className = 'cell'; r.appendChild(h); return h; };`;
const sheet = (size) => `.bar{display:none}main{padding:12px!important;max-width:none!important}
  .row{display:flex;align-items:center;gap:8px;padding:4px 0}.lab{width:64px;flex:none;font-size:11px;color:#6B707A}
  .cell{width:${size + 16}px;height:${size + 16}px;flex:none;border-radius:8px;background:#F2F3F5;display:grid;place-items:center}
  .cell svg{width:${size}px;height:auto;overflow:visible;display:block}`;

const count = shown.length || order.length || known.size;
const tile = 178;
const gap = 16;
const hideBar = '.bar{display:none}main{padding-block:12px!important}';
const cols = Math.min(6, count);
const rowsN = Math.ceil(count / cols);
const gridCss = `${hideBar}.grid{grid-template-columns:repeat(${cols},${tile}px)!important;gap:${gap}px!important}`;
const gridW = 32 + cols * tile + (cols - 1) * gap;
const gridH = 24 + rowsN * tile + (rowsN - 1) * gap;
const hoverAll =
  'setTimeout(()=>document.querySelectorAll(".tile").forEach((t)=>t.dispatchEvent(new Event("focus"))),50);';

try {
  shot('rest', page(gridCss), gridW, gridH);
  shot('hover', page(gridCss, hoverAll), gridW, gridH);

  const steps = [0, 0.15, 0.3, 0.5, 0.75, 1];
  const frames = `${prelude}const g = document.getElementById('grid');
    const rows = ${JSON.stringify(steps)}.map((t) => { const r = row(Math.round(t * 100) + '%');
      shownIcons.forEach((icon) => pose(copy(icon, cell(r)), t)); return r; });
    const box = document.createElement('div'); box.append(...rows); g.replaceWith(box);`;
  shot('frames', page(sheet(56), frames), 100 + count * 80, 30 + steps.length * 82, 2);

  for (const px of [24, 28]) {
    const small = `${prelude}const g = document.getElementById('grid');
      const rows = [0, 1].map((t) => { const r = row(t ? 'hover' : 'rest');
        shownIcons.forEach((icon) => pose(copy(icon, cell(r)), t)); return r; });
      const box = document.createElement('div'); box.append(...rows); g.replaceWith(box);`;
    shot(`size-${px}`, page(sheet(px), small), 100 + count * (px + 24), 30 + 2 * (px + 26), 2);
  }

  const palettes = `${prelude}const g = document.getElementById('grid');
    const rows = PALETTES.map((pal) => { const r = row(pal.name);
      shownIcons.forEach((icon) => { const inst = copy(icon, cell(r), pal); inst.pal = pal; }); return r; });
    const box = document.createElement('div'); box.append(...rows); g.replaceWith(box);`;
  shot('palettes', page(sheet(36), palettes), 100 + count * 60, 30 + 8 * 60, 2);

  const errors = pages
    .map((file) => {
      const dom = execFileSync(
        chrome,
        [
          '--headless=new',
          '--disable-gpu',
          '--force-prefers-reduced-motion',
          `--user-data-dir=${path.join(work, 'profile')}`,
          '--virtual-time-budget=3000',
          '--dump-dom',
          `file://${file}`,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024 },
      );
      const m = dom.match(/data-err="([^"]*)"/);
      return m ? `${path.basename(file, '.html')}: ${m[1]}` : null;
    })
    .filter(Boolean);
  console.log(errors.length ? `Script errors:\n${errors.join('\n')}` : 'No script errors.');
  console.log(`Screenshots in ${out}`);
  process.exitCode = errors.length ? 1 : 0;
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
