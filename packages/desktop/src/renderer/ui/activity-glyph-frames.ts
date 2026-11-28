/**
 * Kapibala UI 2.0 语义化智能体活动微动效纯计算层（无 DOM / 无副作用）：
 * 提供 8 类编码工作台语义映射与任意时刻矢量几何快照，供 SSR 首帧与实时 DOM 驱动共用，防双源漂移。
 */

/** 支持的 8 类编码工作台智能体运行语义态。 */
export type AgentActivityKind =
  | 'thinking'
  | 'reading'
  | 'searching'
  | 'writing'
  | 'checking'
  | 'sending'
  | 'on_hold'
  | 'waiting';

/** 8 类语义态的只读枚举顺序，供测试与外部校验复用。 */
export const AGENT_ACTIVITY_KINDS: readonly AgentActivityKind[] = [
  'thinking',
  'reading',
  'searching',
  'writing',
  'checking',
  'sending',
  'on_hold',
  'waiting',
];

/** 各语义态默认中文无障碍回退标签，防止读屏器仅见图形不知当前阶段。 */
export const AGENT_ACTIVITY_LABELS: Readonly<Record<AgentActivityKind, string>> = {
  thinking: '思考中',
  reading: '读取中',
  searching: '检索中',
  writing: '编写中',
  checking: '校验中',
  sending: '委派中',
  on_hold: '等待中',
  waiting: '连接中',
};

/** 静态回退帧时间戳（秒）：确保 SSR 首帧、静态态与减弱动态模式下呈现高辨识度构图而非空白。 */
export const STATIC_ACTIVITY_FRAME_SEC = 1.65;

/** `checking` 校验圆环周长（半径 10.5）。 */
export const CHECKING_RING_CIRCUMFERENCE = 2 * Math.PI * 10.5;

/** `waiting` 轨道圆环周长（半径 10.2）。 */
export const WAITING_RING_CIRCUMFERENCE = 2 * Math.PI * 10.2;

const TOOL_ACTIVITY_MAP: Readonly<Record<string, AgentActivityKind>> = {
  read_file: 'reading',
  read: 'reading',
  view_file: 'reading',
  glob: 'searching',
  grep: 'searching',
  grep_search: 'searching',
  find_by_name: 'searching',
  list_dir: 'searching',
  search: 'searching',
  web_search: 'searching',
  write_file: 'writing',
  edit_file: 'writing',
  delete_file: 'writing',
  write: 'writing',
  edit: 'writing',
  multi_edit: 'writing',
  apply_patch: 'writing',
  patch: 'writing',
  run_command: 'checking',
  bash: 'checking',
  shell: 'checking',
  exec: 'checking',
  terminal: 'checking',
  spawn_agent: 'sending',
  send_agent: 'sending',
  delegate: 'sending',
  agent: 'sending',
  subagent: 'sending',
  task: 'sending',
};

/**
 * 将本地 Core 或外部代理工具名归一映射为 8 类微动效语义；
 * 未显式命中的外部 MCP/自定义工具回退为 `'waiting'`，避免误导性隐喻。
 */
export function resolveToolActivityKind(toolName: string | undefined): AgentActivityKind {
  if (!toolName) return 'waiting';
  const normalized = toolName.trim().toLowerCase();
  if (!normalized) return 'waiting';
  const exact = TOOL_ACTIVITY_MAP[normalized];
  if (exact) return exact;
  if (/read|view|open_file|cat/.test(normalized)) return 'reading';
  if (/grep|glob|search|find|list|fetch|browse/.test(normalized)) return 'searching';
  if (/write|edit|patch|replace|create_file|delete_file/.test(normalized)) return 'writing';
  if (/command|bash|shell|exec|test|lint|check|verify|build/.test(normalized)) return 'checking';
  if (/agent|delegate|subagent|spawn|send/.test(normalized)) return 'sending';
  return 'waiting';
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** 单帧视觉快照数据：纯函数计算，同时驱动 SSR 首帧属性与实时 DOM 更新。 */
export interface GlyphFrameGeometry {
  readonly thinking?: {
    readonly innerR: number;
    readonly outerR: number;
    readonly outerOpacity: number;
    readonly dotR: number;
    readonly dotOpacity: number;
  };
  readonly reading?: {
    readonly segOpacities: readonly number[];
    readonly segActive: readonly boolean[];
    readonly dotX: number;
    readonly dotY: number;
  };
  readonly searching?: {
    readonly dots: readonly {
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly active: boolean;
      readonly opacity: number;
    }[];
    readonly reticleX: number;
    readonly reticleY: number;
  };
  readonly writing?: {
    readonly lineEnds: readonly number[];
    readonly lineVisible: readonly boolean[];
    readonly caretX: number;
    readonly caretY1: number;
    readonly caretY2: number;
    readonly caretOpacity: number;
  };
  readonly checking?: {
    readonly arcVisible: boolean;
    readonly arcDashOffset: number;
    readonly arcOpacity: number;
    readonly arcRotateDeg: number;
    readonly checkVisible: boolean;
    readonly checkDashOffset: number;
    readonly checkOpacity: number;
  };
  readonly sending?: {
    readonly leftActive: boolean;
    readonly leftOpacity: number;
    readonly rightActive: boolean;
    readonly rightOpacity: number;
    readonly dotX: number;
  };
  readonly onHold?: {
    readonly ringOpacity: number;
    readonly dotOpacity: number;
    readonly arcOpacities: readonly number[];
  };
  readonly waiting?: {
    readonly tailRotateDeg: number;
    readonly dotX: number;
    readonly dotY: number;
  };
}

const READING_ROWS: readonly {
  readonly y: number;
  readonly segs: readonly (readonly [number, number])[];
}[] = [
  {
    y: 9.5,
    segs: [
      [6, 14],
      [17, 26],
    ],
  },
  {
    y: 16,
    segs: [
      [6, 18],
      [21, 26],
    ],
  },
  {
    y: 22.5,
    segs: [
      [6, 12],
      [15, 22],
    ],
  },
];

const WRITING_LINES: readonly {
  readonly y: number;
  readonly x0: number;
  readonly len: number;
  readonly start: number;
  readonly end: number;
}[] = [
  { y: 11, x0: 6, len: 18, start: 0.0, end: 0.36 },
  { y: 16.5, x0: 6, len: 20, start: 0.38, end: 0.74 },
  { y: 22, x0: 6, len: 13, start: 0.76, end: 0.95 },
];

/**
 * 纯函数计算任意时刻 `tSec` 下指定语义态的矢量几何帧；
 * 小尺寸（`size <= 20`）自动采用 3×3 点阵与加粗核心半径，保障 14px–16px 行内清晰度。
 */
export function computeActivityGlyphFrame(
  kind: AgentActivityKind,
  size: number,
  tSec: number,
): GlyphFrameGeometry {
  const small = size <= 20;

  if (kind === 'thinking') {
    const wave = 0.5 - 0.5 * Math.cos(tSec * 2.4);
    return {
      thinking: {
        innerR: 7.2 + (1 - wave) * 1.1,
        outerR: 10.2 + wave * 2.1,
        outerOpacity: 0.35 + wave * 0.55,
        dotR: (small ? 2.7 : 2.2) + wave * 0.5,
        dotOpacity: 0.85 + wave * 0.15,
      },
    };
  }

  if (kind === 'reading') {
    const total = ((tSec * 0.52) % 1) * 3;
    const activeRow = Math.min(2, Math.floor(total));
    const dotX = 6 + easeInOut(total - activeRow) * 20;
    const dotY = READING_ROWS[activeRow]?.y ?? 9.5;
    const segOpacities: number[] = [];
    const segActive: boolean[] = [];
    READING_ROWS.forEach((row, idx) => {
      for (const [x1, x2] of row.segs) {
        const mid = (x1 + x2) / 2;
        const prox = idx === activeRow ? Math.max(0, 1 - Math.abs(dotX - mid) / 10) : 0;
        const hit = prox > 0.05;
        segActive.push(hit);
        segOpacities.push(hit ? 0.32 + prox * 0.65 : 0.45);
      }
    });
    return { reading: { segOpacities, segActive, dotX, dotY } };
  }

  if (kind === 'searching') {
    const gridN = small ? 3 : 4;
    const pad = small ? 8 : 7.2;
    const step = (32 - pad * 2) / (gridN - 1);
    const ang = tSec * 1.55;
    const reticleX = 16 + Math.cos(ang) * (small ? 5.6 : 6.6);
    const reticleY = 16 + Math.sin(ang * 1.5) * (small ? 5.2 : 6.0);
    const baseR = small ? 1.45 : 1.1;
    const dots: Array<{
      readonly cx: number;
      readonly cy: number;
      readonly r: number;
      readonly active: boolean;
      readonly opacity: number;
    }> = [];
    for (let r = 0; r < gridN; r++) {
      for (let c = 0; c < gridN; c++) {
        const cx = pad + c * step;
        const cy = pad + r * step;
        const prox = Math.max(0, 1 - Math.hypot(cx - reticleX, cy - reticleY) / 10);
        const active = prox > 0.15;
        dots.push({
          cx,
          cy,
          r: baseR + prox * 0.55,
          active,
          opacity: active ? 0.35 + prox * 0.65 : 0.45,
        });
      }
    }
    return { searching: { dots, reticleX, reticleY } };
  }

  if (kind === 'writing') {
    const p = (tSec * 0.45) % 1;
    let caretX = 6;
    let caretY = 11;
    const lineEnds: number[] = [];
    const lineVisible: boolean[] = [];
    for (const ln of WRITING_LINES) {
      const prog = Math.max(0, Math.min(1, (p - ln.start) / (ln.end - ln.start)));
      const curX = ln.x0 + ln.len * easeInOut(prog);
      lineEnds.push(curX);
      lineVisible.push(prog > 0);
      if (p >= ln.start && p <= ln.end + 0.05) {
        caretX = curX + 1.5;
        caretY = ln.y;
      }
    }
    return {
      writing: {
        lineEnds,
        lineVisible,
        caretX,
        caretY1: caretY - 2.6,
        caretY2: caretY + 2.6,
        caretOpacity: 0.45 + 0.55 * Math.sin(tSec * 7.5),
      },
    };
  }

  if (kind === 'checking') {
    const p = (tSec * 0.42) % 1;
    if (p < 0.52) {
      const sp = p / 0.52;
      const spanRatio = 0.22 + 0.78 * smoothstep(0.15, 0.95, sp);
      return {
        checking: {
          arcVisible: true,
          arcDashOffset: CHECKING_RING_CIRCUMFERENCE * (1 - spanRatio),
          arcOpacity: 0.95,
          arcRotateDeg: -90 + sp * 252,
          checkVisible: false,
          checkDashOffset: 14,
          checkOpacity: 0,
        },
      };
    }
    const cp = (p - 0.52) / 0.48;
    const fade = 1 - smoothstep(0.76, 1, cp);
    const drawP = smoothstep(0, 0.34, cp);
    return {
      checking: {
        arcVisible: true,
        arcDashOffset: 0,
        arcOpacity: 0.15 + 0.85 * fade,
        arcRotateDeg: -90,
        checkVisible: true,
        checkDashOffset: 14 * (1 - drawP),
        checkOpacity: 0.98 * fade,
      },
    };
  }

  if (kind === 'sending') {
    const p = (tSec * 0.58) % 1;
    const lp = p < 0.25 ? Math.sin((p / 0.25) * Math.PI) : 0;
    const rp = p > 0.72 ? Math.sin(((p - 0.72) / 0.28) * Math.PI) : 0;
    let dotX = 9.5;
    if (p >= 0.22 && p <= 0.76) {
      dotX = 9.5 + 13 * easeInOut((p - 0.22) / 0.54);
    } else if (p > 0.76) {
      dotX = 22.5;
    }
    return {
      sending: {
        leftActive: lp > 0.05,
        leftOpacity: lp > 0.05 ? 0.4 + lp * 0.6 : 0.5,
        rightActive: rp > 0.05,
        rightOpacity: rp > 0.05 ? 0.4 + rp * 0.6 : 0.5,
        dotX,
      },
    };
  }

  if (kind === 'on_hold') {
    const pulse = 0.5 + 0.5 * Math.sin(tSec * 2.6);
    return {
      onHold: {
        ringOpacity: 0.6 + pulse * 0.35,
        dotOpacity: 0.85 + pulse * 0.15,
        arcOpacities: [0, 1, 2].map((idx) => {
          const wave = Math.max(0, Math.sin(tSec * 2.6 - idx * 0.75));
          return 0.18 + wave * 0.78;
        }),
      },
    };
  }

  const ang = tSec * 2.5 - Math.PI / 2;
  return {
    waiting: {
      tailRotateDeg: (ang * 180) / Math.PI - 57,
      dotX: 16 + Math.cos(ang) * 10.2,
      dotY: 16 + Math.sin(ang) * 10.2,
    },
  };
}
