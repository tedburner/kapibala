import { afterEach, describe, expect, it, vi } from 'vitest';
import { type TerminalInputFrame, TerminalInputFramer } from '../src/tui/input-framer.js';

afterEach(() => vi.useRealTimers());

function fixture(options: { maxSequenceBytes?: number; maxPasteBytes?: number } = {}) {
  const frames: TerminalInputFrame[] = [];
  const framer = new TerminalInputFramer((frame) => frames.push(frame), options);
  return { frames, framer };
}

describe('single-chain terminal input framing', () => {
  it('dispatches ordinary input immediately and joins fragmented CSI-u before Ink', () => {
    vi.useFakeTimers();
    const { frames, framer } = fixture();
    framer.push('中文');
    expect(frames).toEqual([{ kind: 'key', text: '中文' }]);
    framer.push('\x1b');
    vi.advanceTimersByTime(10);
    framer.push('[13;');
    vi.advanceTimersByTime(10);
    framer.push('2u');
    expect(frames[1]).toEqual({ kind: 'key', text: '\x1b[13;2u' });
    vi.runAllTimers();
    expect(frames).toHaveLength(2);
    framer.close();
  });

  it('distinguishes a standalone Escape from an incomplete invalid sequence', () => {
    vi.useFakeTimers();
    const { frames, framer } = fixture();
    framer.push('\x1b');
    vi.advanceTimersByTime(40);
    expect(frames).toEqual([{ kind: 'key', text: '\x1b' }]);
    framer.push('\x1b[13;');
    vi.advanceTimersByTime(40);
    expect(frames[1]).toEqual({ kind: 'discarded', reason: 'incomplete-sequence' });
    framer.push('ok');
    expect(frames[2]).toEqual({ kind: 'key', text: 'ok' });
    framer.close();
  });

  it('isolates pasted Enter, approval digits and Ctrl+C across arbitrary marker fragments', () => {
    const { frames, framer } = fixture();
    for (const part of ['\x1b[20', '0~', '/exit\r\n1\x03中文', '\x1b[20', '1~']) {
      framer.push(part);
    }
    expect(frames).toEqual([{ kind: 'paste', text: '/exit\r\n1\x03中文' }]);
    framer.push('\r');
    expect(frames[1]).toEqual({ kind: 'key', text: '\r' });
    framer.close();
  });

  it('discards an oversized paste through its end instead of replaying remaining shortcuts', () => {
    const { frames, framer } = fixture({ maxPasteBytes: 8 });
    framer.push('\x1b[200~中文中文');
    framer.push('\r\x03/exit\x1b[201~safe');
    expect(frames).toEqual([
      { kind: 'discarded', reason: 'paste-too-large' },
      { kind: 'key', text: 'safe' },
    ]);
    framer.close();
  });

  it('bounds an unfinished sequence and never dispatches its embedded Enter', () => {
    const { frames, framer } = fixture({ maxSequenceBytes: 8 });
    framer.push(`\x1b[${'1'.repeat(20)}\r`);
    expect(frames).toEqual([{ kind: 'discarded', reason: 'invalid-sequence' }]);
    framer.close();
  });

  it('close cancels pending Escape and removes partial paste without forwarding it', () => {
    vi.useFakeTimers();
    const { frames, framer } = fixture();
    framer.push('\x1b');
    framer.close();
    framer.push('\r');
    vi.runAllTimers();
    expect(frames).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });
});
