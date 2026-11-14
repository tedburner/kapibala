// Copyright (c) 2026 Kubai087. Licensed under the Kubai Icons License; see LICENSE.
// Kapibala 桌面端品牌功能图标（7 个）。每个条目三部分：svg(u) 分层、target(hover, state)
// 静止与悬停数值、draw(p, E) 写回。几何与运行时全部复用 engine.js，不自造写法。
// 自检：node packages/desktop/src/renderer/icons/check.mjs（需 Chrome）。
import { at, circ, f, gear, go, lines, mountIcon, rr, rp, R, CR, KR, runtime, clearTone } from './engine.js';

const OL = 'class="ol" data-t="stroke:#5393FF"';
const LINE = 'class="ln" data-t="stroke:#D3E2FC"';
const DEEP = 'data-t="fill:#2F6FE0"';
const DEEPS = 'data-t="stroke:#2F6FE0"';
const FOLDER_BACK_R = [KR, 1.4, 1.4, KR, KR, KR];
const GEAR = gear(6, 11.4, 9);

// 应用色板：杏色 clearTone，贴合水豚品牌的暖棕调；在单色 UI 里是唯一的暖色点缀。
// 换色只需改这里的基色（如 #6F87B5 蓝灰、#5BA3A8 青瓷）。
export const APP_PALETTE = clearTone('kapibala', '#C9946A', 8);
runtime.palette = APP_PALETTE;

export const ICONS = [
  {
    name: '新建对话',
    // 铅笔落笔：悬停时铅笔下压，在下方画出一行墨迹——正在写下新对话。
    svg: (u) => {
      const body = rr(7.1, 9.6, 15, 6.8, 0.8), tip = rp([[22.1, 9.6], [28.4, 13], [22.1, 16.4]], [0.3, 0.9, 0.3]), cap = rr(2.8, 9.6, 4.7, 6.8, 2);
      return `<path data-n="ink" fill="none" stroke-width="2.2" stroke-linecap="round" ${DEEPS}/>
      <g filter="${u.sh}"><g filter="${u.hi}"><g data-n="pen"><path d="${body}" fill="${u.loS}"/><path d="${tip}" fill="${u.upS}"/><path d="${cap}" fill="${u.upS}"/></g></g></g>
      <g data-n="penO"><path d="${body}" ${OL}/><path d="${tip}" ${OL}/><path d="${cap}" ${OL}/></g>`;
    },
    target: (h) => ({ push: h ? 1.6 : 0, ink: h ? 9 : 0 }),
    draw(p, E) {
      const t = `rotate(135 15.5 13) translate(${f(p.push)} 0)`;
      at(E.pen, { transform: t }); at(E.penO, { transform: t });
      at(E.ink, { d: `M6.4 23.6H${f(6.4 + p.ink)}`, opacity: p.ink > 0.2 ? 1 : 0 });
    }
  },
  {
    name: '默认空间',
    // 小屋开门：悬停时门绕左侧铰链打开，欢迎回到默认空间。
    svg: (u) => {
      const roof = rp([[3.6, 12.6], [15.5, 2.4], [27.4, 12.6]], [1.4, 2.2, 1.4]);
      const door = rp(R(13.2, 15.6, 4.6, 7.4), [1.2, 1.2, 0, 0]);
      return `
    <g filter="${u.sh}"><g filter="${u.hi}"><path d="${rr(7.4, 10.6, 16.2, 12.4, KR)}" fill="${u.loS}"/></g></g>
    <path d="${rr(7.4, 10.6, 16.2, 12.4, KR)}" ${OL}/>
    <path d="${door}" fill="${u.pure('#2F6FE0')}"/>
    <g data-n="door"><path d="${door}" fill="#fff"/></g>
    <g filter="${u.hi}"><path d="${roof}" fill="${u.upS}"/></g>
    <path d="${roof}" ${OL}/>`;
    },
    target: (h) => ({ door: h ? 0.3 : 1 }),
    draw(p, E) {
      at(E.door, { transform: `translate(13.2 0) scale(${f(Math.max(0.001, p.door))} 1) translate(-13.2 0)` });
    }
  },
  {
    name: '新建项目',
    // 文件夹翻开露出内页，前片上的加号跟着前片倾斜移动：往这个空间里放新东西。
    svg: (u) => `
    <g filter="${u.sh}"><path data-n="back" fill="${u.lo(21)}"/></g>
    <path data-n="backO" ${OL}/>
    <g data-n="file"><path d="${rr(0, 0, 17, 9, 1)}" fill="#fff"/><path d="M5.5 2.3H11.5" ${LINE} stroke-width="1"/></g>
    <g filter="${u.hi}"><path data-n="front" fill="${u.up(18)}"/></g>
    <path data-n="frontO" ${OL}/>
    <path data-n="plus" d="M-2.2 0H2.2M0 -2.2V2.2" fill="none" stroke-width="2.2" stroke-linecap="round" ${DEEPS}/>`,
    target: (h) => ({
      back: h ? [[4, 3], [11.2, 3], [14.2, 6], [27, 6], [27.6, 23], [4.6, 23]] : [[4, 2], [11.2, 2], [14.2, 5], [27, 5], [27, 23], [4, 23]],
      fx: h ? 7.9 : 7,
      front: h ? [[6.8, 13], [29.3, 13], [27.6, 23], [5.4, 23]] : [[4, 5], [27, 5], [27, 23], [4, 23]],
      fr: h ? 1.8 : KR,
      plus: h ? [17.2, 17.8] : [15.5, 14]
    }),
    draw(p, E) {
      const b = rp(p.back, FOLDER_BACK_R), fr = rp(p.front, p.fr);
      at(E.back, { d: b }); at(E.backO, { d: b });
      at(E.file, { transform: `translate(${f(p.fx)} 9)` });
      at(E.front, { d: fr }); at(E.frontO, { d: fr });
      at(E.plus, { transform: `translate(${f(p.plus[0])} ${f(p.plus[1])})` });
    }
  },
  {
    name: '设置',
    // 齿轮转动：悬停时转过 60°，中轴微微收紧。
    svg: (u) => `
    <g filter="${u.sh}"><g filter="${u.hi}"><g data-n="gear"><path d="${GEAR}" fill="${u.loS}"/></g></g></g><g data-n="gearO"><path d="${GEAR}" ${OL}/></g>
    <path d="${circ(15.5, 12.5, 5.8)}" fill="#fff"/>
    <g filter="${u.hi}"><path data-n="hub" fill="${u.upS}"/></g>
    <path data-n="hubO" ${OL}/>`,
    target: (h) => ({ rot: h ? 60 : 0, hub: h ? 2.9 : 3.5 }),
    draw(p, E) {
      at(E.gear, { transform: `rotate(${f(p.rot)} 15.5 12.5)` }); at(E.gearO, { transform: `rotate(${f(p.rot)} 15.5 12.5)` });
      const d = circ(15.5, 12.5, p.hub);
      at(E.hub, { d }); at(E.hubO, { d });
    }
  },
  {
    name: '搜索',
    // 页面是主体，放大镜从右下扫到左上：正在检视内容。
    svg: (u) => `
    <g filter="${u.sh}"><g filter="${u.hi}"><path d="${rr(4, 1, 16.8, 20.2, KR)}" fill="${u.lo(20.2)}"/></g></g>
    <path d="${rr(4, 1, 16.8, 20.2, KR)}" ${OL}/>
    <path d="${lines(7.4, 4.8, [10, 6.6])}" class="ln" stroke="#fff" data-w="stroke"/>
    <g filter="${u.hi}"><path d="${rp(R(4, 10.8, 16.8, 10.4), [1.6, 1.6, KR, KR])}" fill="${u.upS}"/></g>
    <path d="${rp(R(4, 10.8, 16.8, 10.4), [1.6, 1.6, KR, KR])}" ${OL}/>
    <g data-n="lens" filter="${u.sh}">
      <circle r="3.6" fill="#fff" fill-opacity=".8"/>
      <circle r="3.6" fill="${u.upS}" fill-opacity=".35"/>
      <circle r="4.5" fill="none" stroke-width="1.8" data-t="stroke:#2F6FE0"/>
      <path d="M3.8 3.8L6.6 6.6" stroke-width="2.2" stroke-linecap="round" data-t="stroke:#2F6FE0"/>
    </g>`,
    target: (h) => ({ lens: h ? [13.2, 10.4, 1.05] : [19.8, 16.8, 1] }),
    draw(p, E) {
      const [x, y, s] = p.lens;
      at(E.lens, { transform: `translate(${f(x)} ${f(y)}) scale(${f(s)})` });
    }
  },
  {
    name: '信任空间',
    // 盾牌前压、受光半面亮起：信任确认的一刻。
    svg: (u) => {
      const sh = 'M15.5 1.4L24.2 4.8V11.4C24.2 17.2 20.6 21.6 15.5 23.8C10.4 21.6 6.8 17.2 6.8 11.4V4.8Z';
      return `<g data-n="g">
      <clipPath id="${u.id('half')}"><rect x="15.5" y="-2" width="16" height="30"/></clipPath>
      <g filter="${u.sh}"><g filter="${u.hi}"><path d="${sh}" fill="${u.loS}"/></g></g>
      <g clip-path="url(#${u.id('half')})"><g filter="${u.hi}"><path d="${sh}" fill="${u.upS}"/></g></g>
      <path d="${sh}" ${OL}/>
      <path d="M11.4 12.2L14.4 15.2L19.8 9.6" fill="none" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" ${DEEPS}/>
    </g>`;
    },
    target: (h) => ({ y: h ? -1 : 0, s: h ? 1.06 : 1 }),
    draw(p, E) { at(E.g, { transform: `translate(15.5 ${f(12.6 + p.y)}) scale(${f(p.s)}) translate(-15.5 -12.6)` }); }
  },
  {
    name: '项目空间',
    // 盖片翻开露出白色内页：项目展开它的历史。
    svg: (u) => `
    <g filter="${u.sh}"><path data-n="back" fill="${u.lo(21)}"/></g>
    <path data-n="backO" ${OL}/>
    <g data-n="file"><path d="${rr(0, 0, 17, 9, 1)}" fill="#fff"/><path d="M5.5 2.3H11.5" ${LINE} stroke-width="1"/></g>
    <g filter="${u.hi}"><path data-n="front" fill="${u.up(18)}"/></g>
    <path data-n="frontO" ${OL}/>`,
    target: (h) => ({
      back: h ? [[4, 3], [11.2, 3], [14.2, 6], [27, 6], [27.6, 23], [4.6, 23]] : [[4, 2], [11.2, 2], [14.2, 5], [27, 5], [27, 23], [4, 23]],
      fx: h ? 7.9 : 7,
      front: h ? [[6.8, 13], [29.3, 13], [27.6, 23], [5.4, 23]] : [[4, 5], [27, 5], [27, 23], [4, 23]],
      fr: h ? 1.8 : KR
    }),
    draw(p, E) {
      const b = rp(p.back, FOLDER_BACK_R), fr = rp(p.front, p.fr);
      at(E.back, { d: b }); at(E.backO, { d: b });
      at(E.file, { transform: `translate(${f(p.fx)} 9)` });
      at(E.front, { d: fr }); at(E.frontO, { d: fr });
    }
  }
];

// 供 React 包装层挂载单个图标。
export { mountIcon, go };
