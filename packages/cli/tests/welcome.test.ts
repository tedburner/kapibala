import { describe, expect, it } from 'vitest';
import {
  type WelcomeBannerFacts,
  formatHomeRelativePath,
  renderWelcomeBanner,
  writeInteractiveWelcome,
} from '../src/ui/welcome.js';
import { displayWidth } from '../src/ui/width.js';

const BASE_FACTS: WelcomeBannerFacts = {
  version: '0.1.5',
  modelId: 'claude-sonnet-4-5',
  role: 'default',
  mode: 'Approval',
  skillCount: 4,
  workspacePath: '/Users/thor/Project/person/kapibala',
  homeDir: '/Users/thor',
  gitBranch: 'main',
  conversationId: '62f85601-c716-490e-aaf1-87b6da667a04',
};

const ESC = '\x1b';
const ANSI_CTRL_RE = new RegExp(`${ESC}\\[[0-9;?]*[A-Za-z]`, 'g');
const ANSI_BG_RE = new RegExp(`${ESC}\\[(?:4[0-7]|10[0-7]|48;)`);

/** 剥除 ANSI 控制序列，便于测量真实终端显示列宽与纯文本断言。 */
function stripAnsi(input: string): string {
  return input.replace(ANSI_CTRL_RE, '');
}

describe('CLI 1A 极简墨线像素欢迎区 (welcome.ts)', () => {
  it('将用户主目录下的工作区路径折叠为 ~ 前缀，跨平台统一正斜杠展示', () => {
    expect(formatHomeRelativePath('/Users/thor/Project/kapibala', '/Users/thor')).toBe(
      '~/Project/kapibala',
    );
    expect(formatHomeRelativePath('C:\\Users\\Thor\\Project\\kapibala', 'C:\\Users\\Thor')).toBe(
      '~/Project/kapibala',
    );
    expect(formatHomeRelativePath('F:\\Project\\person\\kapibala', 'C:\\Users\\Thor')).toBe(
      'F:/Project/person/kapibala',
    );
  });

  it('在常规 80+ 列终端渲染 5 行双栏墨线半块像素水豚与状态信息，且零背景色码、零超宽折行', () => {
    const output = renderWelcomeBanner(BASE_FACTS, { columns: 80, color: true });
    // 不得注入任何 48;2 / 40..47 背景色码，确保透明适配任意深浅终端配色
    expect(output).not.toMatch(ANSI_BG_RE);
    // 包含水豚琥珀前景色与半块像素字符
    expect(output).toContain('\x1b[38;2;229;139;82m');
    expect(output).toContain('█');
    expect(output).toContain('▄');

    const plain = stripAnsi(output).trimEnd();
    const lines = plain.split('\n').filter((line) => line.length > 0);
    expect(lines.length).toBe(5);
    expect(plain).toContain('卡皮巴拉 v0.1.5');
    expect(plain).toContain('claude-sonnet-4-5');
    expect(plain).toContain('Approval');
    expect(plain).toContain('4 skills');
    expect(plain).toContain('~/Project/person/kapibala');
    expect(plain).toContain('(main)');
    expect(plain).toContain('/model');
    expect(plain).toContain('/help');

    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(80);
    }
  });

  it('在窄终端 (< 64 列) 下自动切换紧凑上下堆叠版式，保证水豚像素画不被硬折行撕裂', () => {
    const output = renderWelcomeBanner(BASE_FACTS, { columns: 52, color: false });
    expect(output).not.toContain('\x1b[');
    const lines = output
      .trim()
      .split('\n')
      .filter((line) => line.length > 0);
    for (const line of lines) {
      expect(displayWidth(line)).toBeLessThanOrEqual(52);
    }
    expect(output).toContain('卡皮巴拉 v0.1.5');
  });

  it('交互式 TTY 支持两帧落橘微动效并最终落定到完整静息帧；非 TTY 仅单次输出无光标控制码', async () => {
    const ttyChunks: string[] = [];
    await writeInteractiveWelcome(
      { isTTY: true, columns: 88, write: (chunk: string) => ttyChunks.push(chunk) },
      BASE_FACTS,
      { color: true, frameDelayMs: 1 },
    );
    const ttyJoined = ttyChunks.join('');
    // 含光标上移覆写帧并确保恢复光标可见 (\x1b[?25h)
    expect(ttyJoined).toContain('\x1b[?25l');
    expect(ttyJoined).toContain('\x1b[?25h');
    expect(stripAnsi(ttyChunks.at(-2) ?? ttyJoined)).toContain('卡皮巴拉 v0.1.5');

    const plainChunks: string[] = [];
    await writeInteractiveWelcome(
      { isTTY: false, write: (chunk: string) => plainChunks.push(chunk) },
      BASE_FACTS,
    );
    expect(plainChunks.length).toBe(1);
    expect(plainChunks[0]).not.toContain('\x1b[?25l');
    expect(stripAnsi(plainChunks[0]!)).toContain('卡皮巴拉 v0.1.5');
  });
});
