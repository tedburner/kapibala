import { describe, expect, it } from 'vitest';
import { color, createEventRenderer } from '../src/ui/events.js';
import { CLI_GLYPHS, createCliTheme, isCliColorEnabled } from '../src/ui/theme.js';

describe('CLI unified semantic theme (theme.ts)', () => {
  it('disables ANSI SGR output whenever NO_COLOR is defined (including empty string) or non-TTY', () => {
    expect(isCliColorEnabled({ isTTY: true, env: { NO_COLOR: '1' } })).toBe(false);
    expect(isCliColorEnabled({ isTTY: true, env: { NO_COLOR: '' } })).toBe(false);
    expect(isCliColorEnabled({ isTTY: true, env: { NO_COLOR: '1', FORCE_COLOR: '1' } })).toBe(
      false,
    );
    expect(isCliColorEnabled({ isTTY: false, env: {} })).toBe(false);
    expect(isCliColorEnabled({ isTTY: true, env: {} })).toBe(true);
    expect(isCliColorEnabled({ isTTY: false, env: { FORCE_COLOR: '1' } })).toBe(true);
    expect(isCliColorEnabled({ isTTY: true, env: { FORCE_COLOR: '0' } })).toBe(false);
    expect(isCliColorEnabled({ isTTY: true, env: { FORCE_COLOR: 'false' } })).toBe(false);

    const plain = createCliTheme({ isTTY: true, env: { NO_COLOR: '1' } });
    expect(plain.strong('Title')).toBe('Title');
    expect(plain.subtle('meta')).toBe('meta');
    expect(plain.amber('capy')).toBe('capy');
    expect(plain.success('ok')).toBe('ok');
    expect(plain.danger('err')).toBe('err');
    expect(plain.reset()).toBe('');
  });

  it('respects NO_COLOR in ui/events.ts even when isTTY is true', () => {
    const prevNoColor = process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    try {
      expect(color('warning', 33, true)).toBe('warning');
      const chunks: string[] = [];
      const renderer = createEventRenderer({
        isTTY: true,
        columns: 80,
        getGitBranch: () => 'main',
        write: (chunk) => chunks.push(chunk),
      });
      renderer.render({ type: 'thinking_delta', thinking: 'step 1' });
      renderer.render({ type: 'tool_start', id: 'c1', name: 'read_file', input: { path: 'a.ts' } });
      renderer.render({
        type: 'tool_finish',
        id: 'c1',
        name: 'read_file',
        result: 'ok',
        isError: false,
        durationMs: 12,
      });
      renderer.finish();
      // 允许光标定位 CSI（如 \x1b[1A / \x1b[2K），但禁止任何 SGR 色彩序列 \x1b[...m
      const sgrPattern = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`);
      expect(chunks.join('')).not.toMatch(sgrPattern);
    } finally {
      if (prevNoColor === undefined) Reflect.deleteProperty(process.env, 'NO_COLOR');
      else process.env.NO_COLOR = prevNoColor;
    }
  });

  it('wraps semantic tokens in deterministic SGR sequences when enabled and exposes shared glyphs', () => {
    const colored = createCliTheme({ enabled: true });
    expect(colored.strong('Title')).toBe('\x1b[1mTitle\x1b[0m');
    expect(colored.subtle('meta')).toBe('\x1b[90mmeta\x1b[0m');
    expect(colored.amber('capy')).toBe('\x1b[38;2;229;139;82mcapy\x1b[0m');
    expect(colored.success('ok')).toBe('\x1b[32mok\x1b[0m');
    expect(colored.danger('fail')).toBe('\x1b[31mfail\x1b[0m');
    expect(colored.warning('warn')).toBe('\x1b[33mwarn\x1b[0m');
    expect(colored.info('hint')).toBe('\x1b[36mhint\x1b[0m');
    expect(colored.glyphs).toEqual(CLI_GLYPHS);
  });
});
