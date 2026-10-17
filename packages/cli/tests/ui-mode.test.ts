import { describe, expect, it } from 'vitest';
import { chooseUiMode, parseUiMode } from '../src/host/ui-mode.js';

describe('side-effect-free UI admission', () => {
  const terminal = { stdinTTY: true, stdoutTTY: true, capable: true, oneShot: false };
  it('accepts only the three explicit modes and rejects repeated or empty options', () => {
    expect(parseUiMode(undefined)).toBe('auto');
    for (const mode of ['auto', 'tui', 'text'] as const) expect(parseUiMode(mode)).toBe(mode);
    for (const invalid of ['', true, ['text', 'tui'], 'gui'])
      expect(() => parseUiMode(invalid)).toThrow(/--ui/);
  });
  it('uses TUI only when both terminal streams and rendering capability are available', () => {
    expect(chooseUiMode('auto', terminal)).toBe('tui');
    expect(chooseUiMode('auto', { ...terminal, stdinTTY: false })).toBe('text');
    expect(chooseUiMode('auto', { ...terminal, stdoutTTY: false })).toBe('text');
    expect(chooseUiMode('auto', { ...terminal, capable: false })).toBe('text');
    expect(chooseUiMode('auto', { ...terminal, oneShot: true })).toBe('text');
    expect(chooseUiMode('text', terminal)).toBe('text');
  });
  it('fails explicit TUI conflicts instead of falling back after runtime side effects', () => {
    for (const options of [
      { ...terminal, oneShot: true },
      { ...terminal, stdinTTY: false },
      { ...terminal, capable: false },
    ]) {
      expect(() => chooseUiMode('tui', options)).toThrow(/TUI|TTY/);
    }
  });
});
