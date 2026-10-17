import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { TerminalModeGuard } from '../src/tui/terminal.js';

function fixture(initialRaw = false) {
  const chunks: string[] = [];
  const lifecycle = new EventEmitter();
  const input = {
    isTTY: true,
    isRaw: initialRaw,
    setRawMode(raw: boolean) {
      this.isRaw = raw;
    },
  };
  const output = {
    isTTY: true,
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  const guard = new TerminalModeGuard({
    input,
    output,
    lifecycle,
    writeSync: (chunk) => chunks.push(chunk),
  });
  return { guard, input, output, lifecycle, chunks };
}

describe('TUI terminal ownership and recovery', () => {
  it('restores only after explicit close and preserves the original raw state', () => {
    const f = fixture(true);
    f.guard.enter();
    f.guard.enableBracketedPaste();
    expect(f.chunks.join('')).toContain('\x1b[?1049h');
    f.input.setRawMode(false);
    f.guard.restore();
    const restored = f.chunks.join('');
    expect(restored).toContain('\x1b[?2004l');
    expect(restored).toContain('\x1b[?1049l\x1b[?25h');
    expect(f.input.isRaw).toBe(true);
    expect(f.lifecycle.listenerCount('exit')).toBe(0);
    expect(f.lifecycle.listenerCount('uncaughtExceptionMonitor')).toBe(0);
    f.guard.restore();
    expect(f.chunks.join('')).toBe(restored);
  });

  it('does not turn task interruption into screen teardown or swallow fatal errors', () => {
    const f = fixture();
    f.guard.enter();
    f.input.setRawMode(true);
    f.lifecycle.emit('SIGINT');
    expect(f.input.isRaw).toBe(true);
    expect(f.chunks.join('')).not.toContain('\x1b[?1049l');
    expect(f.lifecycle.listenerCount('uncaughtException')).toBe(0);
    expect(f.lifecycle.listenerCount('unhandledRejection')).toBe(0);
    f.lifecycle.emit('uncaughtExceptionMonitor', new Error('fixture'));
    expect(f.input.isRaw).toBe(false);
    expect(f.chunks.join('')).toContain('\x1b[?1049l');
    expect(f.lifecycle.listenerCount('exit')).toBe(0);
  });

  it('rejects non-TTY input before claiming modes or registering hooks', () => {
    const f = fixture();
    f.input.isTTY = false;
    expect(() => f.guard.enter()).toThrow(/TTY/);
    expect(f.chunks).toEqual([]);
    expect(f.lifecycle.eventNames()).toEqual([]);
  });

  it('cleans a failed initialization and makes broken-handle recovery nonthrowing', () => {
    const f = fixture();
    f.output.write = () => {
      throw new Error('output unavailable');
    };
    expect(() => f.guard.enter()).toThrow('output unavailable');
    expect(f.lifecycle.eventNames()).toEqual([]);
    expect(() => f.guard.restore()).not.toThrow();
    expect(f.chunks.join('')).toContain('\x1b[?1049l');
  });
});
