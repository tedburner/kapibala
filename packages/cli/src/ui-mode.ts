/** kpbl 的展示策略；CLI/TUI 由同一包承载，auto 不表示可以重放已开始的操作。 */
export type UiMode = 'auto' | 'tui' | 'text';

/** 宿主在设置/信任/会话副作用之前取得的环境事实，不在此读取进程或终端。 */
export interface UiAdmission {
  readonly stdinTTY: boolean;
  readonly stdoutTTY: boolean;
  readonly capable: boolean;
  readonly oneShot: boolean;
}

/** 严格解析单个 --ui 参数；重复、空值或其他类型不能静默回退 auto。 */
export function parseUiMode(value: unknown): UiMode {
  if (value === undefined) return 'auto';
  if (value === 'auto' || value === 'tui' || value === 'text') return value;
  throw new Error('用法: --ui auto|tui|text');
}

/**
 * 根据无副作用的环境快照选择展示通道，单次/非交互保持文本输出。
 * 显式 TUI 冲突立即失败；auto 初始化后的安全回退由资源所有者完成，此处不启动 UI。
 */
export function chooseUiMode(mode: UiMode, admission: UiAdmission): Exclude<UiMode, 'auto'> {
  const available =
    admission.stdinTTY && admission.stdoutTTY && admission.capable && !admission.oneShot;
  if (mode === 'tui' && !available)
    throw new Error('显式 TUI 需要可交互的 TTY 且不能与单次问答同时使用');
  return mode === 'text' || !available ? 'text' : 'tui';
}
