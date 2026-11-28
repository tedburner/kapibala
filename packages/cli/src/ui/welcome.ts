import os from 'node:os';
import { createCliTheme, isCliColorEnabled } from './theme.js';
import { charWidth, displayWidth } from './width.js';

/**
 * CLI 交互式启动欢迎区的环境与会话快照。
 *
 * 设计取舍：只消费已解析的只读标量事实，不直接持有 `AgentSession` 或触发磁盘/Git I/O，
 * 确保欢迎区渲染无副作用且可在任意列宽与色彩配置下做纯函数快照回归。
 */
export interface WelcomeBannerFacts {
  readonly version: string;
  readonly modelId: string;
  readonly role: string;
  readonly mode: string;
  readonly skillCount: number;
  readonly workspacePath: string;
  readonly homeDir?: string;
  readonly gitBranch?: string;
  readonly conversationId: string;
}

/**
 * 欢迎区静态渲染控制项。
 *
 * 前置约束：`columns` 小于 `64` 时自动降级为上下紧凑堆叠，避免半块像素画在窄分屏终端被自动折行撕裂；
 * `frame` 仅供交互式 TTY 首屏微动效内部切换「落橘前闭眼帧」与「静息定格帧」。
 */
export interface WelcomeRenderOptions {
  readonly columns?: number;
  readonly color?: boolean;
  readonly frame?: 'intro' | 'rest';
}

/**
 * 接收欢迎区字符流的最小输出端口（兼容 `process.stdout` 与测试桩）。
 *
 * 失败边界：`isTTY` 为假或未启用色彩时不发送光标隐藏/回退序列，防止管道或日志采集器混入控制字符。
 */
export interface WelcomeOutputStream {
  readonly isTTY?: boolean;
  readonly columns?: number;
  write(chunk: string): unknown;
}

/**
 * 交互式欢迎区输出配置；测试可注入极短 `frameDelayMs` 或禁用动画以消除真实等待。
 */
export interface InteractiveWelcomeOptions {
  readonly animate?: boolean;
  readonly color?: boolean;
  readonly frameDelayMs?: number;
}

/**
 * 方案 1A 极简墨线水豚 16×10 半块像素矩阵（每 2 行合成 1 行终端字符，共 5 行）：
 * `.` 透明空格、`I` 墨线廓形、`A` 头顶水豚琥珀小橘。
 * 刻意保证同一单元格上下半块不混用 `A` 与 `I`，从而无需背景色转义即可在深浅任意终端底色下无损渲染。
 */
const CAPYBARA_GRID_REST = [
  '........AA......',
  '....III.AA......',
  '...I...IIIIIIII.',
  '....III........I',
  '..II....III....I',
  '.I.............I',
  'I..........IIII.',
  'I.........I.....',
  '.I........I.....',
  '..IIIIIIIII.....',
] as const;

/** 入场首帧：小橘尚在高处下落、半阖横眼微闭，110ms 后覆写为 `CAPYBARA_GRID_REST` 落定。 */
const CAPYBARA_GRID_INTRO = [
  '........AA......',
  '....III.........',
  '...I...IIIIIIII.',
  '....III........I',
  '..II...........I',
  '.I.............I',
  'I..........IIII.',
  'I.........I.....',
  '.I........I.....',
  '..IIIIIIIII.....',
] as const;

function renderHalfBlockRows(grid: readonly string[], color: boolean): string[] {
  const ui = createCliTheme({ enabled: color });
  const rows: string[] = [];
  for (let y = 0; y < grid.length; y += 2) {
    const topRow = grid[y]!;
    const botRow = grid[y + 1] ?? '.'.repeat(topRow.length);
    let line = '';
    for (let x = 0; x < topRow.length; x++) {
      const top = topRow[x]!;
      const bot = botRow[x]!;
      if (top === '.' && bot === '.') {
        line += ' ';
        continue;
      }
      const isAmber = top === 'A' || bot === 'A';
      const glyph = top !== '.' && bot !== '.' ? '█' : top !== '.' ? '▀' : '▄';
      line += color && isAmber ? ui.amber(glyph) : glyph;
    }
    rows.push(line.replace(/\s+$/, ''));
  }
  const targetWidth = grid[0]!.length;
  return rows.map((row, idx) => {
    // 补齐右侧透明空格使右侧文字栏严格对齐到固定列，不受 ANSI 转义字节长度干扰
    const plainRow = renderPlainRow(grid[idx * 2]!, grid[idx * 2 + 1]!);
    const pad = Math.max(0, targetWidth - plainRow.length);
    return row + ' '.repeat(pad);
  });
}

function renderPlainRow(topRow: string, botRow: string): string {
  let out = '';
  for (let x = 0; x < topRow.length; x++) {
    const top = topRow[x]!;
    const bot = botRow[x]!;
    out +=
      top === '.' && bot === '.' ? ' ' : top !== '.' && bot !== '.' ? '█' : top !== '.' ? '▀' : '▄';
  }
  return out.replace(/\s+$/, '');
}

function slicePlainByWidth(text: string, maxCols: number): string {
  let out = '';
  let used = 0;
  for (const ch of text) {
    const w = charWidth(ch.codePointAt(0) ?? 0);
    if (used + w > maxCols) break;
    out += ch;
    used += w;
  }
  return out;
}

function fitPlainText(text: string, maxCols: number): string {
  if (maxCols <= 0) return '';
  if (displayWidth(text) <= maxCols) return text;
  if (maxCols <= 1) return slicePlainByWidth(text, maxCols);
  return `${slicePlainByWidth(text, maxCols - 1)}…`;
}

/**
 * 将位于用户主目录内的工作区路径折叠为 `~/` 前缀并统一为正斜杠。
 *
 * 设计取舍：Windows 下大小写不敏感匹配驱动器与用户目录前缀，避免盘符大小写差异导致折叠失效；
 * 非主目录路径原样转为正斜杠，保持与 Claude Code / OpenCode 终端路径观感一致。
 */
export function formatHomeRelativePath(workspacePath: string, homeDir = os.homedir()): string {
  const normWork = workspacePath.replaceAll('\\', '/').replace(/\/+$/, '');
  const normHome = homeDir.replaceAll('\\', '/').replace(/\/+$/, '');
  if (!normHome) return normWork || '/';
  const lowerWork = normWork.toLowerCase();
  const lowerHome = normHome.toLowerCase();
  if (lowerWork === lowerHome) return '~';
  if (lowerWork.startsWith(`${lowerHome}/`)) {
    return `~${normWork.slice(normHome.length)}`;
  }
  return normWork;
}

/**
 * 生成 CLI 1A 启动欢迎区字符串（左侧 5 行极简墨线像素水豚 + 右侧会话摘要）。
 *
 * 前置约束与边界：
 * - 常规宽度（`columns >= 64`）采用双栏并排，每行严格按终端显示宽度裁剪至 `columns` 以内；
 * - 窄分屏终端（`columns < 64`）退化为单栏紧凑文本加水豚图标，杜绝像素画跨行错位。
 */
export function renderWelcomeBanner(
  facts: WelcomeBannerFacts,
  options: WelcomeRenderOptions = {},
): string {
  const columns = Math.max(24, options.columns ?? 80);
  const color = isCliColorEnabled({ enabled: options.color, isTTY: true });
  const ui = createCliTheme({ enabled: color });
  const grid = options.frame === 'intro' ? CAPYBARA_GRID_INTRO : CAPYBARA_GRID_REST;

  const shortPath = formatHomeRelativePath(facts.workspacePath, facts.homeDir);
  const roleTag = facts.role !== 'default' ? ` (${facts.role})` : '';
  const skillTag = facts.skillCount > 0 ? ` · ${facts.skillCount} skills` : '';
  const metaPlain = `${facts.modelId}${roleTag} · ${facts.mode}${skillTag}`;
  const hintFull = '/model 模型 · /mode 权限 · /resume 续答 · /help 命令';
  const hintCompact = '/model · /mode · /resume · /help';

  if (columns < 64) {
    const art = renderHalfBlockRows(grid, color);
    const titlePlain = fitPlainText(`卡皮巴拉 v${facts.version}`, columns);
    const line2Plain = fitPlainText(metaPlain, columns);
    const pathPlain = fitPlainText(
      facts.gitBranch ? `${shortPath} (${facts.gitBranch})` : shortPath,
      columns,
    );
    const hintPlain = fitPlainText(hintCompact, columns);
    const title = color ? `${ui.strong('卡皮巴拉')} ${ui.subtle(`v${facts.version}`)}` : titlePlain;
    return `\n${[...art.map((r) => r.trimEnd()), title, ui.subtle(line2Plain), ui.subtle(pathPlain), ui.subtle(hintPlain)].join('\n')}\n`;
  }

  const artWidth = grid[0]!.length; // 16 cols
  const leftPad = ' ';
  const gap = '  ';
  const infoBudget = Math.max(16, columns - leftPad.length - artWidth - gap.length);

  const titlePlain = fitPlainText(`卡皮巴拉 v${facts.version}`, infoBudget);
  const titleStyled =
    color && titlePlain === `卡皮巴拉 v${facts.version}`
      ? `${ui.strong('卡皮巴拉')} ${ui.subtle(`v${facts.version}`)}`
      : ui.strong(titlePlain);

  const metaFitted = fitPlainText(metaPlain, infoBudget);
  const metaStyled = ui.subtle(metaFitted);

  const branchSuffix = facts.gitBranch ? ` (${facts.gitBranch})` : '';
  const fullPathPlain = `${shortPath}${branchSuffix}`;
  const pathStyled =
    displayWidth(fullPathPlain) <= infoBudget
      ? ui.subtle(fullPathPlain)
      : ui.subtle(fitPlainText(fullPathPlain, infoBudget));

  const chosenHint =
    displayWidth(hintFull) <= infoBudget ? hintFull : fitPlainText(hintCompact, infoBudget);
  const hintStyled = ui.subtle(chosenHint);

  const artRows = renderHalfBlockRows(grid, color);
  const infoRows = [titleStyled, metaStyled, pathStyled, '', hintStyled];

  const lines = artRows.map((artRow, idx) => {
    const right = infoRows[idx] ?? '';
    return right ? `${leftPad}${artRow}${gap}${right}` : `${leftPad}${artRow}`.trimEnd();
  });

  return `\n${lines.join('\n')}\n`;
}

/**
 * 向交互终端输出 CLI 1A 欢迎区；真实彩色 TTY 下播放极短两帧「落橘睁眼」入场微动效后定格。
 *
 * 失败边界：非 TTY、`NO_COLOR` 或 `animate: false` 时退化为单次无控制码写入；
 * 光标隐藏期间若发生任何异常，`finally` 保证写回 `\x1b[?25h` 恢复终端光标。
 */
export async function writeInteractiveWelcome(
  stream: WelcomeOutputStream,
  facts: WelcomeBannerFacts,
  options: InteractiveWelcomeOptions = {},
): Promise<void> {
  const columns = stream.columns ?? 80;
  const color = isCliColorEnabled({ enabled: options.color, isTTY: Boolean(stream.isTTY) });
  const shouldAnimate =
    Boolean(stream.isTTY) && color && options.animate !== false && columns >= 64;

  if (!shouldAnimate) {
    stream.write(`${renderWelcomeBanner(facts, { columns, color, frame: 'rest' })}\n`);
    return;
  }

  const delayMs = options.frameDelayMs ?? 110;
  const introBlock = renderWelcomeBanner(facts, { columns, color, frame: 'intro' });
  const restBlock = renderWelcomeBanner(facts, { columns, color, frame: 'rest' });
  const lineCount = introBlock.split('\n').length - 1;

  stream.write(`\x1b[?25l${introBlock}`);
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    stream.write(`\x1b[${lineCount}A\r${restBlock}\n`);
  } finally {
    stream.write('\x1b[?25h');
  }
}
