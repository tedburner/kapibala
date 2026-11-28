/**
 * Kapibala CLI 语义色彩与终端符号系统（对齐 UI 2.0 纸墨工坊 Ink Atelier 设计令牌）。
 *
 * 设计取舍与边界（017 §6.8 & §8.4）：
 * - 集中收口 `packages/cli/src/ui/` 内全部 ANSI SGR 着色码，业务视图文件仅允许保留光标定位/清行 CSI 序列；
 * - 严格遵循 https://no-color.org 规范：只要 `process.env.NO_COLOR` 存在（无论值是否非空）或目标流非 TTY，
 *   所有着色函数一律无损退化为纯文本直通，杜绝向管道、CI 日志或重定向文件泄漏转义字节。
 */

const SGR_PREFIX = '\x1b[';
const SGR_RESET = '\x1b[0m';

/** CLI 与桌面端统一共享的终端状态符号字典。 */
export const CLI_GLYPHS = Object.freeze({
  active: '●',
  pulse: '◆',
  success: '✓',
  danger: '✗',
  pending: '○',
  worktree: '⎇',
  delegation: '↳',
} as const);

/** 语义化 CLI 调色板实例接口。 */
export interface CliTheme {
  readonly enabled: boolean;
  readonly glyphs: typeof CLI_GLYPHS;
  /** 标题与关键实体加粗强调。 */
  strong(text: string): string;
  /** 次要辅助说明、耗时与时间戳（暗灰 / Dim）。 */
  subtle(text: string): string;
  /** 水豚琥珀色（`#E58B52` Truecolor 前景，用于品牌标识与运行脉搏）。 */
  amber(text: string): string;
  /** 运行中 / 待确认脉搏态（水豚琥珀 / 暖黄）。 */
  pulse(text: string): string;
  /** 执行成功（翠绿）。 */
  success(text: string): string;
  /** 错误、拒绝与中断（朱砂红）。 */
  danger(text: string): string;
  /** 退避重试、截断与预算告警（琥珀黄）。 */
  warning(text: string): string;
  /** 交互引导、命令与信息提示（青蓝）。 */
  info(text: string): string;
  /** 按传统 SGR 数值码着色（兼容底层动态状态码映射）。 */
  sgr(text: string, code: number): string;
  /** 显式状态复位序列（非着色模式下返回空串）。 */
  reset(): string;
}

/**
 * 判定当前环境是否允许输出 ANSI 色彩：
 * 显式传入 `enabled` 时优先采用；缺省遵循 `NO_COLOR` 最高优先级强制关闭，
 * 未设置 `NO_COLOR` 时支持 `FORCE_COLOR`（非 `0` / `false`）强制开启，最后回退 `isTTY`。
 */
export function isCliColorEnabled(options?: {
  readonly enabled?: boolean;
  readonly isTTY?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): boolean {
  if (options?.enabled !== undefined) return options.enabled;
  const env = options?.env ?? process.env;
  if (env.NO_COLOR !== undefined) return false;
  if (env.FORCE_COLOR !== undefined) {
    return env.FORCE_COLOR !== '0' && env.FORCE_COLOR.toLowerCase() !== 'false';
  }
  const isTTY = options?.isTTY ?? Boolean(process.stdout?.isTTY);
  return isTTY;
}

function wrapSgr(openCodes: string, text: string, enabled: boolean): string {
  if (!enabled || !text) return text;
  return `${SGR_PREFIX}${openCodes}m${text}${SGR_RESET}`;
}

/**
 * 构造绑定特定 TTY / 色彩开关的 `CliTheme` 实例，便于纯函数渲染与单元测试注入。
 */
export function createCliTheme(options?: {
  readonly enabled?: boolean;
  readonly isTTY?: boolean;
  readonly env?: NodeJS.ProcessEnv;
}): CliTheme {
  const enabled = isCliColorEnabled(options);
  return {
    enabled,
    glyphs: CLI_GLYPHS,
    strong: (text) => wrapSgr('1', text, enabled),
    subtle: (text) => wrapSgr('90', text, enabled),
    amber: (text) => wrapSgr('38;2;229;139;82', text, enabled),
    pulse: (text) => wrapSgr('33', text, enabled),
    success: (text) => wrapSgr('32', text, enabled),
    danger: (text) => wrapSgr('31', text, enabled),
    warning: (text) => wrapSgr('33', text, enabled),
    info: (text) => wrapSgr('36', text, enabled),
    sgr: (text, code) => wrapSgr(String(code), text, enabled),
    reset: () => (enabled ? SGR_RESET : ''),
  };
}

/** 默认动态跟随当前进程 `stdout.isTTY` 与 `NO_COLOR` 环境变量的快捷语义主题门面。 */
export const theme: CliTheme = {
  get enabled(): boolean {
    return isCliColorEnabled();
  },
  glyphs: CLI_GLYPHS,
  strong: (text) => createCliTheme().strong(text),
  subtle: (text) => createCliTheme().subtle(text),
  amber: (text) => createCliTheme().amber(text),
  pulse: (text) => createCliTheme().pulse(text),
  success: (text) => createCliTheme().success(text),
  danger: (text) => createCliTheme().danger(text),
  warning: (text) => createCliTheme().warning(text),
  info: (text) => createCliTheme().info(text),
  sgr: (text, code) => createCliTheme().sgr(text, code),
  reset: () => createCliTheme().reset(),
};
